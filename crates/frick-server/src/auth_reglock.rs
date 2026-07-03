//! Server-enforced registration lock / recovery PIN (AURA-178).
//!
//! Signal-style registration lock: once a user enables the lock, the
//! password-login ("re-registration") routes refuse to mint a session until
//! the client also proves knowledge of the recovery PIN. Proof is a
//! **verifier** the client derives from the PIN with PBKDF2-SHA256 using
//! exactly the parameters of the web `reglock` module
//! (`clients/web/src/reglock.ts` `hashPin`): [`REGLOCK_PBKDF2_ITERATIONS`]
//! iterations, SHA-256, a 16-byte random salt, a 256-bit derived key, both
//! salt and verifier transported as standard base64. The server treats the
//! verifier as an opaque secret: only its SHA-256 hash is stored (see
//! `frick_store::stores::reglock`), and the challenge response returns the
//! stored salt plus the KDF parameters so a brand-new device can derive the
//! same verifier from the user-entered PIN.
//!
//! Enforcement follows Signal's inactivity rule: the lock only gates
//! re-registration while the account has authenticated activity within the
//! configured window (`FRICK_REGLOCK_EXPIRY_SECONDS`, default 7 days). The
//! window is refreshed by password logins that pass the gate, by token
//! refresh, and by the reglock management routes. After the window lapses the
//! lock is bypassed (and left in place, still enabled, exactly like a
//! Signal reglock that expired).
//!
//! Wrong-PIN attempts back off per the web module's exponential-lockout
//! policy (threshold 3, `2^(n-3)` seconds, capped at one hour), tracked
//! server-side per user in the registration-lock record. The generic
//! per-route auth limiter still applies in front of everything.
//!
//! Routes (all require a valid session token):
//! `POST /auth/reglock/enable` (also "change PIN"), `POST
//! /auth/reglock/disable`, `GET /auth/reglock/status`. The challenge itself
//! rides the existing `/auth/login` + `/auth/email/login` routes, which
//! answer `423 Locked` with the challenge body when the lock applies.

use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::Deserialize;
use serde_json::json;

use crate::auth_routes::{new_request_id, now_ms};
use crate::error::ServerError;
use crate::extract::session_token_from_headers;
use crate::http::{AppState, no_store_headers, respond_error};
use crate::principal::Principal;
use crate::session::principal_from_active_session_token;

/// PBKDF2 iteration count shared with the web reglock module
/// (`clients/web/src/reglock.ts` `PBKDF2_ITERATIONS`).
pub const REGLOCK_PBKDF2_ITERATIONS: u32 = 310_000;

/// Derived-key size in bits (web `deriveBits(..., 256)`).
pub const REGLOCK_PBKDF2_KEY_BITS: u32 = 256;

/// KDF identifier advertised in the challenge body.
pub const REGLOCK_KDF: &str = "PBKDF2-SHA256";

/// Upper bound accepted for the base64 verifier / salt fields (the real
/// values are 44 and 24 chars; the bound just rejects abuse).
const MAX_FIELD_LEN: usize = 128;

/// The registration-lock management routes, merged into the auth router.
pub fn reglock_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/auth/reglock/enable", post(enable))
        .route("/auth/reglock/disable", post(disable))
        .route("/auth/reglock/status", get(status))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnableBody {
    /// Base64 PBKDF2 verifier derived client-side from the PIN.
    verifier: Option<String>,
    /// Base64 salt the verifier was derived with.
    salt: Option<String>,
}

/// `POST /auth/reglock/enable`: enable the lock, or replace the PIN when
/// already enabled ("change PIN" is the same upsert). Resets attempt counters
/// and restarts the inactivity window.
async fn enable(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<EnableBody>,
) -> Response {
    let request_id = new_request_id();
    let now = now_ms();
    let principal = match authenticate(&state, &headers, now).await {
        Ok(principal) => principal,
        Err(error) => return respond_error(&error, &request_id),
    };

    let Some(verifier) = valid_field(body.verifier.as_deref()) else {
        return respond_error(&bad_request("verifier required"), &request_id);
    };
    let Some(salt) = valid_field(body.salt.as_deref()) else {
        return respond_error(&bad_request("salt required"), &request_id);
    };

    if state
        .store
        .registration_locks()
        .enable(
            &principal.tenant_id,
            &principal.user_id,
            verifier,
            salt,
            now,
        )
        .await
        .is_err()
    {
        return respond_error(&ServerError::Internal, &request_id);
    }
    tracing::info!(
        target: "frick.auth",
        user_id = %principal.user_id,
        tenant_id = %principal.tenant_id,
        "frick.auth.reglock_enabled"
    );
    (
        no_store_headers(),
        Json(json!({ "ok": true, "enabled": true })),
    )
        .into_response()
}

/// `POST /auth/reglock/disable`: turn the lock off. Idempotent.
async fn disable(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let request_id = new_request_id();
    let now = now_ms();
    let principal = match authenticate(&state, &headers, now).await {
        Ok(principal) => principal,
        Err(error) => return respond_error(&error, &request_id),
    };

    match state
        .store
        .registration_locks()
        .disable(&principal.tenant_id, &principal.user_id, now)
        .await
    {
        Ok(changed) => {
            if changed {
                tracing::info!(
                    target: "frick.auth",
                    user_id = %principal.user_id,
                    tenant_id = %principal.tenant_id,
                    "frick.auth.reglock_disabled"
                );
            }
            (
                no_store_headers(),
                Json(json!({ "ok": true, "enabled": false })),
            )
                .into_response()
        }
        Err(_) => respond_error(&ServerError::Internal, &request_id),
    }
}

/// `GET /auth/reglock/status`: whether the lock is enabled for the caller.
async fn status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let request_id = new_request_id();
    let now = now_ms();
    let principal = match authenticate(&state, &headers, now).await {
        Ok(principal) => principal,
        Err(error) => return respond_error(&error, &request_id),
    };

    match state
        .store
        .registration_locks()
        .read(&principal.tenant_id, &principal.user_id)
        .await
    {
        Ok(record) => {
            let (enabled, updated_at) =
                record.map_or((false, None), |r| (r.enabled, Some(r.updated_at)));
            (
                no_store_headers(),
                Json(json!({ "enabled": enabled, "updatedAt": updated_at })),
            )
                .into_response()
        }
        Err(_) => respond_error(&ServerError::Internal, &request_id),
    }
}

/// Gate a successful password authentication ("re-registration") behind the
/// registration lock. Called by `/auth/login` and `/auth/email/login` AFTER
/// the password verified, BEFORE any session is minted.
///
/// Outcomes:
/// - no record / disabled ⇒ `Ok(())`, nothing else happens;
/// - enabled but the inactivity window has lapsed ⇒ `Ok(())` (Signal-style
///   expiry bypass — the lock row is left as-is);
/// - enabled and in-window, attempts currently locked out ⇒ `Err(423)` with
///   `reason: "rateLimited"` + `retryAfterSeconds`;
/// - enabled and in-window, no verifier submitted ⇒ `Err(423)` with
///   `reason: "pinRequired"` + the salt/KDF parameters;
/// - wrong verifier ⇒ failure recorded (backoff per the web policy) and
///   `Err(423)` with `reason: "pinIncorrect"`;
/// - correct verifier ⇒ counters reset, activity stamped, `Ok(())`.
pub(crate) async fn check_registration_lock(
    state: &AppState,
    request_id: &str,
    tenant_id: &str,
    user_id: &str,
    submitted_verifier: Option<&str>,
    now_ms: i64,
) -> Result<(), Response> {
    let record = state
        .store
        .registration_locks()
        .read(tenant_id, user_id)
        .await
        .map_err(|_| respond_error(&ServerError::Internal, request_id))?;
    let Some(record) = record else {
        return Ok(());
    };
    if !record.enabled {
        return Ok(());
    }

    // Signal-style inactivity expiry: no authenticated activity inside the
    // window ⇒ the lock is not enforced.
    let expiry_ms = state.config.reglock_expiry_seconds.saturating_mul(1_000);
    if now_ms.saturating_sub(record.last_activity_ms) >= expiry_ms {
        tracing::info!(
            target: "frick.auth",
            user_id = %user_id,
            tenant_id = %tenant_id,
            "frick.auth.reglock_expired_bypass"
        );
        return Ok(());
    }

    // Per-user attempt lockout (checked before the verifier so a locked-out
    // attacker cannot keep probing).
    if record.locked_until_ms > now_ms {
        let retry_after = seconds_until(record.locked_until_ms, now_ms);
        return Err(challenge_response(
            request_id,
            "rateLimited",
            &record.salt,
            record.failed_attempts,
            retry_after,
        ));
    }

    let Some(verifier) = submitted_verifier.filter(|v| !v.is_empty()) else {
        return Err(challenge_response(
            request_id,
            "pinRequired",
            &record.salt,
            record.failed_attempts,
            0,
        ));
    };

    let matched = state
        .store
        .registration_locks()
        .verify(tenant_id, user_id, verifier)
        .await
        .map_err(|_| respond_error(&ServerError::Internal, request_id))?;
    if matched {
        let _ = state
            .store
            .registration_locks()
            .register_success(tenant_id, user_id, now_ms)
            .await;
        return Ok(());
    }

    let updated = state
        .store
        .registration_locks()
        .register_failure(tenant_id, user_id, now_ms)
        .await
        .ok()
        .flatten();
    let (failed_attempts, retry_after) = updated.map_or((record.failed_attempts + 1, 0), |r| {
        (r.failed_attempts, seconds_until(r.locked_until_ms, now_ms))
    });
    tracing::info!(
        target: "frick.auth",
        user_id = %user_id,
        tenant_id = %tenant_id,
        failed_attempts,
        "frick.auth.reglock_pin_incorrect"
    );
    Err(challenge_response(
        request_id,
        "pinIncorrect",
        &record.salt,
        failed_attempts,
        retry_after,
    ))
}

/// Refresh the inactivity window after authenticated activity. Best-effort:
/// a missing record (or a store error) is a no-op.
pub(crate) async fn touch_reglock_activity(
    state: &AppState,
    tenant_id: &str,
    user_id: &str,
    now_ms: i64,
) {
    let _ = state
        .store
        .registration_locks()
        .touch_activity(tenant_id, user_id, now_ms)
        .await;
}

/// The `423 Locked` challenge body. `reason` is one of `pinRequired`,
/// `pinIncorrect`, `rateLimited`. `reglock.saltBase64` + the KDF parameters
/// let a fresh device derive the verifier from the user-entered PIN exactly
/// like the web module's `hashPin` with a pinned salt.
fn challenge_response(
    request_id: &str,
    reason: &str,
    salt: &str,
    failed_attempts: i64,
    retry_after_seconds: i64,
) -> Response {
    (
        axum::http::StatusCode::LOCKED,
        no_store_headers(),
        Json(json!({
            "error": "registrationLock",
            "reason": reason,
            "requestId": request_id,
            "reglock": {
                "kdf": REGLOCK_KDF,
                "iterations": REGLOCK_PBKDF2_ITERATIONS,
                "keyBits": REGLOCK_PBKDF2_KEY_BITS,
                "saltBase64": salt,
                "failedAttempts": failed_attempts,
                "retryAfterSeconds": retry_after_seconds,
            },
        })),
    )
        .into_response()
}

/// Ceil-seconds until `until_ms` (0 when already past).
fn seconds_until(until_ms: i64, now_ms: i64) -> i64 {
    let delta = until_ms.saturating_sub(now_ms);
    if delta <= 0 { 0 } else { (delta + 999) / 1_000 }
}

/// Resolve the caller from the standard session-token headers.
async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    now_ms: i64,
) -> Result<Principal, ServerError> {
    let Some(token) = session_token_from_headers(headers) else {
        return Err(ServerError::Authentication {
            message: "session token required".into(),
        });
    };
    principal_from_active_session_token(&state.store, &token, now_ms).await
}

/// A non-empty, bounded base64-ish field.
fn valid_field(raw: Option<&str>) -> Option<&str> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= MAX_FIELD_LEN)
}

fn bad_request(message: &str) -> ServerError {
    ServerError::BadRequest {
        message: message.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boot::create_frick_server;
    use crate::config::load_frick_config;
    use crate::principal::DEFAULT_TENANT_ID;
    use serde_json::json;
    use std::collections::BTreeMap;
    use tower::ServiceExt;

    /// A verifier/salt pair as the web client would submit (opaque base64 to
    /// the server; the PBKDF2 derivation happens client-side).
    const VERIFIER: &str = "9m5DEyoXWLczZo2vWFCvFtRr9ZBeMWVhcGKmSXfJTPw=";
    const WRONG_VERIFIER: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const SALT: &str = "3q2+7wEjRWeJq83vASNFZw==";

    fn test_config() -> crate::config::FrickConfig {
        let mut env = BTreeMap::new();
        env.insert("FRICK_ENV".to_string(), "test".to_string());
        env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
        env.insert("FRICK_PORT".to_string(), "0".to_string());
        load_frick_config(&env).unwrap()
    }

    async fn server() -> crate::boot::FrickServer {
        create_frick_server(test_config(), frick_protocol::foundation_schema())
            .await
            .unwrap()
    }

    /// POST a JSON body to the auth router, optionally with a bearer session
    /// token, returning (status, parsed body).
    async fn post(
        srv: &crate::boot::FrickServer,
        path: &str,
        token: Option<&str>,
        body: serde_json::Value,
    ) -> (axum::http::StatusCode, serde_json::Value) {
        let router = crate::auth_routes::auth_router(std::sync::Arc::clone(&srv.state));
        let mut request = axum::http::Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let request = request
            .body(axum::body::Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let parsed: serde_json::Value =
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, parsed)
    }

    async fn get(
        srv: &crate::boot::FrickServer,
        path: &str,
        token: Option<&str>,
    ) -> (axum::http::StatusCode, serde_json::Value) {
        let router = crate::auth_routes::auth_router(std::sync::Arc::clone(&srv.state));
        let mut request = axum::http::Request::builder().method("GET").uri(path);
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let request = request.body(axum::body::Body::empty()).unwrap();
        let response = router.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let parsed: serde_json::Value =
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, parsed)
    }

    /// Sign up an email account; returns (session token, user id, email).
    async fn signup(srv: &crate::boot::FrickServer, email: &str) -> (String, String, String) {
        let (status, body) = post(
            srv,
            "/auth/email/signup",
            None,
            json!({ "email": email, "password": "correct-horse-battery" }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::CREATED, "signup: {body}");
        (
            body["session"]["sessionToken"].as_str().unwrap().to_owned(),
            body["session"]["userId"].as_str().unwrap().to_owned(),
            email.to_owned(),
        )
    }

    fn login_body(email: &str, verifier: Option<&str>) -> serde_json::Value {
        let mut body = json!({ "email": email, "password": "correct-horse-battery" });
        if let Some(verifier) = verifier {
            body["recoveryPinVerifier"] = json!(verifier);
        }
        body
    }

    #[tokio::test]
    async fn enable_disable_lifecycle_gates_and_ungates_login() {
        let mut srv = server().await;
        let (token, _user, email) = signup(&srv, "reg@example.com").await;

        // Fresh account: status disabled, login needs no PIN.
        let (status, body) = get(&srv, "/auth/reglock/status", Some(&token)).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(body["enabled"], false);
        let (status, _) = post(&srv, "/auth/email/login", None, login_body(&email, None)).await;
        assert_eq!(status, axum::http::StatusCode::OK, "unlocked login");

        // Enable.
        let (status, body) = post(
            &srv,
            "/auth/reglock/enable",
            Some(&token),
            json!({ "verifier": VERIFIER, "salt": SALT }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "enable: {body}");
        let (_, body) = get(&srv, "/auth/reglock/status", Some(&token)).await;
        assert_eq!(body["enabled"], true);

        // Locked: password alone is refused with the 423 challenge carrying
        // the salt + shared KDF parameters.
        let (status, body) = post(&srv, "/auth/email/login", None, login_body(&email, None)).await;
        assert_eq!(status, axum::http::StatusCode::LOCKED, "challenge: {body}");
        assert_eq!(body["error"], "registrationLock");
        assert_eq!(body["reason"], "pinRequired");
        assert_eq!(body["reglock"]["kdf"], REGLOCK_KDF);
        assert_eq!(body["reglock"]["iterations"], REGLOCK_PBKDF2_ITERATIONS);
        assert_eq!(body["reglock"]["saltBase64"], SALT);

        // Correct verifier: session minted (wrapped email-login envelope).
        let (status, body) = post(
            &srv,
            "/auth/email/login",
            None,
            login_body(&email, Some(VERIFIER)),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "pin login: {body}");
        assert!(body["session"]["sessionToken"].is_string());

        // Disable: back to password-only.
        let (status, _) = post(&srv, "/auth/reglock/disable", Some(&token), json!({})).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        let (status, _) = post(&srv, "/auth/email/login", None, login_body(&email, None)).await;
        assert_eq!(status, axum::http::StatusCode::OK, "post-disable login");
        srv.close().await;
    }

    #[tokio::test]
    async fn wrong_pin_is_rejected_then_rate_limited() {
        let mut srv = server().await;
        let (token, user_id, email) = signup(&srv, "backoff@example.com").await;
        let (status, _) = post(
            &srv,
            "/auth/reglock/enable",
            Some(&token),
            json!({ "verifier": VERIFIER, "salt": SALT }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);

        // Two wrong attempts: rejected, not yet locked out.
        for _ in 0..2 {
            let (status, body) = post(
                &srv,
                "/auth/email/login",
                None,
                login_body(&email, Some(WRONG_VERIFIER)),
            )
            .await;
            assert_eq!(status, axum::http::StatusCode::LOCKED);
            assert_eq!(body["reason"], "pinIncorrect");
            assert_eq!(body["reglock"]["retryAfterSeconds"], 0);
        }
        // Third wrong attempt crosses the threshold: backoff starts.
        let (status, body) = post(
            &srv,
            "/auth/email/login",
            None,
            login_body(&email, Some(WRONG_VERIFIER)),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::LOCKED);
        assert_eq!(body["reason"], "pinIncorrect");
        assert_eq!(body["reglock"]["failedAttempts"], 3);
        assert!(body["reglock"]["retryAfterSeconds"].as_i64().unwrap() >= 1);

        // While locked out, even the CORRECT verifier is refused.
        let (status, body) = post(
            &srv,
            "/auth/email/login",
            None,
            login_body(&email, Some(VERIFIER)),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::LOCKED, "lockout: {body}");
        assert_eq!(body["reason"], "rateLimited");
        assert!(body["reglock"]["retryAfterSeconds"].as_i64().unwrap() >= 1);

        // Clear the lockout window (as if it elapsed), then the correct
        // verifier gets in and resets the counters.
        srv.state
            .store
            .registration_locks()
            .register_success(DEFAULT_TENANT_ID, &user_id, now_ms())
            .await
            .unwrap();
        let (status, _) = post(
            &srv,
            "/auth/email/login",
            None,
            login_body(&email, Some(VERIFIER)),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        srv.close().await;
    }

    #[tokio::test]
    async fn inactivity_expiry_bypasses_the_lock() {
        let mut srv = server().await;
        let (token, user_id, email) = signup(&srv, "expired@example.com").await;
        let (status, _) = post(
            &srv,
            "/auth/reglock/enable",
            Some(&token),
            json!({ "verifier": VERIFIER, "salt": SALT }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);

        // Backdate the last authenticated activity past the 7-day window.
        let eight_days_ago = now_ms() - 8 * 24 * 60 * 60 * 1_000;
        srv.state
            .store
            .registration_locks()
            .touch_activity(DEFAULT_TENANT_ID, &user_id, eight_days_ago)
            .await
            .unwrap();

        // Signal-style expiry: password alone re-registers, no PIN demanded.
        let (status, body) = post(&srv, "/auth/email/login", None, login_body(&email, None)).await;
        assert_eq!(status, axum::http::StatusCode::OK, "expiry bypass: {body}");

        // The lock row is untouched (still enabled) — only enforcement lapsed.
        let record = srv
            .state
            .store
            .registration_locks()
            .read(DEFAULT_TENANT_ID, &user_id)
            .await
            .unwrap()
            .unwrap();
        assert!(record.enabled);
        srv.close().await;
    }

    #[tokio::test]
    async fn handle_login_route_is_gated_too() {
        let mut srv = server().await;
        // Create a handle/password account via /auth/signup.
        let (status, body) = post(
            &srv,
            "/auth/signup",
            None,
            json!({
                "displayName": "Ada L",
                "handle": "ada-reglock",
                "password": "correct-horse-battery",
            }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::CREATED, "signup: {body}");
        let token = body["sessionToken"].as_str().unwrap().to_owned();

        let (status, _) = post(
            &srv,
            "/auth/reglock/enable",
            Some(&token),
            json!({ "verifier": VERIFIER, "salt": SALT }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);

        // `/auth/login` without the verifier: challenged.
        let (status, body) = post(
            &srv,
            "/auth/login",
            None,
            json!({ "identity": "ada-reglock", "password": "correct-horse-battery" }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::LOCKED, "challenge: {body}");
        assert_eq!(body["reason"], "pinRequired");

        // With the verifier: session minted (flat login response shape).
        let (status, body) = post(
            &srv,
            "/auth/login",
            None,
            json!({
                "identity": "ada-reglock",
                "password": "correct-horse-battery",
                "recoveryPinVerifier": VERIFIER,
            }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "pin login: {body}");
        assert!(body["sessionToken"].is_string());
        srv.close().await;
    }

    #[tokio::test]
    async fn management_routes_require_a_session_and_a_valid_body() {
        let mut srv = server().await;
        // No session token ⇒ 401.
        let (status, _) = post(
            &srv,
            "/auth/reglock/enable",
            None,
            json!({ "verifier": VERIFIER, "salt": SALT }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
        let (status, _) = post(&srv, "/auth/reglock/disable", None, json!({})).await;
        assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
        let (status, _) = get(&srv, "/auth/reglock/status", None).await;
        assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);

        // Authenticated but missing fields ⇒ 400.
        let (token, _, _) = signup(&srv, "badbody@example.com").await;
        let (status, _) = post(&srv, "/auth/reglock/enable", Some(&token), json!({})).await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        let (status, _) = post(
            &srv,
            "/auth/reglock/enable",
            Some(&token),
            json!({ "verifier": VERIFIER, "salt": "" }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        srv.close().await;
    }

    #[tokio::test]
    async fn change_pin_replaces_the_verifier() {
        let mut srv = server().await;
        let (token, _, email) = signup(&srv, "change@example.com").await;
        for (verifier, salt) in [(VERIFIER, SALT), (WRONG_VERIFIER, "bmV3LXNhbHQ=")] {
            let (status, _) = post(
                &srv,
                "/auth/reglock/enable",
                Some(&token),
                json!({ "verifier": verifier, "salt": salt }),
            )
            .await;
            assert_eq!(status, axum::http::StatusCode::OK);
        }
        // Old verifier no longer works; the challenge advertises the new salt.
        let (status, body) = post(&srv, "/auth/email/login", None, login_body(&email, None)).await;
        assert_eq!(status, axum::http::StatusCode::LOCKED);
        assert_eq!(body["reglock"]["saltBase64"], "bmV3LXNhbHQ=");
        let (status, _) = post(
            &srv,
            "/auth/email/login",
            None,
            login_body(&email, Some(VERIFIER)),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::LOCKED, "old verifier out");
        let (status, _) = post(
            &srv,
            "/auth/email/login",
            None,
            login_body(&email, Some(WRONG_VERIFIER)),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "new verifier in");
        srv.close().await;
    }

    #[test]
    fn reglock_expiry_is_env_configurable_with_a_7_day_default() {
        let mut env = BTreeMap::new();
        env.insert("FRICK_ENV".to_string(), "test".to_string());
        let config = load_frick_config(&env).unwrap();
        assert_eq!(config.reglock_expiry_seconds, 604_800);

        env.insert(
            "FRICK_REGLOCK_EXPIRY_SECONDS".to_string(),
            "3600".to_string(),
        );
        let config = load_frick_config(&env).unwrap();
        assert_eq!(config.reglock_expiry_seconds, 3_600);
    }
}
