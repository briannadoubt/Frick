//! `/objects` data-plane routes (`src/server.ts:1745-1860`):
//! list, optimistic-concurrency upsert, and idempotent delete.

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use frick_protocol::schema::FrickObjectMergePolicy;
use frick_protocol::{FrickErrorCode, FrickErrorEnvelope, Value};
use frick_store::StoreError;
use serde::Deserialize;
use serde_json::json;

use super::{
    ACTIVE_APP_ID, authenticate, new_request_id, parse_body_value, value_to_json,
    without_envelope_id,
};
use crate::authz::{Action, Decision, DenyReason, ResourceContext, decide_baseline};
use crate::error::ServerError;
use crate::http::{AppState, respond_error};
use crate::principal::Principal;

/// Routes for this surface.
pub fn router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/objects", get(list_objects))
        .route(
            "/objects/:type/:id",
            post(write_object).put(write_object).delete(delete_object),
        )
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    #[serde(rename = "type")]
    object_type: Option<String>,
}

/// `GET /objects?type=T` (`src/server.ts:1745-1760`): 400 `type_required`
/// without `type`; else `{schemaHash, type, data}` with the caller's
/// owner-visible rows.
async fn list_objects(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Response {
    let request_id = new_request_id();
    let (principal, _now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    // The `type_required` 400 is a bespoke body, not the standard envelope
    // (TS sends `{error:"type_required", message}` directly).
    let Some(object_type) = query.object_type.filter(|t| !t.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({
                "error": "type_required",
                "message": "Query parameter type is required",
            })),
        )
            .into_response();
    };

    // `listObjectsForUser` is currently a tenant+type list — per-record read
    // visibility is a TS pass-through (`isObjectVisibleToUser` returns true),
    // so the Rust port lists every owner row in the tenant/type/app.
    let rows = match state
        .store
        .objects()
        .list(&principal.tenant_id, &object_type, ACTIVE_APP_ID)
        .await
    {
        Ok(rows) => rows,
        Err(error) => return respond_error(&store_error(&error), &request_id),
    };
    let data: Vec<serde_json::Value> = rows.iter().map(value_to_json).collect();

    axum::Json(json!({
        "schemaHash": state.schema.hash,
        "type": object_type,
        "data": data,
    }))
    .into_response()
}

/// `POST|PUT /objects/:type/:id` (`src/server.ts:1795-1860`): the write
/// decision, `If-Match` optimistic concurrency, `upsert_object_with_policy`,
/// the `ETag` (nextVersion) header, and the 201/200 body. A version conflict
/// renders the inline 409 `storage.conflict` envelope with `ETag: actualVersion`.
async fn write_object(
    State(state): State<AppState>,
    Path((object_type, object_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let request_id = new_request_id();
    let (principal, _now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    let value = match parse_body_value(&body) {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };

    if let Err(error) = write_decision(&state, &principal, &object_type, &object_id).await {
        return respond_error(&error, &request_id);
    }

    let merge_policy = state.store.object_merge_policy(&object_type);
    let expected_version = match parse_if_match(&headers) {
        Ok(version) => version,
        Err(error) => return respond_error(&error, &request_id),
    };

    match state
        .store
        .upsert_object_with_policy(
            &principal.tenant_id,
            ACTIVE_APP_ID,
            &object_type,
            &object_id,
            &value,
            expected_version,
        )
        .await
    {
        Ok(result) => {
            // The written object echoes the record id plus the body minus its
            // envelope id (`{ id, ...withoutEnvelopeId(value) }`).
            let written = with_record_id(&object_id, &value);
            let status = if result.created {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            (
                status,
                [(header::ETAG, result.next_version.to_string())],
                axum::Json(json!({
                    "schemaHash": state.schema.hash,
                    "object": value_to_json(&written),
                    "version": result.next_version,
                    "previousVersion": result.previous_version,
                    "mergePolicy": merge_policy_str(merge_policy),
                })),
            )
                .into_response()
        }
        Err(StoreError::ObjectVersionConflict {
            tenant_id,
            object_type,
            object_id,
            expected_version,
            actual_version,
        }) => conflict_response(
            &state,
            &tenant_id,
            &object_type,
            &object_id,
            expected_version,
            actual_version,
            merge_policy,
        ),
        Err(error) => respond_error(&store_error(&error), &request_id),
    }
}

/// `DELETE /objects/:type/:id` (`src/server.ts:1762-1794`): reuses the write
/// decision; always 200 `{schemaHash, existed}` (idempotent — never 204/404).
async fn delete_object(
    State(state): State<AppState>,
    Path((object_type, object_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let request_id = new_request_id();
    let (principal, _now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    if let Err(error) = write_decision(&state, &principal, &object_type, &object_id).await {
        return respond_error(&error, &request_id);
    }

    match state
        .store
        .delete_object(
            &principal.tenant_id,
            &object_type,
            &object_id,
            ACTIVE_APP_ID,
        )
        .await
    {
        Ok(existed) => axum::Json(json!({
            "schemaHash": state.schema.hash,
            "existed": existed,
        }))
        .into_response(),
        Err(error) => respond_error(&store_error(&error), &request_id),
    }
}

/// The object write decision (`assertCanWriteObject`): the `object.write`
/// baseline (cross-tenant denied; in-tenant allowed since no object owner is
/// recorded at the baseline) followed by grant relaxation. App policy hooks are
/// FR-245 and not wired here, so the baseline + grant relaxation are the whole
/// pipeline.
async fn write_decision(
    state: &AppState,
    principal: &Principal,
    object_type: &str,
    object_id: &str,
) -> Result<(), ServerError> {
    let resource = ResourceContext {
        tenant_id: principal.tenant_id.clone(),
        owner_user_id: None,
    };
    let decision = decide_baseline(principal, Action::ObjectWrite, &resource);
    let decision =
        relax_object_write_with_grants(state, principal, object_type, object_id, decision).await?;
    decision_to_result(decision)
}

/// Object-record grant relaxation (`relaxWithGrants`, `authz.ts:486-521`): an
/// `object.write` deny for `notAuthorizedForResource`/`ownerMismatch` flips to
/// allow when the principal holds an active grant satisfying `"write"` on
/// `(recordType, recordId)`.
async fn relax_object_write_with_grants(
    state: &AppState,
    principal: &Principal,
    object_type: &str,
    object_id: &str,
    decision: Decision,
) -> Result<Decision, ServerError> {
    let Decision::Deny { reason, .. } = &decision else {
        return Ok(decision);
    };
    if !matches!(
        reason,
        DenyReason::NotAuthorizedForResource | DenyReason::OwnerMismatch
    ) {
        return Ok(decision);
    }
    let allowed = state
        .store
        .grants()
        .has_active_grant_for(
            &principal.tenant_id,
            &principal.user_id,
            object_type,
            object_id,
            "write",
        )
        .await
        .map_err(|_| ServerError::Internal)?;
    Ok(if allowed { Decision::Allow } else { decision })
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

/// `parseIfMatchHeader` (`src/server.ts:3629-3644`): `None` when absent or `*`;
/// a non-negative integer otherwise (the `W/` weak prefix and surrounding
/// quotes are stripped); a present-but-malformed value is a 400.
fn parse_if_match(headers: &HeaderMap) -> Result<Option<i64>, ServerError> {
    let Some(raw) = headers.get(header::IF_MATCH).and_then(|v| v.to_str().ok()) else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "*" {
        return Ok(None);
    }
    let unquoted = trimmed
        .strip_prefix("W/")
        .or_else(|| trimmed.strip_prefix("w/"))
        .unwrap_or(trimmed)
        .trim_matches('"');
    match unquoted.parse::<i64>() {
        Ok(version) if version >= 0 => Ok(Some(version)),
        _ => Err(ServerError::BadRequest {
            message: "If-Match must be a non-negative integer or \"*\"".into(),
        }),
    }
}

/// Re-attach the record id to a value map: `{ id, ...withoutEnvelopeId(value) }`.
fn with_record_id(object_id: &str, value: &Value) -> Value {
    let mut entries = vec![(Value::from("id"), Value::from(object_id))];
    if let Value::Map(rest) = without_envelope_id(value) {
        entries.extend(rest);
    }
    Value::Map(entries)
}

/// Build the inline 409 `storage.conflict` response (`src/server.ts:1827-1855`):
/// the envelope carries `{tenantId, objectType, objectId, expectedVersion?,
/// actualVersion, mergePolicy}` plus the active schema hash/revision, and the
/// `ETag` header is the actual on-disk version.
fn conflict_response(
    state: &AppState,
    tenant_id: &str,
    object_type: &str,
    object_id: &str,
    expected_version: Option<i64>,
    actual_version: i64,
    merge_policy: FrickObjectMergePolicy,
) -> Response {
    let message = StoreError::ObjectVersionConflict {
        tenant_id: tenant_id.to_string(),
        object_type: object_type.to_string(),
        object_id: object_id.to_string(),
        expected_version,
        actual_version,
    }
    .to_string();

    let mut details = vec![
        (Value::from("tenantId"), Value::from(tenant_id)),
        (Value::from("objectType"), Value::from(object_type)),
        (Value::from("objectId"), Value::from(object_id)),
    ];
    if let Some(expected) = expected_version {
        details.push((Value::from("expectedVersion"), Value::from(expected)));
    }
    details.push((Value::from("actualVersion"), Value::from(actual_version)));
    details.push((
        Value::from("mergePolicy"),
        Value::from(merge_policy_str(merge_policy)),
    ));

    let envelope = FrickErrorEnvelope {
        code: FrickErrorCode::StorageConflict,
        message,
        request_id: "object_write_conflict".to_string(),
        retryable: false,
        details: Some(Value::Map(details)),
        schema_hash: Some(state.schema.hash.clone()),
        schema_revision: Some(state.schema.schema_revision),
    };
    let body = json!({
        "error": envelope,
        "code": envelope.code.as_str(),
        "message": envelope.message,
        "requestId": envelope.request_id,
        "retryable": envelope.retryable,
    });
    (
        StatusCode::CONFLICT,
        [(header::ETAG, actual_version.to_string())],
        axum::Json(body),
    )
        .into_response()
}

/// Wire string for a merge policy (`lastWriteWins` / `versionPrecondition`).
fn merge_policy_str(policy: FrickObjectMergePolicy) -> &'static str {
    match policy {
        FrickObjectMergePolicy::LastWriteWins => "lastWriteWins",
        FrickObjectMergePolicy::VersionPrecondition => "versionPrecondition",
    }
}

/// Map a non-conflict store error onto the generic protocol-error envelope
/// (the TS `sendErrorWithMetrics` default). The codec "Unknown object/field"
/// errors are caller errors → 400.
fn store_error(error: &StoreError) -> ServerError {
    ServerError::BadRequest {
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::map_get;
    use super::*;
    use axum::http::{HeaderMap, HeaderValue};

    #[test]
    fn if_match_parsing() {
        assert_eq!(parse_if_match(&HeaderMap::new()).unwrap(), None);

        let mut headers = HeaderMap::new();
        headers.insert(header::IF_MATCH, HeaderValue::from_static("*"));
        assert_eq!(parse_if_match(&headers).unwrap(), None);

        headers.insert(header::IF_MATCH, HeaderValue::from_static("\"3\""));
        assert_eq!(parse_if_match(&headers).unwrap(), Some(3));

        headers.insert(header::IF_MATCH, HeaderValue::from_static("7"));
        assert_eq!(parse_if_match(&headers).unwrap(), Some(7));

        headers.insert(header::IF_MATCH, HeaderValue::from_static("W/\"5\""));
        assert_eq!(parse_if_match(&headers).unwrap(), Some(5));

        headers.insert(header::IF_MATCH, HeaderValue::from_static("nope"));
        assert!(parse_if_match(&headers).is_err());

        headers.insert(header::IF_MATCH, HeaderValue::from_static("-1"));
        assert!(parse_if_match(&headers).is_err());
    }

    #[test]
    fn with_record_id_strips_then_reattaches() {
        let value = Value::Map(vec![
            ("id".into(), "old".into()),
            ("title".into(), "hello".into()),
        ]);
        let written = with_record_id("new", &value);
        let Value::Map(entries) = &written else {
            panic!("map")
        };
        assert_eq!(entries[0].0.as_str(), Some("id"));
        assert_eq!(entries[0].1.as_str(), Some("new"));
        // Exactly one `id` key, and the body value is preserved.
        assert_eq!(
            entries
                .iter()
                .filter(|(k, _)| k.as_str() == Some("id"))
                .count(),
            1
        );
        assert!(map_get(&written, "title").is_some());
    }
}
