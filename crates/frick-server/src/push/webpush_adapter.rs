//! Web Push adapter (map 06 §3.9; `apps/server/src/push/web-push-adapter.ts`).
//!
//! The third leg of the push trio next to APNs and FCM. Given a browser
//! `PushSubscription` (`{ endpoint, keys: { p256dh, auth } }`, JSON-encoded in
//! the registration's `token`), the adapter:
//!   1. loads the tenant's VAPID credentials and signs a per-endpoint ES256 JWT
//!      ([`sign_vapid_jwt`], RFC 8292) over `{aud, exp, sub}`;
//!   2. encrypts the [`FrickPushPayload`] JSON with the RFC 8291 `aes128gcm`
//!      content encoding ([`encrypt_web_push_payload`]); and
//!   3. POSTs the ciphertext to the subscription endpoint with the
//!      `authorization: vapid t=<jwt>, k=<publicKey>` and `ttl` headers.
//!
//! When the subscription carries no browser keys (older registrations) the
//! adapter falls back to an EMPTY body wake-up push (no content-encoding), and
//! the Service Worker shows a generic notification — backward compatible with
//! the pre-FR-60 behaviour.
//!
//! # Content encryption is NOT hand-rolled (§3.9 mandate)
//!
//! The RFC 8291 / RFC 8188 `aes128gcm` orchestration (ephemeral ECDH, the
//! HKDF-SHA256 key/nonce derivation with the `WebPush: info\0` / `Content-
//! Encoding: …\0` info strings, the single-record `0x02` delimiter, and the
//! `salt(16) || rs(4) || idlen(1) || keyid(65) || ciphertext` framing) is done
//! by Mozilla's [`ece`] crate, which is tested against the RFC 8291 Appendix
//! A.2 published vector. To keep this crate pure-Rust (no `openssl`/native
//! deps, matching the rest of the push subsystem) the crate's default
//! `backend-openssl` is disabled and a [`EceCryptographer`] backend built on the
//! `p256` (ECDH), `hkdf`, and `aes-gcm` crates — all already vendored for
//! APNs/FCM/credentials — is installed once at first use. The backend is proven
//! correct by running the crate's own [`ece::crypto::test_cryptographer`]
//! known-answer suite against it (see the unit tests).
//!
//! # Network seam (CI has no push service)
//!
//! Everything except the actual HTTPS POST is unit-testable here; the send sits
//! behind the [`WebPushTransport`] trait (mirrors `ApnsTransport` / `FcmTransport`).
//! Tests inject a recording stub; the default transport fails loudly so a
//! misconfigured deploy never silently drops pushes.
//!
//! # VAPID signature (IEEE-P1363 r||s, not DER)
//!
//! Identical to the APNs JWT path: ES256 over `base64url(header).base64url(claims)`,
//! signature emitted as the fixed-size 64-byte r||s — exactly the TS
//! `dsaEncoding: "ieee-p1363"`.

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine as _;
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use serde::Deserialize;
use serde_json::json;

use super::SharedPushClock;
use super::credentials::{
    CredentialEnv, PushCredentialError, PushCredentialErrorCode, WebPushCredentials,
    load_web_push_credentials,
};
use super::registry::PushAdapter;
use super::router::iso_from_epoch_ms;
use super::types::{
    FrickNotificationContext, FrickNotificationIntent, FrickPushDelivery, PushDeviceRegistration,
    PushPlatform,
};

mod ece_backend;

use ece_backend::install_cryptographer;

/// VAPID JWT validity refresh window: 12 h (the JWT is minted with a 12 h `exp`;
/// the cache refreshes at that mark so a token is never served past validity)
/// (web-push-adapter.ts:53).
pub const JWT_REFRESH_MS: i64 = 12 * 60 * 60 * 1000;
/// VAPID JWT lifetime in seconds: 12 h (`exp = now + 12h`, web-push-adapter.ts).
pub const VAPID_EXP_SECONDS: i64 = 12 * 60 * 60;
/// `MAX_WEB_PUSH_PAYLOAD` (web-push-adapter.ts:55): RFC 8291 caps the encrypted
/// application payload at 4096 octets.
pub const MAX_WEB_PUSH_PAYLOAD: usize = 4096;
/// `WEB_PUSH_TTL` (web-push-adapter.ts:57): the `ttl` header value (seconds; 4
/// weeks) — how long the push service holds an undelivered message.
pub const WEB_PUSH_TTL: &str = "2419200";

/// One HTTPS request the Web Push transport performs (`POST <endpoint>` with the
/// VAPID + content headers and the encrypted — or empty — body).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebPushRequest {
    /// The subscription endpoint (the POST target).
    pub endpoint: String,
    /// `authorization: vapid t=<jwt>, k=<publicKey>` value.
    pub authorization: String,
    /// `ttl` header (always [`WEB_PUSH_TTL`]).
    pub ttl: String,
    /// `content-encoding` header (`Some("aes128gcm")` for an encrypted body,
    /// `None` for the empty-body wake-up push).
    pub content_encoding: Option<String>,
    /// The request body bytes (the aes128gcm ciphertext, or empty).
    pub body: Vec<u8>,
}

/// The HTTP response (`{status}`) the adapter translates. Web Push success
/// carries no receipt id, so only the status is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WebPushResponse {
    /// HTTP status.
    pub status: u16,
}

/// Network seam for the Web Push HTTPS POST. Tests inject a recording stub; a
/// production integrator supplies a real client (e.g. a thin `reqwest` wrapper).
/// Boxed future for object-safety.
pub trait WebPushTransport: Send + Sync {
    /// Send one Web Push request, returning the response or a transport-level
    /// error string (→ a `push.deliveryFailed` failure with
    /// `Web Push transport: <msg>`).
    fn send<'a>(
        &'a self,
        request: &'a WebPushRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<WebPushResponse, String>> + Send + 'a>,
    >;
}

/// The default [`WebPushTransport`]: no HTTP client is wired, so every send
/// fails. Replace with a real transport in production.
#[derive(Debug, Clone, Copy, Default)]
pub struct UnavailableWebPushTransport;

impl WebPushTransport for UnavailableWebPushTransport {
    fn send<'a>(
        &'a self,
        _request: &'a WebPushRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<WebPushResponse, String>> + Send + 'a>,
    > {
        Box::pin(async {
            Err("no Web Push HTTP transport configured (push.transportUnavailable)".to_string())
        })
    }
}

/// The Web Push adapter (TS `FrickWebPushAdapter`).
pub struct WebPushAdapter {
    clock: SharedPushClock,
    env: std::sync::Arc<dyn CredentialEnv + Send + Sync>,
    transport: std::sync::Arc<dyn WebPushTransport>,
    vapid_jwts: Mutex<HashMap<String, CachedVapid>>,
}

struct CachedVapid {
    token: String,
    signed_at_ms: i64,
}

/// Construction options for [`WebPushAdapter`].
pub struct WebPushAdapterOptions {
    /// Clock seam (JWT `exp` + cache + `attemptedAt`).
    pub clock: SharedPushClock,
    /// Credential env seam.
    pub env: std::sync::Arc<dyn CredentialEnv + Send + Sync>,
    /// HTTP transport (network seam). Defaults to [`UnavailableWebPushTransport`].
    pub transport: std::sync::Arc<dyn WebPushTransport>,
}

impl WebPushAdapter {
    /// Build an adapter from explicit options.
    #[must_use]
    pub fn new(options: WebPushAdapterOptions) -> Self {
        Self {
            clock: options.clock,
            env: options.env,
            transport: options.transport,
            vapid_jwts: Mutex::new(HashMap::new()),
        }
    }

    /// Get-or-mint the cached VAPID JWT for `(publicKey, audience)`
    /// (web-push-adapter.ts:85-95). The cache key is `"<publicKey>\0<audience>"`.
    fn vapid_header(&self, creds: &WebPushCredentials, audience: &str) -> Result<String, String> {
        let cache_key = format!("{}\u{0}{audience}", creds.public_key);
        let now_ms = self.clock.now_ms();
        if let Ok(cache) = self.vapid_jwts.lock()
            && let Some(cached) = cache.get(&cache_key)
            && now_ms - cached.signed_at_ms < JWT_REFRESH_MS
        {
            return Ok(format!("vapid t={}, k={}", cached.token, creds.public_key));
        }
        let exp = now_ms.div_euclid(1000) + VAPID_EXP_SECONDS;
        let token = sign_vapid_jwt(creds, audience, exp)?;
        if let Ok(mut cache) = self.vapid_jwts.lock() {
            cache.insert(
                cache_key,
                CachedVapid {
                    token: token.clone(),
                    signed_at_ms: now_ms,
                },
            );
        }
        Ok(format!("vapid t={token}, k={}", creds.public_key))
    }

    /// Build the [`WebPushRequest`] for an intent + registration (no network).
    /// Exposed for tests so the request can be asserted without a transport.
    ///
    /// Returns a [`WebPushBuildError`] when the credentials are missing/corrupt
    /// (→ `skipped`), the token is not a safe `PushSubscription` JSON (→
    /// `failed push.badDeviceToken`), or the encrypted body exceeds the 4 KB cap
    /// (→ `failed push.payloadTooLarge`).
    pub async fn build_request(
        &self,
        intent: &FrickNotificationIntent,
        registration: &PushDeviceRegistration,
        store: &frick_store::FrickStore,
    ) -> Result<WebPushRequest, WebPushBuildError> {
        let creds =
            load_web_push_credentials(store.tenant_settings(), &intent.tenant_id, &*self.env)
                .await
                .map_err(WebPushBuildError::Credential)?;

        let Some(subscription) = parse_subscription_token(&registration.token) else {
            return Err(WebPushBuildError::bad_token());
        };

        let Some(audience) = endpoint_origin(&subscription.endpoint) else {
            return Err(WebPushBuildError::bad_token());
        };
        let authorization = self.vapid_header(&creds, &audience).map_err(|message| {
            WebPushBuildError::Credential(PushCredentialError {
                code: PushCredentialErrorCode::Corrupt,
                message,
            })
        })?;

        let mut request = WebPushRequest {
            endpoint: subscription.endpoint.clone(),
            authorization,
            ttl: WEB_PUSH_TTL.to_string(),
            content_encoding: None,
            body: Vec::new(),
        };

        // Encrypt only when there is a payload AND the subscription carries both
        // browser keys; otherwise fall back to the empty-body wake-up push.
        let plaintext = encode_notification_payload(intent);
        if let Some(plaintext) = plaintext
            && !subscription.keys.p256dh.is_empty()
            && !subscription.keys.auth.is_empty()
        {
            let encrypted = encrypt_web_push_payload(
                plaintext.as_bytes(),
                &subscription.keys.p256dh,
                &subscription.keys.auth,
            )
            .map_err(|_| WebPushBuildError::bad_token())?;
            if encrypted.len() > MAX_WEB_PUSH_PAYLOAD {
                return Err(WebPushBuildError::TooLarge(encrypted.len()));
            }
            request.content_encoding = Some("aes128gcm".to_string());
            request.body = encrypted;
        }
        Ok(request)
    }
}

/// A reason [`WebPushAdapter::build_request`] could not produce a request, with
/// enough context for the [`PushAdapter::send`] mapping to pick the right
/// delivery status + error code.
#[derive(Debug)]
pub enum WebPushBuildError {
    /// Missing/corrupt VAPID credentials → `skipped` with the credential code.
    Credential(PushCredentialError),
    /// Unparseable / unsafe subscription token → `failed push.badDeviceToken`.
    BadToken(String),
    /// Encrypted payload exceeded the 4 KB cap → `failed push.payloadTooLarge`
    /// (carries the actual byte count).
    TooLarge(usize),
}

impl WebPushBuildError {
    fn bad_token() -> Self {
        Self::BadToken("Registration token is not a valid PushSubscription JSON".to_string())
    }
}

impl PushAdapter for WebPushAdapter {
    fn platform(&self) -> PushPlatform {
        PushPlatform::WebPush
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
            let request = match self.build_request(intent, registration, ctx.store).await {
                Ok(request) => request,
                Err(WebPushBuildError::Credential(error)) => {
                    return Ok(FrickPushDelivery::skipped(
                        registration.clone(),
                        attempted_at,
                        error.code.as_str(),
                        error.message,
                    ));
                }
                Err(WebPushBuildError::BadToken(message)) => {
                    return Ok(FrickPushDelivery::failed(
                        registration.clone(),
                        attempted_at,
                        "push.badDeviceToken",
                        message,
                    ));
                }
                Err(WebPushBuildError::TooLarge(bytes)) => {
                    return Ok(FrickPushDelivery::failed(
                        registration.clone(),
                        attempted_at,
                        "push.payloadTooLarge",
                        format!(
                            "Encrypted Web Push payload is {bytes} bytes (max {MAX_WEB_PUSH_PAYLOAD})"
                        ),
                    ));
                }
            };
            match self.transport.send(&request).await {
                Ok(response) => Ok(translate_web_push_result(
                    response.status,
                    registration.clone(),
                    attempted_at,
                )),
                Err(message) => Ok(FrickPushDelivery::failed(
                    registration.clone(),
                    attempted_at,
                    "push.deliveryFailed",
                    format!("Web Push transport: {message}"),
                )),
            }
        })
    }
}

/// `translateWebPushResult` (web-push-adapter.ts:320-336). 2xx → delivered (no
/// receipt id); else map the status via [`map_web_push_status`]. Message
/// `Web push <status>`.
#[must_use]
pub fn translate_web_push_result(
    status: u16,
    registration: PushDeviceRegistration,
    attempted_at: String,
) -> FrickPushDelivery {
    if (200..300).contains(&status) {
        return FrickPushDelivery::delivered(registration, attempted_at, None);
    }
    FrickPushDelivery::failed(
        registration,
        attempted_at,
        map_web_push_status(status),
        format!("Web push {status}"),
    )
}

/// `mapStatus` (web-push-adapter.ts:320-326).
#[must_use]
pub fn map_web_push_status(status: u16) -> &'static str {
    if status == 404 || status == 410 {
        "push.unregistered"
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

/// `encodeNotificationPayload` (web-push-adapter.ts:198-213): the JSON blob the
/// Service Worker reads off the decrypted `push` event. Key order
/// `{ intent[, title][, body][, data][, threadId][, deepLink] }`. Returns `None`
/// when title+body+data are all absent (→ empty-body wake-up fallback).
#[must_use]
pub fn encode_notification_payload(intent: &FrickNotificationIntent) -> Option<String> {
    let body = &intent.body;
    if body.title.is_none() && body.body.is_none() && body.data.is_none() {
        return None;
    }
    let mut payload = serde_json::Map::new();
    payload.insert(
        "intent".to_string(),
        serde_json::Value::String(intent.intent.clone()),
    );
    if let Some(title) = &body.title {
        payload.insert(
            "title".to_string(),
            serde_json::Value::String(title.clone()),
        );
    }
    if let Some(text) = &body.body {
        payload.insert("body".to_string(), serde_json::Value::String(text.clone()));
    }
    if let Some(data) = &body.data {
        payload.insert("data".to_string(), msgpack_to_json(data));
    }
    if let Some(thread_id) = &intent.thread_id {
        payload.insert(
            "threadId".to_string(),
            serde_json::Value::String(thread_id.clone()),
        );
    }
    if let Some(deep_link) = &intent.deep_link {
        payload.insert(
            "deepLink".to_string(),
            serde_json::Value::String(deep_link.clone()),
        );
    }
    Some(serde_json::Value::Object(payload).to_string())
}

/// Convert a dynamic msgpack [`Value`](frick_protocol::Value) to a
/// [`serde_json::Value`] (the encrypted Web Push `data` keeps its self-describing
/// shape, unlike FCM's all-string `data`).
fn msgpack_to_json(value: &frick_protocol::Value) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

/// `encryptWebPushPayload` (web-push-adapter.ts:240-286): RFC 8291 `aes128gcm`
/// content encoding. The orchestration + framing are delegated to the [`ece`]
/// crate (over the pure-Rust [`EceCryptographer`] backend) — NOT hand-rolled.
///
/// `p256dh_b64` is the subscription's base64url uncompressed P-256 point (65
/// bytes, `0x04`-prefixed); `auth_b64` is the base64url 16-byte auth secret. The
/// returned bytes are the full RFC 8188 envelope
/// (`salt(16) || rs(4) || idlen(1) || keyid(65) || ciphertext`).
///
/// # Errors
///
/// Returns a [`WebPushEncryptError`] when a key fails to base64url-decode, the
/// `p256dh` is not a 65-byte `0x04` point, the `auth` secret is not 16 bytes, or
/// the underlying content-encryption fails.
pub fn encrypt_web_push_payload(
    plaintext: &[u8],
    p256dh_b64: &str,
    auth_b64: &str,
) -> Result<Vec<u8>, WebPushEncryptError> {
    let ua_public = decode_base64url(p256dh_b64).ok_or(WebPushEncryptError)?;
    let auth_secret = decode_base64url(auth_b64).ok_or(WebPushEncryptError)?;
    if ua_public.len() != 65 || ua_public[0] != 0x04 {
        return Err(WebPushEncryptError);
    }
    // The ece crate requires a 16-byte auth secret (RFC 8291 §3.2); the TS only
    // checked non-empty, but a real browser subscription always supplies 16.
    if auth_secret.is_empty() {
        return Err(WebPushEncryptError);
    }
    install_cryptographer();
    ece::encrypt(&ua_public, &auth_secret, plaintext).map_err(|_| WebPushEncryptError)
}

/// The content-encryption could not be performed (bad keys or AEAD failure). The
/// adapter maps this to `failed push.badDeviceToken` (the TS reuses the same
/// "not a valid PushSubscription JSON" message for ECDH/encrypt failures).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WebPushEncryptError;

/// `signVapidJwt` (web-push-adapter.ts:502-511): ES256 JWT in IEEE-P1363 r||s
/// form (same crypto path as APNs). Header `{"typ":"JWT","alg":"ES256"}`, claims
/// `{aud: <origin>, exp, sub: <subject>}`.
pub fn sign_vapid_jwt(
    creds: &WebPushCredentials,
    audience: &str,
    exp: i64,
) -> Result<String, String> {
    let header = base64url(
        &serde_json::to_vec(&json!({ "typ": "JWT", "alg": "ES256" })).unwrap_or_default(),
    );
    let payload = base64url(
        &serde_json::to_vec(&json!({
            "aud": audience,
            "exp": exp,
            "sub": creds.subject,
        }))
        .unwrap_or_default(),
    );
    let signing_input = format!("{header}.{payload}");
    let signing_key = parse_ec_private_key(&creds.private_key)?;
    // ECDSA P-256/SHA-256, IEEE-P1363 r||s (64-byte fixed) — exactly the TS
    // `dsaEncoding: "ieee-p1363"`.
    let signature: Signature = signing_key.sign(signing_input.as_bytes());
    Ok(format!(
        "{signing_input}.{}",
        base64url(&signature.to_bytes())
    ))
}

/// Parse a PEM EC P-256 private key (PKCS#8 `BEGIN PRIVATE KEY` or SEC1 `BEGIN EC
/// PRIVATE KEY`) into an ECDSA signing key.
fn parse_ec_private_key(pem: &str) -> Result<SigningKey, String> {
    use p256::elliptic_curve::pkcs8::DecodePrivateKey as _;
    if let Ok(key) = SigningKey::from_pkcs8_pem(pem) {
        return Ok(key);
    }
    p256::SecretKey::from_sec1_pem(pem)
        .map(SigningKey::from)
        .map_err(|err| format!("invalid VAPID private key (expected PEM EC P-256): {err}"))
}

/// The decoded subscription token (`{ endpoint, keys: { p256dh, auth } }`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedSubscription {
    endpoint: String,
    keys: SubscriptionKeys,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
struct SubscriptionKeys {
    #[serde(default)]
    p256dh: String,
    #[serde(default)]
    auth: String,
}

#[derive(Debug, Deserialize)]
struct RawSubscription {
    endpoint: Option<String>,
    #[serde(default)]
    keys: Option<SubscriptionKeys>,
}

/// `parseSubscriptionToken` (web-push-adapter.ts:340-352): parse the JSON token,
/// requiring a safe `https:` endpoint. Returns `None` on parse failure, missing
/// endpoint, or an unsafe endpoint (SSRF guard).
fn parse_subscription_token(token: &str) -> Option<ParsedSubscription> {
    let raw: RawSubscription = serde_json::from_str(token).ok()?;
    let endpoint = raw.endpoint?;
    if !is_safe_web_push_endpoint(&endpoint) {
        return None;
    }
    Some(ParsedSubscription {
        endpoint,
        keys: raw.keys.unwrap_or_default(),
    })
}

/// `validateWebPushRegistrationToken` (web-push-adapter.ts:354-360): a
/// registration-time guard. `Err` carries the TS validation message.
///
/// # Errors
///
/// Errors when the token is not a `PushSubscription` JSON with a safe public
/// `https:` endpoint.
pub fn validate_web_push_registration_token(token: &str) -> Result<(), String> {
    if parse_subscription_token(token).is_some() {
        Ok(())
    } else {
        Err(
            "webPush token must be a PushSubscription JSON with a public https endpoint"
                .to_string(),
        )
    }
}

/// `isSafeWebPushEndpoint` (web-push-adapter.ts:362-374): the endpoint must be a
/// parseable `https:` URL whose host is not on the SSRF deny-list.
///
/// NOTE: this is the synchronous, literal-host guard (no DNS). The TS
/// `isSafeWebPushEndpointForSend` additionally resolves the hostname and
/// re-screens every address — that DNS step is the live transport's
/// responsibility here (the transport seam owns the network), so this adapter
/// applies the literal-host guard at both registration and build time. See the
/// module-level `notes` / the assignment wiring gap.
#[must_use]
pub fn is_safe_web_push_endpoint(endpoint: &str) -> bool {
    let Some((scheme, host)) = split_scheme_host(endpoint) else {
        return false;
    };
    if scheme != "https" {
        return false;
    }
    !is_unsafe_host(&host)
}

/// The origin (`scheme://host[:port]`) of the endpoint — the VAPID `aud` claim.
fn endpoint_origin(endpoint: &str) -> Option<String> {
    let rest = endpoint.strip_prefix("https://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    if authority.is_empty() {
        return None;
    }
    Some(format!("https://{authority}"))
}

/// Split an `https://host[:port]/path` URL into `(scheme, host)` with the host
/// normalized (lowercased, brackets/trailing-dot stripped). `None` if not a
/// minimally well-formed `scheme://authority` URL.
fn split_scheme_host(endpoint: &str) -> Option<(String, String)> {
    let (scheme, rest) = endpoint.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    if authority.is_empty() {
        return None;
    }
    // Strip userinfo if present, then the port.
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, hp)| hp);
    let host = strip_port(host_port);
    if host.is_empty() {
        return None;
    }
    Some((scheme.to_ascii_lowercase(), normalize_hostname(host)))
}

/// Strip the `:port` suffix from a host[:port], being careful not to mistake an
/// IPv6 literal's colons for a port separator (the port only follows `]`).
fn strip_port(host_port: &str) -> &str {
    if let Some(rest) = host_port.strip_prefix('[') {
        // `[ipv6]` or `[ipv6]:port` — the host is up to and including the `]`.
        return rest.split_once(']').map_or(host_port, |(inner, _)| inner);
    }
    host_port
        .rsplit_once(':')
        .map_or(host_port, |(host, port)| {
            if port.chars().all(|c| c.is_ascii_digit()) && !port.is_empty() {
                host
            } else {
                host_port
            }
        })
}

/// `normalizeHostname` (web-push-adapter.ts:411-416): lowercase, strip a single
/// `[...]` bracket pair, strip a trailing dot.
fn normalize_hostname(hostname: &str) -> String {
    let mut host = hostname.to_ascii_lowercase();
    if host.starts_with('[') && host.ends_with(']') && host.len() >= 2 {
        host = host[1..host.len() - 1].to_string();
    }
    host.strip_suffix('.').map_or(host.clone(), str::to_string)
}

/// `isUnsafeHost` (web-push-adapter.ts:390-409): the SSRF deny-list over a
/// (normalized) literal host. Hostnames that aren't literal IPs are safe here
/// (the DNS re-screen is the send-time transport's job).
fn is_unsafe_host(host: &str) -> bool {
    if host == "localhost" || host.ends_with(".localhost") || host == "metadata.google.internal" {
        return true;
    }
    if let Some(v4) = parse_ipv4(host) {
        return is_unsafe_ipv4(v4);
    }
    if let Ok(v6) = host.parse::<std::net::Ipv6Addr>() {
        return is_unsafe_ipv6(v6);
    }
    false
}

fn parse_ipv4(host: &str) -> Option<[u8; 4]> {
    host.parse::<std::net::Ipv4Addr>().ok().map(|a| a.octets())
}

/// `isUnsafeIpv4` (web-push-adapter.ts:418-435).
fn is_unsafe_ipv4(octets: [u8; 4]) -> bool {
    let [a, b, ..] = octets;
    a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (224..=239).contains(&a)
        || a >= 240
}

/// `isUnsafeIpv6` (web-push-adapter.ts:437-457).
fn is_unsafe_ipv6(addr: std::net::Ipv6Addr) -> bool {
    // Embedded-IPv4 re-check (IPv4-mapped/compatible addresses).
    if let Some(v4) = addr.to_ipv4()
        && is_unsafe_ipv4(v4.octets())
    {
        return true;
    }
    let segments = addr.segments();
    let first = segments[0];
    let all_but_last_zero = segments[..7].iter().all(|&s| s == 0);
    (all_but_last_zero && (segments[7] == 0 || segments[7] == 1))
        || (first & 0xfe00) == 0xfc00
        || (first & 0xffc0) == 0xfe80
        || (first & 0xff00) == 0xff00
}

/// base64url decode accepting both padded and unpadded input (browser keys are
/// unpadded base64url; `auth`/`p256dh` round-trip either way).
fn decode_base64url(value: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value.trim_end_matches('='))
        .or_else(|_| URL_SAFE.decode(value))
        .ok()
}

/// base64url no-padding (`+→-`, `/→_`, padding stripped) — the JWT segment
/// encoding (web-push-adapter.ts:513-516).
fn base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests;
