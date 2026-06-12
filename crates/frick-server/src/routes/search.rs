//! `POST /search` (map 02:288; `src/server.ts:2187-2246`).
//!
//! Body `{index, q, filter?, limit?}`. The route validates the query and
//! filter against the configured limits, resolves the index in the shared
//! [`SearchRegistry`], queries the store's FTS adapter (tenant-scoped), then —
//! for non-admin callers — post-filters each hit by the visibility of its
//! source record before stripping the reserved `__frickSource*` fields and
//! returning `{schemaHash, index, hits, total}`.
//!
//! ## Load-bearing parity (map 02 §13.4/5)
//!
//! A non-admin query asks the adapter for `MAX_SEARCH_LIMIT` hits, post-filters
//! them by per-hit source visibility, then slices to the caller's `limit`
//! AFTER filtering — so a page is never short just because some hits were
//! authz-filtered out. `total` for a non-admin is the count of VISIBLE hits,
//! not the adapter's raw total. An admin query trusts the adapter's `limit`
//! and `total` directly.
//!
//! ## Error mapping
//!
//! - validation failures (q too large, malformed filter, reserved filter key,
//!   bad limit) → 400 `sync.protocolError` with `details.reason =
//!   "invalidSearchQuery"`.
//! - unknown index → 404 `storage.notFound` (`SearchIndexNotFound`).
//! - any adapter/store error → 400 `invalidSearchQuery` (the wrapped adapter
//!   error is not exposed — SQLite FTS parser details are implementation noise).

use std::collections::BTreeMap;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use frick_protocol::Value;
use frick_store::{
    DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, SearchFilterValue, SearchHit, SearchQueryResult,
};
use serde_json::{Value as JsonValue, json};

use super::{ActiveApp, authenticate, map_get, new_request_id, parse_body_value, require_string};
use crate::authz::{Action, Decision, ResourceContext, decide_baseline};
use crate::error::ServerError;
use crate::http::{AppState, respond_error};
use crate::principal::Principal;
use crate::search::{SearchSource, is_reserved_search_field, strip_search_source_fields};

/// Routes for this surface.
pub fn router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/search", post(search))
        .with_state(state)
}

/// `POST /search` (`src/server.ts:2187-2246`).
async fn search(
    State(state): State<AppState>,
    active: ActiveApp,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let request_id = new_request_id();
    let (principal, _now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    let parsed = match parse_request(&state, &body) {
        Ok(parsed) => parsed,
        Err(error) => return respond_error(&error, &request_id),
    };

    // Resolve the index → its source (unknown index is a 404, like TS
    // `SearchIndexNotFoundError`). The source kind drives the per-hit
    // visibility post-filter. The index registry is the active app's per-app
    // registry on a multi-app server, else the shared `_default` one.
    let Some(source) = active.search(&state).source_of(&parsed.index) else {
        return respond_error(
            &ServerError::SearchIndexNotFound {
                index: parsed.index,
            },
            &request_id,
        );
    };

    // Query-level authz (`assertCanQuerySearch`): the Rust baseline allows
    // `search.query` within the tenant; an app policy-hook seam (FR-71) will
    // tighten this once hooks land. A deny short-circuits before the adapter.
    if let Decision::Deny {
        reason,
        public_message,
    } = decide_baseline(
        &principal,
        Action::SearchQuery,
        &ResourceContext {
            tenant_id: principal.tenant_id.clone(),
            owner_user_id: None,
        },
    ) {
        return respond_error(
            &ServerError::Authorization {
                message: public_message,
                reason: Some(reason.as_str().to_string()),
            },
            &request_id,
        );
    }

    // Non-admin queries over-fetch (MAX) so the post-authz slice still fills a
    // page; admin queries trust the caller's limit (§13.5 parity).
    let adapter_limit = if principal.is_admin() {
        parsed.limit
    } else {
        MAX_SEARCH_LIMIT
    };

    // Scope the storage index name by the resolved app (multi-app only) so this
    // query can only match the querying app's FTS rows — the same namespacing
    // the search projector applies on write (FR-277). Single-app is unchanged.
    let scoped_index = state.apps.scoped_index_name(active.app_id(), &parsed.index);
    // Adapter/store errors are deliberately wrapped — the FTS parser detail is
    // not exposed (TS `InvalidSearchQueryError`).
    let Ok(result) = state
        .store
        .search_query(
            &principal.tenant_id,
            &scoped_index,
            &parsed.q,
            &parsed.filter,
            adapter_limit,
        )
        .await
    else {
        return respond_error(&invalid_search_query(), &request_id);
    };

    let visible =
        filter_result_for_principal(&state, &principal, &source, result, active.app_id()).await;

    // Slice to the caller's limit AFTER authz filtering (non-admin parity);
    // admin already got exactly `limit` from the adapter.
    let limit = parsed.limit as usize;
    let hits: Vec<JsonValue> = visible.hits.iter().take(limit).map(hit_to_json).collect();

    axum::Json(json!({
        "schemaHash": state.schema.hash,
        "index": parsed.index,
        "hits": hits,
        "total": visible.total,
    }))
    .into_response()
}

/// The validated request body.
struct SearchRequest {
    index: String,
    q: String,
    filter: BTreeMap<String, SearchFilterValue>,
    limit: u32,
}

/// Parse + validate `{index, q, filter?, limit?}` against the configured
/// limits. Validation failures surface as `invalidSearchQuery` (400).
fn parse_request(state: &AppState, body: &[u8]) -> Result<SearchRequest, ServerError> {
    let value = parse_body_value(body).map_err(|_| invalid_search_query())?;
    let index = require_string(&value, "index", "index").map_err(|_| invalid_search_query())?;
    let q = require_string(&value, "q", "q").map_err(|_| invalid_search_query())?;

    // q byte length cap (`maxSearchQueryBytes`).
    let max_q = state.config.limits.max_search_query_bytes;
    if i64::try_from(q.len()).unwrap_or(i64::MAX) > max_q {
        return Err(invalid_search_query());
    }

    let filter = parse_filter(map_get(&value, "filter"), &state.config.limits)?;
    let limit = parse_limit(map_get(&value, "limit"))?;

    Ok(SearchRequest {
        index,
        q,
        filter,
        limit,
    })
}

/// Parse the optional flat `string|number` filter map (`parseSearchFilter`):
/// at most `maxSearchFilterFields` entries; each key matches
/// `/^[A-Za-z0-9_-]+$/` and is `<= maxSearchFilterKeyBytes`; reserved
/// `__frickSource*` keys are rejected; each value is a string/finite-number
/// `<= maxSearchFilterValueBytes`.
fn parse_filter(
    value: Option<&Value>,
    limits: &crate::config::FrickLimits,
) -> Result<BTreeMap<String, SearchFilterValue>, ServerError> {
    let mut out = BTreeMap::new();
    let Some(value) = value else {
        return Ok(out);
    };
    // A nil/absent filter is the empty filter; anything else must be a map.
    if matches!(value, Value::Nil) {
        return Ok(out);
    }
    let Value::Map(entries) = value else {
        return Err(invalid_search_query());
    };
    if i64::try_from(entries.len()).unwrap_or(i64::MAX) > limits.max_search_filter_fields {
        return Err(invalid_search_query());
    }
    for (key, raw) in entries {
        let Some(key) = key.as_str() else {
            return Err(invalid_search_query());
        };
        if i64::try_from(key.len()).unwrap_or(i64::MAX) > limits.max_search_filter_key_bytes {
            return Err(invalid_search_query());
        }
        if !is_valid_filter_key(key) {
            return Err(invalid_search_query());
        }
        if is_reserved_search_field(key) {
            return Err(invalid_search_query());
        }
        let parsed = parse_filter_value(raw, limits.max_search_filter_value_bytes)?;
        out.insert(key.to_string(), parsed);
    }
    Ok(out)
}

/// Coerce a filter value to a string or finite number, enforcing the
/// per-value byte cap (the cap applies to the stringified form, matching TS
/// `Buffer.byteLength(String(value))`).
fn parse_filter_value(raw: &Value, max_bytes: i64) -> Result<SearchFilterValue, ServerError> {
    let parsed = match raw {
        Value::String(s) => {
            let Some(text) = s.as_str() else {
                return Err(invalid_search_query());
            };
            SearchFilterValue::Text(text.to_string())
        }
        Value::Integer(i) => {
            #[allow(clippy::cast_precision_loss)]
            let number = i.as_i64().map(|n| n as f64).or_else(|| i.as_f64());
            let Some(number) = number else {
                return Err(invalid_search_query());
            };
            SearchFilterValue::Number(number)
        }
        Value::F32(f) => SearchFilterValue::Number(f64::from(*f)),
        Value::F64(f) => SearchFilterValue::Number(*f),
        _ => return Err(invalid_search_query()),
    };
    let stringified = match &parsed {
        SearchFilterValue::Text(text) => text.clone(),
        SearchFilterValue::Number(number) => {
            if !number.is_finite() {
                return Err(invalid_search_query());
            }
            number.to_string()
        }
    };
    if i64::try_from(stringified.len()).unwrap_or(i64::MAX) > max_bytes {
        return Err(invalid_search_query());
    }
    Ok(parsed)
}

/// Parse the optional `limit` (positive number; clamped to
/// `MAX_SEARCH_LIMIT`; default `DEFAULT_SEARCH_LIMIT`). Integers are read
/// natively; floats are floored. Non-finite / non-positive values are rejected.
fn parse_limit(value: Option<&Value>) -> Result<u32, ServerError> {
    let Some(value) = value.filter(|v| !matches!(v, Value::Nil)) else {
        return Ok(DEFAULT_SEARCH_LIMIT);
    };
    // The clamped floor as a u64; `None` ⇒ a non-finite/non-positive value.
    let floored: Option<u64> = match value {
        Value::Integer(i) => i
            .as_i64()
            .filter(|n| *n > 0)
            .map(u64::try_from)
            .and_then(Result::ok),
        Value::F32(f) => positive_float_floor(f64::from(*f)),
        Value::F64(f) => positive_float_floor(*f),
        _ => return Err(invalid_search_query()),
    };
    let Some(floored) = floored else {
        return Err(invalid_search_query());
    };
    Ok(u32::try_from(floored.min(u64::from(MAX_SEARCH_LIMIT))).unwrap_or(MAX_SEARCH_LIMIT))
}

/// Floor a strictly-positive finite float to a `u64`; `None` otherwise.
fn positive_float_floor(value: f64) -> Option<u64> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some(value.floor() as u64)
}

/// `/^[A-Za-z0-9_-]+$/` — non-empty, ASCII alnum / `_` / `-`.
fn is_valid_filter_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Post-filter a result for the principal (`filterSearchResultForPrincipal`):
/// admins see every hit (reserved fields stripped, adapter `total`); a
/// non-admin keeps only hits whose source record is visible to them, and
/// `total` becomes the visible count.
async fn filter_result_for_principal(
    state: &AppState,
    principal: &Principal,
    source: &SearchSource,
    result: SearchQueryResult,
    app_id: &str,
) -> SearchQueryResult {
    if principal.is_admin() {
        return SearchQueryResult {
            hits: result.hits,
            total: result.total,
        };
    }
    let mut visible = Vec::new();
    for hit in result.hits {
        if hit_is_visible(state, principal, source, &hit, app_id).await {
            visible.push(hit);
        }
    }
    let total = visible.len() as u64;
    SearchQueryResult {
        hits: visible,
        total,
    }
}

/// Whether `hit`'s source record is visible to `principal`. Object hits re-read
/// the source object in the principal's tenant and run the object-read baseline
/// (a missing object hides the hit); stream hits run the stream-read baseline;
/// projection hits stay deny-by-default (no policy-hook/grant seam yet).
async fn hit_is_visible(
    state: &AppState,
    principal: &Principal,
    source: &SearchSource,
    hit: &SearchHit,
    app_id: &str,
) -> bool {
    match source {
        SearchSource::Object { type_name } => {
            let object_id = source_id(hit).unwrap_or_else(|| hit.doc_id.clone());
            // A missing object (e.g. deleted) hides the hit; a read error fails
            // closed.
            let Ok(Some(object)) = state
                .store
                .objects()
                .read(&principal.tenant_id, type_name, &object_id, app_id)
                .await
            else {
                return false;
            };
            let owner = object_owner(&object);
            decide_baseline(
                principal,
                Action::ObjectRead,
                &ResourceContext {
                    tenant_id: principal.tenant_id.clone(),
                    owner_user_id: owner,
                },
            )
            .is_allow()
        }
        SearchSource::Stream { .. } => decide_baseline(
            principal,
            Action::StreamRead,
            &ResourceContext {
                tenant_id: principal.tenant_id.clone(),
                owner_user_id: None,
            },
        )
        .is_allow(),
        // Projection hits are deny-by-default for search until the policy-hook /
        // grant-cascade seam lands (TS keeps these closed too without a hook).
        SearchSource::Projection { .. } => false,
    }
}

/// The reserved `__frickSourceId` from a hit (the source record id captured at
/// index time), used to re-read the source object for visibility.
fn source_id(hit: &SearchHit) -> Option<String> {
    hit.fields
        .get(crate::search::SOURCE_ID_FIELD)
        .and_then(JsonValue::as_str)
        .map(str::to_string)
}

/// The owner user id recorded on an object, for the owner-scoped read baseline.
/// Mirrors the object store's owner convention (`ownerId` / `ownerUserId`); a
/// missing owner yields `None` (baseline allows within the tenant).
fn object_owner(object: &Value) -> Option<String> {
    for key in ["ownerId", "ownerUserId"] {
        if let Some(owner) = map_get(object, key).and_then(Value::as_str)
            && !owner.is_empty()
        {
            return Some(owner.to_string());
        }
    }
    None
}

/// Render a hit as the wire JSON `{docId, fields}` with the reserved source
/// fields stripped (`stripSearchSourceFields`).
fn hit_to_json(hit: &SearchHit) -> JsonValue {
    let fields = strip_search_source_fields(&hit.fields);
    json!({
        "docId": hit.doc_id,
        "fields": JsonValue::Object(fields),
    })
}

/// A `400 sync.protocolError` carrying `details.reason = "invalidSearchQuery"`
/// (TS `InvalidSearchQueryError`). Used for every validation failure and for a
/// wrapped adapter error.
fn invalid_search_query() -> ServerError {
    ServerError::InvalidSearchQuery
}
