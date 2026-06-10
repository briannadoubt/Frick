//! `/projections` routes (`src/server.ts:2128-2185`).
//!
//! The projection registry is FR-245; until it lands, `GET /projections`
//! reports an empty list and `GET /projections/:name` is always
//! `projectionNotFound`. The authz pipeline (`assertCanSubscribe(projection)`)
//! and the cascade grant relaxation are wired into the registered-projection
//! path when FR-245 brings the registry online.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::json;

use super::{authenticate, new_request_id};
use crate::error::ServerError;
use crate::http::{AppState, respond_error};

/// Routes for this surface.
pub fn router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/projections", get(list_projections))
        .route("/projections/:name", get(read_projection))
        .with_state(state)
}

/// `GET /projections` (`src/server.ts:2128-2137`): 200 `{schemaHash,
/// projections}`. TODO(FR-245): once the projection registry is ported, list
/// each registered projection's `{name, sources}`. For now the list is empty.
async fn list_projections(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let request_id = new_request_id();
    if let Err(error) = authenticate(&state, &headers).await {
        return respond_error(&error, &request_id);
    }
    axum::Json(json!({
        "schemaHash": state.schema.hash,
        "projections": Vec::<serde_json::Value>::new(),
    }))
    .into_response()
}

/// `GET /projections/:name` (`src/server.ts:2139-2185`): 404 `projectionNotFound`
/// for an unregistered projection. TODO(FR-245): once the registry is ported,
/// run `assertCanSubscribe(projection)` and return `{schemaHash, projection,
/// data}` for projections that implement `read` (405 when they do not).
async fn read_projection(
    State(state): State<AppState>,
    Path(name): Path<String>,
    headers: HeaderMap,
) -> Response {
    let request_id = new_request_id();
    if let Err(error) = authenticate(&state, &headers).await {
        return respond_error(&error, &request_id);
    }
    respond_error(
        &ServerError::ProjectionNotFound { projection: name },
        &request_id,
    )
}
