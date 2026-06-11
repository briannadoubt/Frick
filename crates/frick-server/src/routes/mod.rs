//! Protected data-plane HTTP routes (FR-244): objects, streams, append,
//! signals, share/grants, push, projections.
//!
//! Every handler here follows the same preamble the TS `dispatchHttp` runs for
//! a protected route (`src/server.ts:1090-2779`): resolve the bearer principal
//! (401 on failure), run `ensureTenantAllowed`, then the authz decision, then
//! the facade call, then the response. All errors go through
//! [`crate::http::respond_error`].
//!
//! Determinism boundary (per the rewrite spec): the route layer is where time
//! and randomness enter. Handlers stamp `now_ms` from the system clock and mint
//! ids with `uuid`/`OsRng`, passing them down to the facade/store methods that
//! take `now_ms`/id parameters.

pub mod admin;
pub mod admin_push;
pub mod blobs;
pub mod inspect;
pub mod objects;
pub mod projections;
pub mod push;
pub mod search;
pub mod share;
pub mod signals;
pub mod streams;

use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::HeaderMap;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use frick_protocol::Value;
use rand::RngCore;

use crate::error::ServerError;
use crate::http::AppState;
use crate::principal::{DEFAULT_APP_ID, Principal};
use crate::session::ensure_tenant_allowed;

/// Merge every protected data-plane route onto one router
/// (`dispatchHttp`'s built-in route block, `src/server.ts:1745-2776`). The
/// integrator merges this into `boot::listen` alongside the public + auth
/// routers.
pub fn dataplane_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .merge(objects::router(state.clone()))
        .merge(streams::router(state.clone()))
        .merge(signals::router(state.clone()))
        .merge(share::router(state.clone()))
        .merge(push::router(state.clone()))
        .merge(projections::router(state.clone()))
        .merge(search::router(state.clone()))
        .merge(blobs::blobs_router(state))
}

/// The app id the data plane resolves to. The Rust port currently runs a
/// single app (the registry multi-app axis is FR-245), so storage always uses
/// [`DEFAULT_APP_ID`] (TS: `activeAppId` collapses to `_default` unless the
/// registry holds >1 app, `src/server.ts:1171-1172`).
pub(crate) const ACTIVE_APP_ID: &str = DEFAULT_APP_ID;

/// Shared protected-handler preamble: resolve the principal (401 on failure)
/// then run the tenant gate. Returns the authenticated [`Principal`] and the
/// `now_ms` the handler should thread through every downstream store call so
/// time enters exactly once per request.
pub(crate) async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(Principal, i64), ServerError> {
    let now = now_ms();
    let principal = crate::extract::require_principal(state, headers, now).await?;
    ensure_tenant_allowed(
        &state.store,
        &principal.tenant_id,
        state.config.implicit_tenant_creation,
        now,
    )
    .await?;
    Ok((principal, now))
}

/// Epoch milliseconds — the route-layer system-clock boundary.
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// A fresh per-request id for error envelopes (`details.routeCode`).
pub(crate) fn new_request_id() -> String {
    format!("req-{}", uuid::Uuid::new_v4())
}

/// `randomToken(byteLength)` (`src/server.ts`): base64url (no padding) of N
/// `OsRng` bytes. Used for invitation/grant ids and tokens.
pub(crate) fn random_token(byte_length: usize) -> String {
    let mut bytes = vec![0u8; byte_length];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Parse a request body's bytes as a self-describing msgpack [`Value`]. JSON
/// objects/arrays/scalars map onto the same dynamic value the store consumes,
/// so the wire stays MessagePack-compatible. An empty body parses as an empty
/// map (`{}`), matching the TS `readJsonBody` empty-body rule
/// (`src/server.ts:3420-3439`).
pub(crate) fn parse_body_value(bytes: &[u8]) -> Result<Value, ServerError> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(Value::Map(Vec::new()));
    }
    serde_json::from_slice::<Value>(bytes).map_err(|err| ServerError::BadRequest {
        message: format!("invalid JSON body: {err}"),
    })
}

/// `requireRecord(value, name)` (`src/server.ts:3452-3457`): the value must be
/// a JSON object (a msgpack map), else a 400 bad-request.
pub(crate) fn require_record(value: &Value, name: &str) -> Result<Value, ServerError> {
    match value {
        Value::Map(_) => Ok(value.clone()),
        _ => Err(ServerError::BadRequest {
            message: format!("{name} must be an object"),
        }),
    }
}

/// `requireString(value, name)` (`src/server.ts:3477-3482`): a non-empty string
/// field pulled out of a map body, else a 400 bad-request.
pub(crate) fn require_string(body: &Value, key: &str, name: &str) -> Result<String, ServerError> {
    match map_get(body, key).and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Ok(s.to_string()),
        _ => Err(ServerError::BadRequest {
            message: format!("{name} must be a non-empty string"),
        }),
    }
}

/// Look up a key in a msgpack map [`Value`]; `None` for a missing key or a
/// non-map value.
pub(crate) fn map_get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    let Value::Map(entries) = value else {
        return None;
    };
    entries
        .iter()
        .find(|(k, _)| k.as_str() == Some(key))
        .map(|(_, v)| v)
}

/// Strip the record envelope `id` key from a value map
/// (`withoutEnvelopeId`, `src/server.ts:3646-3649`).
pub(crate) fn without_envelope_id(value: &Value) -> Value {
    match value {
        Value::Map(entries) => Value::Map(
            entries
                .iter()
                .filter(|(k, _)| k.as_str() != Some("id"))
                .cloned()
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Convert a dynamic msgpack [`Value`] into a `serde_json::Value` so it can be
/// embedded in a JSON HTTP response body. rmpv's `Serialize` impl is
/// self-describing, so this is a faithful round-trip for the value shapes the
/// store returns.
pub(crate) fn value_to_json(value: &Value) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

/// MessagePack-encoded byte length of a value, used to enforce
/// `maxStreamAppendPayloadBytes` exactly as the TS `assertPayloadWithinLimit`
/// does (it `msgpackEncode`s the payload and measures `byteLength`,
/// `src/server.ts:3441-3450`).
pub(crate) fn msgpack_byte_len(value: &Value) -> usize {
    let mut bytes = Vec::new();
    // rmpv encoding is infallible for in-memory values; an error would only
    // arise from an IO sink, which a Vec never produces.
    if rmpv::encode::write_value(&mut bytes, value).is_ok() {
        bytes.len()
    } else {
        usize::MAX
    }
}
