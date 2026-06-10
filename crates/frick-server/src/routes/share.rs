//! `/share/*` invitation + grant routes (`src/server.ts:1923-2126`).

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use frick_store::StoreError;
use frick_store::stores::grant::{CreateGrantArgs, Grant, ListGrantsArgs};
use frick_store::stores::invitation::{
    CreateInvitationArgs, Invitation, RedeemArgs, RedeemOutcome,
};
use serde::Deserialize;
use serde_json::json;

use super::{
    authenticate, map_get, new_request_id, parse_body_value, random_token, require_string,
};
use crate::boot::iso_from_epoch_ms;
use crate::error::ServerError;
use crate::http::{AppState, respond_error};

/// `DEFAULT_FRICK_INVITATION_TTL_SECONDS` (`packages/protocol/src/sharing.ts`):
/// 14 days.
const DEFAULT_INVITATION_TTL_SECONDS: i64 = 14 * 24 * 60 * 60;
/// `MAX_FRICK_INVITATION_TTL_SECONDS`: 90 days.
const MAX_INVITATION_TTL_SECONDS: i64 = 90 * 24 * 60 * 60;

/// Routes for this surface.
pub fn router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/share/invite", post(invite))
        .route("/share/accept", post(accept))
        .route("/share/grants", get(list_grants))
        .route("/share/grants/:id", axum::routing::delete(revoke_grant))
        .route("/share/grants/:id/leave", post(leave_grant))
        .with_state(state)
}

/// `POST /share/invite` (`src/server.ts:1923-1948`): create an invitation —
/// id `inv-<token12>`, opaque token `randomToken(32)`, ttl default/clamped.
/// 201 `{invitation}`.
async fn invite(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let request_id = new_request_id();
    let (principal, now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    let parsed = match parse_body_value(&body) {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let record_type = match require_string(&parsed, "recordType", "recordType") {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let record_id = match require_string(&parsed, "recordId", "recordId") {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let permission = match parse_sharing_permission(&parsed) {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let ttl_seconds = match resolve_invitation_ttl_seconds(&parsed) {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let expires_at = iso_from_epoch_ms(now.saturating_add(ttl_seconds.saturating_mul(1000)));

    match state
        .store
        .invitations()
        .create(&CreateInvitationArgs {
            id: format!("inv-{}", token12()),
            tenant_id: principal.tenant_id.clone(),
            owner_user_id: principal.user_id.clone(),
            record_type,
            record_id,
            permission: permission.to_string(),
            token: random_token(32),
            created_at: iso_from_epoch_ms(now),
            expires_at,
        })
        .await
    {
        Ok(invitation) => (
            StatusCode::CREATED,
            axum::Json(json!({ "invitation": invitation_json(&invitation) })),
        )
            .into_response(),
        Err(error) => respond_error(&store_error(&error), &request_id),
    }
}

/// `POST /share/accept` (`src/server.ts:1950-2040`): redeem a token. Each
/// redeem outcome that is not `Ok` maps to a 403 `auth.forbidden` with a
/// distinct public message; a self-accept by the owner is also rejected. On
/// success a grant `grant-<token12>` is created → 201 `{grant}`.
async fn accept(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let request_id = new_request_id();
    let (principal, now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    let parsed = match parse_body_value(&body) {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let token = match require_string(&parsed, "token", "token") {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let now_iso = iso_from_epoch_ms(now);

    let outcome = match state
        .store
        .invitations()
        .redeem(&RedeemArgs {
            token: &token,
            tenant_id: &principal.tenant_id,
            redeemer_user_id: &principal.user_id,
            now: &now_iso,
        })
        .await
    {
        Ok(outcome) => outcome,
        Err(error) => return respond_error(&store_error(&error), &request_id),
    };

    let invitation = match outcome {
        RedeemOutcome::NotFound => {
            return respond_error(
                &forbidden("notAuthorizedForResource", "Invitation token is invalid"),
                &request_id,
            );
        }
        RedeemOutcome::TenantMismatch(_) => {
            return respond_error(
                &forbidden("tenantMismatch", "Invitation belongs to a different tenant"),
                &request_id,
            );
        }
        RedeemOutcome::Expired(_) => {
            return respond_error(
                &forbidden("notAuthorizedForResource", "Invitation has expired"),
                &request_id,
            );
        }
        RedeemOutcome::AlreadyRedeemed(_) => {
            return respond_error(
                &forbidden(
                    "notAuthorizedForResource",
                    "Invitation has already been redeemed",
                ),
                &request_id,
            );
        }
        RedeemOutcome::Ok(invitation) => invitation,
    };

    // Owners cannot accept their own invitations.
    if invitation.owner_user_id == principal.user_id {
        return respond_error(
            &forbidden(
                "notAuthorizedForResource",
                "Owners cannot accept their own invitations",
            ),
            &request_id,
        );
    }

    match state
        .store
        .grants()
        .create(&CreateGrantArgs {
            id: format!("grant-{}", token12()),
            tenant_id: invitation.tenant_id.clone(),
            owner_user_id: invitation.owner_user_id.clone(),
            record_type: invitation.record_type.clone(),
            record_id: invitation.record_id.clone(),
            grantee_user_id: principal.user_id.clone(),
            permission: invitation.permission.clone(),
            created_at: now_iso,
        })
        .await
    {
        Ok(grant) => (
            StatusCode::CREATED,
            axum::Json(json!({ "grant": grant_json(&grant) })),
        )
            .into_response(),
        Err(error) => respond_error(&store_error(&error), &request_id),
    }
}

#[derive(Debug, Deserialize)]
struct GrantsQuery {
    #[serde(rename = "recordType")]
    record_type: Option<String>,
    #[serde(rename = "recordId")]
    record_id: Option<String>,
    #[serde(rename = "includeRevoked")]
    include_revoked: Option<String>,
}

/// `GET /share/grants` (`src/server.ts:2042-2059`): the caller's grants,
/// filtered by `recordType` / `recordId` / `includeRevoked=true`. 200
/// `{grants}`.
async fn list_grants(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<GrantsQuery>,
) -> Response {
    let request_id = new_request_id();
    let (principal, _now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    let include_revoked = query.include_revoked.as_deref() == Some("true");
    match state
        .store
        .grants()
        .list(&ListGrantsArgs {
            tenant_id: &principal.tenant_id,
            principal_user_id: &principal.user_id,
            record_type: query.record_type.as_deref(),
            record_id: query.record_id.as_deref(),
            include_revoked,
        })
        .await
    {
        Ok(grants) => {
            let grants: Vec<serde_json::Value> = grants.iter().map(grant_json).collect();
            axum::Json(json!({ "grants": grants })).into_response()
        }
        Err(error) => respond_error(&store_error(&error), &request_id),
    }
}

/// `DELETE /share/grants/:id` (`src/server.ts:2061-2088`): owner-only revoke; a
/// non-owner (or missing) grant is a 404 so the route never leaks existence.
async fn revoke_grant(
    State(state): State<AppState>,
    Path(grant_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let request_id = new_request_id();
    let (principal, now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    let existing = match state
        .store
        .grants()
        .get_by_id(&principal.tenant_id, &grant_id)
        .await
    {
        Ok(existing) => existing,
        Err(error) => return respond_error(&store_error(&error), &request_id),
    };
    let Some(existing) = existing.filter(|g| g.owner_user_id == principal.user_id) else {
        return grant_not_found();
    };

    revoke_and_respond(&state, &principal.tenant_id, &existing.id, now, &request_id).await
}

/// `POST /share/grants/:id/leave` (`src/server.ts:2090-2126`): grantee-only
/// self-revoke; anyone else (including the owner) gets a 404.
async fn leave_grant(
    State(state): State<AppState>,
    Path(grant_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let request_id = new_request_id();
    let (principal, now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    let existing = match state
        .store
        .grants()
        .get_by_id(&principal.tenant_id, &grant_id)
        .await
    {
        Ok(existing) => existing,
        Err(error) => return respond_error(&store_error(&error), &request_id),
    };
    let Some(existing) = existing.filter(|g| g.grantee_user_id == principal.user_id) else {
        return grant_not_found();
    };

    revoke_and_respond(&state, &principal.tenant_id, &existing.id, now, &request_id).await
}

async fn revoke_and_respond(
    state: &AppState,
    tenant_id: &str,
    grant_id: &str,
    now: i64,
    request_id: &str,
) -> Response {
    match state
        .store
        .grants()
        .revoke(tenant_id, grant_id, &iso_from_epoch_ms(now))
        .await
    {
        Ok(grant) => axum::Json(json!({ "grant": grant.map(|g| grant_json(&g)) })).into_response(),
        Err(error) => respond_error(&store_error(&error), request_id),
    }
}

/// The bespoke `{error:"grant_not_found"}` 404 body (not the standard envelope).
fn grant_not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        axum::Json(json!({ "error": "grant_not_found" })),
    )
        .into_response()
}

/// `parseSharingPermission` (`src/server.ts:3459-3464`): `"read"` | `"write"`.
fn parse_sharing_permission(body: &frick_protocol::Value) -> Result<&'static str, ServerError> {
    match map_get(body, "permission").and_then(frick_protocol::Value::as_str) {
        Some("read") => Ok("read"),
        Some("write") => Ok("write"),
        _ => Err(ServerError::BadRequest {
            message: "permission must be \"read\" or \"write\"".into(),
        }),
    }
}

/// `resolveInvitationTtlSeconds` (`src/server.ts:3466-3475`): default when
/// absent/null; a positive finite number otherwise, floored and clamped to the
/// max.
fn resolve_invitation_ttl_seconds(body: &frick_protocol::Value) -> Result<i64, ServerError> {
    use frick_protocol::Value;
    match map_get(body, "expiresInSeconds") {
        None | Some(Value::Nil) => Ok(DEFAULT_INVITATION_TTL_SECONDS),
        Some(value) => {
            let seconds = value
                .as_f64()
                .filter(|n| n.is_finite() && *n > 0.0)
                .ok_or_else(|| ServerError::BadRequest {
                    message: "expiresInSeconds must be a positive finite number".into(),
                })?;
            // Floor then clamp to the max, matching `Math.floor` + `Math.min`.
            #[allow(clippy::cast_possible_truncation)]
            let floored = seconds.floor() as i64;
            Ok(floored.min(MAX_INVITATION_TTL_SECONDS))
        }
    }
}

/// `randomToken(12)`: the 12-byte token that prefixes invitation/grant ids.
fn token12() -> String {
    random_token(12)
}

fn forbidden(reason: &str, message: &str) -> ServerError {
    ServerError::Authorization {
        message: message.to_string(),
        reason: Some(reason.to_string()),
    }
}

/// One invitation → its camelCase JSON shape (the TS `Invitation` row).
fn invitation_json(inv: &Invitation) -> serde_json::Value {
    json!({
        "id": inv.id,
        "tenantId": inv.tenant_id,
        "ownerUserId": inv.owner_user_id,
        "recordType": inv.record_type,
        "recordId": inv.record_id,
        "permission": inv.permission,
        "token": inv.token,
        "createdAt": inv.created_at,
        "expiresAt": inv.expires_at,
        "redeemedAt": inv.redeemed_at,
        "redeemedByUserId": inv.redeemed_by_user_id,
    })
}

/// One grant → its camelCase JSON shape (the TS `Grant` row).
fn grant_json(grant: &Grant) -> serde_json::Value {
    json!({
        "id": grant.id,
        "tenantId": grant.tenant_id,
        "ownerUserId": grant.owner_user_id,
        "recordType": grant.record_type,
        "recordId": grant.record_id,
        "granteeUserId": grant.grantee_user_id,
        "permission": grant.permission,
        "createdAt": grant.created_at,
        "revokedAt": grant.revoked_at,
    })
}

fn store_error(error: &StoreError) -> ServerError {
    ServerError::BadRequest {
        message: error.to_string(),
    }
}
