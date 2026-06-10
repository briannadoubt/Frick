//! `/signals/:name/:key` enqueue + drain (`src/server.ts:2562-2634`).

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use frick_store::StoreError;
use serde_json::json;

use super::{ACTIVE_APP_ID, authenticate, new_request_id, parse_body_value, value_to_json};
use crate::authz::{Action, Decision, ResourceContext, decide_baseline};
use crate::error::ServerError;
use crate::http::{AppState, respond_error};
use crate::principal::Principal;

/// Routes for this surface.
pub fn router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/signals/:name/:key", get(drain_signals).post(send_signal))
        .with_state(state)
}

/// `POST /signals/:name/:key` (`src/server.ts:2563-2601`): the `signal.send`
/// decision, then `enqueue_signal`, then 200 `{ok:true}`.
///
/// The WebRTC call-membership gate (calls-signal-1) and the
/// `gateway.publishSignal` live fan-out are FR-243 gateway concerns; the
/// enqueue is the durable side this route owns. TODO(FR-243): once the gateway
/// is wired into boot, publish the signal to live subscribers here too.
async fn send_signal(
    State(state): State<AppState>,
    Path((name, key)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let request_id = new_request_id();
    let (principal, _now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };
    if let Err(error) = signal_decision(&principal, Action::SignalSend) {
        return respond_error(&error, &request_id);
    }

    let value = match parse_body_value(&body) {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    match state
        .store
        .enqueue_signal(
            &principal.tenant_id,
            &name,
            &key,
            &value,
            None,
            ACTIVE_APP_ID,
        )
        .await
    {
        Ok(()) => axum::Json(json!({ "ok": true })).into_response(),
        Err(error) => respond_error(&store_error(&error), &request_id),
    }
}

/// `GET /signals/:name/:key` (`src/server.ts:2603-2634`): the `signal.read`
/// decision, then drain (at-most-once) → `{schemaHash, name, key, data}`.
async fn drain_signals(
    State(state): State<AppState>,
    Path((name, key)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let request_id = new_request_id();
    let (principal, now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };
    if let Err(error) = signal_decision(&principal, Action::SignalRead) {
        return respond_error(&error, &request_id);
    }

    match state
        .store
        .signals()
        .drain(&principal.tenant_id, &name, &key, ACTIVE_APP_ID, now)
        .await
    {
        Ok(rows) => {
            let data: Vec<serde_json::Value> = rows.iter().map(value_to_json).collect();
            axum::Json(json!({
                "schemaHash": state.schema.hash,
                "name": name,
                "key": key,
                "data": data,
            }))
            .into_response()
        }
        Err(error) => respond_error(&store_error(&error), &request_id),
    }
}

/// The signal decision (`assertCanSignal` / `assertCanReadSignal`): the
/// baseline (cross-tenant denied; in-tenant allowed). The call-membership gate
/// is applied by the gateway when calls are enabled (FR-15).
fn signal_decision(principal: &Principal, action: Action) -> Result<(), ServerError> {
    let resource = ResourceContext {
        tenant_id: principal.tenant_id.clone(),
        owner_user_id: None,
    };
    match decide_baseline(principal, action, &resource) {
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

fn store_error(error: &StoreError) -> ServerError {
    ServerError::BadRequest {
        message: error.to_string(),
    }
}
