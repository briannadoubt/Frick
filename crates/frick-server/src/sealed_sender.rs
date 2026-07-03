//! Sealed-sender delivery primitive (AURA-326): Signal-style unidentified
//! delivery, where the server routes a message to a recipient without ever
//! authenticating (or learning) the sender.
//!
//! The design has three parts. First, sender certificates: an authenticated
//! device asks `POST /sealed-sender/certificate` for a short-lived certificate
//! binding its user id, device id, and identity public key, signed with the
//! server's sealed-sender ECDSA P-256 key (`FRICK_SEALED_SENDER_KEY_PEM`, or
//! an ephemeral boot key). The certificate travels INSIDE the recipient-only
//! encrypted envelope the client builds (`clients/web/src/crypto/sealed-sender.ts`),
//! so the recipient can authenticate the sender end-to-end while the server
//! stays blind. Clients verify certificates against the public key published
//! by `GET /sealed-sender/config`.
//!
//! Second, unidentified delivery: `POST /sealed-sender/deliver` accepts a
//! stream append WITHOUT a bearer session. The only credential is the
//! recipient's unidentified-access token; the append lands through the exact
//! same store funnel as the classic path (idempotent by request id, write
//! listener fan-out, projections, search) under a sender-hidden principal
//! whose user id is the RECIPIENT's — the transport never records who sent
//! it. App policy hooks still run and see the recipient, stream, key, and
//! event type, never a sender. The classic authenticated `/append` path is
//! untouched.
//!
//! Third, anti-abuse: because the sender is anonymous, spam control is keyed
//! by the recipient. Delivery requires the recipient's current access token
//! (registered, rotated, or revoked via `POST /sealed-sender/token` and
//! `POST /sealed-sender/token/revoke`; the token itself is client-derivable,
//! e.g. from a profile key, or server-minted on request), and every delivery
//! attempt counts against a per-recipient fixed window
//! (`FRICK_MAX_SEALED_DELIVERIES_PER_WINDOW` per
//! `FRICK_SEALED_DELIVERY_WINDOW_MS`), so token brute-forcing and flooding
//! are throttled even though the server cannot rate-limit a sender identity.

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use frick_protocol::Value;
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use p256::pkcs8::DecodePrivateKey;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::authz::{
    Action, Decision, PolicyInput, PolicyResource, ResourceContext, apply_policy_hooks,
    decide_baseline,
};
use crate::config::{FrickConfig, FrickConfigError};
use crate::error::{LimitKind, ServerError};
use crate::http::{AppState, respond_error};
use crate::principal::{DEFAULT_TENANT_ID, Principal, PrincipalScope};
use crate::routes::{
    ActiveApp, authenticate, map_get, msgpack_byte_len, new_request_id, now_ms, parse_body_value,
    random_token, require_record, require_string,
};
use crate::session::ensure_tenant_allowed;

/// Certificate wire-format version.
pub const SEALED_SENDER_CERT_VERSION: u8 = 1;

/// The device id stamped on the sender-hidden principal a sealed delivery
/// appends under. Underscore-prefixed like the other reserved principals.
pub const SEALED_DEVICE_ID: &str = "_sealed";

/// The signature algorithm advertised by `GET /sealed-sender/config`. ECDSA
/// over P-256 with SHA-256, signature transported as the 64-byte IEEE-P1363
/// `r||s` concatenation — exactly what WebCrypto's `ECDSA P-256 / SHA-256`
/// produces and verifies, so the web client needs no signature re-encoding.
pub const SEALED_SENDER_ALGORITHM: &str = "ECDSA-P256-SHA256";

/// Uncompressed SEC1 P-256 point length (the identity/server key encoding).
const P256_POINT_LEN: usize = 65;

/// Client-supplied access tokens must be at least this many characters (a
/// profile-key-derived token is far longer; the bound just rejects trivially
/// guessable registrations).
const MIN_ACCESS_TOKEN_LEN: usize = 16;

/// Upper bound on client-supplied access tokens.
const MAX_ACCESS_TOKEN_LEN: usize = 128;

/// A server-issued sender certificate (AURA-326). The JSON shape is the wire
/// contract with the clients: base64 (standard) bytes for `identityKey` and
/// `signature`, epoch milliseconds for `expiresAt`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderCertificate {
    /// Certificate format version ([`SEALED_SENDER_CERT_VERSION`]).
    pub version: u8,
    /// The sender's user id, as authenticated at issue time.
    pub user_id: String,
    /// The sender's device id, as authenticated at issue time.
    pub device_id: String,
    /// Base64 of the sender's identity public key (65-byte uncompressed
    /// SEC1 P-256 point, matching the web client's `exportPublic`).
    pub identity_key: String,
    /// Expiry as epoch milliseconds; the certificate is invalid after this.
    pub expires_at: i64,
    /// Base64 of the 64-byte `r||s` ECDSA signature over
    /// [`certificate_payload`].
    pub signature: String,
}

/// Why a certificate failed verification.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CertificateError {
    #[error("sealed-sender certificate has expired")]
    Expired,
    #[error("unsupported sealed-sender certificate version")]
    Version,
    #[error("sealed-sender certificate is malformed: {0}")]
    Malformed(String),
    #[error("sealed-sender certificate signature verification failed")]
    BadSignature,
}

/// The canonical byte string a sender certificate signs: the version byte,
/// then the length-prefixed user id, length-prefixed device id,
/// length-prefixed identity key, and the big-endian expiry milliseconds.
/// Length prefixes are 4-byte big-endian, mirroring the web client's
/// deterministic layouts.
#[must_use]
pub fn certificate_payload(
    version: u8,
    user_id: &str,
    device_id: &str,
    identity_key: &[u8],
    expires_at_ms: i64,
) -> Vec<u8> {
    let user = user_id.as_bytes();
    let device = device_id.as_bytes();
    let mut buf =
        Vec::with_capacity(1 + 4 + user.len() + 4 + device.len() + 4 + identity_key.len() + 8);
    buf.push(version);
    buf.extend_from_slice(&u32::try_from(user.len()).unwrap_or(u32::MAX).to_be_bytes());
    buf.extend_from_slice(user);
    buf.extend_from_slice(
        &u32::try_from(device.len())
            .unwrap_or(u32::MAX)
            .to_be_bytes(),
    );
    buf.extend_from_slice(device);
    buf.extend_from_slice(
        &u32::try_from(identity_key.len())
            .unwrap_or(u32::MAX)
            .to_be_bytes(),
    );
    buf.extend_from_slice(identity_key);
    buf.extend_from_slice(&expires_at_ms.to_be_bytes());
    buf
}

/// Verify a sender certificate against a server sealed-sender public key (the
/// 65-byte uncompressed point from `GET /sealed-sender/config`). This is what
/// a RECIPIENT does after opening a sealed envelope; it is also used by the
/// server's own tests. Checks version, expiry, then the ECDSA signature.
pub fn verify_certificate_with_key(
    cert: &SenderCertificate,
    server_public_key: &[u8],
    now_ms: i64,
) -> Result<(), CertificateError> {
    if cert.version != SEALED_SENDER_CERT_VERSION {
        return Err(CertificateError::Version);
    }
    if now_ms > cert.expires_at {
        return Err(CertificateError::Expired);
    }
    let identity_key = STANDARD
        .decode(&cert.identity_key)
        .map_err(|_| CertificateError::Malformed("identityKey is not base64".into()))?;
    let signature_bytes = STANDARD
        .decode(&cert.signature)
        .map_err(|_| CertificateError::Malformed("signature is not base64".into()))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| CertificateError::Malformed("signature is not r||s ECDSA".into()))?;
    let verifying_key = VerifyingKey::from_sec1_bytes(server_public_key).map_err(|_| {
        CertificateError::Malformed("server public key is not a P-256 point".into())
    })?;
    let payload = certificate_payload(
        cert.version,
        &cert.user_id,
        &cert.device_id,
        &identity_key,
        cert.expires_at,
    );
    verifying_key
        .verify(&payload, &signature)
        .map_err(|_| CertificateError::BadSignature)
}

/// The server's sealed-sender signing state: the certificate signing key and
/// the issued-certificate TTL. Built once at boot from [`FrickConfig`] and
/// shared on [`crate::http::AppStateInner::sealed_sender`].
pub struct SealedSenderState {
    signing: SigningKey,
    cert_ttl_ms: i64,
}

impl SealedSenderState {
    /// Build from config: parse `FRICK_SEALED_SENDER_KEY_PEM` (PKCS#8 PEM,
    /// ECDSA P-256) when set, else generate an ephemeral key. A malformed PEM
    /// fails boot loudly rather than silently rotating the fleet's key.
    pub fn from_config(config: &FrickConfig) -> Result<Self, FrickConfigError> {
        let cert_ttl_ms = config.sealed_sender_cert_ttl_seconds.saturating_mul(1_000);
        match config.sealed_sender_key_pem.as_deref() {
            Some(pem) => {
                let signing = SigningKey::from_pkcs8_pem(pem).map_err(|err| {
                    FrickConfigError(format!(
                        "Invalid FRICK_SEALED_SENDER_KEY_PEM (expected a PKCS#8 PEM ECDSA P-256 private key): {err}"
                    ))
                })?;
                Ok(Self {
                    signing,
                    cert_ttl_ms,
                })
            }
            None => Ok(Self::ephemeral(cert_ttl_ms)),
        }
    }

    /// A fresh random signing key (used when no PEM is pinned, and by tests).
    #[must_use]
    pub fn ephemeral(cert_ttl_ms: i64) -> Self {
        Self {
            signing: SigningKey::random(&mut rand::rngs::OsRng),
            cert_ttl_ms,
        }
    }

    /// Certificate TTL in milliseconds.
    #[must_use]
    pub fn cert_ttl_ms(&self) -> i64 {
        self.cert_ttl_ms
    }

    /// The verification public key as the 65-byte uncompressed SEC1 point.
    #[must_use]
    pub fn public_key_bytes(&self) -> Vec<u8> {
        self.signing
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec()
    }

    /// The verification public key, base64 (standard) encoded.
    #[must_use]
    pub fn public_key_base64(&self) -> String {
        STANDARD.encode(self.public_key_bytes())
    }

    /// Issue a certificate binding `(user_id, device_id, identity_key)` until
    /// `now_ms + cert_ttl_ms`, signed with the server key.
    #[must_use]
    pub fn issue_certificate(
        &self,
        user_id: &str,
        device_id: &str,
        identity_key: &[u8],
        now_ms: i64,
    ) -> SenderCertificate {
        let expires_at = now_ms.saturating_add(self.cert_ttl_ms);
        let payload = certificate_payload(
            SEALED_SENDER_CERT_VERSION,
            user_id,
            device_id,
            identity_key,
            expires_at,
        );
        let signature: Signature = self.signing.sign(&payload);
        SenderCertificate {
            version: SEALED_SENDER_CERT_VERSION,
            user_id: user_id.to_string(),
            device_id: device_id.to_string(),
            identity_key: STANDARD.encode(identity_key),
            expires_at,
            signature: STANDARD.encode(signature.to_bytes()),
        }
    }

    /// Verify a certificate against THIS server's public key.
    pub fn verify_certificate(
        &self,
        cert: &SenderCertificate,
        now_ms: i64,
    ) -> Result<(), CertificateError> {
        verify_certificate_with_key(cert, &self.public_key_bytes(), now_ms)
    }
}

/// The sealed-sender routes (AURA-326), merged into the framework router at
/// boot. `GET /sealed-sender/config` is public; the certificate and token
/// routes require a session; `POST /sealed-sender/deliver` deliberately
/// requires NO session — the recipient's access token is the only credential.
pub fn sealed_sender_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/sealed-sender/config", get(sealed_config))
        .route("/sealed-sender/certificate", post(issue_certificate))
        .route("/sealed-sender/token", post(register_token))
        .route("/sealed-sender/token/revoke", post(revoke_token))
        .route("/sealed-sender/deliver", post(deliver))
        .with_state(state)
}

/// `GET /sealed-sender/config`: the server's certificate verification key and
/// algorithm. Public — it is a public key.
async fn sealed_config(State(state): State<AppState>) -> Response {
    Json(json!({
        "publicKey": state.sealed_sender.public_key_base64(),
        "algorithm": SEALED_SENDER_ALGORITHM,
        "certVersion": SEALED_SENDER_CERT_VERSION,
        "certTtlMs": state.sealed_sender.cert_ttl_ms(),
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CertificateBody {
    /// Base64 of the caller's identity public key (65-byte uncompressed
    /// SEC1 P-256 point).
    identity_key: Option<String>,
}

/// `POST /sealed-sender/certificate`: issue a short-lived sender certificate
/// for the authenticated user + device over the submitted identity key.
async fn issue_certificate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CertificateBody>,
) -> Response {
    let request_id = new_request_id();
    let (principal, now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    let identity_key = match body
        .identity_key
        .as_deref()
        .and_then(|raw| STANDARD.decode(raw).ok())
    {
        Some(bytes) if bytes.len() == P256_POINT_LEN && bytes[0] == 0x04 => bytes,
        _ => {
            return respond_error(
                &ServerError::BadRequest {
                    message: "identityKey must be base64 of a 65-byte uncompressed P-256 point"
                        .into(),
                },
                &request_id,
            );
        }
    };

    let certificate = state.sealed_sender.issue_certificate(
        &principal.user_id,
        &principal.device_id,
        &identity_key,
        now,
    );
    Json(json!({
        "certificate": certificate,
        "serverPublicKey": state.sealed_sender.public_key_base64(),
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenBody {
    /// Optional client-derived token (e.g. from the profile key). When
    /// absent the server mints one.
    token: Option<String>,
}

/// `POST /sealed-sender/token`: register (or rotate) the authenticated
/// recipient's unidentified-access token. Returns the active token so a
/// server-minted one can be shared with contacts over E2EE.
async fn register_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<TokenBody>,
) -> Response {
    let request_id = new_request_id();
    let (principal, now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };

    let (token, minted) = match body.token {
        Some(token) => {
            let len = token.chars().count();
            if !(MIN_ACCESS_TOKEN_LEN..=MAX_ACCESS_TOKEN_LEN).contains(&len) {
                return respond_error(
                    &ServerError::BadRequest {
                        message: format!(
                            "token must be {MIN_ACCESS_TOKEN_LEN}..={MAX_ACCESS_TOKEN_LEN} characters"
                        ),
                    },
                    &request_id,
                );
            }
            (token, false)
        }
        None => (random_token(32), true),
    };

    if state
        .store
        .sealed_sender_access()
        .issue(&principal.tenant_id, &principal.user_id, &token, now)
        .await
        .is_err()
    {
        return respond_error(&ServerError::Internal, &request_id);
    }
    Json(json!({ "ok": true, "token": token, "minted": minted })).into_response()
}

/// `POST /sealed-sender/token/revoke`: revoke sealed delivery to the
/// authenticated recipient until a new token is registered.
async fn revoke_token(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let request_id = new_request_id();
    let (principal, now) = match authenticate(&state, &headers).await {
        Ok(result) => result,
        Err(error) => return respond_error(&error, &request_id),
    };
    match state
        .store
        .sealed_sender_access()
        .revoke(&principal.tenant_id, &principal.user_id, now)
        .await
    {
        Ok(revoked) => Json(json!({ "ok": true, "revoked": revoked })).into_response(),
        Err(_) => respond_error(&ServerError::Internal, &request_id),
    }
}

/// The uniform rejection for a missing, wrong, or revoked access token. One
/// message for every failure mode so an anonymous sender cannot probe which
/// recipients exist or have enrolled.
fn access_denied() -> ServerError {
    ServerError::Authorization {
        message: "Invalid unidentified-access token".into(),
        reason: Some("unidentifiedAccessDenied".into()),
    }
}

/// The sender-hidden principal a sealed delivery appends under: the
/// RECIPIENT's user id (never the sender's), the reserved [`SEALED_DEVICE_ID`]
/// device, and a recipient-scoped replica id so append idempotency
/// (`tenant\0replica\0requestId`) is partitioned per recipient.
fn sealed_principal(tenant_id: &str, recipient_user_id: &str) -> Principal {
    Principal {
        user_id: recipient_user_id.to_string(),
        device_id: SEALED_DEVICE_ID.to_string(),
        replica_id: format!("{SEALED_DEVICE_ID}:{recipient_user_id}"),
        tenant_id: tenant_id.to_string(),
        scope: PrincipalScope::Tenant,
        service_scopes: Vec::new(),
    }
}

/// The parsed `POST /sealed-sender/deliver` body.
struct DeliverRequest {
    recipient: String,
    access_token: String,
    tenant_id: String,
    stream: String,
    key: String,
    event: String,
    append_request_id: String,
    payload: Value,
}

/// Parse and shape-check the deliver body (the same field rules as `/append`,
/// plus the recipient + access token this route authenticates with).
fn parse_deliver_request(body: &[u8]) -> Result<DeliverRequest, ServerError> {
    let parsed = parse_body_value(body)?;
    let payload = map_get(&parsed, "payload")
        .ok_or_else(|| ServerError::BadRequest {
            message: "payload must be an object".into(),
        })
        .and_then(|value| require_record(value, "payload"))?;
    Ok(DeliverRequest {
        recipient: require_string(&parsed, "recipientUserId", "recipientUserId")?,
        access_token: require_string(&parsed, "accessToken", "accessToken")?,
        tenant_id: map_get(&parsed, "tenantId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(DEFAULT_TENANT_ID)
            .to_string(),
        stream: require_string(&parsed, "stream", "stream")?,
        key: require_string(&parsed, "key", "key")?,
        event: require_string(&parsed, "event", "event")?,
        append_request_id: require_string(&parsed, "requestId", "requestId")?,
        payload,
    })
}

/// The per-recipient fixed-window throttle. Every attempt counts, valid token
/// or not, so an anonymous sender can neither brute-force tokens nor flood a
/// recipient. Keyed like the auth limiter (`route\0tenant\0identity`).
fn check_delivery_window(
    state: &AppState,
    request: &DeliverRequest,
    now: i64,
) -> Result<(), ServerError> {
    let limiter_key = format!(
        "sealedDeliver\0{}\0{}",
        request.tenant_id, request.recipient
    );
    let window_ms = state.config.limits.sealed_delivery_window_ms;
    let limit =
        u32::try_from(state.config.limits.max_sealed_deliveries_per_window).unwrap_or(u32::MAX);
    let allowed = state
        .auth_limiter
        .lock()
        .map_err(|_| ServerError::Internal)?
        .check(&limiter_key, now, window_ms, limit);
    if allowed {
        Ok(())
    } else {
        Err(ServerError::Limit {
            kind: LimitKind::MaxAuthAttemptsPerWindow,
            detail: Value::Map(vec![(
                Value::from("reason"),
                Value::from("sealedDeliveryThrottled"),
            )]),
        })
    }
}

/// Payload size guard: identical to `/append`.
fn check_payload_size(payload: &Value, max_bytes: i64) -> Result<(), ServerError> {
    let payload_bytes = msgpack_byte_len(payload);
    if i64::try_from(payload_bytes).unwrap_or(i64::MAX) <= max_bytes {
        return Ok(());
    }
    Err(ServerError::Limit {
        kind: LimitKind::MaxStreamAppendPayloadBytes,
        detail: Value::Map(vec![
            (Value::from("reason"), Value::from("payloadTooLarge")),
            (
                Value::from("limit"),
                Value::from("maxStreamAppendPayloadBytes"),
            ),
            (
                Value::from("actualValue"),
                Value::from(i64::try_from(payload_bytes).unwrap_or(i64::MAX)),
            ),
            (Value::from("configuredMax"), Value::from(max_bytes)),
        ]),
    })
}

/// Baseline + app policy hooks over the sender-hidden principal (FR-296
/// pipeline, mirroring the gateway append path). Hooks see the recipient,
/// stream, key, and event type — never a sender identity.
async fn sealed_append_decision(
    state: &AppState,
    principal: &Principal,
    request: &DeliverRequest,
) -> Result<(), ServerError> {
    let baseline = decide_baseline(
        principal,
        Action::StreamAppend,
        &ResourceContext {
            tenant_id: principal.tenant_id.clone(),
            owner_user_id: None,
        },
    );
    let decision = apply_policy_hooks(
        baseline,
        &PolicyInput {
            principal,
            action: Action::StreamAppend,
            resource: PolicyResource {
                kind: "stream",
                name: Some(request.stream.clone()),
                key: Some(request.key.clone()),
                event: Some(request.event.clone()),
                owner_id: None,
                tenant_id: principal.tenant_id.clone(),
            },
            context: Some(&request.payload),
        },
        &state.policy_hooks,
    )
    .await;
    match decision {
        Decision::Allow => Ok(()),
        Decision::Deny {
            reason,
            public_message,
        } => Err(ServerError::Authorization {
            message: public_message,
            reason: Some(reason.as_str().to_string()),
        }),
    }
}

/// `POST /sealed-sender/deliver`: the unidentified delivery route. No bearer
/// session — the recipient's access token authorizes the append, the
/// per-recipient window throttles it, and the event lands through the same
/// store funnel as `/append` under the sender-hidden principal.
async fn deliver(State(state): State<AppState>, active: ActiveApp, body: Bytes) -> Response {
    let request_id = new_request_id();
    let now = now_ms();

    let request = match parse_deliver_request(&body) {
        Ok(request) => request,
        Err(error) => return respond_error(&error, &request_id),
    };
    if let Err(error) = check_delivery_window(&state, &request, now) {
        return respond_error(&error, &request_id);
    }

    // The recipient-facing anti-abuse credential: the ONLY authentication on
    // this route. Missing, wrong, and revoked all answer identically.
    match state
        .store
        .sealed_sender_access()
        .verify(
            &request.tenant_id,
            &request.recipient,
            &request.access_token,
        )
        .await
    {
        Ok(true) => {}
        Ok(false) => return respond_error(&access_denied(), &request_id),
        Err(_) => return respond_error(&ServerError::Internal, &request_id),
    }

    // Tenant gate, exactly as the authenticated preamble runs it. Reached
    // only with a valid token, so anonymous traffic cannot create tenants.
    if let Err(error) = ensure_tenant_allowed(
        &state.store,
        &request.tenant_id,
        state.config.implicit_tenant_creation,
        now,
    )
    .await
    {
        return respond_error(&error, &request_id);
    }

    if let Err(error) = check_payload_size(
        &request.payload,
        state.config.limits.max_stream_append_payload_bytes,
    ) {
        return respond_error(&error, &request_id);
    }

    let principal = sealed_principal(&request.tenant_id, &request.recipient);
    if let Err(error) = sealed_append_decision(&state, &principal, &request).await {
        return respond_error(&error, &request_id);
    }

    match state
        .store
        .append_event(
            &principal.tenant_id,
            &request.stream,
            &request.key,
            &principal.replica_id,
            &request.append_request_id,
            &request.event,
            &request.payload,
            active.app_id(),
        )
        .await
    {
        Ok(result) => Json(json!({
            "ok": true,
            "event": crate::routes::streams::event_json(&result.event),
        }))
        .into_response(),
        Err(error) => respond_error(
            &ServerError::BadRequest {
                message: error.to_string(),
            },
            &request_id,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boot::{BootSeams, create_frick_server, create_frick_server_with_seams};
    use crate::config::load_frick_config;
    use crate::principal::DEFAULT_TENANT_ID;
    use p256::pkcs8::EncodePrivateKey;
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    const NOW: i64 = 1_700_000_000_123;

    fn test_env() -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        env.insert("FRICK_ENV".to_string(), "test".to_string());
        env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
        env.insert("FRICK_PORT".to_string(), "0".to_string());
        env
    }

    fn test_config() -> crate::config::FrickConfig {
        load_frick_config(&test_env()).unwrap()
    }

    /// The foundation schema plus the streams/events these tests append to
    /// (appends resolve stream + event names against the schema).
    fn test_schema() -> frick_protocol::FrickSchema {
        use frick_protocol::schema::{EventDef, FieldDef, FieldKind, StreamDef};
        let field = |id: i64, name: &str| FieldDef {
            id,
            name: name.to_string(),
            kind: FieldKind::String,
            required: false,
            ref_: None,
            enum_values: None,
            sensitivity: None,
        };
        let mut schema = frick_protocol::foundation_schema();
        schema.events = vec![
            EventDef {
                id: 1,
                name: "SealedEnvelope".into(),
                fields: vec![field(1, "envelope")],
            },
            EventDef {
                id: 2,
                name: "MessageSent".into(),
                fields: vec![field(1, "body")],
            },
        ];
        schema.streams = [
            "SealedInbox",
            "blocked-stream",
            "open-stream",
            "ClassicStream",
        ]
        .iter()
        .enumerate()
        .map(|(index, name)| StreamDef {
            id: i64::try_from(index).unwrap() + 1,
            name: (*name).to_string(),
            key_fields: vec![],
            events: vec!["SealedEnvelope".into(), "MessageSent".into()],
        })
        .collect();
        schema
    }

    async fn server() -> crate::boot::FrickServer {
        create_frick_server(test_config(), test_schema())
            .await
            .unwrap()
    }

    /// A fake 65-byte uncompressed P-256 point for identity keys: sealed
    /// certificate issuance treats it as opaque bytes (only shape-checked).
    fn fake_identity_key() -> Vec<u8> {
        let mut bytes = vec![0x04];
        bytes.extend_from_slice(&[0xAB; 64]);
        bytes
    }

    async fn send(
        router: axum::Router,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<serde_json::Value>,
    ) -> (axum::http::StatusCode, serde_json::Value) {
        let mut request = axum::http::Request::builder().method(method).uri(path);
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let request = match body {
            Some(body) => request
                .header("content-type", "application/json")
                .body(axum::body::Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
            None => request.body(axum::body::Body::empty()).unwrap(),
        };
        let response = router.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let parsed: serde_json::Value =
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, parsed)
    }

    fn sealed_router(srv: &crate::boot::FrickServer) -> axum::Router {
        sealed_sender_router(Arc::clone(&srv.state))
    }

    /// Sign up an email account; returns (session token, user id).
    async fn signup(srv: &crate::boot::FrickServer, email: &str) -> (String, String) {
        let router = crate::auth_routes::auth_router(Arc::clone(&srv.state));
        let (status, body) = send(
            router,
            "POST",
            "/auth/email/signup",
            None,
            Some(serde_json::json!({
                "email": email,
                "password": "correct-horse-battery"
            })),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::CREATED, "signup: {body}");
        (
            body["session"]["sessionToken"].as_str().unwrap().to_owned(),
            body["session"]["userId"].as_str().unwrap().to_owned(),
        )
    }

    /// Register a server-minted access token for the session; returns it.
    async fn mint_token(srv: &crate::boot::FrickServer, session: &str) -> String {
        let (status, body) = send(
            sealed_router(srv),
            "POST",
            "/sealed-sender/token",
            Some(session),
            Some(serde_json::json!({})),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "mint: {body}");
        assert_eq!(body["minted"], true);
        body["token"].as_str().unwrap().to_owned()
    }

    fn deliver_body(
        recipient: &str,
        access_token: &str,
        stream: &str,
        request_id: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "recipientUserId": recipient,
            "accessToken": access_token,
            "stream": stream,
            "key": recipient,
            "event": "SealedEnvelope",
            "requestId": request_id,
            "payload": { "envelope": "b64-opaque-sealed-bytes" }
        })
    }

    #[test]
    fn certificate_payload_layout_is_deterministic() {
        let payload = certificate_payload(1, "u", "d", &[0x04, 0xFF], 258);
        let expected: Vec<u8> = vec![
            1, // version
            0, 0, 0, 1, b'u', // user id
            0, 0, 0, 1, b'd', // device id
            0, 0, 0, 2, 0x04, 0xFF, // identity key
            0, 0, 0, 0, 0, 0, 1, 2, // expiry 258 BE
        ];
        assert_eq!(payload, expected);
    }

    #[test]
    fn certificate_issue_verify_expiry_and_tamper() {
        let state = SealedSenderState::ephemeral(86_400_000);
        let cert = state.issue_certificate("user-ada", "device-1", &fake_identity_key(), NOW);
        assert_eq!(cert.expires_at, NOW + 86_400_000);

        // Fresh certificate verifies against the server key (both APIs).
        state.verify_certificate(&cert, NOW + 1_000).unwrap();
        verify_certificate_with_key(&cert, &state.public_key_bytes(), NOW + 1_000).unwrap();

        // Expired.
        assert_eq!(
            state.verify_certificate(&cert, cert.expires_at + 1),
            Err(CertificateError::Expired)
        );

        // Any tampered field breaks the signature.
        let mut tampered = cert.clone();
        tampered.user_id = "user-mallory".into();
        assert_eq!(
            state.verify_certificate(&tampered, NOW),
            Err(CertificateError::BadSignature)
        );
        let mut tampered = cert.clone();
        tampered.identity_key = STANDARD.encode([0x04; 65]);
        assert_eq!(
            state.verify_certificate(&tampered, NOW),
            Err(CertificateError::BadSignature)
        );

        // Wrong version is rejected before any crypto.
        let mut wrong_version = cert.clone();
        wrong_version.version = 2;
        assert_eq!(
            state.verify_certificate(&wrong_version, NOW),
            Err(CertificateError::Version)
        );

        // A different server key never verifies it.
        let other = SealedSenderState::ephemeral(86_400_000);
        assert_eq!(
            verify_certificate_with_key(&cert, &other.public_key_bytes(), NOW),
            Err(CertificateError::BadSignature)
        );
    }

    #[test]
    fn pinned_pem_key_survives_config_round_trip() {
        let signing = SigningKey::random(&mut rand::rngs::OsRng);
        let pem = signing
            .to_pkcs8_pem(p256::pkcs8::LineEnding::LF)
            .unwrap()
            .to_string();

        let mut env = test_env();
        env.insert("FRICK_SEALED_SENDER_KEY_PEM".to_string(), pem);
        env.insert(
            "FRICK_SEALED_SENDER_CERT_TTL_SECONDS".to_string(),
            "60".to_string(),
        );
        let config = load_frick_config(&env).unwrap();
        let state = SealedSenderState::from_config(&config).unwrap();
        assert_eq!(state.cert_ttl_ms(), 60_000);
        assert_eq!(
            state.public_key_bytes(),
            signing.verifying_key().to_encoded_point(false).as_bytes()
        );

        // Malformed PEM fails loudly.
        let mut env = test_env();
        env.insert(
            "FRICK_SEALED_SENDER_KEY_PEM".to_string(),
            "not-a-pem".to_string(),
        );
        let config = load_frick_config(&env).unwrap();
        assert!(SealedSenderState::from_config(&config).is_err());
    }

    #[tokio::test]
    async fn config_route_publishes_the_server_verification_key() {
        let srv = server().await;
        let (status, body) = send(
            sealed_router(&srv),
            "GET",
            "/sealed-sender/config",
            None,
            None,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(body["algorithm"], SEALED_SENDER_ALGORITHM);
        assert_eq!(body["certVersion"], i32::from(SEALED_SENDER_CERT_VERSION));
        let key = STANDARD
            .decode(body["publicKey"].as_str().unwrap())
            .unwrap();
        assert_eq!(key.len(), 65);
        assert_eq!(key[0], 0x04);
        assert_eq!(key, srv.state.sealed_sender.public_key_bytes());
    }

    #[tokio::test]
    async fn certificate_route_issues_a_server_signed_cert() {
        let srv = server().await;
        let (session, user_id) = signup(&srv, "sender@example.com").await;

        // Unauthenticated → 401.
        let (status, _) = send(
            sealed_router(&srv),
            "POST",
            "/sealed-sender/certificate",
            None,
            Some(serde_json::json!({ "identityKey": STANDARD.encode(fake_identity_key()) })),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);

        // Bad identity key → 400.
        let (status, _) = send(
            sealed_router(&srv),
            "POST",
            "/sealed-sender/certificate",
            Some(&session),
            Some(serde_json::json!({ "identityKey": STANDARD.encode([1, 2, 3]) })),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);

        // Valid request → certificate bound to the session's user, verifying
        // against the published server key.
        let (status, body) = send(
            sealed_router(&srv),
            "POST",
            "/sealed-sender/certificate",
            Some(&session),
            Some(serde_json::json!({ "identityKey": STANDARD.encode(fake_identity_key()) })),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "issue: {body}");
        let cert: SenderCertificate = serde_json::from_value(body["certificate"].clone()).unwrap();
        assert_eq!(cert.user_id, user_id);
        let server_key = STANDARD
            .decode(body["serverPublicKey"].as_str().unwrap())
            .unwrap();
        verify_certificate_with_key(&cert, &server_key, crate::routes::now_ms()).unwrap();
    }

    #[tokio::test]
    async fn sealed_deliver_lands_for_recipient_without_sender_auth() {
        let srv = server().await;
        let (recipient_session, recipient) = signup(&srv, "recipient@example.com").await;
        let token = mint_token(&srv, &recipient_session).await;

        // Deliver with NO authorization header at all.
        let (status, body) = send(
            sealed_router(&srv),
            "POST",
            "/sealed-sender/deliver",
            None,
            Some(deliver_body(&recipient, &token, "SealedInbox", "req-1")),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "deliver: {body}");
        assert_eq!(body["ok"], true);
        assert_eq!(body["event"]["event"], "SealedEnvelope");

        // The response and the stored event carry NO sender identity: the
        // only party named anywhere is the recipient (as the stream key).
        assert!(body["event"].get("senderId").is_none());
        let events = srv
            .state
            .store
            .streams()
            .read(
                DEFAULT_TENANT_ID,
                "SealedInbox",
                &recipient,
                0,
                Some(10),
                "_default",
            )
            .await
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event.event, "SealedEnvelope");

        // Idempotent by request id, like the classic path.
        let (status, _) = send(
            sealed_router(&srv),
            "POST",
            "/sealed-sender/deliver",
            None,
            Some(deliver_body(&recipient, &token, "SealedInbox", "req-1")),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        let events = srv
            .state
            .store
            .streams()
            .read(
                DEFAULT_TENANT_ID,
                "SealedInbox",
                &recipient,
                0,
                Some(10),
                "_default",
            )
            .await
            .unwrap();
        assert_eq!(events.len(), 1, "replayed request id deduped");
    }

    #[tokio::test]
    async fn deliver_rejects_bad_missing_or_revoked_tokens() {
        let srv = server().await;
        let (recipient_session, recipient) = signup(&srv, "revoker@example.com").await;

        // No token registered yet → denied.
        let (status, body) = send(
            sealed_router(&srv),
            "POST",
            "/sealed-sender/deliver",
            None,
            Some(deliver_body(
                &recipient,
                "guessed-token-000",
                "SealedInbox",
                "req-a",
            )),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::FORBIDDEN);
        assert_eq!(
            body["error"]["details"]["reason"],
            "unidentifiedAccessDenied"
        );

        // Wrong token after registration → denied.
        let token = mint_token(&srv, &recipient_session).await;
        let (status, _) = send(
            sealed_router(&srv),
            "POST",
            "/sealed-sender/deliver",
            None,
            Some(deliver_body(
                &recipient,
                "wrong-token-000000",
                "SealedInbox",
                "req-b",
            )),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::FORBIDDEN);

        // Revoked → the previously valid token is denied.
        let (status, body) = send(
            sealed_router(&srv),
            "POST",
            "/sealed-sender/token/revoke",
            Some(&recipient_session),
            Some(serde_json::json!({})),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(body["revoked"], true);
        let (status, _) = send(
            sealed_router(&srv),
            "POST",
            "/sealed-sender/deliver",
            None,
            Some(deliver_body(&recipient, &token, "SealedInbox", "req-c")),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::FORBIDDEN);

        // Rotation re-enables with the NEW token only.
        let rotated = mint_token(&srv, &recipient_session).await;
        let (status, _) = send(
            sealed_router(&srv),
            "POST",
            "/sealed-sender/deliver",
            None,
            Some(deliver_body(&recipient, &token, "SealedInbox", "req-d")),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::FORBIDDEN, "old token dead");
        let (status, _) = send(
            sealed_router(&srv),
            "POST",
            "/sealed-sender/deliver",
            None,
            Some(deliver_body(&recipient, &rotated, "SealedInbox", "req-e")),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
    }

    #[tokio::test]
    async fn client_supplied_tokens_are_validated_and_usable() {
        let srv = server().await;
        let (session, recipient) = signup(&srv, "derived@example.com").await;

        // Too short → 400.
        let (status, _) = send(
            sealed_router(&srv),
            "POST",
            "/sealed-sender/token",
            Some(&session),
            Some(serde_json::json!({ "token": "short" })),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);

        // A profile-key-derived token registers and authorizes delivery.
        let derived = "profile-key-derived-access-token";
        let (status, body) = send(
            sealed_router(&srv),
            "POST",
            "/sealed-sender/token",
            Some(&session),
            Some(serde_json::json!({ "token": derived })),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(body["minted"], false);
        assert_eq!(body["token"], derived);
        let (status, _) = send(
            sealed_router(&srv),
            "POST",
            "/sealed-sender/deliver",
            None,
            Some(deliver_body(&recipient, derived, "SealedInbox", "req-f")),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
    }

    #[tokio::test]
    async fn deliver_is_throttled_per_recipient() {
        let mut env = test_env();
        env.insert(
            "FRICK_MAX_SEALED_DELIVERIES_PER_WINDOW".to_string(),
            "2".to_string(),
        );
        let config = load_frick_config(&env).unwrap();
        let srv = create_frick_server(config, test_schema()).await.unwrap();
        let (session, recipient) = signup(&srv, "flooded@example.com").await;
        let token = mint_token(&srv, &session).await;

        for n in 0..2 {
            let (status, _) = send(
                sealed_router(&srv),
                "POST",
                "/sealed-sender/deliver",
                None,
                Some(deliver_body(
                    &recipient,
                    &token,
                    "SealedInbox",
                    &format!("req-{n}"),
                )),
            )
            .await;
            assert_eq!(status, axum::http::StatusCode::OK);
        }
        let (status, body) = send(
            sealed_router(&srv),
            "POST",
            "/sealed-sender/deliver",
            None,
            Some(deliver_body(&recipient, &token, "SealedInbox", "req-3")),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::TOO_MANY_REQUESTS, "{body}");
    }

    /// What the recording hook observed for one append decision: principal
    /// user id, principal device id, stream name, event type.
    type SeenAppend = (String, String, Option<String>, Option<String>);

    /// A tightening-only hook that denies appends to `blocked-stream` and
    /// records every principal + resource it was consulted about.
    struct RecordingHook {
        seen: Mutex<Vec<SeenAppend>>,
    }

    impl crate::authz::PolicyHook for RecordingHook {
        fn evaluate<'a>(
            &'a self,
            input: &'a PolicyInput<'a>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Decision>> + Send + 'a>>
        {
            Box::pin(async move {
                if input.action == Action::StreamAppend {
                    self.seen.lock().unwrap().push((
                        input.principal.user_id.clone(),
                        input.principal.device_id.clone(),
                        input.resource.name.clone(),
                        input.resource.event.clone(),
                    ));
                }
                if input.resource.name.as_deref() == Some("blocked-stream") {
                    Some(Decision::Deny {
                        reason: crate::authz::DenyReason::NotAuthorizedForResource,
                        public_message: "stream is closed".into(),
                    })
                } else {
                    None
                }
            })
        }
    }

    #[tokio::test]
    async fn policy_hooks_run_with_recipient_scoped_principal() {
        let hook = Arc::new(RecordingHook {
            seen: Mutex::new(Vec::new()),
        });
        let mut seams = BootSeams::production();
        seams.policy_hooks.push(hook.clone());
        let srv = create_frick_server_with_seams(test_config(), test_schema(), seams)
            .await
            .unwrap();
        let (session, recipient) = signup(&srv, "hooked@example.com").await;
        let token = mint_token(&srv, &session).await;

        // Hook denies the blocked stream even though the token is valid.
        let (status, body) = send(
            sealed_router(&srv),
            "POST",
            "/sealed-sender/deliver",
            None,
            Some(deliver_body(&recipient, &token, "blocked-stream", "req-1")),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::FORBIDDEN, "{body}");

        // And allows the open one.
        let (status, _) = send(
            sealed_router(&srv),
            "POST",
            "/sealed-sender/deliver",
            None,
            Some(deliver_body(&recipient, &token, "open-stream", "req-2")),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);

        // The hook saw the recipient-scoped sealed principal (never a sender)
        // plus the stream + event type, for both decisions.
        let seen = hook.seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        for (user, device, stream, event) in seen.iter() {
            assert_eq!(user, &recipient, "hooks see the recipient, not a sender");
            assert_eq!(device, SEALED_DEVICE_ID);
            assert_eq!(event.as_deref(), Some("SealedEnvelope"));
            assert!(stream.is_some());
        }
    }

    #[tokio::test]
    async fn classic_authenticated_append_path_is_unaffected() {
        let srv = server().await;
        let (session, user_id) = signup(&srv, "classic@example.com").await;

        // The classic `/append` still works exactly as before, with a bearer
        // session and the caller's own principal.
        let dataplane = crate::routes::dataplane_router(Arc::clone(&srv.state));
        let (status, body) = send(
            dataplane,
            "POST",
            "/append",
            Some(&session),
            Some(serde_json::json!({
                "stream": "ClassicStream",
                "key": user_id,
                "event": "MessageSent",
                "requestId": "classic-req-1",
                "payload": { "body": "hello" }
            })),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "classic append: {body}");
        assert_eq!(body["ok"], true);

        // And the classic path never requires a sealed-sender token.
        let record = srv
            .state
            .store
            .sealed_sender_access()
            .read(DEFAULT_TENANT_ID, &user_id)
            .await
            .unwrap();
        assert!(record.is_none());
    }
}
