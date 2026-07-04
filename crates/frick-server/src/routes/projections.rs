//! `/projections` routes (`src/server.ts:2128-2185`).
//!
//! Backed by the shared [`ProjectionRegistry`] (FR-245): `GET /projections`
//! lists `{name, sources}`; `GET /projections/:name` returns `{schemaHash,
//! projection, data}` for projections that implement `read` (404
//! `projectionNotFound` for unknown names, 405 `method_not_allowed` when there
//! is no `read`), after `assertCanSubscribe(projection)` authorizes.

use std::collections::BTreeMap;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;

use super::{ActiveApp, authenticate, new_request_id};
use crate::authz::{
    Action, Decision, PolicyInput, PolicyResource, ResourceContext, apply_policy_hooks,
    decide_baseline,
};
use crate::http::{AppState, respond_error};
use crate::projections::{
    FrickProjectionContext, ProjectionHttpRead, list_projections_body, method_not_allowed_body,
    projection_not_found_body, read_projection, read_projection_body,
};

/// Routes for this surface.
pub fn router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/projections", get(list))
        .route("/projections/:name", get(read))
        .with_state(state)
}

/// `GET /projections` (`src/server.ts:2128-2137`): 200 `{schemaHash,
/// projections:[{name, sources}]}` from the shared registry.
async fn list(State(state): State<AppState>, active: ActiveApp, headers: HeaderMap) -> Response {
    let request_id = new_request_id();
    if let Err(error) = authenticate(&state, &headers).await {
        return respond_error(&error, &request_id);
    }
    axum::Json(list_projections_body(
        active.projections(&state),
        &state.schema.hash,
    ))
    .into_response()
}

/// `GET /projections/:name` (`src/server.ts:2139-2185`).
async fn read(
    State(state): State<AppState>,
    active: ActiveApp,
    Path(name): Path<String>,
    Query(query): Query<BTreeMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let request_id = new_request_id();
    let principal = match authenticate(&state, &headers).await {
        Ok((principal, _now)) => principal,
        Err(error) => return respond_error(&error, &request_id),
    };

    let ctx = FrickProjectionContext::new(principal.tenant_id.clone(), active.resolved_id());
    match read_projection(active.projections(&state), &name, &ctx, &query) {
        ProjectionHttpRead::NotFound => {
            // The TS 404 uses sync.protocolError (not storage.notFound), so the
            // registry helper builds the faithful envelope directly.
            (
                StatusCode::NOT_FOUND,
                axum::Json(projection_not_found_body(&name, &request_id)),
            )
                .into_response()
        }
        ProjectionHttpRead::MethodNotAllowed => (
            StatusCode::METHOD_NOT_ALLOWED,
            axum::Json(method_not_allowed_body(&name)),
        )
            .into_response(),
        ProjectionHttpRead::Found(data) => {
            // assertCanSubscribe(projection): the `key` query param doubles as
            // the subscription key for the authz decision. Baseline → app
            // policy hooks (FR-296) — projections have no owner concept, so
            // hooks + baseline are the whole pipeline (no grant relaxation).
            let decision = decide_baseline(
                &principal,
                Action::ProjectionRead,
                &ResourceContext {
                    tenant_id: principal.tenant_id.clone(),
                    owner_user_id: None,
                },
            );
            let decision = apply_policy_hooks(
                decision,
                &PolicyInput {
                    principal: &principal,
                    action: Action::ProjectionRead,
                    resource: PolicyResource {
                        kind: "projection",
                        name: Some(name.clone()),
                        key: query.get("key").cloned(),
                        event: None,
                        owner_id: None,
                        tenant_id: principal.tenant_id.clone(),
                    },
                    context: None,
                },
                &state.policy_hooks,
            )
            .await;
            if let Decision::Deny {
                reason,
                public_message,
            } = decision
            {
                return respond_error(
                    &crate::error::ServerError::Authorization {
                        message: public_message,
                        reason: Some(reason.as_str().to_string()),
                    },
                    &request_id,
                );
            }
            axum::Json(read_projection_body(&state.schema.hash, &name, &data)).into_response()
        }
    }
}
