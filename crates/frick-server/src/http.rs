//! The axum HTTP application: shared state, the public/lifecycle routes, and
//! the structured error responder (`src/server.ts`).
//!
//! This module owns the bootable core (`AppState`, the router, the public
//! routes, and the `respond_error` helper that every handler uses). The auth
//! routes, protected data-plane routes, and the WebSocket gateway are layered
//! on in their own modules.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use axum::Json;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use frick_protocol::FrickSchema;
use frick_store::FrickStore;
use serde_json::json;

use crate::apps::FrickAppRegistry;
use crate::config::FrickConfig;
use crate::email::EmailRouter;
use crate::error::ServerError;
use crate::gateway::GatewayHub;
use crate::jobs::StoreProvider;
use crate::projections::ProjectionRegistry;
use crate::push::{NotificationRouter, PushRegistry};
use crate::search::SearchRegistry;

/// Shared application state handed to every handler.
///
/// ## The `apps` registry and the legacy single-app fields (FR-277)
///
/// [`schema`](Self::schema), [`projections`](Self::projections), and
/// [`search`](Self::search) are the **`_default` app's** values. They are kept
/// as top-level fields so every existing route + the gateway keep working
/// unchanged on a single-app server (`state.schema` / `state.projections` /
/// `state.search`). The registry's `_default` [`AppEntry`] holds the SAME
/// registry handles — `projections` and `search` are `Arc`-backed clones that
/// share one interior — so `registry.get("_default").projections` observes
/// every projection registered through `state.projections`, and likewise for
/// search. `schema` is a value: the `_default` entry holds an equal clone.
///
/// On a single-app server the registry holds exactly one app (`_default`,
/// base_path `""`) and [`FrickAppRegistry::storage_app_id`] always returns
/// `_default`, so storage behavior is byte-for-byte identical to before this
/// field existed. A multi-app server is built via
/// [`crate::boot::create_frick_server_with_apps`]; the HTTP nest routing + the
/// WS Hello routing read [`apps`](Self::apps) to resolve the active app per
/// request.
///
/// [`AppEntry`]: crate::apps::AppEntry
pub struct AppStateInner {
    pub config: FrickConfig,
    /// The shared store. Held behind an `Arc` so the durable-job worker
    /// ([`StoreProvider`]) and the [`NotificationRouter`] can borrow it from a
    /// `'static` task without cloning the (non-`Clone`) store. Handlers keep
    /// using `state.store.method()` — `Arc<FrickStore>` derefs to `FrickStore`.
    pub store: Arc<FrickStore>,
    /// The `_default` (root) app's schema. On a single-app server this is the
    /// only app's schema; equal to `apps.get("_default").schema`.
    pub schema: FrickSchema,
    /// Wall-clock start, ISO-8601 (stamped at boot by the caller).
    pub started_at: String,
    /// Fixed-window auth-attempt limiter (`src/server.ts:3030-3072`).
    pub auth_limiter: Mutex<AuthLimiter>,
    /// The `_default` app's projection registry (FR-245). Empty until an app
    /// registers projections; the gateway reads snapshots and the routes
    /// list/read it. Shares its `Arc` interior with
    /// `apps.get("_default").projections` (see the struct doc).
    pub projections: ProjectionRegistry,
    /// The `_default` app's search index registry (FR-245, map 03 §13). Empty
    /// until an app registers indexes; installed as the store's search projector
    /// at boot so object/stream writes flow into the FTS tables, and read by the
    /// `POST /search` route + the `/_frick/inspect/search` report. Shares its
    /// `Arc` interior with `apps.get("_default").search` (see the struct doc).
    pub search: SearchRegistry,
    /// The wired push-adapter registry (FR-265): APNs / FCM / Web Push + test,
    /// each over a real transport. Held so the server can close adapters at
    /// shutdown and so routes can inspect registered platforms.
    pub push_registry: Arc<PushRegistry>,
    /// The notification router (FR-265): the same instance registered on the
    /// durable-job registry under `push.deliver` and handed to the admin-push
    /// routes so an enqueue + a worker tick share one delivery path.
    pub notification_router: Arc<NotificationRouter>,
    /// The outbound-email router (FR-268). Default is a
    /// [`crate::email::NoopEmailAdapter`]-backed router that logs + succeeds, so
    /// `forgot-password` can dispatch unconditionally and still return 200.
    /// Tests inject a [`crate::email::RecordingEmailAdapter`]; FR-271 plugs a
    /// Resend adapter here. The injection point is [`crate::boot::BootSeams`].
    pub email_router: Arc<EmailRouter>,
    /// The multi-app registry (FR-277). Always holds at least the `_default`
    /// (root, base_path `""`) app, whose `schema` / `projections` / `search`
    /// are the legacy top-level fields above (same `Arc` interiors). On a
    /// single-app server `apps.is_multi_app()` is `false` and every storage call
    /// stays pinned to `_default`; on a multi-app server the HTTP nest routing
    /// (`routes::multi_app_dataplane_router`) and the WS Hello routing
    /// (`gateway::handle_hello`) resolve the active app from this registry.
    pub apps: Arc<FrickAppRegistry>,
    /// A back-reference to the live WebSocket hub (FR-278), populated once at
    /// boot via [`AppStateInner::attach_gateway`] right after the hub is built
    /// (the hub holds the `Arc<AppStateInner>`, so this is a `Weak` to avoid a
    /// reference cycle). Lets the HTTP control plane live-close WebSocket
    /// connections when a session is revoked: the logout route and the admin
    /// `sessions/revoke` route resolve the hub via [`AppStateInner::gateway`]
    /// and call [`GatewayHub::close_session`]. `None` (unattached) when a server
    /// is constructed without a gateway (e.g. unit tests that never wire one) —
    /// callers treat that as "no live connections to close".
    pub gateway: OnceLock<Weak<GatewayHub>>,
}

impl AppStateInner {
    /// Attach the live WebSocket hub (FR-278). Called once at boot, immediately
    /// after the hub is constructed over this same state, so the HTTP control
    /// plane can reach it. Stores a `Weak` (the hub owns the `Arc` to this
    /// state); a second call is a no-op (`OnceLock`).
    pub fn attach_gateway(&self, gateway: &Arc<GatewayHub>) {
        let _ = self.gateway.set(Arc::downgrade(gateway));
    }

    /// The attached live WebSocket hub, if one was wired at boot and is still
    /// alive. Returns `None` on an unattached state (unit tests) or after the
    /// hub has been dropped — callers treat either as "nothing live to close".
    #[must_use]
    pub fn gateway(&self) -> Option<Arc<GatewayHub>> {
        self.gateway.get().and_then(Weak::upgrade)
    }
}

/// The durable-job worker / recurring scheduler read the store through this
/// seam (FR-265 wiring): the worker holds `Arc<dyn StoreProvider>` and calls
/// `store()` each tick, so the boot path can hand it the shared `AppStateInner`
/// without exposing the store's concrete ownership.
impl StoreProvider for AppStateInner {
    fn store(&self) -> &FrickStore {
        &self.store
    }
}

/// Fixed-window auth-attempt counter, keyed `route\0tenantId\0identity`
/// (`src/server.ts:3030-3072`). 30 attempts / 300 s by default.
#[derive(Debug, Default)]
pub struct AuthLimiter {
    windows: HashMap<String, (i64, u32)>,
}

impl AuthLimiter {
    /// Record an attempt; returns `true` when it is allowed (under the cap),
    /// `false` when the window is exhausted. `now_ms` and the window/limit
    /// come from the caller (config limits).
    pub fn check(&mut self, key: &str, now_ms: i64, window_ms: i64, limit: u32) -> bool {
        let entry = self.windows.entry(key.to_string()).or_insert((now_ms, 0));
        if now_ms - entry.0 >= window_ms {
            *entry = (now_ms, 0);
        }
        entry.1 += 1;
        entry.1 <= limit
    }
}

/// Cheaply-cloneable handle to [`AppStateInner`].
pub type AppState = Arc<AppStateInner>;

/// Build the axum router for the public/lifecycle surface. Auth and
/// data-plane routers are merged on by their modules.
pub fn public_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/schema", get(schema))
        .with_state(state)
}

/// `GET /health` (`src/server.ts:1174`).
async fn health() -> Response {
    Json(json!({ "ok": true, "service": "frick-server", "status": "ok" })).into_response()
}

/// `GET /ready` (`src/server.ts:1186-1209`): 200 when the database answers and
/// migrations are readable, else 503 with a reason.
async fn ready(State(state): State<AppState>) -> Response {
    let db_ok = state.store.ping_database().await;
    if !db_ok {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "status": "not-ready", "reason": "database_unresponsive" })),
        )
            .into_response();
    }

    match state.store.list_applied_migrations().await {
        Ok(applied) => Json(json!({
            "status": "ready",
            "schemaId": state.schema.schema_id,
            "schemaRevision": state.schema.schema_revision,
            "schemaHash": state.schema.hash,
            "appliedMigrations": applied.len(),
        }))
        .into_response(),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "status": "not-ready", "reason": "migrations_unavailable" })),
        )
            .into_response(),
    }
}

/// `GET /schema` (`src/server.ts:1438`): the active app's full schema JSON.
async fn schema(State(state): State<AppState>) -> Response {
    Json(&state.schema).into_response()
}

/// Render a [`ServerError`] as the wire error response (`sendError`): the
/// mapped HTTP status and the JSON body with the top-level field duplication
/// (`{ error, code, message, requestId, retryable }`).
#[must_use]
pub fn respond_error(error: &ServerError, request_id: &str) -> Response {
    let status = StatusCode::from_u16(error.http_status()).unwrap_or(StatusCode::BAD_REQUEST);
    let envelope = error.to_envelope(request_id);
    let body = json!({
        "error": envelope,
        "code": envelope.code.as_str(),
        "message": envelope.message,
        "requestId": envelope.request_id,
        "retryable": envelope.retryable,
    });
    (status, Json(body)).into_response()
}

/// The no-store cache headers every auth route sets (`sendAuthJson`,
/// `src/server.ts:3257-3264`).
pub fn no_store_headers() -> [(header::HeaderName, &'static str); 2] {
    [
        (header::CACHE_CONTROL, "no-store"),
        (header::PRAGMA, "no-cache"),
    ]
}
