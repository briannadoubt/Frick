//! FCM v1 adapter (map 06 §3.8; `apps/server/src/push/fcm-adapter.ts`).
//!
//! Implements the [`PushAdapter`] contract for
//! `fcm.googleapis.com/v1/projects/{projectId}/messages:send`. FCM uses an
//! OAuth2 access token: sign a service-account JWT (RS256), exchange it for an
//! access token at the token endpoint, then POST the FROZEN FCM message
//! ([`encode_fcm_message`](crate::push::payload::encode_fcm_message)).
//!
//! # Network seam (CI has no FCM endpoint)
//!
//! The JWT, token-exchange request shape, message JSON, and result translation
//! are unit-testable here; the two HTTP calls (token exchange + send) sit behind
//! the [`FcmTransport`] trait. Tests inject a stub; a production integrator
//! supplies a real HTTP client (`reqwest` is intentionally not a dependency of
//! this crate). The default transport fails loudly.
//!
//! # Service-account JWT (RS256)
//!
//! `signServiceAccountJwt` (fcm-adapter.ts:229-250): header
//! `{"alg":"RS256","typ":"JWT"}`, payload `{iss: clientEmail, scope: FCM_SCOPE,
//! aud: <tokenUri>, iat, exp: iat+3600}`, RSA-SHA256 (PKCS#1 v1.5, DER), base64url
//! segments. Posted as
//! `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>`.
//!
//! # Token cache
//!
//! Per `"<tenantId>:<clientEmail>"`, the access token is cached until
//! `expires_in` (default 3600 s) minus a 60 s early-refresh margin.

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rsa::RsaPrivateKey;
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::pkcs1v15::SigningKey;
use rsa::pkcs8::DecodePrivateKey;
use rsa::sha2::Sha256;
use rsa::signature::{SignatureEncoding, Signer};
use serde_json::json;

use super::SharedPushClock;
use super::credentials::{CredentialEnv, FcmCredentials, load_fcm_credentials};
use super::payload::encode_fcm_message;
use super::registry::PushAdapter;
use super::router::iso_from_epoch_ms;
use super::types::{
    FrickNotificationContext, FrickNotificationIntent, FrickPushDelivery, PushDeviceRegistration,
    PushPlatform,
};

/// `DEFAULT_TOKEN_URI` (fcm-adapter.ts:32).
pub const DEFAULT_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
/// `DEFAULT_FCM_BASE` (fcm-adapter.ts:33).
pub const DEFAULT_FCM_BASE: &str = "https://fcm.googleapis.com";
/// `FCM_SCOPE` (fcm-adapter.ts:34).
pub const FCM_SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
/// Early-refresh margin for cached access tokens: 60 s (fcm-adapter.ts:69).
pub const TOKEN_REFRESH_MARGIN_MS: i64 = 60_000;

/// A generic HTTP request the FCM transport performs (used for both the OAuth2
/// token exchange and the v1 message send).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FcmHttpRequest {
    /// Target URL.
    pub url: String,
    /// `content-type` header.
    pub content_type: String,
    /// `authorization` header value, if any (the send call sets `Bearer <tok>`).
    pub authorization: Option<String>,
    /// The request body bytes.
    pub body: Vec<u8>,
}

/// The HTTP response (`{status, body}`) the adapter translates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FcmHttpResponse {
    /// HTTP status.
    pub status: u16,
    /// Response body.
    pub body: String,
}

/// Network seam for the FCM HTTP calls. Tests inject a stub; production supplies
/// a real client.
pub trait FcmTransport: Send + Sync {
    /// Perform one HTTP request, returning the response or a transport-level
    /// error string.
    fn request<'a>(
        &'a self,
        request: &'a FcmHttpRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<FcmHttpResponse, String>> + Send + 'a>,
    >;
}

/// The default [`FcmTransport`]: no HTTP client wired, every request fails.
#[derive(Debug, Clone, Copy, Default)]
pub struct UnavailableFcmTransport;

impl FcmTransport for UnavailableFcmTransport {
    fn request<'a>(
        &'a self,
        _request: &'a FcmHttpRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<FcmHttpResponse, String>> + Send + 'a>,
    > {
        Box::pin(async {
            Err("no FCM HTTP transport configured (push.transportUnavailable)".to_string())
        })
    }
}

/// The FCM adapter (TS `FrickFcmAdapter`).
pub struct FcmAdapter {
    clock: SharedPushClock,
    env: std::sync::Arc<dyn CredentialEnv + Send + Sync>,
    transport: std::sync::Arc<dyn FcmTransport>,
    fcm_base_override: Option<String>,
    token_uri_override: Option<String>,
    tokens: Mutex<HashMap<String, CachedAccessToken>>,
}

struct CachedAccessToken {
    token: String,
    expires_at_ms: i64,
}

/// Construction options for [`FcmAdapter`].
pub struct FcmAdapterOptions {
    /// Clock seam (JWT `iat`/`exp`, token cache, `attemptedAt`).
    pub clock: SharedPushClock,
    /// Credential env seam.
    pub env: std::sync::Arc<dyn CredentialEnv + Send + Sync>,
    /// HTTP transport (network seam). Defaults to [`UnavailableFcmTransport`].
    pub transport: std::sync::Arc<dyn FcmTransport>,
    /// FCM base URL override (tests). `None` ⇒ [`DEFAULT_FCM_BASE`].
    pub fcm_base_url: Option<String>,
    /// Token endpoint override (tests). `None` ⇒ creds.tokenUri or default.
    pub token_uri: Option<String>,
}

impl FcmAdapter {
    /// Build an adapter from explicit options.
    #[must_use]
    pub fn new(options: FcmAdapterOptions) -> Self {
        Self {
            clock: options.clock,
            env: options.env,
            transport: options.transport,
            fcm_base_override: options.fcm_base_url,
            token_uri_override: options.token_uri,
            tokens: Mutex::new(HashMap::new()),
        }
    }

    fn token_uri(&self, creds: &FcmCredentials) -> String {
        self.token_uri_override
            .clone()
            .or_else(|| creds.token_uri.clone())
            .unwrap_or_else(|| DEFAULT_TOKEN_URI.to_string())
    }

    /// Build the OAuth2 token-exchange request for these credentials (no
    /// network). Exposed for tests.
    pub fn build_token_request(&self, creds: &FcmCredentials) -> Result<FcmHttpRequest, String> {
        let now_ms = self.clock.now_ms();
        let token_uri = self.token_uri(creds);
        let assertion = sign_service_account_jwt(creds, now_ms.div_euclid(1000), &token_uri)?;
        // application/x-www-form-urlencoded body.
        let body = format!(
            "grant_type={}&assertion={}",
            urlencode("urn:ietf:params:oauth:grant-type:jwt-bearer"),
            urlencode(&assertion),
        );
        Ok(FcmHttpRequest {
            url: token_uri,
            content_type: "application/x-www-form-urlencoded".to_string(),
            authorization: None,
            body: body.into_bytes(),
        })
    }

    /// Get-or-mint the cached access token (fcm-adapter.ts:64-94). Returns the
    /// token, or a `push.tokenExchangeFailed`-shaped error string on failure.
    async fn access_token(
        &self,
        creds: &FcmCredentials,
        tenant_id: &str,
    ) -> Result<String, String> {
        let cache_key = format!("{tenant_id}:{}", creds.client_email);
        let now_ms = self.clock.now_ms();
        if let Ok(tokens) = self.tokens.lock()
            && let Some(cached) = tokens.get(&cache_key)
            && cached.expires_at_ms - now_ms > TOKEN_REFRESH_MARGIN_MS
        {
            return Ok(cached.token.clone());
        }
        let request = self.build_token_request(creds)?;
        let response = self.transport.request(&request).await?;
        if !(200..300).contains(&response.status) {
            return Err(format!(
                "FCM token exchange failed: {} {}",
                response.status,
                truncate(&response.body, 200)
            ));
        }
        let parsed: serde_json::Value = serde_json::from_str(&response.body).map_err(|_| {
            format!(
                "FCM token exchange failed: {} missing access_token",
                response.status
            )
        })?;
        let Some(access_token) = parsed.get("access_token").and_then(|v| v.as_str()) else {
            return Err(format!(
                "FCM token exchange failed: {} missing access_token",
                response.status
            ));
        };
        let expires_in_sec = parsed
            .get("expires_in")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(3600);
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.insert(
                cache_key,
                CachedAccessToken {
                    token: access_token.to_string(),
                    expires_at_ms: now_ms + expires_in_sec * 1000,
                },
            );
        }
        Ok(access_token.to_string())
    }

    /// Build the FCM v1 send request for an intent + registration + access token
    /// (no network). Exposed for tests.
    #[must_use]
    pub fn build_send_request(
        &self,
        intent: &FrickNotificationIntent,
        registration: &PushDeviceRegistration,
        project_id: &str,
        access_token: &str,
    ) -> FcmHttpRequest {
        let base = self
            .fcm_base_override
            .clone()
            .unwrap_or_else(|| DEFAULT_FCM_BASE.to_string());
        let url = format!("{base}/v1/projects/{}/messages:send", urlencode(project_id));
        let mut message = encode_fcm_message(intent, &registration.token);
        if let Some(data) = message
            .get_mut("data")
            .and_then(serde_json::Value::as_object_mut)
        {
            // Token-scoped recipient binding lets clients fail closed when an
            // install changes accounts but an old registration still exists.
            // Values are opaque ids and remain metadata-only.
            data.insert(
                "recipientUserId".to_string(),
                serde_json::Value::String(registration.user_id.clone()),
            );
            data.insert(
                "recipientDeviceId".to_string(),
                serde_json::Value::String(registration.device_id.clone()),
            );
        }
        let body = serde_json::to_vec(&json!({
            "message": message,
        }))
        .unwrap_or_default();
        FcmHttpRequest {
            url,
            content_type: "application/json".to_string(),
            authorization: Some(format!("Bearer {access_token}")),
            body,
        }
    }
}

impl PushAdapter for FcmAdapter {
    fn platform(&self) -> PushPlatform {
        PushPlatform::Fcm
    }

    fn send<'a>(
        &'a self,
        intent: &'a FrickNotificationIntent,
        registration: &'a PushDeviceRegistration,
        ctx: &'a FrickNotificationContext<'a>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<FrickPushDelivery, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            let attempted_at = iso_from_epoch_ms(self.clock.now_ms());
            // Missing creds → skipped with the credential error code.
            let creds = match load_fcm_credentials(
                ctx.store.tenant_settings(),
                &intent.tenant_id,
                &*self.env,
            )
            .await
            {
                Ok(creds) => creds,
                Err(error) => {
                    return Ok(FrickPushDelivery::skipped(
                        registration.clone(),
                        attempted_at,
                        error.code.as_str(),
                        error.message,
                    ));
                }
            };
            // Token exchange failure → failed push.tokenExchangeFailed.
            let access_token = match self.access_token(&creds, &intent.tenant_id).await {
                Ok(token) => token,
                Err(message) => {
                    return Ok(FrickPushDelivery::failed(
                        registration.clone(),
                        attempted_at,
                        "push.tokenExchangeFailed",
                        message,
                    ));
                }
            };
            let request =
                self.build_send_request(intent, registration, &creds.project_id, &access_token);
            match self.transport.request(&request).await {
                Ok(response) => Ok(translate_fcm_result(
                    response.status,
                    &response.body,
                    registration.clone(),
                    attempted_at,
                )),
                Err(message) => Ok(FrickPushDelivery::failed(
                    registration.clone(),
                    attempted_at,
                    "push.deliveryFailed",
                    format!("FCM transport: {message}"),
                )),
            }
        })
    }
}

/// `translateFcmResult` (fcm-adapter.ts:174-222). 2xx → delivered (+`name`
/// receipt); else parse `{error:{status,message,details:[{errorCode}]}}` and map.
#[must_use]
pub fn translate_fcm_result(
    status: u16,
    body: &str,
    registration: PushDeviceRegistration,
    attempted_at: String,
) -> FrickPushDelivery {
    if (200..300).contains(&status) {
        let receipt_id = serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_string));
        return FrickPushDelivery::delivered(registration, attempted_at, receipt_id);
    }
    let mut error_code = String::new();
    let mut error_message = truncate(body, 200);
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body)
        && let Some(error) = parsed.get("error")
    {
        // errorCode = details[0].errorCode ?? error.status ?? "".
        error_code = error
            .get("details")
            .and_then(|d| d.get(0))
            .and_then(|d| d.get("errorCode"))
            .and_then(|c| c.as_str())
            .or_else(|| error.get("status").and_then(|s| s.as_str()))
            .unwrap_or("")
            .to_string();
        if let Some(message) = error.get("message").and_then(|m| m.as_str()) {
            error_message = message.to_string();
        }
    }
    FrickPushDelivery::failed(
        registration,
        attempted_at,
        map_fcm_error_code(status, &error_code),
        format!("FCM {status}: {error_message}"),
    )
}

/// `mapFcmErrorCode` (fcm-adapter.ts:214-222).
#[must_use]
pub fn map_fcm_error_code(status: u16, error_code: &str) -> &'static str {
    if status == 404 || error_code == "UNREGISTERED" {
        "push.unregistered"
    } else if error_code == "INVALID_ARGUMENT" || error_code == "SENDER_ID_MISMATCH" {
        "push.badDeviceToken"
    } else if error_code == "QUOTA_EXCEEDED" || status == 429 {
        "push.rateLimited"
    } else if status >= 500 {
        "push.serverError"
    } else {
        "push.deliveryFailed"
    }
}

/// `signServiceAccountJwt` (fcm-adapter.ts:229-250): RS256 service-account JWT.
pub fn sign_service_account_jwt(
    creds: &FcmCredentials,
    issued_at_seconds: i64,
    audience: &str,
) -> Result<String, String> {
    let header = base64url(
        &serde_json::to_vec(&json!({ "alg": "RS256", "typ": "JWT" })).unwrap_or_default(),
    );
    let payload = base64url(
        &serde_json::to_vec(&json!({
            "iss": creds.client_email,
            "scope": FCM_SCOPE,
            "aud": audience,
            "iat": issued_at_seconds,
            "exp": issued_at_seconds + 3600,
        }))
        .unwrap_or_default(),
    );
    let signing_input = format!("{header}.{payload}");
    let signing_key = parse_rsa_private_key(&creds.private_key)?;
    // RS256 = RSASSA-PKCS1-v1_5 over SHA-256 (DER-encoded signature, Node's
    // default).
    let signature = signing_key.sign(signing_input.as_bytes());
    Ok(format!(
        "{signing_input}.{}",
        base64url(&signature.to_bytes())
    ))
}

/// Parse a PEM RSA private key (PKCS#8 `BEGIN PRIVATE KEY` — Google
/// service-account JSON — or PKCS#1 `BEGIN RSA PRIVATE KEY`) into a SHA-256
/// PKCS#1 v1.5 signing key.
fn parse_rsa_private_key(pem: &str) -> Result<SigningKey<Sha256>, String> {
    if let Ok(key) = RsaPrivateKey::from_pkcs8_pem(pem) {
        return Ok(SigningKey::<Sha256>::new(key));
    }
    RsaPrivateKey::from_pkcs1_pem(pem)
        .map(SigningKey::<Sha256>::new)
        .map_err(|err| format!("invalid FCM private key (expected PEM RSA): {err}"))
}

/// base64url no-padding (`+→-`, `/→_`, padding stripped).
fn base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `body.slice(0, n)` over chars (the TS truncates the response body for error
/// messages).
fn truncate(input: &str, max: usize) -> String {
    input.chars().take(max).collect()
}

/// Minimal `application/x-www-form-urlencoded` percent-encoding for the token
/// request (mirrors `URLSearchParams`: encode everything that is not an
/// unreserved char or `*`/`-`/`.`/`_`; space → `+`). The values here are a fixed
/// grant-type string and a base64url JWT, so this covers them exactly.
fn urlencode(input: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'*' => {
                out.push(byte as char);
            }
            b' ' => out.push('+'),
            other => {
                let _ = write!(out, "%{other:02X}");
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::push::FixedPushClock;
    use crate::push::credentials::FixedCredentialEnv;
    use std::sync::Arc;

    // A deterministic 2048-bit RSA PKCS#8 PEM (test-only).
    const RSA_KEY_PEM: &str = include_str!("test_rsa_key.pem");

    fn creds() -> FcmCredentials {
        FcmCredentials {
            project_id: "frick-demo".to_string(),
            client_email: "svc@frick-demo.iam.gserviceaccount.com".to_string(),
            private_key: RSA_KEY_PEM.to_string(),
            token_uri: None,
        }
    }

    fn registration() -> PushDeviceRegistration {
        PushDeviceRegistration {
            registration_id: "push-1".to_string(),
            tenant_id: "tenant-1".to_string(),
            user_id: "user-1".to_string(),
            device_id: "dev-1".to_string(),
            platform: PushPlatform::Fcm,
            token: "fcm-device-token".to_string(),
            environment: crate::push::PushEnvironment::Production,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            last_seen_at: "2026-01-01T00:00:00.000Z".to_string(),
            revoked_at: None,
        }
    }

    fn intent() -> FrickNotificationIntent {
        FrickNotificationIntent {
            intent: "message.new".to_string(),
            tenant_id: "tenant-1".to_string(),
            recipient_user_ids: vec!["user-1".to_string()],
            body: crate::push::types::NotificationBody {
                title: Some("Hi".to_string()),
                body: Some("there".to_string()),
                data: None,
            },
            thread_id: None,
            deep_link: None,
        }
    }

    fn adapter() -> FcmAdapter {
        FcmAdapter::new(FcmAdapterOptions {
            clock: Arc::new(FixedPushClock(1_700_000_000_000)),
            env: Arc::new(FixedCredentialEnv::from_key(&[5u8; 32])),
            transport: Arc::new(UnavailableFcmTransport),
            fcm_base_url: None,
            token_uri: None,
        })
    }

    #[test]
    fn service_account_jwt_claims_match_contract() {
        let jwt = sign_service_account_jwt(&creds(), 1_700_000_000, DEFAULT_TOKEN_URI).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
        assert_eq!(header["alg"], "RS256");
        assert_eq!(header["typ"], "JWT");
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["iss"], "svc@frick-demo.iam.gserviceaccount.com");
        assert_eq!(claims["scope"], FCM_SCOPE);
        assert_eq!(claims["aud"], DEFAULT_TOKEN_URI);
        assert_eq!(claims["iat"], 1_700_000_000);
        assert_eq!(claims["exp"], 1_700_003_600);
        // RS256 signature is 256 bytes for a 2048-bit key.
        let sig = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        assert_eq!(sig.len(), 256);
    }

    #[test]
    fn token_request_is_form_encoded_jwt_bearer_grant() {
        let request = adapter().build_token_request(&creds()).unwrap();
        assert_eq!(request.url, DEFAULT_TOKEN_URI);
        assert_eq!(request.content_type, "application/x-www-form-urlencoded");
        let body = String::from_utf8(request.body).unwrap();
        assert!(body.starts_with(
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion="
        ));
    }

    #[test]
    fn send_request_url_headers_and_message_json() {
        let request =
            adapter().build_send_request(&intent(), &registration(), "frick-demo", "tok-xyz");
        assert_eq!(
            request.url,
            "https://fcm.googleapis.com/v1/projects/frick-demo/messages:send"
        );
        assert_eq!(request.authorization.as_deref(), Some("Bearer tok-xyz"));
        let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["message"]["token"], "fcm-device-token");
        assert_eq!(body["message"]["notification"]["title"], "Hi");
        assert_eq!(body["message"]["data"]["intent"], "message.new");
        assert_eq!(body["message"]["data"]["recipientUserId"], "user-1");
        assert_eq!(body["message"]["data"]["recipientDeviceId"], "dev-1");
    }

    #[test]
    fn result_translation_maps_codes() {
        let reg = registration();
        let ok = translate_fcm_result(
            200,
            "{\"name\":\"projects/x/messages/123\"}",
            reg.clone(),
            "t".to_string(),
        );
        assert_eq!(ok.status, crate::push::types::PushDeliveryStatus::Delivered);
        assert_eq!(ok.receipt_id.as_deref(), Some("projects/x/messages/123"));

        let gone = translate_fcm_result(
            404,
            "{\"error\":{\"status\":\"NOT_FOUND\",\"message\":\"dead\",\"details\":[{\"errorCode\":\"UNREGISTERED\"}]}}",
            reg.clone(),
            "t".to_string(),
        );
        assert_eq!(gone.error.as_ref().unwrap().code, "push.unregistered");
        assert_eq!(gone.error.as_ref().unwrap().message, "FCM 404: dead");

        let bad = translate_fcm_result(
            400,
            "{\"error\":{\"status\":\"INVALID_ARGUMENT\",\"message\":\"bad token\"}}",
            reg,
            "t".to_string(),
        );
        assert_eq!(bad.error.unwrap().code, "push.badDeviceToken");
    }

    #[test]
    fn error_code_mapping_table() {
        assert_eq!(map_fcm_error_code(404, ""), "push.unregistered");
        assert_eq!(map_fcm_error_code(200, "UNREGISTERED"), "push.unregistered");
        assert_eq!(
            map_fcm_error_code(400, "INVALID_ARGUMENT"),
            "push.badDeviceToken"
        );
        assert_eq!(
            map_fcm_error_code(400, "SENDER_ID_MISMATCH"),
            "push.badDeviceToken"
        );
        assert_eq!(
            map_fcm_error_code(400, "QUOTA_EXCEEDED"),
            "push.rateLimited"
        );
        assert_eq!(map_fcm_error_code(429, ""), "push.rateLimited");
        assert_eq!(map_fcm_error_code(500, ""), "push.serverError");
        assert_eq!(map_fcm_error_code(400, "OTHER"), "push.deliveryFailed");
    }
}
