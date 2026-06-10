//! Admin push routes (map 06 §3.12; `apps/server/src/server.ts` admin arm).
//!
//! Admin-token-authenticated, JSON, audited routes for per-tenant push
//! credential management + delivery telemetry/enqueue:
//!
//! - `POST /_frick/admin/push/deliver` — build an intent, audit (strict),
//!   enqueue a `push.deliver` job, respond `201 { jobId, jobType, status }`.
//! - `PUT  /_frick/admin/tenants/:id/push/apns` — seal + store APNs creds.
//! - `PUT  /_frick/admin/tenants/:id/push/fcm` — seal + store FCM creds.
//! - `PUT  /_frick/admin/tenants/:id/push/webpush` — seal + store Web Push creds
//!   (note the URL segment is lowercase `webpush`; the platform enum is `webPush`).
//!
//! Credential errors → `400 { error: <code>, message }` (`sendPushCredentialError`,
//! both branches 400). Each PUT audits `push.<platform>.credentials.set`; the
//! deliver route audits `push.deliver` (strict — an audit-write failure aborts).
//!
//! # Why a separate module (not edits to `admin.rs`)
//!
//! This module owns its admin-auth preamble + strict-audit helpers (replicas of
//! `admin.rs`'s private ones) so it stays self-contained. The credential
//! encryption key is read from the process env via
//! [`ProcessCredentialEnv`](crate::push::credentials::ProcessCredentialEnv) (the
//! TS reads `process.env`).
//!
//! # Integrator wiring
//!
//! Merge this router into the server router. The existing `admin_router` has a
//! `/_frick/admin/*rest` catch-all; merge `admin_push_router` so its concrete
//! routes coexist (axum 0.7 allows concrete routes alongside a sibling router's
//! wildcard — `admin.rs` already mixes both in one router):
//!
//! ```ignore
//! let router = public_router(state.clone())
//!     // ... other routers ...
//!     .merge(crate::routes::admin::admin_router(state.clone()))
//!     .merge(crate::routes::admin_push::admin_push_router(router_handle, state.clone()));
//! ```
//!
//! where `router_handle: Arc<NotificationRouter>` is the same router registered
//! on the `JobHandlerRegistry` under `push.deliver`.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{post, put};
use frick_protocol::Value;
use frick_store::stores::admin_audit::{AdminAuditInput, AdminAuditOutcome};
use serde_json::json;

use super::{map_get, new_request_id, now_ms, parse_body_value};
use crate::error::ServerError;
use crate::extract::session_token_from_headers;
use crate::http::{AppState, respond_error};
use crate::push::NotificationRouter;
use crate::push::credentials::{
    ApnsCredentials, CredentialEnv, FcmCredentials, ProcessCredentialEnv, PushCredentialError,
    WebPushCredentials, save_apns_credentials, save_fcm_credentials, save_web_push_credentials,
};
use crate::push::types::{FrickNotificationIntent, NotificationBody};

/// Shared state for the admin-push routes: the [`AppState`] plus the
/// [`NotificationRouter`] (for `enqueue`) and the credential env seam.
#[derive(Clone)]
pub struct AdminPushState {
    app: AppState,
    router: Arc<NotificationRouter>,
    env: Arc<dyn CredentialEnv + Send + Sync>,
}

/// Build the admin-push router with production seams (process credential env).
/// `router` is the same [`NotificationRouter`] registered on the job registry
/// under `push.deliver`.
pub fn admin_push_router(router: Arc<NotificationRouter>, state: AppState) -> axum::Router {
    admin_push_router_with_env(router, state, Arc::new(ProcessCredentialEnv))
}

/// [`admin_push_router`] with an injected credential env (tests pin a fixed key).
pub fn admin_push_router_with_env(
    router: Arc<NotificationRouter>,
    state: AppState,
    env: Arc<dyn CredentialEnv + Send + Sync>,
) -> axum::Router {
    let push_state = AdminPushState {
        app: state,
        router,
        env,
    };
    axum::Router::new()
        .route("/_frick/admin/push/deliver", post(deliver))
        .route("/_frick/admin/tenants/:id/push/apns", put(put_apns))
        .route("/_frick/admin/tenants/:id/push/fcm", put(put_fcm))
        .route("/_frick/admin/tenants/:id/push/webpush", put(put_webpush))
        .with_state(push_state)
}

// ---- auth preamble (replica of admin.rs's private helper) --------------------

struct AdminAuth {
    fingerprint: String,
}

/// Authenticate the admin bearer (`adminPrincipalFromRequest`). Mirrors
/// `admin.rs::authenticate_admin`: admin disabled → 404; no bearer → 401; valid
/// session (not admin) → 403; bad token → 401.
async fn authenticate_admin(
    state: &AppState,
    headers: &HeaderMap,
    request_id: &str,
) -> Result<AdminAuth, Response> {
    let Some(admin_token) = state.config.admin_token.as_deref() else {
        return Err(not_found_response());
    };
    let bearer = session_token_from_headers(headers);
    if bearer.as_deref() == Some(admin_token) {
        return Ok(AdminAuth {
            fingerprint: admin_token_fingerprint(admin_token),
        });
    }
    let Some(token) = bearer else {
        return Err(respond_error(
            &ServerError::Authentication {
                message: "Missing admin token".into(),
            },
            request_id,
        ));
    };
    let now = now_ms();
    let is_active_session = state
        .store
        .sessions()
        .read_active(&token, now)
        .await
        .is_ok_and(|session| session.is_some());
    if is_active_session {
        return Err(respond_error(
            &ServerError::Authorization {
                message: "Admin scope required".into(),
                reason: Some("notAuthorizedForResource".into()),
            },
            request_id,
        ));
    }
    Err(respond_error(
        &ServerError::Authentication {
            message: "Invalid admin token".into(),
        },
        request_id,
    ))
}

/// `sha256(admin_token)` hex truncated to 12 chars (matches `admin.rs`).
fn admin_token_fingerprint(admin_token: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(admin_token.as_bytes());
    let mut out = String::with_capacity(12);
    for byte in &digest[..6] {
        out.push(char::from_digit(u32::from(byte >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(byte & 0x0f), 16).unwrap_or('0'));
    }
    out
}

/// Strict audit (`strictAudit`): an audit-write failure becomes
/// [`ServerError::AdminAuditWrite`].
async fn strict_audit(
    state: &AppState,
    auth: &AdminAuth,
    action: &str,
    target: Option<&str>,
    outcome: AdminAuditOutcome,
    detail: Option<serde_json::Value>,
    now_ms: i64,
) -> Result<(), ServerError> {
    let input = AdminAuditInput {
        admin_token_fingerprint: auth.fingerprint.clone(),
        action: action.to_string(),
        target: target.map(str::to_string),
        outcome,
        detail: detail.map(|value| value.to_string()),
    };
    state
        .store
        .admin_audit()
        .record(&input, now_ms)
        .await
        .map(|_| ())
        .map_err(|_| ServerError::AdminAuditWrite)
}

// ---- POST /_frick/admin/push/deliver -----------------------------------------

/// `POST /_frick/admin/push/deliver` (server.ts:4516-4567). Body
/// `{ tenantId?, intent, recipientUserIds: string[], body?, threadId?, deepLink? }`.
/// Builds an intent with the same string/shape filters as the router decode,
/// audits `push.deliver` (strict), enqueues, responds
/// `201 { jobId, jobType: "push.deliver", status }`.
async fn deliver(
    State(state): State<AdminPushState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let request_id = new_request_id();
    let auth = match authenticate_admin(&state.app, &headers, &request_id).await {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let now = now_ms();

    let value = match parse_body_value(&body) {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };

    let intent = match build_admin_intent(&value, &state.app) {
        Ok(intent) => intent,
        Err(error) => return respond_error(&error, &request_id),
    };

    // Strict audit BEFORE enqueue (server.ts audits then enqueues).
    if let Err(error) = strict_audit(
        &state.app,
        &auth,
        "push.deliver",
        Some(&intent.tenant_id),
        AdminAuditOutcome::Allow,
        Some(json!({ "intent": intent.intent, "recipients": intent.recipient_user_ids.len() })),
        now,
    )
    .await
    {
        return respond_error(&error, &request_id);
    }

    match state.router.enqueue_intent(&intent, now).await {
        Ok(row) => (
            StatusCode::CREATED,
            axum::Json(json!({
                "jobId": row.id,
                "jobType": crate::push::PUSH_DELIVER_JOB_TYPE,
                "status": row.status.as_str(),
            })),
        )
            .into_response(),
        Err(error) => respond_error(
            &ServerError::BadRequest {
                message: error.to_string(),
            },
            &request_id,
        ),
    }
}

/// Build the admin-deliver intent from the request body, applying the same
/// string/shape filters as the router decode (server.ts:4516-4567). `tenantId`
/// resolves to the body value or the default tenant `_default`.
fn build_admin_intent(
    value: &Value,
    state: &AppState,
) -> Result<FrickNotificationIntent, ServerError> {
    let _ = state;
    let intent = non_empty_str(value, "intent").ok_or_else(|| ServerError::BadRequest {
        message: "intent must be a non-empty string".to_string(),
    })?;
    let tenant_id =
        non_empty_str(value, "tenantId").unwrap_or_else(|| crate::DEFAULT_TENANT_ID.to_string());

    let Some(Value::Array(recipients)) = map_get(value, "recipientUserIds") else {
        return Err(ServerError::BadRequest {
            message: "recipientUserIds must be an array".to_string(),
        });
    };
    let mut recipient_user_ids = Vec::with_capacity(recipients.len());
    for entry in recipients {
        let Some(user) = entry.as_str().filter(|s| !s.is_empty()) else {
            return Err(ServerError::BadRequest {
                message: "recipientUserIds must be non-empty strings".to_string(),
            });
        };
        recipient_user_ids.push(user.to_string());
    }

    let body = match map_get(value, "body") {
        Some(Value::Map(entries)) => NotificationBody {
            title: get_in(entries, "title")
                .and_then(Value::as_str)
                .map(str::to_string),
            body: get_in(entries, "body")
                .and_then(Value::as_str)
                .map(str::to_string),
            data: get_in(entries, "data")
                .filter(|v| matches!(v, Value::Map(_)))
                .cloned(),
        },
        _ => NotificationBody::default(),
    };

    Ok(FrickNotificationIntent {
        intent,
        tenant_id,
        recipient_user_ids,
        body,
        thread_id: non_empty_str(value, "threadId"),
        deep_link: non_empty_str(value, "deepLink"),
    })
}

// ---- PUT credential routes ---------------------------------------------------

/// `PUT /_frick/admin/tenants/:id/push/apns` (server.ts:4940-4970). Body
/// `{ keyId, teamId, bundleId, privateKeyPem, useSandbox? }` → `save_apns_credentials`;
/// `204` on success; credential errors → `400 { error, message }`. Audits
/// `push.apns.credentials.set`.
async fn put_apns(
    State(state): State<AdminPushState>,
    headers: HeaderMap,
    Path(tenant_id): Path<String>,
    body: axum::body::Bytes,
) -> Response {
    let request_id = new_request_id();
    let auth = match authenticate_admin(&state.app, &headers, &request_id).await {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let now = now_ms();

    let value = match parse_body_value(&body) {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let creds = match parse_apns_body(&value) {
        Ok(creds) => creds,
        Err(error) => return respond_error(&error, &request_id),
    };

    if let Err(error) = strict_audit(
        &state.app,
        &auth,
        "push.apns.credentials.set",
        Some(&tenant_id),
        AdminAuditOutcome::Allow,
        None,
        now,
    )
    .await
    {
        return respond_error(&error, &request_id);
    }

    match save_apns_credentials(
        state.app.store.tenant_settings(),
        &tenant_id,
        &creds,
        &*state.env,
        now,
    )
    .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => push_credential_error(&error),
    }
}

/// `PUT /_frick/admin/tenants/:id/push/fcm` (server.ts:4972-5003). Body
/// `{ projectId, clientEmail, privateKey, tokenUri? }`. Audits
/// `push.fcm.credentials.set`.
async fn put_fcm(
    State(state): State<AdminPushState>,
    headers: HeaderMap,
    Path(tenant_id): Path<String>,
    body: axum::body::Bytes,
) -> Response {
    let request_id = new_request_id();
    let auth = match authenticate_admin(&state.app, &headers, &request_id).await {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let now = now_ms();

    let value = match parse_body_value(&body) {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let creds = match parse_fcm_body(&value) {
        Ok(creds) => creds,
        Err(error) => return respond_error(&error, &request_id),
    };

    if let Err(error) = strict_audit(
        &state.app,
        &auth,
        "push.fcm.credentials.set",
        Some(&tenant_id),
        AdminAuditOutcome::Allow,
        None,
        now,
    )
    .await
    {
        return respond_error(&error, &request_id);
    }

    match save_fcm_credentials(
        state.app.store.tenant_settings(),
        &tenant_id,
        &creds,
        &*state.env,
        now,
    )
    .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => push_credential_error(&error),
    }
}

/// `PUT /_frick/admin/tenants/:id/push/webpush` (server.ts:5005-5033). Body
/// `{ subject, publicKey, privateKey }`. Audits `push.webPush.credentials.set`.
/// (URL segment is lowercase `webpush`; the platform enum is `webPush`.)
async fn put_webpush(
    State(state): State<AdminPushState>,
    headers: HeaderMap,
    Path(tenant_id): Path<String>,
    body: axum::body::Bytes,
) -> Response {
    let request_id = new_request_id();
    let auth = match authenticate_admin(&state.app, &headers, &request_id).await {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let now = now_ms();

    let value = match parse_body_value(&body) {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let creds = match parse_web_push_body(&value) {
        Ok(creds) => creds,
        Err(error) => return respond_error(&error, &request_id),
    };

    if let Err(error) = strict_audit(
        &state.app,
        &auth,
        "push.webPush.credentials.set",
        Some(&tenant_id),
        AdminAuditOutcome::Allow,
        None,
        now,
    )
    .await
    {
        return respond_error(&error, &request_id);
    }

    match save_web_push_credentials(
        state.app.store.tenant_settings(),
        &tenant_id,
        &creds,
        &*state.env,
        now,
    )
    .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => push_credential_error(&error),
    }
}

// ---- body parsers ------------------------------------------------------------

fn parse_apns_body(value: &Value) -> Result<ApnsCredentials, ServerError> {
    Ok(ApnsCredentials {
        key_id: required(value, "keyId")?,
        team_id: required(value, "teamId")?,
        bundle_id: required(value, "bundleId")?,
        private_key_pem: required(value, "privateKeyPem")?,
        use_sandbox: map_get(value, "useSandbox")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn parse_fcm_body(value: &Value) -> Result<FcmCredentials, ServerError> {
    Ok(FcmCredentials {
        project_id: required(value, "projectId")?,
        client_email: required(value, "clientEmail")?,
        private_key: required(value, "privateKey")?,
        token_uri: non_empty_str(value, "tokenUri"),
    })
}

fn parse_web_push_body(value: &Value) -> Result<WebPushCredentials, ServerError> {
    Ok(WebPushCredentials {
        subject: required(value, "subject")?,
        public_key: required(value, "publicKey")?,
        private_key: required(value, "privateKey")?,
    })
}

// ---- helpers -----------------------------------------------------------------

/// `sendPushCredentialError` (server.ts:3353-3356): a credential error →
/// `400 { error: <code>, message }`. Both error branches are 400.
fn push_credential_error(error: &PushCredentialError) -> Response {
    (
        StatusCode::BAD_REQUEST,
        axum::Json(json!({ "error": error.code.as_str(), "message": error.message })),
    )
        .into_response()
}

/// 404 `{error:"not_found"}` — admin-disabled body.
fn not_found_response() -> Response {
    (
        StatusCode::NOT_FOUND,
        axum::Json(json!({ "error": "not_found" })),
    )
        .into_response()
}

/// A required non-empty string body field, else a 400 bad-request.
fn required(value: &Value, key: &str) -> Result<String, ServerError> {
    non_empty_str(value, key).ok_or_else(|| ServerError::BadRequest {
        message: format!("{key} must be a non-empty string"),
    })
}

/// A non-empty string body field, else `None`.
fn non_empty_str(value: &Value, key: &str) -> Option<String> {
    map_get(value, key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Look up a key in a `Vec<(Value, Value)>` map.
fn get_in<'a>(entries: &'a [(Value, Value)], key: &str) -> Option<&'a Value> {
    entries
        .iter()
        .find(|(k, _)| k.as_str() == Some(key))
        .map(|(_, v)| v)
}
