//! `/blobs*` content + metadata + derivative routes (`src/server.ts:2248-2560`,
//! map 05 §3.5/§3.6, map 02 §4.4 blob rows).
//!
//! Every handler requires an authenticated principal (the `/blobs*` paths are
//! on the TS protected-path list, `src/server.ts:5084-5085`). The surface:
//!
//! - `GET  /blobs` — owner-scoped metadata list + usage block.
//! - `POST /blobs` — metadata-only declaration.
//! - `GET  /blobs/:id` — metadata JSON (read authz with grant cascade).
//! - `PUT  /blobs/:id/content` — the full upload sequence (map 05 §3.5), or one
//!   chunk of a resumable upload when the request carries `Content-Range`
//!   (AURA-432, see the "Resumable/chunked upload" section below).
//! - `HEAD /blobs/:id/content` — resumable-upload offset probe: returns the
//!   server-known committed byte count for an in-progress chunked upload via
//!   `x-frick-upload-offset` (0 when no chunks have landed yet).
//! - `GET  /blobs/:id/content` — raw bytes download.
//! - `GET  /blobs/:id/derivatives` — derivative row list.
//! - `GET  /blobs/:id/derivatives/:derivativeId/content` — derivative bytes.
//!
//! ## Resumable/chunked upload (AURA-432)
//!
//! `PUT /blobs/:id/content` additionally accepts a `Content-Range: bytes
//! <start>-<end>/<total>` header. When present the raw body is treated as ONE
//! chunk of a larger upload rather than the whole content:
//!
//! - `start` MUST equal the number of bytes already staged for `:id` (0 for
//!   the first chunk) — a mismatch is a 409 `storage.conflict` naming the
//!   `expectedOffset`, so a client that lost its place can resync via `HEAD`.
//! - A non-final chunk (`end + 1 < total`) is appended to a durable staging
//!   area and the response is `202 {ok, blobId, receivedOffset, totalBytes}`.
//! - The final chunk (`end + 1 == total`) assembles the complete bytes and
//!   falls through to the same ownership/hash/quota/processor pipeline the
//!   whole-body upload uses, then clears the staging area.
//!
//! Chunks are staged WITHOUT a schema migration by reusing the existing
//! `blob_derivatives` byte store under a reserved, publicly-unaddressable
//! parent-id namespace ([`is_staging_namespace`]) — see
//! [`stage_key_for`]/[`read_staged_bytes`]/[`clear_staged_bytes`]. The public
//! derivative routes explicitly refuse that namespace so a chunked upload's
//! partial bytes can never be read back through `GET
//! /blobs/:id/derivatives*`.
//!
//! ## Integrator wiring
//!
//! Merge [`blobs_router`] into the data-plane router so the full server serves
//! the blob surface. In `src/routes/mod.rs`'s `dataplane_router`, add:
//!
//! ```ignore
//! pub mod blobs;
//! // ...
//! .merge(blobs::blobs_router(state.clone()))
//! ```
//!
//! Both blob-bytes storage (the facade's `write_content`/`read_content` +
//! `blob_driver`/`blob_storage_path`/`blob_s3_config` options) and the
//! derivative read helpers (`FrickStore::list_derivatives` / `read_derivative`)
//! live in the facade. `boot::build_server` plumbs `config.blob_driver`,
//! `config.blob_storage_path`, and the `FRICK_BLOB_S3_*` settings into
//! `FrickStoreOptions` (FR-273), so the byte backend is config-selectable:
//! `sqlite` (bytes in `blob_content`, the default), `filesystem`
//! (`FRICK_BLOB_STORAGE_PATH`), or `s3` (`FRICK_BLOB_S3_BUCKET`/`REGION`/
//! `ENDPOINT`/`PREFIX`/`FORCE_PATH_STYLE` + the standard `AWS_*` credentials).
//! The S3 driver is `object_store`-backed (rustls, no openssl).

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, OriginalUri, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use frick_protocol::Value;
use frick_store::StoreError;
use frick_store::facade::{DerivativeRecordInput, DerivativeRow};
use frick_store::stores::blob::{BlobMetadata, BlobMetadataInput};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use super::{ActiveApp, authenticate, map_get, new_request_id, parse_body_value, require_string};
use crate::authz::{Action, Decision, DenyReason, ResourceContext, decide_baseline};
use crate::error::{LimitKind, ServerError};
use crate::http::{AppState, respond_error};
use crate::principal::Principal;

/// Header carrying the owner id on a new-blob upload when `?ownerId=` is absent
/// (`x-frick-owner-id`, `src/server.ts:2305`).
const OWNER_ID_HEADER: &str = "x-frick-owner-id";

/// Build the `/blobs*` router. The `PUT /blobs/:id/content` body cap is
/// enforced inside the handler against `maxBlobBytes`, so the route disables
/// axum's default body limit (else a large-but-legal upload would 413 with the
/// wrong shape before reaching the handler).
pub fn blobs_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/blobs", get(list_blobs).post(declare_blob))
        .route(
            "/blobs/:id/content",
            get(get_content)
                .put(put_content)
                .head(head_content)
                .layer(DefaultBodyLimit::disable()),
        )
        .route(
            "/blobs/:id/derivatives/:derivativeId/content",
            get(get_derivative_content),
        )
        .route("/blobs/:id/derivatives", get(list_derivatives))
        .route("/blobs/:id", get(get_metadata))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct OwnerQuery {
    #[serde(rename = "ownerId")]
    owner_id: Option<String>,
}

/// `GET /blobs` (`src/server.ts:2248-2282`): owner-scoped metadata list. A
/// non-admin defaults `ownerId` to its own `userId`; admin is unrestricted
/// (`None` ⇒ every owner). A non-admin asking for an explicit owner runs the
/// `blob.read` baseline. 200 `{schemaHash, data}` plus a `usage` block when the
/// listing is owner-scoped.
async fn list_blobs(
    State(state): State<AppState>,
    active: ActiveApp,
    headers: HeaderMap,
    Query(query): Query<OwnerQuery>,
) -> Response {
    let request_id = new_request_id();
    let (principal, _now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    // ownerId from the query; non-admin defaults to self; admin → None.
    let requested_owner_id: Option<String> = query.owner_id.or_else(|| {
        if principal.is_admin() {
            None
        } else {
            Some(principal.user_id.clone())
        }
    });

    // A non-admin with an explicit ownerId (incl. the self-default) runs the
    // `blob.read` baseline against that owner.
    if !principal.is_admin()
        && let Some(owner) = requested_owner_id.as_deref()
        && let Err(error) = read_blob_decision(&principal, owner)
    {
        return respond_error(&error, &request_id);
    }

    let data = match state
        .store
        .blobs()
        .list(
            &principal.tenant_id,
            requested_owner_id.as_deref(),
            active.app_id(),
        )
        .await
    {
        Ok(rows) => rows,
        Err(error) => return respond_error(&store_error(&error), &request_id),
    };
    let data: Vec<serde_json::Value> = data.iter().map(blob_metadata_json).collect();

    let mut body = json!({
        "schemaHash": state.schema.hash,
        "data": data,
    });
    // Quota-aware listing (FR-56): only when scoped to a single owner.
    if let Some(owner) = requested_owner_id.as_deref() {
        let used_bytes = match state
            .store
            .blobs()
            .total_bytes_for_owner(&principal.tenant_id, owner, active.app_id())
            .await
        {
            Ok(total) => total,
            Err(error) => return respond_error(&store_error(&error), &request_id),
        };
        let quota = state.config.limits.max_blob_bytes_per_principal;
        let quota_bytes = if quota_configured(quota) {
            json!(quota)
        } else {
            json!(null)
        };
        if let Some(map) = body.as_object_mut() {
            map.insert(
                "usage".into(),
                json!({ "ownerId": owner, "usedBytes": used_bytes, "quotaBytes": quota_bytes }),
            );
        }
    }

    axum::Json(body).into_response()
}

/// `POST /blobs` (`src/server.ts:2538-2560`): metadata-only declaration
/// `{blobId, ownerId, contentHash, byteLength, mimeType, storageKey?}`. The
/// `blob.write` ownership assertion runs against the declared owner; 201
/// `{ok:true, blobId}`.
async fn declare_blob(
    State(state): State<AppState>,
    active: ActiveApp,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let request_id = new_request_id();
    let (principal, now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    let parsed = match parse_body_value(&body) {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let owner_id = match require_string(&parsed, "ownerId", "ownerId") {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    if let Err(error) = ownership_decision(&principal, &owner_id) {
        return respond_error(&error, &request_id);
    }
    let blob_id = match require_string(&parsed, "blobId", "blobId") {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let content_hash = match require_string(&parsed, "contentHash", "contentHash") {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let byte_length = match require_number(&parsed, "byteLength", "byteLength") {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let mime_type = match require_string(&parsed, "mimeType", "mimeType") {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    // `storageKey` is carried only when present AND a string (TS spread guard).
    let storage_key = map_get(&parsed, "storageKey")
        .and_then(Value::as_str)
        .map(str::to_owned);

    match state
        .store
        .blobs()
        .create(
            &principal.tenant_id,
            &BlobMetadataInput {
                blob_id: blob_id.clone(),
                owner_id,
                content_hash,
                byte_length,
                mime_type,
                storage_key,
            },
            active.app_id(),
            now,
        )
        .await
    {
        Ok(()) => (
            StatusCode::CREATED,
            axum::Json(json!({ "ok": true, "blobId": blob_id })),
        )
            .into_response(),
        Err(error) => respond_error(&store_error(&error), &request_id),
    }
}

/// `GET /blobs/:id` (`src/server.ts:2516-2536`): metadata JSON or 404
/// `{error:"blob_not_found"}`. After the lookup, the read authz baseline (with
/// the grant cascade) gates visibility.
async fn get_metadata(
    State(state): State<AppState>,
    active: ActiveApp,
    Path(blob_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let request_id = new_request_id();
    let (principal, _now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    let metadata = if blob_id.is_empty() {
        None
    } else {
        match state
            .store
            .blobs()
            .read(&principal.tenant_id, &blob_id, active.app_id())
            .await
        {
            Ok(metadata) => metadata,
            Err(error) => return respond_error(&store_error(&error), &request_id),
        }
    };
    let Some(metadata) = metadata else {
        return blob_not_found("blob_not_found");
    };

    if let Err(error) =
        assert_can_read_blob(&state, &principal, &metadata.owner_id, &metadata.blob_id).await
    {
        return respond_error(&error, &request_id);
    }

    axum::Json(blob_metadata_json(&metadata)).into_response()
}

/// `PUT /blobs/:id/content` (`src/server.ts:2284-2413`, map 05 §3.5): the full
/// upload sequence. The raw body is capped at `maxBlobBytes` (→ 413
/// `blob.tooLarge`); the content hash is `"sha256-"+hex(sha256(bytes))`.
/// Existing metadata → 200 (ownership + byteLength/contentHash match); a new
/// blob → 201 (ownerId from `?ownerId=` or `x-frick-owner-id`, mime from
/// `Content-Type` before `;`). The per-principal quota projection runs before
/// any write; the metadata row is created BEFORE the bytes (FK). Blob
/// processors/validators are deferred — see the `TODO(FR-248/processors)`.
#[allow(clippy::too_many_lines)] // the upload sequence is one linear TS-faithful flow
async fn put_content(
    State(state): State<AppState>,
    active: ActiveApp,
    Path(blob_id): Path<String>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let request_id = new_request_id();
    let (principal, now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    // AURA-432: a `Content-Range` header means this PUT carries one chunk of a
    // resumable upload rather than the whole body — hand off to the chunk path
    // and never fall through to the whole-body sequence below.
    if let Some(range_header) = header_str(&headers, header::CONTENT_RANGE.as_str()) {
        let range = match parse_content_range(range_header) {
            Ok(range) => range,
            Err(error) => return respond_error(&error, &request_id),
        };
        return put_content_chunk(
            &state,
            &principal,
            active.app_id(),
            &blob_id,
            &uri,
            &headers,
            now,
            range,
            body.as_ref(),
            &request_id,
        )
        .await;
    }

    // 1. Bound the raw body at maxBlobBytes → 413 `blob.tooLarge`.
    let max_blob_bytes = state.config.limits.max_blob_bytes;
    if i64::try_from(body.len()).unwrap_or(i64::MAX) > max_blob_bytes {
        return respond_error(&too_large(body.len(), max_blob_bytes), &request_id);
    }
    let content = body.as_ref();

    // 2. Existing metadata + the content hash of the raw bytes.
    let metadata = match state
        .store
        .blobs()
        .read(&principal.tenant_id, &blob_id, active.app_id())
        .await
    {
        Ok(metadata) => metadata,
        Err(error) => return respond_error(&store_error(&error), &request_id),
    };
    let content_hash = sha256_content_hash(content);

    // 3/4. Resolve owner + mime, run ownership/validation, pick the status.
    let resolved = match resolve_upload(
        &principal,
        metadata.as_ref(),
        &uri,
        &headers,
        &blob_id,
        content,
        &content_hash,
    ) {
        Ok(resolved) => resolved,
        Err(error) => return respond_error(&error, &request_id),
    };
    let ResolvedUpload {
        status: response_status,
        response_content_hash,
        owner_id: resolved_owner_id,
        mime_type: resolved_mime_type,
        existing_byte_length,
    } = resolved;

    // 4b. Blob processors (FR-272). Resolve the processors matching the
    // resolved (mime, size) tuple ONCE — the sync validators run here against
    // the 4 KiB preview (reject → 415), and the SAME set drives the async
    // `blob.process` enqueue after the bytes commit (TS `src/server.ts:2315-2403`).
    let matching_processors = state.blob_processors.matching(
        &resolved_mime_type,
        i64::try_from(content.len()).unwrap_or(i64::MAX),
    );
    if let Err(error) = run_sync_validators(
        &state,
        &matching_processors,
        &principal,
        &resolved_owner_id,
        &resolved_mime_type,
        &blob_id,
        content,
    ) {
        return respond_error(&error, &request_id);
    }

    // 5. Per-principal quota projection (FR-56), only when a finite cap is set.
    let quota = state.config.limits.max_blob_bytes_per_principal;
    if quota_configured(quota) {
        let current_bytes = match state
            .store
            .blobs()
            .total_bytes_for_owner(&principal.tenant_id, &resolved_owner_id, active.app_id())
            .await
        {
            Ok(total) => total,
            Err(error) => return respond_error(&store_error(&error), &request_id),
        };
        let incoming = i64::try_from(content.len()).unwrap_or(i64::MAX);
        let projected = current_bytes - existing_byte_length + incoming;
        if projected > quota {
            return respond_error(
                &quota_exceeded(&resolved_owner_id, projected, quota),
                &request_id,
            );
        }
    }

    let byte_length = i64::try_from(content.len()).unwrap_or(i64::MAX);

    // 6. New blob: create the metadata row BEFORE writing bytes (the
    // blob_content.blob_id FK references blob_metadata).
    if metadata.is_none()
        && let Err(error) = state
            .store
            .blobs()
            .create(
                &principal.tenant_id,
                &BlobMetadataInput {
                    blob_id: blob_id.clone(),
                    owner_id: resolved_owner_id.clone(),
                    content_hash: content_hash.clone(),
                    byte_length,
                    mime_type: infer_mime_type(&headers),
                    storage_key: None,
                },
                active.app_id(),
                now,
            )
            .await
    {
        return respond_error(&store_error(&error), &request_id);
    }

    // 7. Write the bytes.
    if let Err(error) = state
        .store
        .write_content(
            &principal.tenant_id,
            &blob_id,
            content,
            active.app_id(),
            now,
        )
        .await
    {
        return respond_error(&store_error(&error), &request_id);
    }

    // 8. Enqueue async post-processing jobs (FR-272). Each matching processor
    // with a `process` hook gets its own `blob.process` job, deduped by the
    // idempotency key `<blobId>:<processorId>:<contentHash>` (TS
    // `src/server.ts:2385-2403`). An enqueue failure does NOT fail the upload —
    // the bytes are already committed; the derivative is recoverable by a
    // re-upload (same idempotency key).
    if let Err(error) = enqueue_process_jobs(
        &state,
        &matching_processors,
        &principal.tenant_id,
        active.app_id(),
        &blob_id,
        &content_hash,
    )
    .await
    {
        return respond_error(&store_error(&error), &request_id);
    }

    (
        response_status,
        axum::Json(json!({
            "ok": true,
            "blobId": blob_id,
            "byteLength": byte_length,
            "contentHash": response_content_hash,
        })),
    )
        .into_response()
}

// ── AURA-432: resumable/chunked upload ──────────────────────────────────────

/// A parsed `Content-Range: bytes <start>-<end>/<total>` request header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ContentRange {
    start: u64,
    end: u64,
    total: u64,
}

impl ContentRange {
    /// Whether `end` is the last byte of `total` — i.e. this chunk completes
    /// the upload.
    fn is_final(self) -> bool {
        self.end + 1 == self.total
    }
}

/// Parse a `Content-Range: bytes <start>-<end>/<total>` header (the only unit
/// this endpoint accepts). Malformed/unsupported input is a 400
/// `sync.protocolError` — the `*` (unknown-length) form is rejected because a
/// resumable upload MUST declare its total length up front so the server can
/// tell the final chunk apart from an interior one.
fn parse_content_range(raw: &str) -> Result<ContentRange, ServerError> {
    let bad = || ServerError::BadRequest {
        message: format!("invalid Content-Range header: {raw}"),
    };
    let rest = raw.trim().strip_prefix("bytes ").ok_or_else(bad)?;
    let (range, total) = rest.split_once('/').ok_or_else(bad)?;
    let (start, end) = range.split_once('-').ok_or_else(bad)?;
    let start: u64 = start.trim().parse().map_err(|_| bad())?;
    let end: u64 = end.trim().parse().map_err(|_| bad())?;
    let total: u64 = total.trim().parse().map_err(|_| bad())?;
    if end < start || end >= total {
        return Err(bad());
    }
    Ok(ContentRange { start, end, total })
}

/// The reserved `blob_derivatives.parent_blob_id` prefix used to stage
/// in-progress chunked-upload bytes (module docs, "Resumable/chunked
/// upload"). Chosen so it can NEVER equal a real `blob_id`: an HTTP path
/// segment is matched and percent-decoded by axum before this string
/// comparison ever runs, but [`is_staging_namespace`] is applied to every
/// value that reaches the derivative routes regardless — so even a `blob_id`
/// crafted to collide with this literal prefix is refused there.
const STAGING_NAMESPACE: &str = "\u{0}aura-432-upload\u{0}";

/// The single staged-chunk derivative id under a staging parent (one row per
/// upload holds the whole accumulated prefix so far; ordering is enforced by
/// the offset check in [`put_content_chunk`], not by having one row per
/// chunk).
const STAGING_DERIVATIVE_ID: &str = "chunk";

/// Build the reserved staging `parent_blob_id` for a real `blob_id`. Tenant
/// isolation is already provided by `blob_derivatives`' `tenant_id` column, so
/// this only needs to be unique per real blob id within that tenant.
fn stage_key_for(blob_id: &str) -> String {
    format!("{STAGING_NAMESPACE}{blob_id}")
}

/// Whether a `blob_id` path value falls inside the reserved staging
/// namespace. The public derivative routes call this and refuse to serve
/// (404, indistinguishable from "unknown blob") any value it matches, so a
/// chunked upload's partial bytes can never be read back through `GET
/// /blobs/:id/derivatives*` even if a caller crafts their own `blob_id` to
/// collide with [`STAGING_NAMESPACE`].
fn is_staging_namespace(blob_id: &str) -> bool {
    blob_id.starts_with(STAGING_NAMESPACE)
}

/// Read the bytes staged so far for `blob_id` (empty when none).
async fn read_staged_bytes(
    state: &AppState,
    tenant_id: &str,
    blob_id: &str,
) -> Result<Vec<u8>, StoreError> {
    let parent = stage_key_for(blob_id);
    let result = state
        .store
        .read_derivative(&parent, STAGING_DERIVATIVE_ID, tenant_id)
        .await?;
    Ok(result.map(|result| result.bytes).unwrap_or_default())
}

/// Persist the full accumulated staged bytes for `blob_id` (an upsert — the
/// caller passes the WHOLE prefix received so far, not just the new chunk).
async fn write_staged_bytes(
    state: &AppState,
    tenant_id: &str,
    blob_id: &str,
    content: Vec<u8>,
) -> Result<(), StoreError> {
    let parent = stage_key_for(blob_id);
    state
        .store
        .record_derivative(&DerivativeRecordInput {
            parent_blob_id: parent,
            derivative_id: STAGING_DERIVATIVE_ID.to_string(),
            tenant_id: tenant_id.to_string(),
            processor_id: "aura-432-chunk-stage".to_string(),
            mime_type: "application/octet-stream".to_string(),
            content,
            metadata_json: None,
            storage_key: None,
        })
        .await
}

/// Discard the staged bytes for `blob_id` (finalize/abandon cleanup). No-op
/// when nothing is staged.
async fn clear_staged_bytes(
    state: &AppState,
    tenant_id: &str,
    blob_id: &str,
) -> Result<(), StoreError> {
    let parent = stage_key_for(blob_id);
    state
        .store
        .blobs()
        .delete_derivatives(&parent, tenant_id)
        .await?;
    Ok(())
}

/// Resolve the eventual owner for a chunk upload: existing metadata's owner,
/// else `?ownerId=`/`x-frick-owner-id` for a brand-new blob (the same
/// resolution `resolve_upload` runs, split out here so `put_content_chunk`
/// stays under the line cap).
fn resolve_chunk_owner(
    metadata: Option<&BlobMetadata>,
    uri: &axum::http::Uri,
    headers: &HeaderMap,
) -> Result<String, ServerError> {
    if let Some(metadata) = metadata {
        return Ok(metadata.owner_id.clone());
    }
    owner_id_from_query(uri)
        .or_else(|| header_str(headers, OWNER_ID_HEADER).map(str::to_owned))
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ServerError::BadRequest {
            message: "ownerId must be a non-empty string".into(),
        })
}

/// Handle one chunk of a resumable upload (the `Content-Range` branch of
/// `PUT /blobs/:id/content`). Ownership is re-derived exactly as the
/// whole-body path does (existing metadata's owner, or `?ownerId=`/
/// `x-frick-owner-id` for a brand-new blob) so a chunk cannot be staged by
/// anyone but the eventual owner.
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
async fn put_content_chunk(
    state: &AppState,
    principal: &Principal,
    app_id: &str,
    blob_id: &str,
    uri: &axum::http::Uri,
    headers: &HeaderMap,
    now: i64,
    range: ContentRange,
    chunk: &[u8],
    request_id: &str,
) -> Response {
    if chunk.len() as u64 != range.end - range.start + 1 {
        return respond_error(
            &(ServerError::BadRequest {
                message: format!(
                    "Content-Range declared {} bytes but the body carried {}",
                    range.end - range.start + 1,
                    chunk.len()
                ),
            }),
            request_id,
        );
    }
    let max_blob_bytes = state.config.limits.max_blob_bytes;
    if i64::try_from(range.total).unwrap_or(i64::MAX) > max_blob_bytes {
        return respond_error(
            &too_large(
                usize::try_from(range.total).unwrap_or(usize::MAX),
                max_blob_bytes,
            ),
            request_id,
        );
    }

    // Resolve + authorize the eventual owner, mirroring `resolve_upload`'s
    // ownership half (the mime/status half only matters for the whole-body
    // response, decided again at finalize).
    let metadata = match state
        .store
        .blobs()
        .read(&principal.tenant_id, blob_id, app_id)
        .await
    {
        Ok(metadata) => metadata,
        Err(error) => return respond_error(&store_error(&error), request_id),
    };
    let owner_id = match resolve_chunk_owner(metadata.as_ref(), uri, headers) {
        Ok(owner_id) => owner_id,
        Err(error) => return respond_error(&error, request_id),
    };
    if let Err(error) = ownership_decision(principal, &owner_id) {
        return respond_error(&error, request_id);
    }

    // The staged prefix so far MUST match `range.start` exactly — out-of-order
    // or duplicate chunks are rejected with the offset the server actually has,
    // so a client can resync via `HEAD` and resume cleanly.
    let staged = match read_staged_bytes(state, &principal.tenant_id, blob_id).await {
        Ok(staged) => staged,
        Err(error) => return respond_error(&store_error(&error), request_id),
    };
    let staged_len = staged.len() as u64;
    if range.start != staged_len {
        return respond_error(
            &ServerError::StorageConflict {
                detail: Value::Map(vec![
                    ("reason".into(), Value::from("uploadOffsetMismatch")),
                    (
                        "expectedOffset".into(),
                        Value::from(i64::try_from(staged_len).unwrap_or(i64::MAX)),
                    ),
                    (
                        "receivedOffset".into(),
                        Value::from(i64::try_from(range.start).unwrap_or(i64::MAX)),
                    ),
                ]),
            },
            request_id,
        );
    }

    let mut assembled = staged;
    assembled.extend_from_slice(chunk);

    if !range.is_final() {
        // Interior chunk: persist the growing prefix and report progress.
        let received_offset = assembled.len();
        if let Err(error) =
            write_staged_bytes(state, &principal.tenant_id, blob_id, assembled).await
        {
            return respond_error(&store_error(&error), request_id);
        }
        return (
            StatusCode::ACCEPTED,
            axum::Json(json!({
                "ok": true,
                "blobId": blob_id,
                "receivedOffset": received_offset,
                "totalBytes": range.total,
            })),
        )
            .into_response();
    }

    // Final chunk: the assembled bytes must match the declared total, then the
    // rest is byte-for-byte the whole-body upload sequence (steps 2-8 of
    // `put_content`), reusing `resolve_upload` for ownership/hash checks.
    if assembled.len() as u64 != range.total {
        return respond_error(
            &(ServerError::BadRequest {
                message: format!(
                    "assembled upload is {} bytes but Content-Range declared {}",
                    assembled.len(),
                    range.total
                ),
            }),
            request_id,
        );
    }
    let content = assembled.as_slice();
    let content_hash = sha256_content_hash(content);

    let resolved = match resolve_upload(
        principal,
        metadata.as_ref(),
        uri,
        headers,
        blob_id,
        content,
        &content_hash,
    ) {
        Ok(resolved) => resolved,
        Err(error) => return respond_error(&error, request_id),
    };
    let ResolvedUpload {
        status: response_status,
        response_content_hash,
        owner_id: resolved_owner_id,
        mime_type: resolved_mime_type,
        existing_byte_length,
    } = resolved;

    let matching_processors = state.blob_processors.matching(
        &resolved_mime_type,
        i64::try_from(content.len()).unwrap_or(i64::MAX),
    );
    if let Err(error) = run_sync_validators(
        state,
        &matching_processors,
        principal,
        &resolved_owner_id,
        &resolved_mime_type,
        blob_id,
        content,
    ) {
        return respond_error(&error, request_id);
    }

    let quota = state.config.limits.max_blob_bytes_per_principal;
    if quota_configured(quota) {
        let current_bytes = match state
            .store
            .blobs()
            .total_bytes_for_owner(&principal.tenant_id, &resolved_owner_id, app_id)
            .await
        {
            Ok(total) => total,
            Err(error) => return respond_error(&store_error(&error), request_id),
        };
        let incoming = i64::try_from(content.len()).unwrap_or(i64::MAX);
        let projected = current_bytes - existing_byte_length + incoming;
        if projected > quota {
            return respond_error(
                &quota_exceeded(&resolved_owner_id, projected, quota),
                request_id,
            );
        }
    }

    let byte_length = i64::try_from(content.len()).unwrap_or(i64::MAX);

    if metadata.is_none()
        && let Err(error) = state
            .store
            .blobs()
            .create(
                &principal.tenant_id,
                &BlobMetadataInput {
                    blob_id: blob_id.to_string(),
                    owner_id: resolved_owner_id.clone(),
                    content_hash: content_hash.clone(),
                    byte_length,
                    mime_type: infer_mime_type(headers),
                    storage_key: None,
                },
                app_id,
                now,
            )
            .await
    {
        return respond_error(&store_error(&error), request_id);
    }

    if let Err(error) = state
        .store
        .write_content(&principal.tenant_id, blob_id, content, app_id, now)
        .await
    {
        return respond_error(&store_error(&error), request_id);
    }

    // The staging area is no longer needed once the real bytes are committed.
    if let Err(error) = clear_staged_bytes(state, &principal.tenant_id, blob_id).await {
        return respond_error(&store_error(&error), request_id);
    }

    if let Err(error) = enqueue_process_jobs(
        state,
        &matching_processors,
        &principal.tenant_id,
        app_id,
        blob_id,
        &content_hash,
    )
    .await
    {
        return respond_error(&store_error(&error), request_id);
    }

    (
        response_status,
        axum::Json(json!({
            "ok": true,
            "blobId": blob_id,
            "byteLength": byte_length,
            "contentHash": response_content_hash,
        })),
    )
        .into_response()
}

/// `HEAD /blobs/:id/content` (AURA-432): the resumable-upload offset probe.
/// Requires the same ownership as an upload (not read authz) — a caller must
/// be the (eventual) owner to learn how much of their own in-flight upload
/// has landed. `x-frick-upload-offset` is 0 when nothing is staged yet;
/// existing metadata (an already-finalized blob) also reports 0 — resuming a
/// completed upload makes no sense, the caller should just `GET` it.
async fn head_content(
    State(state): State<AppState>,
    active: ActiveApp,
    Path(blob_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let request_id = new_request_id();
    let (principal, _now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    let metadata = match state
        .store
        .blobs()
        .read(&principal.tenant_id, &blob_id, active.app_id())
        .await
    {
        Ok(metadata) => metadata,
        Err(error) => return respond_error(&store_error(&error), &request_id),
    };
    let owner_id = match &metadata {
        Some(metadata) => metadata.owner_id.clone(),
        None => principal.user_id.clone(),
    };
    if let Err(error) = ownership_decision(&principal, &owner_id) {
        return respond_error(&error, &request_id);
    }

    let offset = if metadata.is_some() {
        0
    } else {
        match read_staged_bytes(&state, &principal.tenant_id, &blob_id).await {
            Ok(staged) => staged.len(),
            Err(error) => return respond_error(&store_error(&error), &request_id),
        }
    };

    Response::builder()
        .status(StatusCode::OK)
        .header("x-frick-upload-offset", offset)
        .body(Body::empty())
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Run the sync blob validators (FR-272) over the 4 KiB preview. Each matching
/// processor with a `validate` hook is invoked; the first rejection becomes a
/// `415 blob.unsupportedContentType` carrying `processorId` + `rejectionReason`
/// (TS `src/server.ts:2315-2338`). No store row is written when a validator
/// rejects (this runs before the metadata create / byte write).
#[allow(clippy::too_many_arguments)]
fn run_sync_validators(
    state: &AppState,
    processors: &[crate::blob_processors::SharedBlobProcessor],
    principal: &Principal,
    owner_id: &str,
    mime_type: &str,
    blob_id: &str,
    content: &[u8],
) -> Result<(), ServerError> {
    // First 4 KiB of the content for sniffing (shorter for tiny blobs).
    let preview = &content[..content.len().min(4 * 1024)];
    let byte_length = i64::try_from(content.len()).unwrap_or(i64::MAX);
    for processor in processors {
        if !processor.has_validate() {
            continue;
        }
        let verdict = processor.validate(&crate::blob_processors::BlobValidateContext {
            tenant_id: &principal.tenant_id,
            blob_id,
            owner_id,
            mime_type,
            byte_length,
            preview,
            store: &state.store,
        });
        if let crate::blob_processors::BlobValidation::Reject { reason } = verdict {
            let processor_id = processor.id().to_string();
            return Err(ServerError::BlobValidationRejected {
                message: format!("Blob rejected by processor {processor_id}: {reason}"),
                processor_id,
                rejection_reason: Some(reason),
            });
        }
    }
    Ok(())
}

/// Enqueue one `blob.process` job per matching processor with a `process` hook
/// (FR-272, TS `src/server.ts:2385-2403`). The idempotency key
/// `<blobId>:<processorId>:<contentHash>` makes a same-content re-upload a
/// no-op enqueue.
async fn enqueue_process_jobs(
    state: &AppState,
    processors: &[crate::blob_processors::SharedBlobProcessor],
    tenant_id: &str,
    app_id: &str,
    blob_id: &str,
    content_hash: &str,
) -> Result<(), StoreError> {
    for processor in processors {
        if !processor.has_process() {
            continue;
        }
        let processor_id = processor.id();
        let payload = crate::blob_processors::encode_blob_process_payload(
            &crate::blob_processors::BlobProcessPayload {
                blob_id: blob_id.to_string(),
                processor_id: processor_id.to_string(),
            },
        );
        state
            .store
            .enqueue_job(frick_store::stores::job::EnqueueInput {
                tenant_id: tenant_id.to_string(),
                app_id: Some(app_id.to_string()),
                job_type: crate::blob_processors::BLOB_PROCESS_JOB_TYPE.to_string(),
                payload,
                idempotency_key: Some(format!("{blob_id}:{processor_id}:{content_hash}")),
                available_at: None,
                max_attempts: None,
            })
            .await?;
    }
    Ok(())
}

/// The owner / mime / status resolution for an upload (`put_content` step 3/4).
struct ResolvedUpload {
    /// 200 for an existing-metadata upload, 201 for a new blob.
    status: StatusCode,
    /// The `contentHash` echoed in the response: the stored metadata hash on
    /// overwrite, the computed hash on create.
    response_content_hash: String,
    owner_id: String,
    /// The resolved MIME type: the stored metadata mime on overwrite, the
    /// inferred `Content-Type` on create. Drives processor matching (FR-272).
    mime_type: String,
    /// Bytes already attributed to this blob (the overwritten blob's declared
    /// length, or 0 for a new blob) — subtracted from the quota projection.
    existing_byte_length: i64,
}

/// Resolve owner/mime/status for an upload and run the ownership + content
/// validation (`put_content` step 3/4, map 05 §3.5). Existing metadata →
/// ownership + byteLength/contentHash match (200); a new blob → ownerId from
/// `?ownerId=` or `x-frick-owner-id` (201). Pure (no store I/O) so the route
/// body stays under the line cap.
fn resolve_upload(
    principal: &Principal,
    metadata: Option<&BlobMetadata>,
    uri: &axum::http::Uri,
    headers: &HeaderMap,
    blob_id: &str,
    content: &[u8],
    content_hash: &str,
) -> Result<ResolvedUpload, ServerError> {
    if let Some(metadata) = metadata {
        // Existing blob (declared-then-upload or overwrite) → 200.
        ownership_decision(principal, &metadata.owner_id)?;
        validate_blob_content(
            blob_id,
            metadata.byte_length,
            &metadata.content_hash,
            content,
            content_hash,
        )?;
        return Ok(ResolvedUpload {
            status: StatusCode::OK,
            response_content_hash: metadata.content_hash.clone(),
            owner_id: metadata.owner_id.clone(),
            mime_type: metadata.mime_type.clone(),
            existing_byte_length: metadata.byte_length,
        });
    }
    // New blob → 201. ownerId from ?ownerId= or x-frick-owner-id header.
    let owner_id = owner_id_from_query(uri)
        .or_else(|| header_str(headers, OWNER_ID_HEADER).map(str::to_owned))
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ServerError::BadRequest {
            message: "ownerId must be a non-empty string".into(),
        })?;
    ownership_decision(principal, &owner_id)?;
    Ok(ResolvedUpload {
        status: StatusCode::CREATED,
        response_content_hash: content_hash.to_owned(),
        owner_id,
        mime_type: infer_mime_type(headers),
        existing_byte_length: 0,
    })
}

/// `GET /blobs/:id/content` (`src/server.ts:2415-2442`): metadata AND content
/// must both exist else 404 `{error:"blob_content_not_found"}`. The read authz
/// baseline + grant cascade gates access. Headers: `content-type`,
/// `content-length`, `x-frick-blob-id`, `x-frick-content-hash`; body = raw
/// bytes.
async fn get_content(
    State(state): State<AppState>,
    active: ActiveApp,
    Path(blob_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let request_id = new_request_id();
    let (principal, _now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    let metadata = match state
        .store
        .blobs()
        .read(&principal.tenant_id, &blob_id, active.app_id())
        .await
    {
        Ok(metadata) => metadata,
        Err(error) => return respond_error(&store_error(&error), &request_id),
    };
    let content = match state
        .store
        .read_content(&principal.tenant_id, &blob_id, active.app_id())
        .await
    {
        Ok(content) => content,
        Err(error) => return respond_error(&store_error(&error), &request_id),
    };
    let (Some(metadata), Some(content)) = (metadata, content) else {
        return blob_not_found("blob_content_not_found");
    };

    if let Err(error) =
        assert_can_read_blob(&state, &principal, &metadata.owner_id, &metadata.blob_id).await
    {
        return respond_error(&error, &request_id);
    }

    blob_bytes_response(
        &metadata.mime_type,
        &metadata.blob_id,
        &metadata.content_hash,
        None,
        content,
    )
}

/// `GET /blobs/:id/derivatives` (`src/server.ts:2489-2514`): parent metadata
/// missing → 404 `{error:"blob_not_found"}`; else 200 `{derivatives}` ordered
/// `derivative_id ASC`. Parent metadata is read with the active app id (gating
/// access); the derivative rows themselves are not app-scoped.
async fn list_derivatives(
    State(state): State<AppState>,
    active: ActiveApp,
    Path(blob_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let request_id = new_request_id();
    // AURA-432: the staging namespace is never a real blob — refuse it before
    // even touching metadata, so a crafted `blob_id` can never observe
    // someone else's in-progress chunked-upload bytes (module docs).
    if is_staging_namespace(&blob_id) {
        return blob_not_found("blob_not_found");
    }
    let (principal, _now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    let metadata = match state
        .store
        .blobs()
        .read(&principal.tenant_id, &blob_id, active.app_id())
        .await
    {
        Ok(metadata) => metadata,
        Err(error) => return respond_error(&store_error(&error), &request_id),
    };
    let Some(metadata) = metadata else {
        return blob_not_found("blob_not_found");
    };
    if let Err(error) =
        assert_can_read_blob(&state, &principal, &metadata.owner_id, &metadata.blob_id).await
    {
        return respond_error(&error, &request_id);
    }

    match state
        .store
        .list_derivatives(&blob_id, &principal.tenant_id)
        .await
    {
        Ok(rows) => {
            let derivatives: Vec<serde_json::Value> =
                rows.iter().map(derivative_row_json).collect();
            axum::Json(json!({ "derivatives": derivatives })).into_response()
        }
        Err(error) => respond_error(&store_error(&error), &request_id),
    }
}

/// `GET /blobs/:id/derivatives/:derivativeId/content` (`src/server.ts:2444-2487`):
/// parent metadata missing → 404 `{error:"blob_not_found"}`; derivative missing
/// → 404 `{error:"blob_derivative_not_found"}`. Headers: `content-type`
/// (derivative mime), `content-length`, `x-frick-blob-id` (the PARENT id),
/// `x-frick-content-hash` (derivative hash), `etag: "\"<hash>\""`.
async fn get_derivative_content(
    State(state): State<AppState>,
    active: ActiveApp,
    Path((blob_id, derivative_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let request_id = new_request_id();
    // AURA-432: same staging-namespace refusal as `list_derivatives`.
    if is_staging_namespace(&blob_id) {
        return blob_not_found("blob_not_found");
    }
    let (principal, _now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    let metadata = match state
        .store
        .blobs()
        .read(&principal.tenant_id, &blob_id, active.app_id())
        .await
    {
        Ok(metadata) => metadata,
        Err(error) => return respond_error(&store_error(&error), &request_id),
    };
    let Some(metadata) = metadata else {
        // Cross-tenant and unknown share 404 — never leak another tenant's blob.
        return blob_not_found("blob_not_found");
    };
    if let Err(error) =
        assert_can_read_blob(&state, &principal, &metadata.owner_id, &metadata.blob_id).await
    {
        return respond_error(&error, &request_id);
    }

    let result = match state
        .store
        .read_derivative(&blob_id, &derivative_id, &principal.tenant_id)
        .await
    {
        Ok(result) => result,
        Err(error) => return respond_error(&store_error(&error), &request_id),
    };
    let Some(result) = result else {
        return blob_not_found("blob_derivative_not_found");
    };

    let etag = format!("\"{}\"", result.row.content_hash);
    blob_bytes_response(
        &result.row.mime_type,
        &metadata.blob_id,
        &result.row.content_hash,
        Some(&etag),
        result.bytes,
    )
}

// ── authz ────────────────────────────────────────────────────────────────────

/// `assertCanReadBlob` (authz.ts:1069-1101): the `blob.read` baseline (owner /
/// admin), relaxed by the sharing-grant cascade — an `ownerMismatch` deny flips
/// to allow when the principal holds an active grant on the record whose id ==
/// `blobId`. Policy hooks are FR-245 (deferred), so baseline + cascade is the
/// whole pipeline.
async fn assert_can_read_blob(
    state: &AppState,
    principal: &Principal,
    owner_id: &str,
    blob_id: &str,
) -> Result<(), ServerError> {
    let resource = ResourceContext {
        tenant_id: principal.tenant_id.clone(),
        owner_user_id: Some(owner_id.to_owned()),
    };
    let decision = decide_baseline(principal, Action::BlobRead, &resource);
    let Decision::Deny { reason, .. } = &decision else {
        return Ok(());
    };
    // Only an owner-mismatch deny is eligible for the cascade relaxation.
    if *reason == DenyReason::OwnerMismatch {
        let allowed = state
            .store
            .grants()
            .has_active_grant_for_record_id(&principal.tenant_id, &principal.user_id, blob_id)
            .await
            .map_err(|_| ServerError::Internal)?;
        if allowed {
            return Ok(());
        }
    }
    decision_to_result(decision)
}

/// The `blob.read` baseline alone (no cascade) — used by `GET /blobs` for an
/// explicit non-admin ownerId, where the TS calls `assertCanReadBlob` with no
/// blobId/cascade lookup (strict owner-only).
fn read_blob_decision(principal: &Principal, owner_id: &str) -> Result<(), ServerError> {
    let resource = ResourceContext {
        tenant_id: principal.tenant_id.clone(),
        owner_user_id: Some(owner_id.to_owned()),
    };
    decision_to_result(decide_baseline(principal, Action::BlobRead, &resource))
}

/// `assertBlobOwnership` (authz.ts:1103-1116): the `blob.write` baseline (owner
/// / admin). No cascade — a non-owner cannot upload to another's blob.
fn ownership_decision(principal: &Principal, owner_id: &str) -> Result<(), ServerError> {
    let resource = ResourceContext {
        tenant_id: principal.tenant_id.clone(),
        owner_user_id: Some(owner_id.to_owned()),
    };
    decision_to_result(decide_baseline(principal, Action::BlobWrite, &resource))
}

fn decision_to_result(decision: Decision) -> Result<(), ServerError> {
    match decision {
        Decision::Allow => Ok(()),
        Decision::Deny {
            reason,
            public_message,
        } => Err(ServerError::Authorization {
            message: public_message,
            reason: Some(reason.as_str().to_string()),
        }),
    }
}

// ── helpers ────────────────────────────────────────────────────────────────

/// `sha256ContentHash` (`src/server.ts:3660-3662`): `"sha256-"+hex(sha256(bytes))`.
fn sha256_content_hash(content: &[u8]) -> String {
    format!("sha256-{}", hex_lower(&Sha256::digest(content)))
}

/// Lowercase hex of a byte slice (no external dep needed in this crate).
fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit(u32::from(byte >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(byte & 0x0f), 16).unwrap_or('0'));
    }
    out
}

/// `validateBlobContent` (`src/server.ts:3664-3677`): the byte length must
/// equal the declared length; the content hash is compared ONLY when the
/// stored hash begins `"sha256-"` (other hash schemes pass unchecked). A
/// mismatch is a 400 `sync.protocolError`.
fn validate_blob_content(
    blob_id: &str,
    expected_byte_length: i64,
    expected_content_hash: &str,
    content: &[u8],
    actual_content_hash: &str,
) -> Result<(), ServerError> {
    let actual_len = i64::try_from(content.len()).unwrap_or(i64::MAX);
    if actual_len != expected_byte_length {
        return Err(ServerError::BadRequest {
            message: format!(
                "blob {blob_id} byteLength mismatch: expected {expected_byte_length}, got {actual_len}"
            ),
        });
    }
    if expected_content_hash.starts_with("sha256-") && expected_content_hash != actual_content_hash
    {
        return Err(ServerError::BadRequest {
            message: format!(
                "blob {blob_id} contentHash mismatch: expected {expected_content_hash}, got {actual_content_hash}"
            ),
        });
    }
    Ok(())
}

/// `inferMimeType` (`src/server.ts:3679-3681`): `Content-Type` before the first
/// `;`, trimmed; empty/absent → `application/octet-stream`.
fn infer_mime_type(headers: &HeaderMap) -> String {
    header_str(headers, header::CONTENT_TYPE.as_str())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("application/octet-stream")
        .to_owned()
}

/// `requireNumber(value, name)` (`src/server.ts:3484-3489`): a finite number
/// field pulled out of the body map, else 400. The wire value is JSON; an
/// integer round-trips through `i64` (byte lengths are i64-safe).
fn require_number(body: &Value, key: &str, name: &str) -> Result<i64, ServerError> {
    let bad = || ServerError::BadRequest {
        message: format!("{name} must be a finite number"),
    };
    let value = map_get(body, key).ok_or_else(bad)?;
    if let Some(int) = value.as_i64() {
        return Ok(int);
    }
    let float = value.as_f64().filter(|n| n.is_finite()).ok_or_else(bad)?;
    #[allow(clippy::cast_possible_truncation)]
    Ok(float as i64)
}

/// Whether a per-principal quota is a finite, below-`MAX_SAFE_INTEGER` cap
/// (`Number.isFinite(q) && q < Number.MAX_SAFE_INTEGER`). The default is
/// `MAX_SAFE_INTEGER` (unlimited), so this is false unless explicitly set.
fn quota_configured(quota: i64) -> bool {
    quota < 9_007_199_254_740_991
}

/// The shared raw-bytes 200 response (`content-type`, `content-length`,
/// `x-frick-blob-id`, `x-frick-content-hash`, optional `etag`), body = bytes.
fn blob_bytes_response(
    mime_type: &str,
    blob_id: &str,
    content_hash: &str,
    etag: Option<&str>,
    bytes: Vec<u8>,
) -> Response {
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime_type)
        .header(header::CONTENT_LENGTH, bytes.len())
        .header("x-frick-blob-id", blob_id)
        .header("x-frick-content-hash", content_hash);
    if let Some(etag) = etag {
        builder = builder.header(header::ETAG, etag);
    }
    builder
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// A bespoke `{error:"<code>"}` 404 body (plain JSON, not the standard
/// envelope) — matches the TS `sendJson(404, { error })`.
fn blob_not_found(code: &'static str) -> Response {
    (StatusCode::NOT_FOUND, axum::Json(json!({ "error": code }))).into_response()
}

/// `FrickLimitError{limit:"maxBlobBytes"}` → 413 `blob.tooLarge` with
/// `{limit, configuredMax, actualValue}` details.
fn too_large(actual: usize, configured_max: i64) -> ServerError {
    ServerError::Limit {
        kind: LimitKind::MaxBlobBytes,
        detail: Value::Map(vec![
            ("limit".into(), Value::from("maxBlobBytes")),
            ("configuredMax".into(), Value::from(configured_max)),
            (
                "actualValue".into(),
                Value::from(i64::try_from(actual).unwrap_or(i64::MAX)),
            ),
        ]),
    }
}

/// `FrickLimitError{limit:"maxBlobBytesPerPrincipal"}` → 413 `blob.quotaExceeded`.
fn quota_exceeded(owner_id: &str, projected: i64, quota: i64) -> ServerError {
    ServerError::Limit {
        kind: LimitKind::MaxBlobBytesPerPrincipal,
        detail: Value::Map(vec![
            ("limit".into(), Value::from("maxBlobBytesPerPrincipal")),
            ("configuredMax".into(), Value::from(quota)),
            ("actualValue".into(), Value::from(projected)),
            (
                "message".into(),
                Value::from(format!(
                    "blob quota exceeded for owner {owner_id}: {projected} > {quota}"
                )),
            ),
        ]),
    }
}

/// Read a header as a `&str` (lossy on non-UTF8 → `None`).
fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// Pull `?ownerId=` off the request URI's query string (the upload handler
/// consumes the body, so it reads the original URI directly rather than via a
/// `Query` extractor). Returns `None` when the param is absent. A small
/// self-contained `application/x-www-form-urlencoded` decode (`+`→space,
/// `%XX`→byte) keeps the crate free of a URL-parsing dependency.
fn owner_id_from_query(uri: &axum::http::Uri) -> Option<String> {
    let query = uri.query()?;
    query
        .split('&')
        .filter_map(|pair| pair.split_once('=').or(Some((pair, ""))))
        .find(|(key, _)| decode_form_component(key) == "ownerId")
        .map(|(_, value)| decode_form_component(value))
}

/// Decode one `x-www-form-urlencoded` component: `+` → space, `%XX` → byte,
/// invalid escapes pass through verbatim.
fn decode_form_component(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    #[allow(clippy::cast_possible_truncation)]
                    out.push((hi * 16 + lo) as u8);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            other => out.push(other),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// One [`BlobMetadata`] → its camelCase JSON (`mapBlobRow`, map 05 §3.2).
/// `storageKey` is emitted only when present (the TS mapper omits the key for
/// a NULL column). JSON key order is not load-bearing on the HTTP surface — the
/// crate's `serde_json` is the default (sorted) `Map`, consistent with the
/// sibling routes (`push.rs` / `share.rs`).
fn blob_metadata_json(metadata: &BlobMetadata) -> serde_json::Value {
    let mut value = json!({
        "tenantId": metadata.tenant_id,
        "appId": metadata.app_id,
        "blobId": metadata.blob_id,
        "ownerId": metadata.owner_id,
        "contentHash": metadata.content_hash,
        "byteLength": metadata.byte_length,
        "mimeType": metadata.mime_type,
        "createdAt": metadata.created_at,
    });
    if let Some(storage_key) = &metadata.storage_key
        && let Some(map) = value.as_object_mut()
    {
        map.insert("storageKey".into(), json!(storage_key));
    }
    value
}

/// One [`DerivativeRow`] → its camelCase JSON (map 05 §3.6). `metadata` is
/// emitted only when present (decoded from the row's JSON column).
fn derivative_row_json(row: &DerivativeRow) -> serde_json::Value {
    let mut value = json!({
        "parentBlobId": row.parent_blob_id,
        "derivativeId": row.derivative_id,
        "tenantId": row.tenant_id,
        "processorId": row.processor_id,
        "mimeType": row.mime_type,
        "byteLength": row.byte_length,
        "contentHash": row.content_hash,
        "storageKey": row.storage_key,
        "createdAt": row.created_at,
    });
    if let Some(metadata) = &row.metadata
        && let Some(map) = value.as_object_mut()
    {
        map.insert("metadata".into(), metadata.clone());
    }
    value
}

/// Map a non-specific store error onto the generic 400 `sync.protocolError`
/// envelope (the TS `sendErrorWithMetrics` default). Cross-app access denials
/// surface as 400 too (the TS `FrickCrossAppAccessError` → default mapping).
fn store_error(error: &StoreError) -> ServerError {
    ServerError::BadRequest {
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_content_hash_matches_node() {
        // `crypto.createHash("sha256").update("hello").digest("hex")` in node.
        assert_eq!(
            sha256_content_hash(b"hello"),
            "sha256-2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        // Empty input.
        assert_eq!(
            sha256_content_hash(b""),
            "sha256-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn validate_blob_content_checks_length_then_sha256_only() {
        // Length mismatch is always rejected.
        assert!(validate_blob_content("b", 3, "sha256-x", b"hello", "sha256-y").is_err());
        // sha256-prefixed stored hash must match.
        assert!(validate_blob_content("b", 5, "sha256-aaa", b"hello", "sha256-bbb").is_err());
        assert!(validate_blob_content("b", 5, "sha256-aaa", b"hello", "sha256-aaa").is_ok());
        // A non-sha256 stored hash is not checked (passes on any actual hash).
        assert!(validate_blob_content("b", 5, "crc32-1234", b"hello", "sha256-zzz").is_ok());
    }

    #[test]
    fn infer_mime_type_strips_params_and_defaults() {
        let mut headers = HeaderMap::new();
        assert_eq!(infer_mime_type(&headers), "application/octet-stream");
        headers.insert(
            header::CONTENT_TYPE,
            axum::http::HeaderValue::from_static("image/png; charset=binary"),
        );
        assert_eq!(infer_mime_type(&headers), "image/png");
        headers.insert(
            header::CONTENT_TYPE,
            axum::http::HeaderValue::from_static("   "),
        );
        assert_eq!(infer_mime_type(&headers), "application/octet-stream");
    }

    #[test]
    fn quota_configured_is_false_for_the_unlimited_default() {
        assert!(!quota_configured(9_007_199_254_740_991));
        assert!(quota_configured(1_000));
    }

    #[test]
    fn blob_metadata_json_carries_fields_and_storage_key_presence() {
        let with_key = BlobMetadata {
            blob_id: "b-1".into(),
            owner_id: "o-1".into(),
            content_hash: "sha256-x".into(),
            byte_length: 7,
            mime_type: "text/plain".into(),
            storage_key: Some("k".into()),
            tenant_id: "t-1".into(),
            app_id: "_default".into(),
            created_at: "2023-11-14T22:13:20.123Z".into(),
        };
        let json = blob_metadata_json(&with_key);
        let obj = json.as_object().unwrap();
        assert_eq!(obj["tenantId"], json!("t-1"));
        assert_eq!(obj["appId"], json!("_default"));
        assert_eq!(obj["blobId"], json!("b-1"));
        assert_eq!(obj["ownerId"], json!("o-1"));
        assert_eq!(obj["contentHash"], json!("sha256-x"));
        assert_eq!(obj["byteLength"], json!(7));
        assert_eq!(obj["mimeType"], json!("text/plain"));
        assert_eq!(obj["createdAt"], json!("2023-11-14T22:13:20.123Z"));
        assert_eq!(obj["storageKey"], json!("k"));

        // Absent storage_key omits the key entirely (TS mapper omits a NULL).
        let mut without_key = with_key;
        without_key.storage_key = None;
        let json = blob_metadata_json(&without_key);
        assert!(!json.as_object().unwrap().contains_key("storageKey"));
    }

    #[test]
    fn owner_id_from_query_decodes_and_misses() {
        let uri: axum::http::Uri = "/blobs/b/content?ownerId=user-1".parse().unwrap();
        assert_eq!(owner_id_from_query(&uri), Some("user-1".to_string()));

        let encoded: axum::http::Uri = "/blobs/b/content?ownerId=user%2D2&x=1".parse().unwrap();
        assert_eq!(owner_id_from_query(&encoded), Some("user-2".to_string()));

        let none: axum::http::Uri = "/blobs/b/content".parse().unwrap();
        assert_eq!(owner_id_from_query(&none), None);
    }
}
