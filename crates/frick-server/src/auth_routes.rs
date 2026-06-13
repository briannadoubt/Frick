//! Built-in password / demo auth routes (`src/server.ts:1443-1607`).
//!
//! `/auth/signup`, `/auth/login`, `/auth/dev-login`, `/auth/logout`. All set
//! no-store cache headers, run the tenant pre-check and the fixed-window
//! auth-attempt limiter, and mint sessions with a 32-byte base64url token.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use frick_store::stores::account::CreateAccountInput;
use frick_store::stores::password_reset::DEFAULT_RESET_TTL_MINUTES;
use frick_store::stores::refresh_token::DEFAULT_REFRESH_TTL_SECONDS;
use frick_store::stores::session::CreateSessionInput;
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;

use crate::auth_lifecycle::{AuthIdentity, AuthSessionContext, FirstSignInContext};
use crate::email::router::PasswordResetEmail;
use crate::error::{LimitKind, ServerError};
use crate::extract::session_token_from_headers;
use crate::gateway::CloseTarget;
use crate::http::{AppState, no_store_headers, respond_error};
use crate::principal::DEFAULT_TENANT_ID;
use crate::session::ensure_tenant_allowed;

/// Merge the auth routes onto the app router.
pub fn auth_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/auth/signup", post(signup))
        .route("/auth/login", post(login))
        .route("/auth/dev-login", post(dev_login))
        .route("/auth/logout", post(logout))
        // Email/password identity + refresh-token routes (FR-268, map 02 §4.3).
        .route("/auth/email/signup", post(email_signup))
        .route("/auth/email/login", post(email_login))
        .route("/auth/email/forgot-password", post(email_forgot_password))
        .route("/auth/email/reset-password", post(email_reset_password))
        .route("/auth/refresh", post(refresh))
        .route("/auth/refresh/revoke", post(refresh_revoke))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignupBody {
    display_name: String,
    handle: String,
    password: String,
    tenant_id: Option<String>,
    device_id: Option<String>,
    replica_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginBody {
    identity: String,
    password: String,
    tenant_id: Option<String>,
    device_id: Option<String>,
    replica_id: Option<String>,
}

// Field names are the wire contract (userId/tenantId/deviceId/replicaId), so
// the shared `_id` suffix is intentional, not a naming smell.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_field_names)]
struct DevLoginBody {
    user_id: String,
    tenant_id: Option<String>,
    device_id: Option<String>,
    replica_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogoutBody {
    session_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmailSignupBody {
    email: Option<String>,
    password: Option<String>,
    display_name: Option<String>,
    tenant_id: Option<String>,
    device_id: Option<String>,
    replica_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmailLoginBody {
    email: Option<String>,
    password: Option<String>,
    tenant_id: Option<String>,
    device_id: Option<String>,
    replica_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForgotPasswordBody {
    email: Option<String>,
    tenant_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResetPasswordBody {
    token: Option<String>,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshBody {
    refresh_token: Option<String>,
}

async fn signup(State(state): State<AppState>, Json(body): Json<SignupBody>) -> Response {
    let request_id = new_request_id();
    let tenant_id = body
        .tenant_id
        .unwrap_or_else(|| DEFAULT_TENANT_ID.to_string());
    let now_ms = now_ms();

    if let Err(error) = precheck(
        &state,
        "signup",
        &tenant_id,
        &body.handle.to_lowercase(),
        now_ms,
    )
    .await
    {
        return respond_error(&error, &request_id);
    }

    let display_name = match normalize_display_name(&body.display_name) {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    let handle = match normalize_handle_strict(&body.handle) {
        Ok(value) => value,
        Err(error) => return respond_error(&error, &request_id),
    };
    if !(8..=256).contains(&body.password.chars().count()) {
        return respond_error(
            &ServerError::BadRequest {
                message: "password must be 8–256 characters".into(),
            },
            &request_id,
        );
    }

    let user_id = user_id_from_handle(&tenant_id, &handle);
    let created = state
        .store
        .accounts()
        .create(
            &CreateAccountInput {
                tenant_id: tenant_id.clone(),
                user_id: user_id.clone(),
                handle: handle.clone(),
                display_name: display_name.clone(),
                password: body.password,
            },
            now_ms,
        )
        .await;
    if let Err(error) = created {
        // "Handle is already taken" → 400 (matches the TS conflict surfacing).
        return respond_error(
            &ServerError::BadRequest {
                message: error.to_string(),
            },
            &request_id,
        );
    }

    let device_id = body
        .device_id
        .unwrap_or_else(|| format!("device-{}", random_token(12)));
    let replica_id = body
        .replica_id
        .unwrap_or_else(|| format!("replica-{}", random_token(12)));
    match mint_session(
        &state,
        &tenant_id,
        &user_id,
        &device_id,
        &replica_id,
        now_ms,
    )
    .await
    {
        Ok(session) => (
            axum::http::StatusCode::CREATED,
            no_store_headers(),
            Json(json!({
                "schemaHash": state.schema.hash,
                "sessionToken": session.token,
                "tenantId": tenant_id,
                "userId": user_id,
                "displayName": display_name,
                "handle": handle,
                "deviceId": device_id,
                "replicaId": replica_id,
                "expiresAt": session.expires_at,
            })),
        )
            .into_response(),
        Err(error) => respond_error(&error, &request_id),
    }
}

async fn login(State(state): State<AppState>, Json(body): Json<LoginBody>) -> Response {
    let request_id = new_request_id();
    let tenant_id = body
        .tenant_id
        .unwrap_or_else(|| DEFAULT_TENANT_ID.to_string());
    let now_ms = now_ms();

    if let Err(error) = precheck(
        &state,
        "login",
        &tenant_id,
        &body.identity.to_lowercase(),
        now_ms,
    )
    .await
    {
        return respond_error(&error, &request_id);
    }

    let verified = state
        .store
        .accounts()
        .verify_password(&tenant_id, &body.identity, &body.password)
        .await
        .unwrap_or(None);

    let Some(account) = verified else {
        // `verify_password` already spends the constant Argon2 work on a miss
        // (auth-core-2), so unknown-identity and wrong-password cost the same;
        // just return a uniform 401.
        return respond_error(
            &ServerError::Authentication {
                message: "Invalid credentials".into(),
            },
            &request_id,
        );
    };

    let device_id = body
        .device_id
        .unwrap_or_else(|| format!("device-{}", random_token(12)));
    let replica_id = body
        .replica_id
        .unwrap_or_else(|| format!("replica-{}", random_token(12)));
    match mint_session(
        &state,
        &tenant_id,
        &account.user_id,
        &device_id,
        &replica_id,
        now_ms,
    )
    .await
    {
        Ok(session) => (
            no_store_headers(),
            Json(json!({
                "schemaHash": state.schema.hash,
                "sessionToken": session.token,
                "tenantId": tenant_id,
                "userId": account.user_id,
                "displayName": account.display_name,
                "handle": account.handle,
                "deviceId": device_id,
                "replicaId": replica_id,
                "expiresAt": session.expires_at,
            })),
        )
            .into_response(),
        Err(error) => respond_error(&error, &request_id),
    }
}

async fn dev_login(State(state): State<AppState>, Json(body): Json<DevLoginBody>) -> Response {
    let request_id = new_request_id();
    if !state.config.demo_auth_enabled {
        return respond_error(
            &ServerError::Authorization {
                message: "demo auth is disabled".into(),
                reason: Some("demoAuthDisabled".into()),
            },
            &request_id,
        );
    }
    let tenant_id = body
        .tenant_id
        .unwrap_or_else(|| DEFAULT_TENANT_ID.to_string());
    let now_ms = now_ms();

    if let Err(error) = precheck(&state, "dev-login", &tenant_id, &body.user_id, now_ms).await {
        return respond_error(&error, &request_id);
    }

    // Auto-create the account when missing (random password).
    let exists = state
        .store
        .accounts()
        .read_by_identity(&tenant_id, &body.user_id)
        .await
        .unwrap_or(None)
        .is_some();
    if !exists {
        let handle = dev_handle_from_user_id(&body.user_id);
        let created = state
            .store
            .accounts()
            .create(
                &CreateAccountInput {
                    tenant_id: tenant_id.clone(),
                    user_id: body.user_id.clone(),
                    handle,
                    display_name: body.user_id.clone(),
                    password: random_token(32),
                },
                now_ms,
            )
            .await;
        if let Err(error) = created {
            return respond_error(
                &ServerError::BadRequest {
                    message: error.to_string(),
                },
                &request_id,
            );
        }
        tracing::info!(
            target: "frick.auth",
            user_id = %body.user_id,
            tenant_id = %tenant_id,
            "frick.auth.dev_login_auto_create"
        );
    }

    let device_id = body
        .device_id
        .unwrap_or_else(|| format!("device-{}", random_token(12)));
    let replica_id = body
        .replica_id
        .unwrap_or_else(|| format!("replica-{}", random_token(12)));
    match mint_session(
        &state,
        &tenant_id,
        &body.user_id,
        &device_id,
        &replica_id,
        now_ms,
    )
    .await
    {
        Ok(session) => (
            no_store_headers(),
            Json(json!({
                "schemaHash": state.schema.hash,
                "sessionToken": session.token,
                "tenantId": tenant_id,
                "userId": body.user_id,
                "deviceId": device_id,
                "replicaId": replica_id,
                "expiresAt": session.expires_at,
            })),
        )
            .into_response(),
        Err(error) => respond_error(&error, &request_id),
    }
}

async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Option<Json<LogoutBody>>,
) -> Response {
    let request_id = new_request_id();
    // Prefer the standard auth headers (`Authorization: Bearer` /
    // `x-frick-session-token`, the TS `sessionTokenFromRequest` contract),
    // falling back to the JSON body for older callers. The body is optional so
    // a header-only logout still reaches the handler.
    let token = session_token_from_headers(&headers)
        .or_else(|| body.and_then(|Json(body)| body.session_token));
    let Some(token) = token else {
        return respond_error(
            &ServerError::Authentication {
                message: "session token required".into(),
            },
            &request_id,
        );
    };
    let _ = state.store.sessions().delete(&token).await;
    // Live-disconnect any WebSocket connections that authenticated with this
    // token (FR-278). Best-effort: a server without a wired gateway (or no live
    // socket on this token) closes nothing, and logout still returns ok. The
    // session row is already deleted, so even a missed close would be torn down
    // on the connection's next per-frame session re-validation.
    if let Some(gateway) = state.gateway() {
        let _ = gateway.close_session(&CloseTarget::Token(token));
    }
    Json(json!({ "ok": true })).into_response()
}

// -- Email / password identity routes (FR-268, map 02 §4.3) -----------------
//
// The Rust foundation has no app-owned `userObject`; the email IS the account
// `handle`, so lookup-by-subject is the indexed `(tenant_id, LOWER(handle))`
// account lookup (FR-218 — never a linear scan). A duplicate email surfaces a
// DISTINCT 409 `auth.emailTaken` (FR-219). forgot-password keys its throttle on
// the normalized email AND the client IP (FR-217) so an attacker IP drains only
// its own bucket and can't lock out a victim's reset capability.

/// Default minimum password length (TS `minPasswordLength ?? 8`).
const MIN_EMAIL_PASSWORD_LENGTH: usize = 8;

/// `POST /auth/email/signup`: create an account with the email as its subject
/// (handle) + an argon2 password hash, then mint a session. A duplicate email
/// returns a distinct 409 `auth.emailTaken` (FR-219) rather than a generic
/// error.
async fn email_signup(
    State(state): State<AppState>,
    Json(body): Json<EmailSignupBody>,
) -> Response {
    let request_id = new_request_id();
    let tenant_id = body
        .tenant_id
        .unwrap_or_else(|| DEFAULT_TENANT_ID.to_string());
    let now_ms = now_ms();

    let email = normalize_email(body.email.as_deref());
    if !is_valid_email(&email) {
        return respond_error(&bad_request("invalid email"), &request_id);
    }
    let password = body.password.unwrap_or_default();
    if password.chars().count() < MIN_EMAIL_PASSWORD_LENGTH {
        return respond_error(
            &bad_request(&format!(
                "Password must be at least {MIN_EMAIL_PASSWORD_LENGTH} characters."
            )),
            &request_id,
        );
    }

    // Throttle (shared AuthLimiter, label "email-signup") + tenant pre-check.
    // Runs before the duplicate lookup so the 409 existence oracle can't be
    // probed at scale (auth-core-1/6). Keyed on the email subject.
    if let Err(error) = precheck(&state, "email-signup", &tenant_id, &email, now_ms).await {
        return respond_error(&error, &request_id);
    }

    // Duplicate-email check via the indexed account lookup (FR-218): an existing
    // account under this email (= handle) yields a DISTINCT 409 (FR-219).
    let existing = state
        .store
        .accounts()
        .read_by_identity(&tenant_id, &email)
        .await
        .unwrap_or(None)
        .is_some();
    if existing {
        return respond_error(&email_taken(), &request_id);
    }

    let display_name = body
        .display_name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| email_local_part(&email));
    let user_id = format!("user-email-{}", random_token(16));
    let first_sign_in = state
        .auth_lifecycle
        .on_first_sign_in(FirstSignInContext {
            store: Arc::clone(&state.store),
            now_ms,
            auth_tenant_id: tenant_id.clone(),
            identity: AuthIdentity::Email {
                email: email.clone(),
            },
            proposed_user_id: user_id,
            proposed_display_name: display_name,
        })
        .await;
    let first_sign_in = match first_sign_in {
        Ok(outcome) => outcome,
        Err(error) => return respond_error(&error, &request_id),
    };

    let created = state
        .store
        .accounts()
        .create(
            &CreateAccountInput {
                tenant_id: tenant_id.clone(),
                user_id: first_sign_in.user_id.clone(),
                handle: email.clone(),
                display_name: first_sign_in.display_name.clone(),
                password,
            },
            now_ms,
        )
        .await;
    if let Err(error) = created {
        // A constraint race (two concurrent signups) also surfaces emailTaken.
        if error.to_string().to_lowercase().contains("taken") {
            return respond_error(&email_taken(), &request_id);
        }
        return respond_error(&ServerError::Internal, &request_id);
    }

    mint_email_session_response(
        &state,
        &request_id,
        &first_sign_in.session_tenant_id,
        &first_sign_in.user_id,
        &first_sign_in.display_name,
        &email,
        body.device_id,
        body.replica_id,
        now_ms,
        true,
    )
    .await
}

/// `POST /auth/email/login`: verify the password (constant-time; lazy rehash on
/// success), then mint a session. Throttled via the shared limiter (label
/// "email-login"). A bad email OR a bad password both return the identical
/// generic 401 `auth.invalidCredentials` — no user enumeration.
async fn email_login(State(state): State<AppState>, Json(body): Json<EmailLoginBody>) -> Response {
    let request_id = new_request_id();
    let tenant_id = body
        .tenant_id
        .unwrap_or_else(|| DEFAULT_TENANT_ID.to_string());
    let now_ms = now_ms();

    let email = normalize_email(body.email.as_deref());
    let password = body.password.unwrap_or_default();
    if email.is_empty() || password.is_empty() {
        return respond_error(&bad_request("email and password are required"), &request_id);
    }

    // auth-core-1: throttle login by email (label "email-login") + tenant
    // pre-check. The bucket is keyed on the email subject.
    if let Err(error) = precheck(&state, "email-login", &tenant_id, &email, now_ms).await {
        return respond_error(&error, &request_id);
    }

    // The email is the account handle; verify against the indexed row.
    let verified = state
        .store
        .accounts()
        .verify_password(&tenant_id, &email, &password)
        .await
        .unwrap_or(None);

    let Some(account) = verified else {
        // `verify_password` already spends the constant Argon2 work on a miss
        // (auth-core-2): unknown-email and wrong-password cost the same, and
        // both return the identical 401.
        return respond_error(&invalid_credentials(), &request_id);
    };

    let session = state
        .auth_lifecycle
        .resolve_session(AuthSessionContext {
            store: Arc::clone(&state.store),
            now_ms,
            auth_tenant_id: tenant_id.clone(),
            identity: AuthIdentity::Email {
                email: email.clone(),
            },
            user_id: account.user_id,
            display_name: account.display_name,
        })
        .await;
    let session = match session {
        Ok(outcome) => outcome,
        Err(error) => return respond_error(&error, &request_id),
    };

    mint_email_session_response(
        &state,
        &request_id,
        &session.session_tenant_id,
        &session.user_id,
        &session.display_name,
        &email,
        body.device_id,
        body.replica_id,
        now_ms,
        false,
    )
    .await
}

/// `POST /auth/email/forgot-password`: always 200 (no account-existence leak).
/// If the account exists, mint a reset token and dispatch it through the email
/// router (best-effort — the response never depends on the send). FR-217: the
/// throttle is keyed on the normalized email AND the client IP, so one attacker
/// IP can't exhaust a victim's reset bucket.
async fn email_forgot_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ForgotPasswordBody>,
) -> Response {
    let request_id = new_request_id();
    let tenant_id = body
        .tenant_id
        .unwrap_or_else(|| DEFAULT_TENANT_ID.to_string());
    let now_ms = now_ms();

    let email = normalize_email(body.email.as_deref());
    if email.is_empty() {
        return respond_error(&bad_request("invalid email"), &request_id);
    }

    // FR-217 / auth-core-4: throttle reset issuance keyed on email AND the
    // client IP, so an attacker IP drains only its own (email, ip) bucket and
    // can't lock out the victim's legitimate (email, victim-ip) requests. Runs
    // before the lookup so unknown emails are capped too (no existence leak).
    let throttle_key = format!("{email} ip:{}", client_ip(&headers));
    if let Err(error) = precheck(&state, "forgot-password", &tenant_id, &throttle_key, now_ms).await
    {
        return respond_error(&error, &request_id);
    }

    // Indexed lookup by subject (FR-218). Only issue + send for a real account;
    // either way the response is an identical 200.
    if let Ok(Some(account)) = state
        .store
        .accounts()
        .read_by_identity(&tenant_id, &email)
        .await
    {
        let token = random_token(32);
        if let Ok(issued) = state
            .store
            .password_reset_tokens()
            .issue(
                &token,
                &tenant_id,
                &account.user_id,
                DEFAULT_RESET_TTL_MINUTES,
                now_ms,
            )
            .await
        {
            // Best-effort send through the router seam. A failure is logged by
            // the router and ignored here — the 200 never depends on it.
            let _ = state
                .email_router
                .send_password_reset_email(PasswordResetEmail {
                    tenant_id: tenant_id.clone(),
                    to: email.clone(),
                    reset_url: reset_url(&issued.token),
                })
                .await;
        }
    }

    // Uniform 200 for existing AND non-existing accounts.
    (no_store_headers(), Json(json!({ "ok": true }))).into_response()
}

/// `POST /auth/email/reset-password`: consume a valid, unexpired, unused reset
/// token (the store marks it used + rejects reuse/expiry), set the new argon2
/// hash, then revoke the user's existing sessions + refresh tokens so the reset
/// fully cuts off prior credentials.
async fn email_reset_password(
    State(state): State<AppState>,
    Json(body): Json<ResetPasswordBody>,
) -> Response {
    let request_id = new_request_id();
    let now_ms = now_ms();

    let token = body.token.unwrap_or_default();
    let password = body.password.unwrap_or_default();
    if token.is_empty() {
        return respond_error(&bad_request("missing token"), &request_id);
    }

    // FR-29: throttle reset-token guessing by the token value (label
    // "reset-password"). Tenant pre-check is keyed on the default tenant here
    // (the token carries the tenant); the limiter bucket is the token.
    if let Err(error) = precheck(&state, "reset-password", DEFAULT_TENANT_ID, &token, now_ms).await
    {
        return respond_error(&error, &request_id);
    }
    if password.chars().count() < MIN_EMAIL_PASSWORD_LENGTH {
        return respond_error(
            &bad_request(&format!(
                "Password must be at least {MIN_EMAIL_PASSWORD_LENGTH} characters."
            )),
            &request_id,
        );
    }

    // Single-use consume: rejects unknown / already-consumed / expired tokens.
    let consumed = state
        .store
        .password_reset_tokens()
        .consume(&token, now_ms)
        .await
        .unwrap_or(None);
    let Some(consumed) = consumed else {
        return respond_error(&bad_request("invalid or expired token"), &request_id);
    };

    let ok = state
        .store
        .accounts()
        .set_password(&consumed.tenant_id, &consumed.user_id, &password)
        .await
        .unwrap_or(false);
    if !ok {
        // The token validated but the account vanished (race with deletion).
        return respond_error(&bad_request("account no longer exists"), &request_id);
    }

    // Kill outstanding sessions + refresh tokens so the reset cuts off any
    // squirreled-away credentials.
    let _ = state
        .store
        .sessions()
        .delete_for_user(&consumed.user_id, Some(&consumed.tenant_id))
        .await;
    let _ = state
        .store
        .refresh_tokens()
        .revoke_for_user(&consumed.user_id, Some(&consumed.tenant_id), now_ms)
        .await;

    (no_store_headers(), Json(json!({ "ok": true }))).into_response()
}

/// `POST /auth/refresh`: rotate a refresh token (reuse-detection burns the
/// family inside the store) and mint a fresh session bound to the same
/// `(tenant, user, device, replica)`. The presented token is revoked; a fresh
/// one is returned.
async fn refresh(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RefreshBody>,
) -> Response {
    let request_id = new_request_id();
    let now_ms = now_ms();

    let presented = body.refresh_token.unwrap_or_default();
    if presented.is_empty() {
        return respond_error(&bad_request("refreshToken required"), &request_id);
    }

    // Throttle by IP — the refresh token isn't a stable per-user identifier and
    // a stolen token is the threat being bounded. Keyed on the client IP.
    if let Err(error) = precheck(
        &state,
        "refresh",
        DEFAULT_TENANT_ID,
        &client_ip(&headers),
        now_ms,
    )
    .await
    {
        return respond_error(&error, &request_id);
    }

    // Rotate: revokes the presented token and issues a fresh one atomically, so
    // a replayed token is rejected (and the family is burned on reuse).
    let fresh = random_token(32);
    let rotated = state
        .store
        .refresh_tokens()
        .rotate(&presented, &fresh, DEFAULT_REFRESH_TTL_SECONDS, now_ms)
        .await
        .unwrap_or(None);
    let Some(record) = rotated else {
        return respond_error(&invalid_refresh_token(), &request_id);
    };

    // Refuse to mint a session for a user whose account no longer exists.
    let account_exists = state
        .store
        .accounts()
        .read_by_identity(&record.tenant_id, &record.user_id)
        .await
        .unwrap_or(None)
        .is_some();
    if !account_exists {
        return respond_error(&invalid_refresh_token(), &request_id);
    }

    match mint_session(
        &state,
        &record.tenant_id,
        &record.user_id,
        &record.device_id,
        &record.replica_id,
        now_ms,
    )
    .await
    {
        Ok(session) => (
            no_store_headers(),
            Json(json!({
                "schemaHash": state.schema.hash,
                "sessionToken": session.token,
                "tenantId": record.tenant_id,
                "userId": record.user_id,
                "deviceId": record.device_id,
                "replicaId": record.replica_id,
                "expiresAt": session.expires_at,
                "refreshToken": record.token,
                "refreshTokenExpiresAt": record.expires_at,
            })),
        )
            .into_response(),
        Err(error) => respond_error(&error, &request_id),
    }
}

/// `POST /auth/refresh/revoke`: revoke a refresh token. Idempotent — an unknown
/// or already-revoked token still returns 200 so a client can't probe which
/// tokens are live.
async fn refresh_revoke(State(state): State<AppState>, Json(body): Json<RefreshBody>) -> Response {
    let request_id = new_request_id();
    let now_ms = now_ms();
    let presented = body.refresh_token.unwrap_or_default();
    if presented.is_empty() {
        return respond_error(&bad_request("refreshToken required"), &request_id);
    }
    let _ = state
        .store
        .refresh_tokens()
        .revoke(&presented, now_ms)
        .await;
    (no_store_headers(), Json(json!({ "ok": true }))).into_response()
}

/// Mint a session for an email signup/login and render the success body. Shared
/// by [`email_signup`] and [`email_login`] (the `is_new_user` flag mirrors the
/// TS `isNewUser`).
#[allow(clippy::too_many_arguments)]
async fn mint_email_session_response(
    state: &AppState,
    request_id: &str,
    tenant_id: &str,
    user_id: &str,
    display_name: &str,
    email: &str,
    device_id: Option<String>,
    replica_id: Option<String>,
    now_ms: i64,
    is_new_user: bool,
) -> Response {
    let device_id = device_id.unwrap_or_else(|| format!("device-{}", random_token(12)));
    let replica_id = replica_id.unwrap_or_else(|| format!("replica-{}", random_token(12)));
    let session =
        match mint_session(state, tenant_id, user_id, &device_id, &replica_id, now_ms).await {
            Ok(session) => session,
            Err(error) => return respond_error(&error, request_id),
        };
    let status = if is_new_user {
        axum::http::StatusCode::CREATED
    } else {
        axum::http::StatusCode::OK
    };
    (
        status,
        no_store_headers(),
        Json(json!({
            // Wrapped envelope: clients (Swift/Kotlin) decode
            // `{ session, user, isNewUser }`. The pre-rewrite TS server returned
            // this shape; the Rust rewrite flattened it, breaking the native
            // SDK decoders (see FR auth-envelope regression ticket).
            "session": {
                "schemaHash": state.schema.hash,
                "sessionToken": session.token,
                "tenantId": tenant_id,
                "userId": user_id,
                "displayName": display_name,
                "email": email,
                "handle": email,
                "deviceId": device_id,
                "replicaId": replica_id,
                "expiresAt": session.expires_at,
            },
            "user": {
                "id": user_id,
                "userId": user_id,
                "displayName": display_name,
                "email": email,
                "handle": email,
            },
            "isNewUser": is_new_user,
        })),
    )
        .into_response()
}

/// A minted session token + its expiry.
pub(crate) struct MintedSession {
    pub(crate) token: String,
    pub(crate) expires_at: String,
}

pub(crate) async fn mint_session(
    state: &AppState,
    tenant_id: &str,
    user_id: &str,
    device_id: &str,
    replica_id: &str,
    now_ms: i64,
) -> Result<MintedSession, ServerError> {
    let token = random_token(32);
    // sessionTtlSeconds may be negative (tests use ≤0 for "expire
    // immediately"); clamp the millisecond product into i64 range explicitly.
    let ttl_ms = {
        let millis = state.config.session_ttl_seconds * 1000.0;
        if millis >= 9_007_199_254_740_992.0 {
            i64::MAX
        } else if millis <= -9_007_199_254_740_992.0 {
            i64::MIN
        } else {
            // Range is bounded above; fractional ms loss on a TTL is intended.
            #[allow(clippy::cast_possible_truncation)]
            let truncated = millis as i64;
            truncated
        }
    };
    let expires_at = iso_from_epoch_ms(now_ms.saturating_add(ttl_ms));
    state
        .store
        .sessions()
        .create(
            &CreateSessionInput {
                session_token: token.clone(),
                tenant_id: tenant_id.to_string(),
                user_id: user_id.to_string(),
                device_id: device_id.to_string(),
                replica_id: replica_id.to_string(),
                expires_at: expires_at.clone(),
            },
            now_ms,
        )
        .await
        .map_err(|_| ServerError::Internal)?;
    Ok(MintedSession { token, expires_at })
}

/// Tenant pre-check + the fixed-window auth limiter (`src/server.ts:3030-3072`).
pub(crate) async fn precheck(
    state: &AppState,
    route: &str,
    tenant_id: &str,
    identity: &str,
    now_ms: i64,
) -> Result<(), ServerError> {
    ensure_tenant_allowed(
        &state.store,
        tenant_id,
        state.config.implicit_tenant_creation,
        now_ms,
    )
    .await?;

    // Limiter key uses literal NUL separators (`route\0tenantId\0identity`).
    let key = format!("{route}\0{tenant_id}\0{identity}");
    let window_ms = state.config.limits.auth_rate_limit_window_ms;
    let limit = u32::try_from(state.config.limits.max_auth_attempts_per_window).unwrap_or(30);
    let allowed = state
        .auth_limiter
        .lock()
        .map_err(|_| ServerError::Internal)?
        .check(&key, now_ms, window_ms, limit);
    if allowed {
        Ok(())
    } else {
        Err(ServerError::Limit {
            kind: LimitKind::MaxAuthAttemptsPerWindow,
            detail: frick_protocol::Value::Nil,
        })
    }
}

// -- helpers (`src/server.ts:5468-5495`) ------------------------------------

/// `userIdFromHandle`: `user-<handle with _→->` for `_default`, else
/// `user-<tenantId>-<base>`.
fn user_id_from_handle(tenant_id: &str, handle: &str) -> String {
    let base = handle.replace('_', "-");
    if tenant_id == DEFAULT_TENANT_ID {
        format!("user-{base}")
    } else {
        format!("user-{tenant_id}-{base}")
    }
}

/// `devHandleFromUserId`: strip the `user-` prefix, replace non-`[a-z0-9_-]`
/// runs with `-`, truncate to 32, fallback `dev-user`.
fn dev_handle_from_user_id(user_id: &str) -> String {
    let stripped = user_id.strip_prefix("user-").unwrap_or(user_id);
    let mut out = String::new();
    let mut in_run = false;
    for ch in stripped.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch.to_ascii_lowercase());
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    let truncated: String = out.chars().take(32).collect();
    if truncated.is_empty() {
        "dev-user".to_string()
    } else {
        truncated
    }
}

/// `randomToken(byteLength)`: base64url (no padding) of N random bytes.
pub(crate) fn random_token(byte_length: usize) -> String {
    let mut bytes = vec![0u8; byte_length];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Trim + collapse internal whitespace; require 2–80 chars.
fn normalize_display_name(raw: &str) -> Result<String, ServerError> {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if (2..=80).contains(&collapsed.chars().count()) {
        Ok(collapsed)
    } else {
        Err(ServerError::BadRequest {
            message: "displayName must be 2–80 characters".into(),
        })
    }
}

/// Lowercase + validate `^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$` (3–32 chars).
fn normalize_handle_strict(raw: &str) -> Result<String, ServerError> {
    let handle = raw.to_lowercase();
    let bytes = handle.as_bytes();
    let valid_len = (3..=32).contains(&handle.len());
    let valid_chars = handle
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');
    let valid_ends = bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric);
    if valid_len && valid_chars && valid_ends {
        Ok(handle)
    } else {
        Err(ServerError::BadRequest {
            message: "invalid handle".into(),
        })
    }
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

pub(crate) fn new_request_id() -> String {
    format!("req-{}", uuid::Uuid::new_v4())
}

// -- Email-route helpers ----------------------------------------------------

/// Normalize an email per the TS (`body.email.trim().toLowerCase()`).
fn normalize_email(raw: Option<&str>) -> String {
    raw.map(|value| value.trim().to_lowercase())
        .unwrap_or_default()
}

/// `^[^@\s]+@[^@\s]+\.[^@\s]+$` — the TS signup email guard. Requires a single
/// `@`, a non-empty local part, and a domain with at least one dot, none of the
/// three segments containing whitespace or `@`.
fn is_valid_email(email: &str) -> bool {
    let no_at_or_space = |segment: &str| {
        !segment.is_empty() && !segment.chars().any(|c| c == '@' || c.is_whitespace())
    };
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    if !no_at_or_space(local) {
        return false;
    }
    let Some((host, tld)) = domain.rsplit_once('.') else {
        return false;
    };
    no_at_or_space(host) && no_at_or_space(tld)
}

/// The email local-part (`email.split("@")[0]`), used as the default display
/// name when none is submitted.
fn email_local_part(email: &str) -> String {
    email.split('@').next().unwrap_or(email).to_string()
}

/// Build the reset-link URL the email carries. The Rust foundation has no
/// app-supplied `resetUrl` builder (that is an app seam in the TS); the route
/// embeds the token in a default `/auth/reset?token=…` path so the link is
/// well-formed. FR-271 / an app hook can override the formatting at the router.
fn reset_url(token: &str) -> String {
    format!("/auth/email/reset?token={token}")
}

/// The client IP for FR-217 throttle keying. Mirrors the TS
/// `clientIpFromRequest` (which reads the socket address); behind a proxy the
/// real client is in `x-forwarded-for` (first hop) or `x-real-ip`. Falls back
/// to `"unknown"` (the TS fallback) so a missing header still yields a stable,
/// non-empty bucket suffix.
pub(crate) fn client_ip(headers: &HeaderMap) -> String {
    if let Some(forwarded) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        let first = forwarded.split(',').next().unwrap_or("").trim();
        if !first.is_empty() {
            return first.to_string();
        }
    }
    if let Some(real) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        let real = real.trim();
        if !real.is_empty() {
            return real.to_string();
        }
    }
    "unknown".to_string()
}

/// A 400 `sync.protocolError` with a custom message.
fn bad_request(message: &str) -> ServerError {
    ServerError::BadRequest {
        message: message.to_string(),
    }
}

/// The FR-219 distinct 409 for a duplicate signup email.
fn email_taken() -> ServerError {
    ServerError::EmailTaken
}

/// The generic, no-enumeration 401 for a bad email OR password at email-login.
fn invalid_credentials() -> ServerError {
    ServerError::Authentication {
        message: "Invalid credentials".into(),
    }
}

/// The generic 401 for an unknown / rotated / expired refresh token.
fn invalid_refresh_token() -> ServerError {
    ServerError::Authentication {
        message: "Invalid refresh token".into(),
    }
}

/// ISO-8601 UTC ms string (`Date.toISOString`); shared with `boot::now_iso`.
fn iso_from_epoch_ms(epoch_ms: i64) -> String {
    crate::boot::iso_from_epoch_ms(epoch_ms)
}

#[cfg(test)]
mod tests {
    use crate::boot::create_frick_server;
    use crate::config::load_frick_config;
    use crate::session::principal_from_active_session_token;
    use std::collections::BTreeMap;

    fn test_config() -> crate::config::FrickConfig {
        let mut env = BTreeMap::new();
        env.insert("FRICK_ENV".to_string(), "test".to_string());
        env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
        env.insert("FRICK_PORT".to_string(), "0".to_string());
        load_frick_config(&env).unwrap()
    }

    /// Dev-login over a real socket mints a session that the resolver then
    /// accepts — the end-to-end auth path.
    #[tokio::test]
    async fn dev_login_round_trip_authenticates() {
        let schema = frick_protocol::foundation_schema();
        let mut server = create_frick_server(test_config(), schema).await.unwrap();
        let port = server.listen().await.unwrap();

        let response = post_json(port, "/auth/dev-login", r#"{"userId":"user-ada"}"#).await;
        assert!(
            response.contains("\"sessionToken\""),
            "dev-login body: {response}"
        );

        // Extract the token and confirm the session resolver accepts it.
        let token = extract_json_string(&response, "sessionToken");
        let now = 1_700_000_000_000;
        let principal = principal_from_active_session_token(&server.state.store, &token, now)
            .await
            .unwrap();
        assert_eq!(principal.user_id, "user-ada");

        server.close().await;
    }

    /// FR-307: the email signup response is the wrapped
    /// `{ session, user, isNewUser }` envelope the native SDK decoders
    /// (Swift `SignInWithEmailEnvelope`, Kotlin) expect — NOT the flattened
    /// session fields the 0.4.0 rewrite briefly emitted, which broke every
    /// native signUp/signIn.
    #[tokio::test]
    async fn email_signup_returns_wrapped_session_envelope() {
        let schema = frick_protocol::foundation_schema();
        let mut server = create_frick_server(test_config(), schema).await.unwrap();
        let port = server.listen().await.unwrap();

        let response = post_json(
            port,
            "/auth/email/signup",
            r#"{"email":"ada@example.com","password":"correct-horse-battery"}"#,
        )
        .await;

        let body = response
            .rsplit("\r\n\r\n")
            .next()
            .expect("response has a body");
        let json: serde_json::Value = serde_json::from_str(body)
            .unwrap_or_else(|_| panic!("email signup body not JSON: {response}"));

        // Session is NESTED, with the token under it — not flattened.
        assert!(
            json["session"]["sessionToken"].is_string(),
            "expected nested session.sessionToken: {response}"
        );
        assert!(
            json.get("user").is_some(),
            "expected a user object: {response}"
        );
        // isNewUser stays at the top level.
        assert_eq!(json["isNewUser"], true, "isNewUser at top level: {response}");
        // The token must NOT also be flattened at the top level.
        assert!(
            json.get("sessionToken").is_none(),
            "sessionToken should not be top-level: {response}"
        );

        server.close().await;
    }

    /// Dev-login is refused when demo auth is disabled (production posture).
    #[tokio::test]
    async fn dev_login_forbidden_without_demo_auth() {
        let mut env = BTreeMap::new();
        env.insert("FRICK_ENV".to_string(), "test".to_string());
        env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
        env.insert("FRICK_PORT".to_string(), "0".to_string());
        env.insert("FRICK_DEMO_AUTH_ENABLED".to_string(), "false".to_string());
        let config = load_frick_config(&env).unwrap();

        let mut server = create_frick_server(config, frick_protocol::foundation_schema())
            .await
            .unwrap();
        let port = server.listen().await.unwrap();
        let response = post_json(port, "/auth/dev-login", r#"{"userId":"user-x"}"#).await;
        assert!(response.contains("403"), "expected 403, got: {response}");
        assert!(response.contains("auth.forbidden"), "body: {response}");
        server.close().await;
    }

    async fn post_json(port: u16, path: &str, body: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{port}"))
            .await
            .unwrap();
        let request = format!(
            "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    /// Pull a JSON string value out of a raw HTTP response body.
    fn extract_json_string(response: &str, key: &str) -> String {
        let needle = format!("\"{key}\":\"");
        let start = response.find(&needle).expect("key present") + needle.len();
        let rest = &response[start..];
        let end = rest.find('"').expect("closing quote");
        rest[..end].to_string()
    }
}
