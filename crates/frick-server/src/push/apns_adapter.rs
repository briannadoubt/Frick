//! APNs adapter (map 06 §3.7; `apps/server/src/push/apns-adapter.ts`).
//!
//! Implements the [`PushAdapter`] contract: sign an ES256 JWT from the tenant's
//! stored APNs `.p8` private key, build the FROZEN APNs JSON body
//! ([`encode_apns_body`](crate::push::payload::encode_apns_body)), and POST it to
//! `/3/device/<token>` over HTTP/2.
//!
//! # Network seam (CI has no APNs endpoint)
//!
//! The JWT + body + header + result-translation logic is fully unit-testable and
//! lives here. The actual HTTP/2 send sits behind the [`ApnsTransport`] trait so
//! tests drive a recording/stub transport and never touch the network. A
//! production integrator supplies an HTTP/2 transport (e.g. a thin `reqwest`
//! / `hyper` client) — `reqwest` is deliberately NOT a dependency of this crate
//! (it pulls a heavy native-TLS tree); wiring it is the integrator's choice. The
//! default transport returns a failure so a misconfigured deploy fails loudly
//! rather than silently dropping pushes.
//!
//! # Per-tenant state
//!
//! One global adapter serves every tenant; JWTs are cached per
//! `"<tenantId>:<keyId>"` and refreshed at the 50-minute mark
//! ([`JWT_REFRESH_MS`]) — Apple accepts a JWT for up to 60 min. The TS also
//! caches one HTTP/2 session per `(tenant, endpoint)`; session pooling is the
//! transport's concern here.
//!
//! # ES256 signature (IEEE-P1363, not DER)
//!
//! `signApnsJwt` (apns-adapter.ts:278-287): header
//! `{"alg":"ES256","kid":"<keyId>","typ":"JWT"}`, claims `{"iss":"<teamId>",
//! "iat":<unix seconds>}` (no `exp`), signature ECDSA P-256/SHA-256 over
//! `base64url(header) + "." + base64url(claims)`, emitted in **IEEE P1363 raw
//! r||s** form (64 bytes) — NOT DER. base64url = standard base64 with `+→-`,
//! `/→_`, padding stripped.

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use serde_json::json;

use super::SharedPushClock;
use super::credentials::{
    ApnsCredentials, CredentialEnv, PushCredentialError, PushCredentialErrorCode,
    load_apns_credentials,
};
use super::payload::encode_apns_body;
use super::registry::PushAdapter;
use super::router::iso_from_epoch_ms;
use super::types::{
    FrickNotificationContext, FrickNotificationIntent, FrickPushDelivery, PushDeviceRegistration,
    PushEnvironment, PushPlatform,
};

/// APNs JWT bearer validity refresh window: 50 min (Apple accepts ~60 min;
/// refresh early to absorb skew) (apns-adapter.ts:38).
pub const JWT_REFRESH_MS: i64 = 50 * 60 * 1000;
/// `DEFAULT_PUSH_TYPE` (apns-adapter.ts:40): the `apns-push-type` header value.
pub const DEFAULT_PUSH_TYPE: &str = "alert";
/// Production APNs endpoint.
pub const APNS_PRODUCTION_ENDPOINT: &str = "https://api.push.apple.com";
/// Sandbox APNs endpoint for registrations issued by the development gateway.
pub const APNS_SANDBOX_ENDPOINT: &str = "https://api.sandbox.push.apple.com";

/// The bits of an APNs request the transport needs (`POST /3/device/<token>`
/// with the headers + JSON body). The transport implements the HTTP/2 send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApnsRequest {
    /// The full endpoint base (`https://api.push.apple.com` or sandbox/override).
    pub endpoint: String,
    /// The device token (the `:path` is `/3/device/<token>`).
    pub device_token: String,
    /// `authorization: bearer <jwt>` value (lowercase "bearer", apns-adapter.ts:143).
    pub authorization: String,
    /// `apns-topic` header = the credentials' bundle id.
    pub apns_topic: String,
    /// `apns-push-type` header (always [`DEFAULT_PUSH_TYPE`]).
    pub apns_push_type: String,
    /// The JSON body bytes.
    pub body: Vec<u8>,
}

/// The APNs HTTP/2 response the adapter translates (`{status, apns-id, body}`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApnsResponse {
    /// HTTP status.
    pub status: u16,
    /// `apns-id` response header → `receiptId`, if present.
    pub apns_id: Option<String>,
    /// Response body (parsed for `{reason}` on failure).
    pub body: String,
}

/// Network seam for the APNs HTTP/2 POST. Tests inject a recording stub; a
/// production integrator supplies a real HTTP/2 client. Boxed future for
/// object-safety.
pub trait ApnsTransport: Send + Sync {
    /// Send one APNs request, returning the response or a transport-level error
    /// string (→ a `push.deliveryFailed` failure with `APNs transport: <msg>`).
    fn send<'a>(
        &'a self,
        request: &'a ApnsRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<ApnsResponse, String>> + Send + 'a>,
    >;
}

/// The default [`ApnsTransport`]: no HTTP client is wired, so every send fails
/// with `transport unavailable`. Replace with a real transport in production.
#[derive(Debug, Clone, Copy, Default)]
pub struct UnavailableApnsTransport;

impl ApnsTransport for UnavailableApnsTransport {
    fn send<'a>(
        &'a self,
        _request: &'a ApnsRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<ApnsResponse, String>> + Send + 'a>,
    > {
        Box::pin(async {
            Err("no APNs HTTP/2 transport configured (push.transportUnavailable)".to_string())
        })
    }
}

/// The APNs adapter (TS `FrickApnsAdapter`).
pub struct ApnsAdapter {
    clock: SharedPushClock,
    env: std::sync::Arc<dyn CredentialEnv + Send + Sync>,
    transport: std::sync::Arc<dyn ApnsTransport>,
    endpoint_override: Option<String>,
    jwts: Mutex<HashMap<String, CachedJwt>>,
}

struct CachedJwt {
    token: String,
    signed_at_ms: i64,
}

/// Construction options for [`ApnsAdapter`].
pub struct ApnsAdapterOptions {
    /// Clock seam (JWT `iat` + `attemptedAt`).
    pub clock: SharedPushClock,
    /// Credential env seam.
    pub env: std::sync::Arc<dyn CredentialEnv + Send + Sync>,
    /// HTTP/2 transport (network seam). Defaults to [`UnavailableApnsTransport`].
    pub transport: std::sync::Arc<dyn ApnsTransport>,
    /// Endpoint override (tests point at a mock; `None` ⇒ prod/sandbox by creds).
    pub endpoint: Option<String>,
}

impl ApnsAdapter {
    /// Build an adapter from explicit options.
    #[must_use]
    pub fn new(options: ApnsAdapterOptions) -> Self {
        Self {
            clock: options.clock,
            env: options.env,
            transport: options.transport,
            endpoint_override: options.endpoint,
            jwts: Mutex::new(HashMap::new()),
        }
    }

    fn resolve_endpoint(&self, environment: PushEnvironment) -> String {
        if let Some(endpoint) = &self.endpoint_override {
            return endpoint.clone();
        }
        match environment {
            PushEnvironment::Production => APNS_PRODUCTION_ENDPOINT.to_string(),
            PushEnvironment::Sandbox => APNS_SANDBOX_ENDPOINT.to_string(),
        }
    }

    /// Get-or-mint the cached JWT for `(tenant, keyId)` (apns-adapter.ts:109-119).
    fn get_jwt(&self, creds: &ApnsCredentials, tenant_id: &str) -> Result<String, String> {
        let cache_key = format!("{tenant_id}:{}", creds.key_id);
        let now_ms = self.clock.now_ms();
        if let Ok(jwts) = self.jwts.lock()
            && let Some(cached) = jwts.get(&cache_key)
            && now_ms - cached.signed_at_ms < JWT_REFRESH_MS
        {
            return Ok(cached.token.clone());
        }
        let issued_at_seconds = now_ms.div_euclid(1000);
        let token = sign_apns_jwt(creds, issued_at_seconds)?;
        if let Ok(mut jwts) = self.jwts.lock() {
            jwts.insert(
                cache_key,
                CachedJwt {
                    token: token.clone(),
                    signed_at_ms: now_ms,
                },
            );
        }
        Ok(token)
    }

    /// Build the [`ApnsRequest`] for an intent + registration (no network).
    /// Exposed for tests so the request can be asserted without a transport.
    pub async fn build_request(
        &self,
        intent: &FrickNotificationIntent,
        registration: &PushDeviceRegistration,
        store: &frick_store::FrickStore,
    ) -> Result<ApnsRequest, PushCredentialError> {
        let creds =
            load_apns_credentials(store.tenant_settings(), &intent.tenant_id, &*self.env).await?;
        let jwt =
            self.get_jwt(&creds, &intent.tenant_id)
                .map_err(|message| PushCredentialError {
                    code: PushCredentialErrorCode::Corrupt,
                    message,
                })?;
        let body = serde_json::to_vec(&encode_apns_body(intent)).unwrap_or_default();
        Ok(ApnsRequest {
            endpoint: self.resolve_endpoint(registration.environment),
            device_token: registration.token.clone(),
            authorization: format!("bearer {jwt}"),
            apns_topic: creds.bundle_id.clone(),
            apns_push_type: DEFAULT_PUSH_TYPE.to_string(),
            body,
        })
    }
}

impl PushAdapter for ApnsAdapter {
    fn platform(&self) -> PushPlatform {
        PushPlatform::Apns
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
            // Missing/bad creds → skipped with the credential error code.
            let request = match self.build_request(intent, registration, ctx.store).await {
                Ok(request) => request,
                Err(error) => {
                    return Ok(FrickPushDelivery::skipped(
                        registration.clone(),
                        attempted_at,
                        error.code.as_str(),
                        error.message,
                    ));
                }
            };
            match self.transport.send(&request).await {
                Ok(response) => Ok(translate_apns_result(
                    &response,
                    registration.clone(),
                    attempted_at,
                )),
                Err(message) => Ok(FrickPushDelivery::failed(
                    registration.clone(),
                    attempted_at,
                    "push.deliveryFailed",
                    format!("APNs transport: {message}"),
                )),
            }
        })
    }
}

/// `translateApnsResult` (apns-adapter.ts:202-240). 200 → delivered (+`apns-id`
/// receipt); else map `{reason}` via [`map_apns_reason`].
#[must_use]
pub fn translate_apns_result(
    response: &ApnsResponse,
    registration: PushDeviceRegistration,
    attempted_at: String,
) -> FrickPushDelivery {
    if response.status == 200 {
        return FrickPushDelivery::delivered(registration, attempted_at, response.apns_id.clone());
    }
    let reason = serde_json::from_str::<serde_json::Value>(&response.body)
        .ok()
        .and_then(|v| v.get("reason").and_then(|r| r.as_str()).map(str::to_string))
        .unwrap_or_default();
    let code = map_apns_reason(response.status, &reason);
    let mut delivery = FrickPushDelivery::failed(
        registration,
        attempted_at,
        code,
        format!(
            "APNs {} {}",
            response.status,
            if reason.is_empty() {
                "unknown"
            } else {
                &reason
            }
        ),
    );
    delivery.receipt_id.clone_from(&response.apns_id);
    delivery
}

/// `mapApnsReason` (apns-adapter.ts:232-240).
#[must_use]
pub fn map_apns_reason(status: u16, reason: &str) -> &'static str {
    if status == 410 || reason == "Unregistered" {
        "push.unregistered"
    } else if reason == "BadDeviceToken" {
        "push.badDeviceToken"
    } else if reason == "ExpiredProviderToken" {
        "push.tokenExpired"
    } else if status == 413 {
        "push.payloadTooLarge"
    } else if status == 429 {
        "push.rateLimited"
    } else if status >= 500 {
        "push.serverError"
    } else {
        "push.deliveryFailed"
    }
}

/// `signApnsJwt` (apns-adapter.ts:278-287): ES256 JWT in IEEE-P1363 r||s form.
/// `issued_at_seconds` is `floor(now_ms / 1000)`. Returns the compact JWT or a
/// signing error string (bad PEM key).
pub fn sign_apns_jwt(creds: &ApnsCredentials, issued_at_seconds: i64) -> Result<String, String> {
    let header = base64url(
        &serde_json::to_vec(&json!({
            "alg": "ES256",
            "kid": creds.key_id,
            "typ": "JWT",
        }))
        .unwrap_or_default(),
    );
    let payload = base64url(
        &serde_json::to_vec(&json!({
            "iss": creds.team_id,
            "iat": issued_at_seconds,
        }))
        .unwrap_or_default(),
    );
    let signing_input = format!("{header}.{payload}");

    let signing_key = parse_ec_private_key(&creds.private_key_pem)?;
    // ECDSA P-256/SHA-256. `p256::ecdsa::Signature` is the fixed-size IEEE-P1363
    // r||s encoding (64 bytes) — exactly the TS `dsaEncoding: "ieee-p1363"`.
    let signature: Signature = signing_key.sign(signing_input.as_bytes());
    let raw = signature.to_bytes(); // 64-byte r||s
    Ok(format!("{signing_input}.{}", base64url(&raw)))
}

/// Parse a PEM EC P-256 private key (PKCS#8 `BEGIN PRIVATE KEY` — Apple `.p8`
/// keys — or SEC1 `BEGIN EC PRIVATE KEY`) into an ECDSA signing key.
fn parse_ec_private_key(pem: &str) -> Result<SigningKey, String> {
    use p256::elliptic_curve::pkcs8::DecodePrivateKey as _;
    // PKCS#8 first (Apple `.p8`).
    if let Ok(key) = SigningKey::from_pkcs8_pem(pem) {
        return Ok(key);
    }
    // SEC1 fallback (`BEGIN EC PRIVATE KEY`).
    p256::SecretKey::from_sec1_pem(pem)
        .map(SigningKey::from)
        .map_err(|err| format!("invalid APNs private key (expected PEM EC P-256): {err}"))
}

/// base64url = standard base64 with `+→-`, `/→_`, padding stripped
/// (apns-adapter.ts:289-292).
fn base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::push::FixedPushClock;
    use crate::push::credentials::FixedCredentialEnv;
    use std::sync::Arc;

    // A deterministic EC P-256 PKCS#8 PEM (test-only).
    const APNS_KEY_PEM: &str = include_str!("test_ec_key.pem");

    fn creds() -> ApnsCredentials {
        ApnsCredentials {
            key_id: "ABC1234567".to_string(),
            team_id: "TEAM123456".to_string(),
            bundle_id: "dev.frick.app".to_string(),
            private_key_pem: APNS_KEY_PEM.to_string(),
            use_sandbox: false,
        }
    }

    fn registration() -> PushDeviceRegistration {
        PushDeviceRegistration {
            registration_id: "push-1".to_string(),
            tenant_id: "tenant-1".to_string(),
            user_id: "user-1".to_string(),
            device_id: "dev-1".to_string(),
            platform: PushPlatform::Apns,
            token: "abc123token".to_string(),
            environment: crate::push::PushEnvironment::Production,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            last_seen_at: "2026-01-01T00:00:00.000Z".to_string(),
            revoked_at: None,
        }
    }

    #[test]
    fn jwt_header_and_claims_match_apple_contract() {
        let jwt = sign_apns_jwt(&creds(), 1_700_000_000).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
        assert_eq!(header["alg"], "ES256");
        assert_eq!(header["kid"], "ABC1234567");
        assert_eq!(header["typ"], "JWT");
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["iss"], "TEAM123456");
        assert_eq!(claims["iat"], 1_700_000_000);
        // No `exp` claim (Apple JWTs omit it).
        assert!(claims.get("exp").is_none());
        // IEEE-P1363 signature is 64 bytes (r||s), NOT a DER blob (~70-72 bytes).
        let sig = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        assert_eq!(sig.len(), 64);
    }

    #[tokio::test]
    async fn build_request_carries_headers_and_path_token() {
        let store = crate::push::router::tests_support::store().await;
        let env = FixedCredentialEnv::from_key(&[5u8; 32]);
        crate::push::credentials::save_apns_credentials(
            store.tenant_settings(),
            "tenant-1",
            &creds(),
            &env,
            1_700_000_000_000,
        )
        .await
        .unwrap();

        let adapter = ApnsAdapter::new(ApnsAdapterOptions {
            clock: Arc::new(FixedPushClock(1_700_000_000_000)),
            env: Arc::new(env),
            transport: Arc::new(UnavailableApnsTransport),
            endpoint: None,
        });
        let intent = FrickNotificationIntent {
            intent: "message.new".to_string(),
            tenant_id: "tenant-1".to_string(),
            recipient_user_ids: vec!["user-1".to_string()],
            body: crate::push::types::NotificationBody::default(),
            thread_id: None,
            deep_link: None,
        };
        let request = adapter
            .build_request(&intent, &registration(), &store)
            .await
            .unwrap();
        assert_eq!(request.endpoint, APNS_PRODUCTION_ENDPOINT);
        assert_eq!(request.device_token, "abc123token");
        assert!(request.authorization.starts_with("bearer "));
        assert_eq!(request.apns_topic, "dev.frick.app");
        assert_eq!(request.apns_push_type, "alert");
    }

    #[tokio::test]
    async fn build_request_routes_each_registration_to_its_apns_environment() {
        let store = crate::push::router::tests_support::store().await;
        let env = FixedCredentialEnv::from_key(&[5u8; 32]);
        let mut saved_credentials = creds();
        // The credential flag is a legacy/default value. A tenant can have
        // development and distribution installs active at the same time, so
        // each registration must choose its own APNs gateway.
        saved_credentials.use_sandbox = true;
        crate::push::credentials::save_apns_credentials(
            store.tenant_settings(),
            "tenant-1",
            &saved_credentials,
            &env,
            1_700_000_000_000,
        )
        .await
        .unwrap();

        let adapter = ApnsAdapter::new(ApnsAdapterOptions {
            clock: Arc::new(FixedPushClock(1_700_000_000_000)),
            env: Arc::new(env),
            transport: Arc::new(UnavailableApnsTransport),
            endpoint: None,
        });
        let intent = FrickNotificationIntent {
            intent: "message.new".to_string(),
            tenant_id: "tenant-1".to_string(),
            recipient_user_ids: vec!["user-1".to_string()],
            body: crate::push::types::NotificationBody::default(),
            thread_id: None,
            deep_link: None,
        };

        let production = adapter
            .build_request(&intent, &registration(), &store)
            .await
            .unwrap();
        assert_eq!(production.endpoint, APNS_PRODUCTION_ENDPOINT);

        let mut sandbox_registration = registration();
        sandbox_registration.environment = PushEnvironment::Sandbox;
        let sandbox = adapter
            .build_request(&intent, &sandbox_registration, &store)
            .await
            .unwrap();
        assert_eq!(sandbox.endpoint, APNS_SANDBOX_ENDPOINT);
    }

    #[test]
    fn result_translation_maps_reasons() {
        let reg = registration();
        let ok = translate_apns_result(
            &ApnsResponse {
                status: 200,
                apns_id: Some("rcpt-1".to_string()),
                body: String::new(),
            },
            reg.clone(),
            "t".to_string(),
        );
        assert_eq!(ok.status, crate::push::types::PushDeliveryStatus::Delivered);
        assert_eq!(ok.receipt_id.as_deref(), Some("rcpt-1"));
        let gone = translate_apns_result(
            &ApnsResponse {
                status: 410,
                apns_id: None,
                body: "{\"reason\":\"Unregistered\"}".to_string(),
            },
            reg.clone(),
            "t".to_string(),
        );
        assert_eq!(gone.error.as_ref().unwrap().code, "push.unregistered");
        assert_eq!(
            gone.error.as_ref().unwrap().message,
            "APNs 410 Unregistered"
        );
        let bad = translate_apns_result(
            &ApnsResponse {
                status: 400,
                apns_id: None,
                body: "{\"reason\":\"BadDeviceToken\"}".to_string(),
            },
            reg,
            "t".to_string(),
        );
        assert_eq!(bad.error.unwrap().code, "push.badDeviceToken");
    }

    #[test]
    fn reason_mapping_table() {
        assert_eq!(map_apns_reason(410, ""), "push.unregistered");
        assert_eq!(map_apns_reason(400, "Unregistered"), "push.unregistered");
        assert_eq!(
            map_apns_reason(400, "BadDeviceToken"),
            "push.badDeviceToken"
        );
        assert_eq!(
            map_apns_reason(403, "ExpiredProviderToken"),
            "push.tokenExpired"
        );
        assert_eq!(map_apns_reason(413, ""), "push.payloadTooLarge");
        assert_eq!(map_apns_reason(429, ""), "push.rateLimited");
        assert_eq!(map_apns_reason(503, ""), "push.serverError");
        assert_eq!(map_apns_reason(400, "PayloadEmpty"), "push.deliveryFailed");
    }
}
