//! `/streams` reads, the cursor head probe, and `/append`
//! (`src/server.ts:2636-2776`).

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use frick_protocol::{StreamEventInput, Value};
use frick_store::StoreError;
use frick_store::stores::stream::StoredEvent;
use serde_json::json;

use super::{
    ActiveApp, authenticate, map_get, msgpack_byte_len, new_request_id, parse_body_value,
    require_record, require_string, value_to_json,
};
use crate::authz::{
    Action, Decision, DenyReason, PolicyInput, PolicyResource, ResourceContext, apply_policy_hooks,
    decide_baseline,
};
use crate::error::{LimitKind, ServerError};
use crate::http::{AppState, respond_error};
use crate::principal::Principal;

/// Routes for this surface.
pub fn router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/streams/:stream/:key", get(read_stream))
        .route("/streams/:stream/:key/cursor", get(stream_cursor))
        .route("/append", post(append))
        .with_state(state)
}

/// `GET /streams/:stream/:key` (`src/server.ts:2659-2733`): `?since=` strict
/// cursor read (400 `stream.invalidCursor` on a bad value) → `{events}`;
/// `?before=` backward page; else forward page (reads `limit+1` to compute
/// `hasMore`).
async fn read_stream(
    State(state): State<AppState>,
    active: ActiveApp,
    Path((stream, key)): Path<(String, String)>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let request_id = new_request_id();
    let (principal, _now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };
    if let Err(error) = stream_read_decision(&state, &principal, &key).await {
        return respond_error(&error, &request_id);
    }

    let max_page = state.config.limits.max_stream_page_size;
    let app_id = active.app_id();

    if params.contains_key("since") {
        since_page(
            &state,
            &principal.tenant_id,
            &stream,
            &key,
            &params,
            &request_id,
            max_page,
            app_id,
        )
        .await
    } else if params.contains_key("before") {
        before_page(
            &state,
            &principal.tenant_id,
            &stream,
            &key,
            &params,
            &request_id,
            max_page,
            app_id,
        )
        .await
    } else {
        forward_page(
            &state,
            &principal.tenant_id,
            &stream,
            &key,
            &params,
            &request_id,
            max_page,
            app_id,
        )
        .await
    }
}

/// `?since=<seq>` strict cursor read → `{events}` (400 on a bad cursor).
#[allow(clippy::too_many_arguments)]
async fn since_page(
    state: &AppState,
    tenant_id: &str,
    stream: &str,
    key: &str,
    params: &HashMap<String, String>,
    request_id: &str,
    max_page: i64,
    app_id: &str,
) -> Response {
    let Some(since) = params.get("since").and_then(|raw| parse_cursor(raw)) else {
        return respond_error(&ServerError::InvalidStreamCursor, request_id);
    };
    let limit = parse_stream_page_limit(params.get("limit"), max_page, max_page);
    match state
        .store
        .streams()
        .read(tenant_id, stream, key, since, Some(limit), app_id)
        .await
    {
        Ok(events) => axum::Json(json!({ "events": events_json(&events) })).into_response(),
        Err(error) => respond_error(&store_error(&error), request_id),
    }
}

/// `?before=<seq>` backward page → `{schemaHash, stream, key, data, cursor,
/// hasMore:false}`.
#[allow(clippy::too_many_arguments)]
async fn before_page(
    state: &AppState,
    tenant_id: &str,
    stream: &str,
    key: &str,
    params: &HashMap<String, String>,
    request_id: &str,
    max_page: i64,
    app_id: &str,
) -> Response {
    let before = params
        .get("before")
        .and_then(|raw| raw.parse::<i64>().ok())
        .unwrap_or(i64::MAX);
    let limit = parse_stream_page_limit(params.get("limit"), 50, max_page.min(500));
    match state
        .store
        .streams()
        .read_before(tenant_id, stream, key, before, limit, app_id)
        .await
    {
        Ok(events) => {
            let cursor = events.last().map_or(0, |last| last.event.sequence);
            page_response(state, stream, key, &events, cursor, false)
        }
        Err(error) => respond_error(&store_error(&error), request_id),
    }
}

/// Forward page (`?after=` + `?limit=`): reads `limit+1` to compute `hasMore`.
#[allow(clippy::too_many_arguments)]
async fn forward_page(
    state: &AppState,
    tenant_id: &str,
    stream: &str,
    key: &str,
    params: &HashMap<String, String>,
    request_id: &str,
    max_page: i64,
    app_id: &str,
) -> Response {
    let after = params
        .get("after")
        .and_then(|raw| raw.parse::<i64>().ok())
        .unwrap_or(0);
    let limit = parse_stream_page_limit(params.get("limit"), max_page, max_page);
    match state
        .store
        .streams()
        .read(tenant_id, stream, key, after, Some(limit + 1), app_id)
        .await
    {
        Ok(mut page) => {
            let has_more = i64::try_from(page.len()).unwrap_or(i64::MAX) > limit;
            page.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
            let cursor = page.last().map_or(after, |last| last.event.sequence);
            page_response(state, stream, key, &page, cursor, has_more)
        }
        Err(error) => respond_error(&store_error(&error), request_id),
    }
}

/// The standard page body `{schemaHash, stream, key, data, cursor, hasMore}`.
fn page_response(
    state: &AppState,
    stream: &str,
    key: &str,
    events: &[StoredEvent],
    cursor: i64,
    has_more: bool,
) -> Response {
    axum::Json(json!({
        "schemaHash": state.schema.hash,
        "stream": stream,
        "key": key,
        "data": events_json(events),
        "cursor": cursor,
        "hasMore": has_more,
    }))
    .into_response()
}

/// `GET /streams/:stream/:key/cursor` (`src/server.ts:2655-2658`): the cheap
/// head probe → `{headSequence, count}`.
async fn stream_cursor(
    State(state): State<AppState>,
    active: ActiveApp,
    Path((stream, key)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let request_id = new_request_id();
    let (principal, _now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };
    if let Err(error) = stream_read_decision(&state, &principal, &key).await {
        return respond_error(&error, &request_id);
    }

    match state
        .store
        .streams()
        .head(&principal.tenant_id, &stream, &key, active.app_id())
        .await
    {
        Ok(head) => axum::Json(json!({
            "headSequence": head.head_sequence,
            "count": head.count,
        }))
        .into_response(),
        Err(error) => respond_error(&store_error(&error), &request_id),
    }
}

/// `POST /append` (`src/server.ts:2740-2776`): payload-size guard, the append
/// decision, then `append_event` (idempotent by `(tenant, replica, requestId)`).
/// 200 `{ok, event}`; the store write listener fans out — no inline broadcast.
async fn append(
    State(state): State<AppState>,
    active: ActiveApp,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let request_id = new_request_id();
    let (principal, _now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    let parsed = match parse_body_value(&body) {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let stream = match require_string(&parsed, "stream", "stream") {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let key = match require_string(&parsed, "key", "key") {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let event = match require_string(&parsed, "event", "event") {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let payload = match map_get(&parsed, "payload")
        .ok_or_else(|| ServerError::BadRequest {
            message: "payload must be an object".into(),
        })
        .and_then(|value| require_record(value, "payload"))
    {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };

    // Payload size guard: msgpack-encoded byte length ≤ maxStreamAppendPayloadBytes.
    let payload_bytes = msgpack_byte_len(&payload);
    let max_bytes = state.config.limits.max_stream_append_payload_bytes;
    if i64::try_from(payload_bytes).unwrap_or(i64::MAX) > max_bytes {
        return respond_error(
            &ServerError::Limit {
                kind: LimitKind::MaxStreamAppendPayloadBytes,
                detail: Value::Map(vec![
                    (Value::from("reason"), Value::from("payloadTooLarge")),
                    (
                        Value::from("limit"),
                        Value::from("maxStreamAppendPayloadBytes"),
                    ),
                    (
                        Value::from("actualValue"),
                        Value::from(i64::try_from(payload_bytes).unwrap_or(i64::MAX)),
                    ),
                    (Value::from("configuredMax"), Value::from(max_bytes)),
                ]),
            },
            &request_id,
        );
    }

    let append_request_id = match require_string(&parsed, "requestId", "requestId") {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    if let Err(error) = append_decision(&state, &principal, &stream, &key, &event, &payload).await {
        return respond_error(&error, &request_id);
    }

    match state
        .store
        .append_event(
            &principal.tenant_id,
            &stream,
            &key,
            &principal.replica_id,
            &append_request_id,
            &event,
            &payload,
            active.app_id(),
        )
        .await
    {
        Ok(result) => axum::Json(json!({
            "ok": true,
            "event": event_json(&result.event),
        }))
        .into_response(),
        Err(error) => respond_error(&store_error(&error), &request_id),
    }
}

/// The `stream.read` decision (`assertCanSubscribe(stream)`): the baseline
/// (cross-tenant denied, in-tenant allowed) plus the read-only cascade grant
/// relaxation keyed on `streamId`.
async fn stream_read_decision(
    state: &AppState,
    principal: &Principal,
    key: &str,
) -> Result<(), ServerError> {
    let resource = ResourceContext {
        tenant_id: principal.tenant_id.clone(),
        owner_user_id: None,
    };
    let decision = decide_baseline(principal, Action::StreamRead, &resource);
    let decision = relax_cascade(state, principal, key, decision).await?;
    decision_to_result(decision)
}

/// The `stream.append` decision (`assertCanAppend`): the baseline, then app
/// policy hooks (FR-296) — the read-only cascade never relaxes append, so
/// baseline → hooks is the whole pipeline. `payload` is the event record, so a
/// hook can gate on field values; `event` is the event type, letting a hook
/// gate by event type (e.g. "only admins may append `MessageSent`").
async fn append_decision(
    state: &AppState,
    principal: &Principal,
    stream: &str,
    key: &str,
    event: &str,
    payload: &Value,
) -> Result<(), ServerError> {
    let resource = ResourceContext {
        tenant_id: principal.tenant_id.clone(),
        owner_user_id: None,
    };
    let decision = decide_baseline(principal, Action::StreamAppend, &resource);
    let decision = apply_policy_hooks(
        decision,
        &PolicyInput {
            principal,
            action: Action::StreamAppend,
            resource: PolicyResource {
                kind: "stream",
                name: Some(stream.to_string()),
                key: Some(key.to_string()),
                event: Some(event.to_string()),
                owner_id: None,
                tenant_id: principal.tenant_id.clone(),
            },
            context: Some(payload),
        },
        &state.policy_hooks,
    )
    .await;
    decision_to_result(decision)
}

/// Cascade grant relaxation (`relaxWithCascadeGrants`, `authz.ts:549-587`): a
/// `stream.read` deny for an ownership/membership reason flips to allow when
/// the principal holds an active read-satisfying grant on any record whose id
/// equals the stream key.
async fn relax_cascade(
    state: &AppState,
    principal: &Principal,
    key: &str,
    decision: Decision,
) -> Result<Decision, ServerError> {
    let Decision::Deny { reason, .. } = &decision else {
        return Ok(decision);
    };
    if !matches!(
        reason,
        DenyReason::NotAuthorizedForResource | DenyReason::OwnerMismatch | DenyReason::NotMember
    ) {
        return Ok(decision);
    }
    let allowed = state
        .store
        .grants()
        .has_active_grant_for_record_id(&principal.tenant_id, &principal.user_id, key)
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

/// `parseStreamPageLimit` (`src/server.ts:5177-5187`): `max(1, min(max,
/// floor(default)))` for a missing / non-positive value, else `max(1, min(max,
/// floor(parsed)))`.
fn parse_stream_page_limit(value: Option<&String>, default_limit: i64, configured_max: i64) -> i64 {
    let max = configured_max.max(1);
    match value.and_then(|raw| raw.parse::<i64>().ok()) {
        Some(parsed) if parsed > 0 => parsed.min(max).max(1),
        _ => default_limit.min(max).max(1),
    }
}

/// `?since=` cursor parsing: a non-negative integer, else invalid.
fn parse_cursor(raw: &str) -> Option<i64> {
    raw.parse::<i64>().ok().filter(|v| *v >= 0)
}

/// Serialize a list of stored events to the camelCase wire shape.
fn events_json(events: &[StoredEvent]) -> Vec<serde_json::Value> {
    events.iter().map(event_json).collect()
}

/// One stored event → `{stream, streamId, sequence, eventId, event, payload,
/// tenantId, appId}` (the TS `StoredEvent` JSON shape). Shared with the
/// sealed-sender delivery route so both append surfaces answer identically.
pub(crate) fn event_json(stored: &StoredEvent) -> serde_json::Value {
    let StreamEventInput {
        stream,
        stream_id,
        sequence,
        event_id,
        event,
        payload,
    } = &stored.event;
    json!({
        "stream": stream,
        "streamId": stream_id,
        "sequence": sequence,
        "eventId": event_id,
        "event": event,
        "payload": value_to_json(payload),
        "tenantId": stored.tenant_id,
        "appId": stored.app_id,
    })
}

fn store_error(error: &StoreError) -> ServerError {
    ServerError::BadRequest {
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_limit_clamps_and_defaults() {
        // Missing → default, clamped to max.
        assert_eq!(parse_stream_page_limit(None, 50, 500), 50);
        assert_eq!(parse_stream_page_limit(None, 9999, 500), 500);
        // Provided positive → clamped to max.
        assert_eq!(
            parse_stream_page_limit(Some(&"10".to_string()), 50, 500),
            10
        );
        assert_eq!(
            parse_stream_page_limit(Some(&"9999".to_string()), 50, 500),
            500
        );
        // Non-positive / garbage → default.
        assert_eq!(parse_stream_page_limit(Some(&"0".to_string()), 50, 500), 50);
        assert_eq!(parse_stream_page_limit(Some(&"x".to_string()), 50, 500), 50);
    }

    #[test]
    fn cursor_rejects_negative_and_garbage() {
        assert_eq!(parse_cursor("0"), Some(0));
        assert_eq!(parse_cursor("12"), Some(12));
        assert_eq!(parse_cursor("-1"), None);
        assert_eq!(parse_cursor("abc"), None);
    }
}
