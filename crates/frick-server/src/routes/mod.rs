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

use axum::extract::{FromRequestParts, Request};
use axum::http::HeaderMap;
use axum::http::request::Parts;
use axum::middleware::Next;
use axum::response::Response;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use frick_protocol::Value;
use rand::RngCore;

use crate::error::ServerError;
use crate::http::AppState;
use crate::principal::{DEFAULT_APP_ID, Principal};
use crate::projections::ProjectionRegistry;
use crate::search::SearchRegistry;
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

/// The fallback storage app id used by surfaces that are not URL-app-scoped
/// (e.g. the diagnostics probe). On a single-app server every storage call uses
/// this id (TS: `activeAppId` collapses to `_default` unless the registry holds
/// more than one app, `src/server.ts:1171-1172`); multi-app data-plane handlers
/// resolve the active app per request via [`ActiveApp`] instead.
pub(crate) const ACTIVE_APP_ID: &str = DEFAULT_APP_ID;

/// The active-app resolution stamped onto each request's extensions by
/// [`app_resolution_layer`] (FR-277). Carries the storage `app_id` the data
/// plane uses for every store call plus the resolved registry id so per-app
/// projection/search lookups can find the right registry. On a single-app
/// server both collapse to `_default` and the storage id stays pinned there, so
/// existing behavior is byte-for-byte unchanged.
#[derive(Debug, Clone)]
pub(crate) struct ResolvedApp {
    /// The storage partition id for store calls: the resolved app id on a
    /// genuine multi-app server, else `_default`
    /// ([`crate::apps::FrickAppRegistry::storage_app_id`]).
    storage_app_id: String,
    /// The resolved app's registry id (the matched app on multi-app, else
    /// `_default`). Drives the per-app projection/search registry lookup.
    resolved_id: String,
}

impl ResolvedApp {
    /// The single-app default: storage + registry both pinned to `_default`.
    fn default_app() -> Self {
        Self {
            storage_app_id: DEFAULT_APP_ID.to_string(),
            resolved_id: DEFAULT_APP_ID.to_string(),
        }
    }
}

/// The active app for a request, extracted from the request extensions stamped
/// by [`app_resolution_layer`]. Handlers add `active: ActiveApp` to their
/// signature and pass [`ActiveApp::app_id`] to every store call in place of a
/// hardcoded `_default`. When the layer did not run (e.g. a unit test calling a
/// handler directly) the extractor falls back to `_default`, so single-app and
/// test code paths are unchanged.
#[derive(Debug, Clone)]
pub(crate) struct ActiveApp(ResolvedApp);

impl ActiveApp {
    /// The storage `app_id` to thread through every store call for this request.
    pub(crate) fn app_id(&self) -> &str {
        &self.0.storage_app_id
    }

    /// The resolved registry id (matched app on multi-app, else `_default`).
    pub(crate) fn resolved_id(&self) -> &str {
        &self.0.resolved_id
    }

    /// The projection registry scoped to this request's app: the resolved app's
    /// per-app registry on a genuine multi-app server, else the shared
    /// `_default` registry (`state.projections`). Map 02 §10.
    pub(crate) fn projections<'a>(&self, state: &'a AppState) -> &'a ProjectionRegistry {
        if state.apps.is_multi_app() {
            state
                .apps
                .get(&self.0.resolved_id)
                .map_or(&state.projections, |app| &app.projections)
        } else {
            &state.projections
        }
    }

    /// The search registry scoped to this request's app (see [`Self::projections`]).
    pub(crate) fn search<'a>(&self, state: &'a AppState) -> &'a SearchRegistry {
        if state.apps.is_multi_app() {
            state
                .apps
                .get(&self.0.resolved_id)
                .map_or(&state.search, |app| &app.search)
        } else {
            &state.search
        }
    }
}

#[axum::async_trait]
impl<S> FromRequestParts<S> for ActiveApp
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(ActiveApp(
            parts
                .extensions
                .get::<ResolvedApp>()
                .cloned()
                .unwrap_or_else(ResolvedApp::default_app),
        ))
    }
}

/// Axum middleware that stamps a fixed [`ResolvedApp`] onto the request
/// extensions for the data-plane handlers (FR-277). One instance is wired per
/// app and layered onto that app's `nest`ed data-plane router, so the storage
/// app id + registry id are decided by WHICH base_path the request matched
/// (`Router::nest` strips the prefix before the inner routes match). On a
/// single-app server no nesting happens — the data-plane router is merged at the
/// root and no layer runs, so the [`ActiveApp`] extractor falls back to
/// `_default` and behavior is byte-for-byte unchanged.
pub(crate) async fn inject_resolved_app(
    resolved: ResolvedApp,
    mut request: Request,
    next: Next,
) -> Response {
    request.extensions_mut().insert(resolved);
    next.run(request).await
}

/// Build the multi-app data-plane router (FR-277): one [`dataplane_router`]
/// `nest`ed under each app's base_path, each carrying a per-app layer that
/// stamps the app's [`ResolvedApp`] (storage app id + registry id) onto the
/// request. `Router::nest` strips the base_path, so the inner `/objects`,
/// `/streams/...`, etc. routes match under `/<base_path>/objects` and the store
/// calls partition by that app's id. An app whose base_path is `""` (the root
/// app, if any) is merged at the root instead of nested (axum rejects an empty
/// nest prefix).
///
/// Only called when `state.apps.is_multi_app()`; the single-app boot path merges
/// a single un-nested `dataplane_router` exactly as before.
pub(crate) fn multi_app_dataplane_router(state: &AppState) -> axum::Router {
    let mut router = axum::Router::new();
    for descriptor in state.apps.descriptors() {
        let storage_app_id = state.apps.storage_app_id(&descriptor.id).to_string();
        let resolved = ResolvedApp {
            storage_app_id,
            resolved_id: descriptor.id.clone(),
        };
        let app_routes = dataplane_router(state.clone()).layer(axum::middleware::from_fn(
            move |request, next| {
                let resolved = resolved.clone();
                inject_resolved_app(resolved, request, next)
            },
        ));
        if descriptor.base_path.is_empty() {
            router = router.merge(app_routes);
        } else {
            router = router.nest(&descriptor.base_path, app_routes);
        }
    }
    router
}

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
