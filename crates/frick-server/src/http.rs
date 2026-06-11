//! The axum HTTP application: shared state, the public/lifecycle routes, and
//! the structured error responder (`src/server.ts`).
//!
//! This module owns the bootable core (`AppState`, the router, the public
//! routes, and the `respond_error` helper that every handler uses). The auth
//! routes, protected data-plane routes, and the WebSocket gateway are layered
//! on in their own modules.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::Json;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use frick_protocol::FrickSchema;
use frick_store::FrickStore;
use serde_json::json;

use crate::config::FrickConfig;
use crate::error::ServerError;
use crate::jobs::StoreProvider;
use crate::projections::ProjectionRegistry;
use crate::push::{NotificationRouter, PushRegistry};

/// Shared application state handed to every handler.
pub struct AppStateInner {
    pub config: FrickConfig,
    /// The shared store. Held behind an `Arc` so the durable-job worker
    /// ([`StoreProvider`]) and the [`NotificationRouter`] can borrow it from a
    /// `'static` task without cloning the (non-`Clone`) store. Handlers keep
    /// using `state.store.method()` — `Arc<FrickStore>` derefs to `FrickStore`.
    pub store: Arc<FrickStore>,
    pub schema: FrickSchema,
    /// Wall-clock start, ISO-8601 (stamped at boot by the caller).
    pub started_at: String,
    /// Fixed-window auth-attempt limiter (`src/server.ts:3030-3072`).
    pub auth_limiter: Mutex<AuthLimiter>,
    /// The shared projection registry (FR-245). Empty until an app registers
    /// projections; the gateway reads snapshots and the routes list/read it.
    pub projections: ProjectionRegistry,
    /// The wired push-adapter registry (FR-265): APNs / FCM / Web Push + test,
    /// each over a real transport. Held so the server can close adapters at
    /// shutdown and so routes can inspect registered platforms.
    pub push_registry: Arc<PushRegistry>,
    /// The notification router (FR-265): the same instance registered on the
    /// durable-job registry under `push.deliver` and handed to the admin-push
    /// routes so an enqueue + a worker tick share one delivery path.
    pub notification_router: Arc<NotificationRouter>,
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
