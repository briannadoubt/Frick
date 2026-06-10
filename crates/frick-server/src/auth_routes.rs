//! Built-in password / demo auth routes (`src/server.ts:1443-1607`).
//!
//! `/auth/signup`, `/auth/login`, `/auth/dev-login`, `/auth/logout`. All set
//! no-store cache headers, run the tenant pre-check and the fixed-window
//! auth-attempt limiter, and mint sessions with a 32-byte base64url token.

use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use frick_store::stores::account::CreateAccountInput;
use frick_store::stores::session::CreateSessionInput;
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;

use crate::error::{LimitKind, ServerError};
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
        // Anti-enumeration constant-work, then a uniform 401.
        let _ = state
            .store
            .accounts()
            .verify_dummy_password(&body.password)
            .await;
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

async fn logout(State(state): State<AppState>, Json(body): Json<LogoutBody>) -> Response {
    let request_id = new_request_id();
    let Some(token) = body.session_token else {
        return respond_error(
            &ServerError::Authentication {
                message: "session token required".into(),
            },
            &request_id,
        );
    };
    let _ = state.store.sessions().delete(&token).await;
    // TODO(FR-243 gateway): also live-disconnect the WS via gateway.close_session(token).
    Json(json!({ "ok": true })).into_response()
}

/// A minted session token + its expiry.
struct MintedSession {
    token: String,
    expires_at: String,
}

async fn mint_session(
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
async fn precheck(
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
fn random_token(byte_length: usize) -> String {
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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn new_request_id() -> String {
    format!("req-{}", uuid::Uuid::new_v4())
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
