//! Sign in with Apple / Google id-token verification routes (FR-269; map 02
//! §4.3). Ported from the deleted TS `auth/identity-routes.ts`
//! `handleAppleVerify` / `handleGoogleVerify` / `handleAppleNotifications`.
//!
//! The Rust foundation has no app-owned `userObject` (the TS read/wrote a
//! schema-defined User row). Mirroring the just-landed email-auth routes
//! (FR-268), the provider subject IS the account handle — `apple:<sub>` /
//! `google:<sub>` — so find-or-create is the indexed `(tenant, LOWER(handle))`
//! account lookup, never a scan. On success we mint a session and return the
//! SAME flat session response shape as `/auth/email/login`.
//!
//! Security: all verification flows through
//! [`crate::auth::verify::verify_id_token`], which pins RS256, validates
//! `exp`/`iss`/`aud`/`nonce`, and resolves keys via the injectable
//! [`JwksProvider`] seam. EVERY verification failure collapses to one generic
//! 401 — no oracle about which check failed (matches the TS, which returned a
//! single `*_token_invalid`). The provider-verify routes share the AuthLimiter
//! under the labels `apple-verify` / `google-verify`, keyed by client IP (the
//! id-token isn't a stable per-user identifier yet, mirroring the TS FR-29
//! note).

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use frick_store::stores::account::CreateAccountInput;
use serde::Deserialize;
use serde_json::json;

use crate::auth::jwks::JwksProvider;
use crate::auth::verify::{
    APPLE_ISSUER, APPLE_JWKS_URI, GOOGLE_ISSUERS, GOOGLE_JWKS_URI, VerifiedIdentity, VerifyParams,
    verify_id_token,
};
use crate::auth_routes::{client_ip, mint_session, new_request_id, now_ms, precheck, random_token};
use crate::error::ServerError;
use crate::http::{AppState, no_store_headers, respond_error};
use crate::principal::DEFAULT_TENANT_ID;

/// The JWKS provider seam shared by the provider-verify routes. Production wires
/// [`crate::auth::jwks::ReqwestJwksProvider`]; tests inject a fixed key set.
pub type SharedJwksProvider = Arc<dyn JwksProvider>;

/// The provider-verify routes: `POST /auth/apple/verify`, `/auth/google/verify`,
/// `/auth/apple/notifications`, and `/auth/oidc/:id/verify` (FR-270). The JWKS
/// provider is closed over via per-route state so it can be injected.
pub fn provider_auth_router(state: AppState, jwks: SharedJwksProvider) -> axum::Router {
    let ctx = ProviderCtx { state, jwks };
    axum::Router::new()
        .route("/auth/apple/verify", post(apple_verify))
        .route("/auth/google/verify", post(google_verify))
        .route("/auth/apple/notifications", post(apple_notifications))
        // Generic OIDC id-token verify, one route covering every configured
        // provider; the `:id` segment selects the provider (FR-270).
        .route("/auth/oidc/:id/verify", post(oidc_verify))
        .with_state(ctx)
}

/// Per-route state: the app state + the injectable JWKS provider.
#[derive(Clone)]
struct ProviderCtx {
    state: AppState,
    jwks: SharedJwksProvider,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppleVerifyBody {
    identity_token: Option<String>,
    nonce: Option<String>,
    device_id: Option<String>,
    replica_id: Option<String>,
    tenant_id: Option<String>,
    /// Apple delivers the user's name to the client only on the first sign-in;
    /// the client forwards it. Used as the default display name.
    full_name: Option<AppleFullName>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppleFullName {
    given_name: Option<String>,
    family_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleVerifyBody {
    id_token: Option<String>,
    nonce: Option<String>,
    device_id: Option<String>,
    replica_id: Option<String>,
    tenant_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppleNotificationsBody {
    payload: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OidcVerifyBody {
    id_token: Option<String>,
    nonce: Option<String>,
    device_id: Option<String>,
    replica_id: Option<String>,
    tenant_id: Option<String>,
}

/// `POST /auth/apple/verify`.
async fn apple_verify(
    State(ctx): State<ProviderCtx>,
    headers: HeaderMap,
    Json(body): Json<AppleVerifyBody>,
) -> Response {
    let request_id = new_request_id();
    let state = &ctx.state;

    // Not configured (no audiences) ⇒ 404 provider-not-configured, NEVER accept
    // an unaudienced token.
    if state.config.apple_audiences.is_empty() {
        return provider_not_configured(&request_id, "apple");
    }

    let tenant_id = body
        .tenant_id
        .clone()
        .unwrap_or_else(|| DEFAULT_TENANT_ID.to_string());
    let now = now_ms();

    // Shared AuthLimiter (label "apple-verify") keyed by client IP — the
    // identityToken isn't a stable per-user identifier yet (TS FR-29).
    if let Err(error) = precheck(state, "apple-verify", &tenant_id, &client_ip(&headers), now).await
    {
        return respond_error(&error, &request_id);
    }

    let Some(token) = body.identity_token.as_deref().filter(|t| !t.is_empty()) else {
        return respond_error(&bad_request("identityToken required"), &request_id);
    };

    let params = VerifyParams {
        issuers: &[APPLE_ISSUER],
        jwks_uri: APPLE_JWKS_URI,
        audiences: &state.config.apple_audiences,
        expected_nonce: body.nonce.as_deref(),
    };
    let verified = match verify_id_token(token, &params, ctx.jwks.as_ref(), now).await {
        Ok(verified) => verified,
        Err(error) => {
            tracing::info!(
                target: "frick.auth",
                provider = "apple",
                code = error.code(),
                "frick.auth.apple_verify_failed"
            );
            return respond_error(&invalid_provider_token(), &request_id);
        }
    };

    let display_name = apple_display_name(body.full_name.as_ref(), verified.email.as_deref());
    finish_provider_login(
        state,
        &request_id,
        "apple",
        &tenant_id,
        &verified,
        &display_name,
        body.device_id,
        body.replica_id,
        now,
    )
    .await
}

/// `POST /auth/google/verify`.
async fn google_verify(
    State(ctx): State<ProviderCtx>,
    headers: HeaderMap,
    Json(body): Json<GoogleVerifyBody>,
) -> Response {
    let request_id = new_request_id();
    let state = &ctx.state;

    if state.config.google_client_ids.is_empty() {
        return provider_not_configured(&request_id, "google");
    }

    let tenant_id = body
        .tenant_id
        .clone()
        .unwrap_or_else(|| DEFAULT_TENANT_ID.to_string());
    let now = now_ms();

    if let Err(error) = precheck(
        state,
        "google-verify",
        &tenant_id,
        &client_ip(&headers),
        now,
    )
    .await
    {
        return respond_error(&error, &request_id);
    }

    let Some(token) = body.id_token.as_deref().filter(|t| !t.is_empty()) else {
        return respond_error(&bad_request("idToken required"), &request_id);
    };

    let params = VerifyParams {
        issuers: &GOOGLE_ISSUERS,
        jwks_uri: GOOGLE_JWKS_URI,
        audiences: &state.config.google_client_ids,
        expected_nonce: body.nonce.as_deref(),
    };
    let verified = match verify_id_token(token, &params, ctx.jwks.as_ref(), now).await {
        Ok(verified) => verified,
        Err(error) => {
            tracing::info!(
                target: "frick.auth",
                provider = "google",
                code = error.code(),
                "frick.auth.google_verify_failed"
            );
            return respond_error(&invalid_provider_token(), &request_id);
        }
    };

    // Google's id_token carries `name` directly (no first-sign-in dance).
    let display_name = verified
        .name
        .clone()
        .or_else(|| verified.email.as_deref().map(email_local_part))
        .unwrap_or_else(|| "Frick user".to_string());
    finish_provider_login(
        state,
        &request_id,
        "google",
        &tenant_id,
        &verified,
        &display_name,
        body.device_id,
        body.replica_id,
        now,
    )
    .await
}

/// `POST /auth/oidc/:id/verify` (FR-270). The generic OIDC id-token verify:
/// where Apple/Google hard-wire one issuer, this selects a configured provider
/// by the `:id` path segment and verifies the id-token against THAT provider's
/// issuer / audiences / JWKS endpoint through the SAME [`verify_id_token`] path.
///
/// Differences from Apple/Google (ported from the deleted TS `handleOidcVerify`
/// in `auth/identity-routes.ts`):
/// - An unknown / unconfigured `{id}` is a 404 `providerNotConfigured` — we
///   never accept a token for a provider we don't have an issuer/JWKS for.
/// - The account handle is provider-id-scoped (`oidc:<id>:<sub>`) so two OIDC
///   issuers that reuse the same `sub` can never alias onto one account.
/// - The AuthLimiter label is `oidc-verify:<id>` (per-provider, keyed by IP).
/// - **A nonce is REQUIRED** here (OIDC replay defense): the request must carry
///   a `nonce` and it must match the token's `nonce` claim. A missing nonce is a
///   generic 401, exactly like a mismatched one — no oracle.
async fn oidc_verify(
    State(ctx): State<ProviderCtx>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<OidcVerifyBody>,
) -> Response {
    let request_id = new_request_id();
    let state = &ctx.state;

    // Unknown provider id ⇒ 404 provider-not-configured. We resolve the issuer /
    // audiences / JWKS from the registry BEFORE anything else, so a token for an
    // unconfigured provider is never even verified.
    let Some(provider) = state.config.oidc_provider(&id) else {
        return provider_not_configured(&request_id, &format!("oidc:{id}"));
    };

    let tenant_id = body
        .tenant_id
        .clone()
        .unwrap_or_else(|| DEFAULT_TENANT_ID.to_string());
    let now = now_ms();

    // Shared AuthLimiter (label "oidc-verify:<id>") keyed by client IP — the
    // id-token isn't a stable per-user identifier yet (TS FR-29).
    let limiter_label = format!("oidc-verify:{id}");
    if let Err(error) = precheck(state, &limiter_label, &tenant_id, &client_ip(&headers), now).await
    {
        return respond_error(&error, &request_id);
    }

    let Some(token) = body.id_token.as_deref().filter(|t| !t.is_empty()) else {
        return respond_error(&bad_request("idToken required"), &request_id);
    };

    // OIDC enforces the nonce: it MUST be supplied and MUST match the token
    // claim. A missing nonce collapses to the same generic 401 as a mismatch so
    // the client learns nothing about which check failed.
    let Some(nonce) = body.nonce.as_deref().filter(|n| !n.is_empty()) else {
        tracing::info!(
            target: "frick.auth",
            provider = "oidc",
            id = %id,
            code = "missing_nonce",
            "frick.auth.oidc_verify_failed"
        );
        return respond_error(&invalid_provider_token(), &request_id);
    };

    let issuer = provider.issuer.clone();
    let issuers = [issuer.as_str()];
    let params = VerifyParams {
        issuers: &issuers,
        jwks_uri: &provider.jwks_uri,
        audiences: &provider.audiences,
        expected_nonce: Some(nonce),
    };
    let verified = match verify_id_token(token, &params, ctx.jwks.as_ref(), now).await {
        Ok(verified) => verified,
        Err(error) => {
            tracing::info!(
                target: "frick.auth",
                provider = "oidc",
                id = %id,
                code = error.code(),
                "frick.auth.oidc_verify_failed"
            );
            return respond_error(&invalid_provider_token(), &request_id);
        }
    };

    // Standard OIDC display-name resolution: `name`, else the email local-part,
    // else a generic fallback (mirrors the TS `defaultDisplayName`).
    let display_name = verified
        .name
        .clone()
        .or_else(|| verified.email.as_deref().map(email_local_part))
        .unwrap_or_else(|| "Frick user".to_string());

    // The provider label is the id-scoped `oidc:<id>` so the handle becomes
    // `oidc:<id>:<sub>` (see `provider_handle`) — provider-id-scoped subjects.
    let provider_label = format!("oidc:{id}");
    finish_provider_login(
        state,
        &request_id,
        &provider_label,
        &tenant_id,
        &verified,
        &display_name,
        body.device_id,
        body.replica_id,
        now,
    )
    .await
}

/// `POST /auth/apple/notifications`: Apple's server-to-server webhook for
/// account changes (consent revoked / account deleted / email enabled-disabled-
/// updated). The body is `{ "payload": "<JWT>" }`; the JWT carries the same
/// `iss`/`aud` as an id-token. We verify it against Apple's keys, then for a
/// revoke/delete event wipe the user's sessions + refresh tokens so a revoked
/// user can't keep minting access. Unknown subjects / unknown event types are
/// acknowledged as a no-op 200 (matches the TS).
async fn apple_notifications(
    State(ctx): State<ProviderCtx>,
    Json(body): Json<AppleNotificationsBody>,
) -> Response {
    let request_id = new_request_id();
    let state = &ctx.state;

    if state.config.apple_audiences.is_empty() {
        return provider_not_configured(&request_id, "apple");
    }

    let Some(payload) = body.payload.as_deref().filter(|p| !p.is_empty()) else {
        return respond_error(&bad_request("payload required"), &request_id);
    };

    let now = now_ms();
    // Verify the notification JWT exactly like an id-token (same RS256/iss/aud
    // pins). The notification's change details live in an `events` claim that
    // `verify_id_token` ignores — but `sub` is the subject we key on, which is
    // what we need to apply the revoke.
    let params = VerifyParams {
        issuers: &[APPLE_ISSUER],
        jwks_uri: APPLE_JWKS_URI,
        audiences: &state.config.apple_audiences,
        expected_nonce: None,
    };
    let verified = match verify_id_token(payload, &params, ctx.jwks.as_ref(), now).await {
        Ok(verified) => verified,
        Err(error) => {
            tracing::info!(
                target: "frick.auth",
                provider = "apple",
                code = error.code(),
                "frick.auth.apple_notification_invalid"
            );
            return respond_error(&invalid_provider_token(), &request_id);
        }
    };

    // Parse the `events` claim (Apple stringifies a JSON object inside the JWT)
    // to learn the change type. The signature is already verified above.
    let event = parse_apple_notification_event(payload);

    let handle = provider_handle("apple", &verified.subject);
    let account = state
        .store
        .accounts()
        .read_by_identity(DEFAULT_TENANT_ID, &handle)
        .await
        .unwrap_or(None);

    let Some(account) = account else {
        // Unknown subject ⇒ acknowledged no-op (TS `applied: false`).
        return (
            no_store_headers(),
            Json(json!({ "ok": true, "applied": false, "reason": "unknown_user" })),
        )
            .into_response();
    };

    let event_type = event.as_deref().unwrap_or("");
    match event_type {
        "consent-revoked" | "account-delete" => {
            // Revoke: kill sessions + refresh tokens so the disconnected user
            // can't mint fresh access (mirrors the TS revoke path).
            let killed = state
                .store
                .sessions()
                .delete_for_user(&account.user_id, Some(DEFAULT_TENANT_ID))
                .await
                .unwrap_or(0);
            let _ = state
                .store
                .refresh_tokens()
                .revoke_for_user(&account.user_id, Some(DEFAULT_TENANT_ID), now)
                .await;
            tracing::info!(
                target: "frick.auth",
                provider = "apple",
                event_type,
                user_id = %account.user_id,
                sessions_killed = killed,
                "frick.auth.apple_notification_applied"
            );
            (
                no_store_headers(),
                Json(json!({
                    "ok": true,
                    "applied": true,
                    "type": event_type,
                    "sessionsKilled": killed,
                })),
            )
                .into_response()
        }
        // email-enabled / email-disabled / email-updated / unknown future types
        // ⇒ acknowledged without a session change (matches the TS, which logged
        // and returned applied:true for the email-* types and a no-op for the
        // default). The framework has no app-owned email field to update here.
        _ => {
            tracing::info!(
                target: "frick.auth",
                provider = "apple",
                event_type,
                user_id = %account.user_id,
                "frick.auth.apple_notification_ack"
            );
            (
                no_store_headers(),
                Json(json!({ "ok": true, "applied": false, "type": event_type })),
            )
                .into_response()
        }
    }
}

/// Find-or-create the account keyed on the provider subject (`apple:<sub>` /
/// `google:<sub>`), then mint a session and render the email-login-shaped
/// success body. The find-or-create is idempotent: a second sign-in reuses the
/// existing account.
#[allow(clippy::too_many_arguments)]
async fn finish_provider_login(
    state: &AppState,
    request_id: &str,
    provider: &str,
    tenant_id: &str,
    verified: &VerifiedIdentity,
    display_name: &str,
    device_id: Option<String>,
    replica_id: Option<String>,
    now_ms: i64,
) -> Response {
    let handle = provider_handle(provider, &verified.subject);

    // Indexed lookup by subject-handle (find).
    let existing = state
        .store
        .accounts()
        .read_by_identity(tenant_id, &handle)
        .await
        .unwrap_or(None);

    let (user_id, display_name, is_new_user) = if let Some(account) = existing {
        (account.user_id, account.display_name, false)
    } else {
        // Create. The password is never used (provider-backed identity); a
        // random one is stored, mirroring `dev_login`'s auto-create.
        let user_id = format!("user-{provider}-{}", random_token(16));
        let created = state
            .store
            .accounts()
            .create(
                &CreateAccountInput {
                    tenant_id: tenant_id.to_string(),
                    user_id: user_id.clone(),
                    handle: handle.clone(),
                    display_name: display_name.to_string(),
                    password: random_token(32),
                },
                now_ms,
            )
            .await;
        match created {
            Ok(account) => (account.user_id, account.display_name, true),
            Err(_) => {
                // A concurrent first sign-in won the create race; fall back to
                // the now-existing row so the login still succeeds idempotently.
                match state
                    .store
                    .accounts()
                    .read_by_identity(tenant_id, &handle)
                    .await
                    .unwrap_or(None)
                {
                    Some(account) => (account.user_id, account.display_name, false),
                    None => return respond_error(&ServerError::Internal, request_id),
                }
            }
        }
    };

    let device_id = device_id.unwrap_or_else(|| format!("device-{}", random_token(12)));
    let replica_id = replica_id.unwrap_or_else(|| format!("replica-{}", random_token(12)));
    let session =
        match mint_session(state, tenant_id, &user_id, &device_id, &replica_id, now_ms).await {
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
            "schemaHash": state.schema.hash,
            "sessionToken": session.token,
            "tenantId": tenant_id,
            "userId": user_id,
            "displayName": display_name,
            "email": verified.email,
            "handle": handle,
            "provider": provider,
            "deviceId": device_id,
            "replicaId": replica_id,
            "expiresAt": session.expires_at,
            "isNewUser": is_new_user,
        })),
    )
        .into_response()
}

/// The stable account handle for a provider subject (`apple:<sub>` /
/// `google:<sub>`), mirroring how email-auth used the email as the handle.
fn provider_handle(provider: &str, subject: &str) -> String {
    format!("{provider}:{subject}")
}

/// The Apple default display name: `givenName familyName` if the client
/// forwarded the name on first sign-in, else the email local-part, else a
/// generic fallback (mirrors the TS `derivedDisplayName`).
fn apple_display_name(full_name: Option<&AppleFullName>, email: Option<&str>) -> String {
    if let Some(name) = full_name {
        let parts: Vec<&str> = [name.given_name.as_deref(), name.family_name.as_deref()]
            .into_iter()
            .flatten()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if !parts.is_empty() {
            return parts.join(" ");
        }
    }
    email.map_or_else(|| "Frick user".to_string(), email_local_part)
}

/// The email local-part (`email.split("@")[0]`).
fn email_local_part(email: &str) -> String {
    email.split('@').next().unwrap_or(email).to_string()
}

/// Parse the `events` claim from a verified Apple notification JWT to extract
/// the change `type`. Apple JSON-stringifies the events object inside the JWT;
/// some versions inline it as an object. The signature is verified separately
/// — this only reads the already-trusted payload for the event type.
fn parse_apple_notification_event(jwt: &str) -> Option<String> {
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let payload_b64 = jwt.split('.').nth(1)?;
    let payload = URL_SAFE_NO_PAD.decode(payload_b64).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&payload).ok()?;
    let raw_events = claims.get("events")?;
    let events: serde_json::Value = match raw_events {
        serde_json::Value::String(text) => serde_json::from_str(text).ok()?,
        other => other.clone(),
    };
    events
        .get("type")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

/// The generic 401 every provider-verify failure collapses to — no oracle about
/// which specific check failed (matches the TS single `*_token_invalid`).
fn invalid_provider_token() -> ServerError {
    ServerError::Authentication {
        message: "Invalid credentials".into(),
    }
}

/// A 400 `sync.protocolError` with a custom message.
fn bad_request(message: &str) -> ServerError {
    ServerError::BadRequest {
        message: message.to_string(),
    }
}

/// The 404 returned when a provider has no configured audience(s): refuse to
/// accept an unaudienced token rather than minting a session for it.
fn provider_not_configured(request_id: &str, provider: &str) -> Response {
    respond_error(
        &ServerError::ProviderNotConfigured {
            provider: provider.to_string(),
        },
        request_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::jwks::{FixedJwksProvider, Jwks, RsaJwk};
    use crate::boot::create_frick_server;
    use crate::config::load_frick_config;
    use crate::session::principal_from_active_session_token;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
    use rsa::RsaPrivateKey;
    use rsa::pkcs1v15::SigningKey;
    use rsa::pkcs8::DecodePrivateKey;
    use rsa::sha2::Sha256;
    use rsa::signature::{SignatureEncoding, Signer};
    use rsa::traits::PublicKeyParts;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::sync::OnceLock;

    const KID: &str = "test-key-1";
    const APPLE_AUD: &str = "com.example.frick";
    const GOOGLE_AUD: &str = "client-123.apps.googleusercontent.com";
    const OIDC_ID: &str = "okta";
    const OIDC_ISSUER: &str = "https://example.okta.com";
    const OIDC_AUD: &str = "0oa-client-okta";
    const OIDC_JWKS_URI: &str = "https://example.okta.com/oauth2/v1/keys";

    fn test_key() -> &'static RsaPrivateKey {
        static KEY: OnceLock<RsaPrivateKey> = OnceLock::new();
        KEY.get_or_init(|| {
            let pem = include_str!("../push/test_rsa_key.pem");
            RsaPrivateKey::from_pkcs8_pem(pem).expect("valid test RSA key")
        })
    }

    fn test_jwks() -> Jwks {
        let key = test_key();
        Jwks::new(vec![RsaJwk {
            kid: KID.to_string(),
            n: B64.encode(key.n().to_bytes_be()),
            e: B64.encode(key.e().to_bytes_be()),
        }])
    }

    #[allow(clippy::needless_pass_by_value)]
    fn sign(claims: serde_json::Value) -> String {
        let header = json!({ "alg": "RS256", "typ": "JWT", "kid": KID });
        let header_b64 = B64.encode(serde_json::to_vec(&header).unwrap());
        let payload_b64 = B64.encode(serde_json::to_vec(&claims).unwrap());
        let signing_input = format!("{header_b64}.{payload_b64}");
        let signing_key = SigningKey::<Sha256>::new(test_key().clone());
        let signature = signing_key.sign(signing_input.as_bytes());
        format!("{signing_input}.{}", B64.encode(signature.to_bytes()))
    }

    fn now_seconds() -> i64 {
        now_ms() / 1000
    }

    fn test_config() -> crate::config::FrickConfig {
        let mut env = BTreeMap::new();
        env.insert("FRICK_ENV".to_string(), "test".to_string());
        env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
        env.insert("FRICK_PORT".to_string(), "0".to_string());
        env.insert("FRICK_APPLE_AUDIENCES".to_string(), APPLE_AUD.to_string());
        env.insert(
            "FRICK_GOOGLE_CLIENT_IDS".to_string(),
            GOOGLE_AUD.to_string(),
        );
        env.insert(
            "FRICK_OIDC_PROVIDERS".to_string(),
            format!(
                r#"[{{"id":"{OIDC_ID}","issuer":"{OIDC_ISSUER}",
                     "audiences":["{OIDC_AUD}"],"jwksUri":"{OIDC_JWKS_URI}"}}]"#
            ),
        );
        load_frick_config(&env).unwrap()
    }

    async fn server() -> crate::boot::FrickServer {
        create_frick_server(test_config(), frick_protocol::foundation_schema())
            .await
            .unwrap()
    }

    fn provider() -> SharedJwksProvider {
        Arc::new(FixedJwksProvider::new(test_jwks()))
    }

    /// Build a router with the injected fixed JWKS and POST a JSON body to it,
    /// returning the (status, body) of the response.
    async fn post(
        srv: &crate::boot::FrickServer,
        path: &str,
        body: serde_json::Value,
    ) -> (axum::http::StatusCode, serde_json::Value) {
        use tower::ServiceExt;
        let router = provider_auth_router(Arc::clone(&srv.state), provider());
        let request = axum::http::Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json")
            .body(axum::body::Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    #[tokio::test]
    async fn apple_verify_mints_session_and_creates_account() {
        let mut srv = server().await;
        let token = sign(json!({
            "iss": APPLE_ISSUER,
            "sub": "apple-sub-A",
            "aud": APPLE_AUD,
            "exp": now_seconds() + 3600,
            "email": "ada@example.com",
            "email_verified": "true",
        }));
        let (status, body) = post(
            &srv,
            "/auth/apple/verify",
            json!({ "identityToken": token }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::CREATED, "body: {body}");
        assert_eq!(body["isNewUser"], true);
        assert_eq!(body["handle"], "apple:apple-sub-A");
        assert_eq!(body["provider"], "apple");

        // The minted session resolves to a principal (end-to-end auth).
        let token = body["sessionToken"].as_str().unwrap();
        let principal = principal_from_active_session_token(&srv.state.store, token, now_ms())
            .await
            .unwrap();
        assert_eq!(principal.user_id, body["userId"].as_str().unwrap());

        // The account exists under the subject handle.
        assert!(
            srv.state
                .store
                .accounts()
                .read_by_identity(DEFAULT_TENANT_ID, "apple:apple-sub-A")
                .await
                .unwrap()
                .is_some()
        );
        srv.close().await;
    }

    #[tokio::test]
    async fn google_verify_mints_session_and_creates_account() {
        let mut srv = server().await;
        let token = sign(json!({
            "iss": "accounts.google.com",
            "sub": "google-sub-G",
            "aud": GOOGLE_AUD,
            "exp": now_seconds() + 600,
            "email": "grace@example.com",
            "email_verified": true,
            "name": "Grace Hopper",
        }));
        let (status, body) = post(&srv, "/auth/google/verify", json!({ "idToken": token })).await;
        assert_eq!(status, axum::http::StatusCode::CREATED, "body: {body}");
        assert_eq!(body["displayName"], "Grace Hopper");
        assert_eq!(body["handle"], "google:google-sub-G");
        srv.close().await;
    }

    #[tokio::test]
    async fn find_or_create_is_idempotent() {
        let mut srv = server().await;
        let claims = json!({
            "iss": APPLE_ISSUER, "sub": "apple-sub-idem", "aud": APPLE_AUD,
            "exp": now_seconds() + 3600,
        });
        let token = sign(claims);

        let (s1, b1) = post(
            &srv,
            "/auth/apple/verify",
            json!({ "identityToken": token }),
        )
        .await;
        assert_eq!(s1, axum::http::StatusCode::CREATED);
        assert_eq!(b1["isNewUser"], true);
        let first_user = b1["userId"].as_str().unwrap().to_string();

        // Second sign-in reuses the account: 200, not 201, same userId.
        let (s2, b2) = post(
            &srv,
            "/auth/apple/verify",
            json!({ "identityToken": token }),
        )
        .await;
        assert_eq!(s2, axum::http::StatusCode::OK);
        assert_eq!(b2["isNewUser"], false);
        assert_eq!(b2["userId"].as_str().unwrap(), first_user);
        srv.close().await;
    }

    #[tokio::test]
    async fn rejects_wrong_audience_with_generic_401() {
        let mut srv = server().await;
        let token = sign(json!({
            "iss": APPLE_ISSUER, "sub": "s", "aud": "com.attacker.app",
            "exp": now_seconds() + 3600,
        }));
        let (status, body) = post(
            &srv,
            "/auth/apple/verify",
            json!({ "identityToken": token }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED, "body: {body}");
        // Generic auth code — no oracle about WHICH check failed.
        assert_eq!(body["code"], "auth.unauthenticated");
        srv.close().await;
    }

    #[tokio::test]
    async fn rejects_alg_none_and_hs256_forgery() {
        let mut srv = server().await;
        let claims = json!({
            "iss": APPLE_ISSUER, "sub": "s", "aud": APPLE_AUD, "exp": now_seconds() + 3600,
        });
        let payload_b64 = B64.encode(serde_json::to_vec(&claims).unwrap());

        for alg in ["none", "HS256"] {
            let header_b64 =
                B64.encode(serde_json::to_vec(&json!({ "alg": alg, "kid": KID })).unwrap());
            let token = format!("{header_b64}.{payload_b64}.AAAA");
            let (status, _) = post(
                &srv,
                "/auth/apple/verify",
                json!({ "identityToken": token }),
            )
            .await;
            assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED, "alg {alg}");
        }
        srv.close().await;
    }

    #[tokio::test]
    async fn rejects_expired_and_bad_signature_and_unknown_kid() {
        let mut srv = server().await;

        // Expired.
        let expired = sign(json!({
            "iss": APPLE_ISSUER, "sub": "s", "aud": APPLE_AUD, "exp": now_seconds() - 3600,
        }));
        let (s, _) = post(
            &srv,
            "/auth/apple/verify",
            json!({ "identityToken": expired }),
        )
        .await;
        assert_eq!(s, axum::http::StatusCode::UNAUTHORIZED, "expired");

        // Bad signature: valid token, but the JWKS publishes a DIFFERENT key.
        let token = sign(json!({
            "iss": APPLE_ISSUER, "sub": "s", "aud": APPLE_AUD, "exp": now_seconds() + 3600,
        }));
        let other = RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048).unwrap();
        let bad_jwks = Jwks::new(vec![RsaJwk {
            kid: KID.to_string(),
            n: B64.encode(other.n().to_bytes_be()),
            e: B64.encode(other.e().to_bytes_be()),
        }]);
        let bad_provider: SharedJwksProvider = Arc::new(FixedJwksProvider::new(bad_jwks));
        let router = provider_auth_router(Arc::clone(&srv.state), bad_provider);
        let response = {
            use tower::ServiceExt;
            let req = axum::http::Request::builder()
                .method("POST")
                .uri("/auth/apple/verify")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::to_vec(&json!({ "identityToken": token })).unwrap(),
                ))
                .unwrap();
            router.oneshot(req).await.unwrap()
        };
        assert_eq!(
            response.status(),
            axum::http::StatusCode::UNAUTHORIZED,
            "bad signature"
        );

        // Unknown kid (rotated away).
        let header_b64 =
            B64.encode(serde_json::to_vec(&json!({ "alg": "RS256", "kid": "rotated" })).unwrap());
        let payload_b64 = B64.encode(
            serde_json::to_vec(&json!({
                "iss": APPLE_ISSUER, "sub": "s", "aud": APPLE_AUD, "exp": now_seconds() + 3600,
            }))
            .unwrap(),
        );
        let signing_key = SigningKey::<Sha256>::new(test_key().clone());
        let signing_input = format!("{header_b64}.{payload_b64}");
        let sig = signing_key.sign(signing_input.as_bytes());
        let token = format!("{signing_input}.{}", B64.encode(sig.to_bytes()));
        let (s, _) = post(
            &srv,
            "/auth/apple/verify",
            json!({ "identityToken": token }),
        )
        .await;
        assert_eq!(s, axum::http::StatusCode::UNAUTHORIZED, "unknown kid");

        srv.close().await;
    }

    #[tokio::test]
    async fn provider_not_configured_when_audiences_absent() {
        // No FRICK_APPLE_AUDIENCES / FRICK_GOOGLE_CLIENT_IDS ⇒ 404.
        let mut env = BTreeMap::new();
        env.insert("FRICK_ENV".to_string(), "test".to_string());
        env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
        env.insert("FRICK_PORT".to_string(), "0".to_string());
        let config = load_frick_config(&env).unwrap();
        let mut srv = create_frick_server(config, frick_protocol::foundation_schema())
            .await
            .unwrap();

        let token = sign(json!({
            "iss": APPLE_ISSUER, "sub": "s", "aud": APPLE_AUD, "exp": now_seconds() + 3600,
        }));
        let (status, _) = post(
            &srv,
            "/auth/apple/verify",
            json!({ "identityToken": token }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
        let (status, _) = post(&srv, "/auth/google/verify", json!({ "idToken": token })).await;
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
        srv.close().await;
    }

    #[tokio::test]
    async fn apple_notification_account_delete_kills_sessions() {
        let mut srv = server().await;
        // First, sign in to create the account + a live session.
        let token = sign(json!({
            "iss": APPLE_ISSUER, "sub": "apple-sub-del", "aud": APPLE_AUD,
            "exp": now_seconds() + 3600,
        }));
        let (_, body) = post(
            &srv,
            "/auth/apple/verify",
            json!({ "identityToken": token }),
        )
        .await;
        let session_token = body["sessionToken"].as_str().unwrap().to_string();
        assert!(
            principal_from_active_session_token(&srv.state.store, &session_token, now_ms())
                .await
                .is_ok()
        );

        // Apple posts an account-delete notification for the same subject.
        let notification = sign(json!({
            "iss": APPLE_ISSUER, "aud": APPLE_AUD, "exp": now_seconds() + 3600,
            "sub": "apple-sub-del",
            "events": json!({ "type": "account-delete", "sub": "apple-sub-del" }).to_string(),
        }));
        let (status, body) = post(
            &srv,
            "/auth/apple/notifications",
            json!({ "payload": notification }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "body: {body}");
        assert_eq!(body["applied"], true);
        assert_eq!(body["type"], "account-delete");

        // The session is gone (the resolver errors on a missing/expired token).
        assert!(
            principal_from_active_session_token(&srv.state.store, &session_token, now_ms())
                .await
                .is_err(),
            "session should be revoked after account-delete"
        );
        srv.close().await;
    }

    #[tokio::test]
    async fn apple_notification_unknown_subject_is_noop() {
        let mut srv = server().await;
        let notification = sign(json!({
            "iss": APPLE_ISSUER, "aud": APPLE_AUD, "exp": now_seconds() + 3600,
            "sub": "nobody",
            "events": json!({ "type": "account-delete", "sub": "nobody" }).to_string(),
        }));
        let (status, body) = post(
            &srv,
            "/auth/apple/notifications",
            json!({ "payload": notification }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(body["applied"], false);
        assert_eq!(body["reason"], "unknown_user");
        srv.close().await;
    }

    // ----- Generic OIDC (FR-270) -----------------------------------------

    /// Mint a valid OIDC id-token for the configured `okta` provider, with an
    /// optional nonce baked into the claims.
    fn oidc_token(sub: &str, nonce: Option<&str>) -> String {
        let mut claims = json!({
            "iss": OIDC_ISSUER,
            "sub": sub,
            "aud": OIDC_AUD,
            "exp": now_seconds() + 3600,
            "email": "user@example.com",
            "email_verified": true,
            "name": "Olive C",
        });
        if let Some(nonce) = nonce {
            claims["nonce"] = json!(nonce);
        }
        sign(claims)
    }

    const OIDC_ID_2: &str = "auth0";
    const OIDC_ISSUER_2: &str = "https://example.auth0.com";

    /// A config with TWO OIDC providers that share an audience and (via the
    /// `FixedJwksProvider`) the same signing key, so issuer-pinning is the SOLE
    /// defense against cross-provider token replay.
    fn two_provider_config() -> crate::config::FrickConfig {
        let mut env = BTreeMap::new();
        env.insert("FRICK_ENV".to_string(), "test".to_string());
        env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
        env.insert("FRICK_PORT".to_string(), "0".to_string());
        env.insert(
            "FRICK_OIDC_PROVIDERS".to_string(),
            format!(
                r#"[{{"id":"{OIDC_ID}","issuer":"{OIDC_ISSUER}","audiences":["{OIDC_AUD}"],"jwksUri":"{OIDC_JWKS_URI}"}},
                     {{"id":"{OIDC_ID_2}","issuer":"{OIDC_ISSUER_2}","audiences":["{OIDC_AUD}"],"jwksUri":"{OIDC_JWKS_URI}"}}]"#
            ),
        );
        load_frick_config(&env).unwrap()
    }

    async fn two_provider_server() -> crate::boot::FrickServer {
        create_frick_server(two_provider_config(), frick_protocol::foundation_schema())
            .await
            .unwrap()
    }

    fn oidc_token_for(issuer: &str, sub: &str, nonce: &str) -> String {
        sign(json!({
            "iss": issuer,
            "sub": sub,
            "aud": OIDC_AUD,
            "exp": now_seconds() + 3600,
            "email": "user@example.com",
            "email_verified": true,
            "name": "X",
            "nonce": nonce,
        }))
    }

    /// A valid token for provider A must NOT authenticate against provider B's
    /// route — issuer-pinning prevents cross-provider account takeover even when
    /// the two providers share an audience and signing key.
    #[tokio::test]
    async fn oidc_token_for_one_provider_is_rejected_by_another() {
        let mut srv = two_provider_server().await;
        // Minted by auth0 (iss = OIDC_ISSUER_2).
        let token = oidc_token_for(OIDC_ISSUER_2, "shared-sub", "n1");

        // Replayed against okta's route ⇒ 401 (issuer mismatch is the only
        // thing standing between A's token and a B account).
        let (status, body) = post(
            &srv,
            "/auth/oidc/okta/verify",
            json!({ "idToken": token, "nonce": "n1" }),
        )
        .await;
        assert_eq!(
            status,
            axum::http::StatusCode::UNAUTHORIZED,
            "cross-provider replay must fail: {body}"
        );
        assert_eq!(body["code"], "auth.unauthenticated");

        // The same token against its OWN provider's route ⇒ 201.
        let (status, body) = post(
            &srv,
            "/auth/oidc/auth0/verify",
            json!({ "idToken": token, "nonce": "n1" }),
        )
        .await;
        assert_eq!(
            status,
            axum::http::StatusCode::CREATED,
            "own-provider must succeed: {body}"
        );
        assert_eq!(body["handle"], "oidc:auth0:shared-sub");
        srv.close().await;
    }

    /// Two providers presenting the SAME `sub` yield two DISTINCT accounts
    /// (provider-id-scoped handle), so a sub collision across IdPs cannot alias
    /// one user onto another.
    #[tokio::test]
    async fn oidc_same_sub_across_providers_is_distinct_accounts() {
        let mut srv = two_provider_server().await;
        let okta = oidc_token_for(OIDC_ISSUER, "123", "n1");
        let auth0 = oidc_token_for(OIDC_ISSUER_2, "123", "n1");

        let (s1, b1) = post(
            &srv,
            "/auth/oidc/okta/verify",
            json!({ "idToken": okta, "nonce": "n1" }),
        )
        .await;
        assert_eq!(s1, axum::http::StatusCode::CREATED);
        let (s2, b2) = post(
            &srv,
            "/auth/oidc/auth0/verify",
            json!({ "idToken": auth0, "nonce": "n1" }),
        )
        .await;
        assert_eq!(s2, axum::http::StatusCode::CREATED);

        assert_eq!(b1["handle"], "oidc:okta:123");
        assert_eq!(b2["handle"], "oidc:auth0:123");
        assert_ne!(
            b1["userId"], b2["userId"],
            "same sub, different providers ⇒ distinct accounts"
        );
        srv.close().await;
    }

    #[tokio::test]
    async fn oidc_verify_mints_session_with_matching_nonce_and_is_idempotent() {
        let mut srv = server().await;
        let token = oidc_token("oidc-sub-1", Some("nonce-abc"));

        let (status, body) = post(
            &srv,
            "/auth/oidc/okta/verify",
            json!({ "idToken": token, "nonce": "nonce-abc" }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::CREATED, "body: {body}");
        assert_eq!(body["isNewUser"], true);
        // Provider-id-scoped handle: `oidc:<id>:<sub>`.
        assert_eq!(body["handle"], "oidc:okta:oidc-sub-1");
        assert_eq!(body["provider"], "oidc:okta");
        assert_eq!(body["displayName"], "Olive C");

        // The minted session resolves to a principal (end-to-end auth).
        let session_token = body["sessionToken"].as_str().unwrap();
        let principal =
            principal_from_active_session_token(&srv.state.store, session_token, now_ms())
                .await
                .unwrap();
        assert_eq!(principal.user_id, body["userId"].as_str().unwrap());

        // Repeat ⇒ idempotent: 200 (not 201), same userId, reused account.
        let first_user = body["userId"].as_str().unwrap().to_string();
        let (s2, b2) = post(
            &srv,
            "/auth/oidc/okta/verify",
            json!({ "idToken": token, "nonce": "nonce-abc" }),
        )
        .await;
        assert_eq!(s2, axum::http::StatusCode::OK);
        assert_eq!(b2["isNewUser"], false);
        assert_eq!(b2["userId"].as_str().unwrap(), first_user);
        srv.close().await;
    }

    #[tokio::test]
    async fn oidc_verify_unknown_provider_is_404() {
        let mut srv = server().await;
        // A token that WOULD verify against `okta`, but the route id is unknown.
        let token = oidc_token("oidc-sub-x", Some("nonce-abc"));
        let (status, body) = post(
            &srv,
            "/auth/oidc/keycloak/verify",
            json!({ "idToken": token, "nonce": "nonce-abc" }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND, "body: {body}");
        srv.close().await;
    }

    #[tokio::test]
    async fn oidc_verify_requires_nonce() {
        let mut srv = server().await;

        // Token carries a nonce, but the request omits it ⇒ generic 401.
        let token = oidc_token("oidc-sub-2", Some("nonce-abc"));
        let (status, body) =
            post(&srv, "/auth/oidc/okta/verify", json!({ "idToken": token })).await;
        assert_eq!(
            status,
            axum::http::StatusCode::UNAUTHORIZED,
            "missing nonce"
        );
        assert_eq!(body["code"], "auth.unauthenticated");

        // Request supplies a nonce, but the token has none ⇒ mismatch ⇒ 401.
        let token = oidc_token("oidc-sub-2", None);
        let (status, _) = post(
            &srv,
            "/auth/oidc/okta/verify",
            json!({ "idToken": token, "nonce": "nonce-abc" }),
        )
        .await;
        assert_eq!(
            status,
            axum::http::StatusCode::UNAUTHORIZED,
            "token no nonce"
        );

        // Both present but differ ⇒ 401.
        let token = oidc_token("oidc-sub-2", Some("the-real-nonce"));
        let (status, _) = post(
            &srv,
            "/auth/oidc/okta/verify",
            json!({ "idToken": token, "nonce": "WRONG" }),
        )
        .await;
        assert_eq!(
            status,
            axum::http::StatusCode::UNAUTHORIZED,
            "nonce mismatch"
        );
        srv.close().await;
    }

    #[tokio::test]
    async fn oidc_verify_rejects_wrong_aud_and_wrong_iss() {
        let mut srv = server().await;

        // Wrong audience.
        let token = sign(json!({
            "iss": OIDC_ISSUER, "sub": "s", "aud": "some-other-client",
            "exp": now_seconds() + 3600, "nonce": "n",
        }));
        let (status, body) = post(
            &srv,
            "/auth/oidc/okta/verify",
            json!({ "idToken": token, "nonce": "n" }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED, "wrong aud");
        assert_eq!(body["code"], "auth.unauthenticated");

        // Wrong issuer (e.g. a token from a DIFFERENT IdP that reused our aud).
        let token = sign(json!({
            "iss": "https://evil.example", "sub": "s", "aud": OIDC_AUD,
            "exp": now_seconds() + 3600, "nonce": "n",
        }));
        let (status, _) = post(
            &srv,
            "/auth/oidc/okta/verify",
            json!({ "idToken": token, "nonce": "n" }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED, "wrong iss");
        srv.close().await;
    }

    #[tokio::test]
    async fn oidc_verify_rejects_expired_and_alg_forgery() {
        let mut srv = server().await;

        // Expired.
        let expired = sign(json!({
            "iss": OIDC_ISSUER, "sub": "s", "aud": OIDC_AUD,
            "exp": now_seconds() - 3600, "nonce": "n",
        }));
        let (s, _) = post(
            &srv,
            "/auth/oidc/okta/verify",
            json!({ "idToken": expired, "nonce": "n" }),
        )
        .await;
        assert_eq!(s, axum::http::StatusCode::UNAUTHORIZED, "expired");

        // alg=none / HS256 alg-confusion forgeries — rejected at the header.
        let claims = json!({
            "iss": OIDC_ISSUER, "sub": "s", "aud": OIDC_AUD,
            "exp": now_seconds() + 3600, "nonce": "n",
        });
        let payload_b64 = B64.encode(serde_json::to_vec(&claims).unwrap());
        for alg in ["none", "HS256"] {
            let header_b64 =
                B64.encode(serde_json::to_vec(&json!({ "alg": alg, "kid": KID })).unwrap());
            let token = format!("{header_b64}.{payload_b64}.AAAA");
            let (status, _) = post(
                &srv,
                "/auth/oidc/okta/verify",
                json!({ "idToken": token, "nonce": "n" }),
            )
            .await;
            assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED, "alg {alg}");
        }
        srv.close().await;
    }

    #[tokio::test]
    async fn oidc_verify_rejects_bad_signature() {
        let mut srv = server().await;
        // A token signed with the real test key, but the JWKS publishes a
        // DIFFERENT key under the same kid — signature must fail.
        let token = oidc_token("s", Some("n"));
        let other = RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048).unwrap();
        let bad_jwks = Jwks::new(vec![RsaJwk {
            kid: KID.to_string(),
            n: B64.encode(other.n().to_bytes_be()),
            e: B64.encode(other.e().to_bytes_be()),
        }]);
        let bad_provider: SharedJwksProvider = Arc::new(FixedJwksProvider::new(bad_jwks));
        let router = provider_auth_router(Arc::clone(&srv.state), bad_provider);
        let response = {
            use tower::ServiceExt;
            let req = axum::http::Request::builder()
                .method("POST")
                .uri("/auth/oidc/okta/verify")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::to_vec(&json!({ "idToken": token, "nonce": "n" })).unwrap(),
                ))
                .unwrap();
            router.oneshot(req).await.unwrap()
        };
        assert_eq!(response.status(), axum::http::StatusCode::UNAUTHORIZED);
        srv.close().await;
    }

    #[tokio::test]
    async fn oidc_verify_404_when_no_providers_configured() {
        // No FRICK_OIDC_PROVIDERS ⇒ every /auth/oidc/:id/verify is a 404.
        let mut env = BTreeMap::new();
        env.insert("FRICK_ENV".to_string(), "test".to_string());
        env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
        env.insert("FRICK_PORT".to_string(), "0".to_string());
        let config = load_frick_config(&env).unwrap();
        let mut srv = create_frick_server(config, frick_protocol::foundation_schema())
            .await
            .unwrap();

        let token = oidc_token("s", Some("n"));
        let (status, _) = post(
            &srv,
            "/auth/oidc/okta/verify",
            json!({ "idToken": token, "nonce": "n" }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
        srv.close().await;
    }
}
