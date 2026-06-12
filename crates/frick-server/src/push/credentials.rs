//! Per-tenant push credential storage (map 06 §3.6;
//! `apps/server/src/push/credentials.ts`).
//!
//! Ops store APNs (`.p8` key + ids), FCM (Google service-account JSON), and Web
//! Push (VAPID) credentials per tenant. Each record is JSON-serialized, sealed
//! with AES-256-GCM under a server-side key, and persisted in `tenant_settings`
//! under [`APNS_SETTINGS_KEY`] / [`FCM_SETTINGS_KEY`] / [`WEB_PUSH_SETTINGS_KEY`].
//!
//! # Encryption envelope (byte-compatible with the TS)
//!
//! `createCipheriv("aes-256-gcm", key, iv)` over `JSON.stringify(record)` UTF-8,
//! with a random 12-byte IV and a 16-byte auth tag, NO additional authenticated
//! data (the TS never calls `setAAD`). The stored value is
//! `base64( iv(12) || ciphertext || tag(16) )`. Minimum decodable length is
//! strictly greater than 28 bytes (`IV_BYTES + TAG_BYTES`).
//!
//! # Keys (never stored in the DB)
//!
//! The primary key comes from `FRICK_PUSH_CRED_KEY` (base64, exactly 32 bytes
//! after decode; anything else disables the subsystem). Rotation (FR-61):
//! `FRICK_PUSH_CRED_KEY_PREVIOUS` is a comma-separated list of previous base64
//! 32-byte keys; decryption tries the primary first then each previous key in
//! order (a GCM tag mismatch falls through to the next); blank/invalid entries
//! are silently skipped; all new writes use the primary.
//!
//! Every helper returns `Result<_, PushCredentialError>` and never panics. The
//! env is injected (the [`CredentialEnv`] seam) so tests pin a fixed key.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use rand::RngCore;
use serde::{Deserialize, Serialize};

use frick_store::stores::tenant::TenantSettingsStore;

/// `tenant_settings` key for the sealed APNs credentials (credentials.ts:37).
pub const APNS_SETTINGS_KEY: &str = "push.apns.encrypted";
/// `tenant_settings` key for the sealed FCM credentials (credentials.ts:38).
pub const FCM_SETTINGS_KEY: &str = "push.fcm.encrypted";
/// `tenant_settings` key for the sealed Web Push credentials (credentials.ts:39).
pub const WEB_PUSH_SETTINGS_KEY: &str = "push.webPush.encrypted";

const ENV_PRIMARY_KEY: &str = "FRICK_PUSH_CRED_KEY";
const ENV_PREVIOUS_KEYS: &str = "FRICK_PUSH_CRED_KEY_PREVIOUS";

const IV_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
const KEY_BYTES: usize = 32;

const DISABLED_MESSAGE: &str = "FRICK_PUSH_CRED_KEY is unset or not a base64-encoded 32-byte value";

/// APNs credentials (credentials.ts:46-57). The adapter signs ES256 JWTs from
/// `private_key_pem` and attaches `key_id` + `team_id`; `bundle_id` becomes the
/// `apns-topic` header. `use_sandbox` defaults to `false`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApnsCredentials {
    /// Apple 10-char key id (`keyId`).
    #[serde(rename = "keyId")]
    pub key_id: String,
    /// Apple 10-char team id (`teamId`).
    #[serde(rename = "teamId")]
    pub team_id: String,
    /// App bundle id → `apns-topic` (`bundleId`).
    #[serde(rename = "bundleId")]
    pub bundle_id: String,
    /// PEM-encoded EC P-256 private key (`privateKeyPem`).
    #[serde(rename = "privateKeyPem")]
    pub private_key_pem: String,
    /// Target the sandbox endpoint (`useSandbox`); absent when `false`.
    #[serde(rename = "useSandbox", default, skip_serializing_if = "is_false")]
    pub use_sandbox: bool,
}

/// FCM credentials (credentials.ts:66-71): verbatim from a Google service-account
/// JSON (`project_id`, `client_email`, `private_key`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FcmCredentials {
    /// Google project id (`projectId`).
    #[serde(rename = "projectId")]
    pub project_id: String,
    /// Service-account email = JWT `iss` (`clientEmail`).
    #[serde(rename = "clientEmail")]
    pub client_email: String,
    /// PEM-encoded RSA private key (`privateKey`).
    #[serde(rename = "privateKey")]
    pub private_key: String,
    /// OAuth2 token endpoint override (`tokenUri`).
    #[serde(rename = "tokenUri", default, skip_serializing_if = "Option::is_none")]
    pub token_uri: Option<String>,
}

/// Web Push (VAPID) credentials (credentials.ts:78-82). `subject` must be
/// `mailto:` or `https:`; `public_key` is the base64url VAPID application-server
/// key; `private_key` is a PEM EC P-256 key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebPushCredentials {
    /// VAPID `sub` claim (`subject`).
    pub subject: String,
    /// base64url application-server public key (`publicKey`).
    #[serde(rename = "publicKey")]
    pub public_key: String,
    /// PEM EC P-256 private key (`privateKey`).
    #[serde(rename = "privateKey")]
    pub private_key: String,
}

/// Marker trait implemented by the three credential record types so the
/// load/save helpers can be generic over them.
pub trait PushCredentials: Serialize + serde::de::DeserializeOwned {
    /// The `tenant_settings` key this credential type is stored under.
    fn settings_key() -> &'static str;
}

impl PushCredentials for ApnsCredentials {
    fn settings_key() -> &'static str {
        APNS_SETTINGS_KEY
    }
}
impl PushCredentials for FcmCredentials {
    fn settings_key() -> &'static str {
        FCM_SETTINGS_KEY
    }
}
impl PushCredentials for WebPushCredentials {
    fn settings_key() -> &'static str {
        WEB_PUSH_SETTINGS_KEY
    }
}

/// `PushCredentialError` code (credentials.ts:84-87). The wire string is the
/// `code` field of the `{ ok: false, error }` results / admin error bodies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushCredentialErrorCode {
    /// Key env unset/invalid (`push.credentials.disabled`).
    Disabled,
    /// No `tenant_settings` row (`push.credentials.missing`).
    Missing,
    /// base64 / envelope / JSON / decryption failure (`push.credentials.corrupt`).
    Corrupt,
}

impl PushCredentialErrorCode {
    /// The wire `code` literal.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "push.credentials.disabled",
            Self::Missing => "push.credentials.missing",
            Self::Corrupt => "push.credentials.corrupt",
        }
    }
}

/// `PushCredentialError` (credentials.ts:84-87): `{ code, message }`. Never
/// thrown — returned in `Err` from every operation.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct PushCredentialError {
    /// Stable machine code.
    pub code: PushCredentialErrorCode,
    /// Human-readable detail.
    pub message: String,
}

impl PushCredentialError {
    fn disabled() -> Self {
        Self {
            code: PushCredentialErrorCode::Disabled,
            message: DISABLED_MESSAGE.to_string(),
        }
    }
    fn missing(key: &str, tenant_id: &str) -> Self {
        Self {
            code: PushCredentialErrorCode::Missing,
            message: format!("No {key} stored for tenant {tenant_id}"),
        }
    }
    fn corrupt(message: &str) -> Self {
        Self {
            code: PushCredentialErrorCode::Corrupt,
            message: message.to_string(),
        }
    }
}

/// Env seam for the encryption keys (the TS reads `process.env`, injectable for
/// tests). Production wires [`ProcessCredentialEnv`]; tests pass a fixed map.
///
/// `Send + Sync` so adapters can hold an `Arc<dyn CredentialEnv>` and pass a
/// reference across the async send boundary (the delivery future must be `Send`
/// to dispatch from the job worker).
pub trait CredentialEnv: Send + Sync {
    /// `FRICK_PUSH_CRED_KEY` (base64 32-byte primary), or `None`.
    fn primary(&self) -> Option<String>;
    /// `FRICK_PUSH_CRED_KEY_PREVIOUS` (comma-separated base64 keys), or `None`.
    fn previous(&self) -> Option<String>;
}

/// [`CredentialEnv`] reading the process environment.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProcessCredentialEnv;

impl CredentialEnv for ProcessCredentialEnv {
    fn primary(&self) -> Option<String> {
        std::env::var(ENV_PRIMARY_KEY).ok()
    }
    fn previous(&self) -> Option<String> {
        std::env::var(ENV_PREVIOUS_KEYS).ok()
    }
}

/// A fixed-key [`CredentialEnv`] for tests. `primary` is the base64 of a 32-byte
/// key; `previous` is the comma-joined base64 of additional keys.
#[derive(Debug, Clone, Default)]
pub struct FixedCredentialEnv {
    /// `FRICK_PUSH_CRED_KEY` value.
    pub primary: Option<String>,
    /// `FRICK_PUSH_CRED_KEY_PREVIOUS` value.
    pub previous: Option<String>,
}

impl FixedCredentialEnv {
    /// Build from a raw 32-byte primary key (base64-encoded for you).
    #[must_use]
    pub fn from_key(key: &[u8; KEY_BYTES]) -> Self {
        Self {
            primary: Some(BASE64_STANDARD.encode(key)),
            previous: None,
        }
    }
}

impl CredentialEnv for FixedCredentialEnv {
    fn primary(&self) -> Option<String> {
        self.primary.clone()
    }
    fn previous(&self) -> Option<String> {
        self.previous.clone()
    }
}

/// Decode a base64 key, returning the 32-byte material or `None` for any decode
/// failure / wrong length (`decodeKey`, credentials.ts:93-103).
fn decode_key(raw: &str) -> Option<[u8; KEY_BYTES]> {
    let decoded = BASE64_STANDARD.decode(raw).ok()?;
    if decoded.len() != KEY_BYTES {
        return None;
    }
    let mut key = [0u8; KEY_BYTES];
    key.copy_from_slice(&decoded);
    Some(key)
}

/// The ordered set of keys to try when decrypting, primary first
/// (`readEncryptionKeys`, credentials.ts:113-127). Empty when no valid primary.
fn read_keys(env: &dyn CredentialEnv) -> Vec<[u8; KEY_BYTES]> {
    let Some(primary) = env.primary().as_deref().and_then(decode_key) else {
        return Vec::new();
    };
    let mut keys = vec![primary];
    if let Some(previous) = env.previous() {
        for part in previous.split(',') {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Some(decoded) = decode_key(trimmed) {
                keys.push(decoded);
            }
        }
    }
    keys
}

/// The single primary key used for all new writes (`readPrimaryKey`,
/// credentials.ts:130-132), or `None`.
fn read_primary(env: &dyn CredentialEnv) -> Option<[u8; KEY_BYTES]> {
    env.primary().as_deref().and_then(decode_key)
}

/// `encryptCredential` (credentials.ts:139-159): seal a JSON-serializable record
/// under the primary key. Returns the base64 envelope or
/// `push.credentials.disabled` when no primary key is configured.
///
/// The IV is drawn from `OsRng` at this boundary (the TS uses
/// `crypto.randomBytes`); pass `iv` explicitly via [`encrypt_credential_with_iv`]
/// for deterministic tests.
pub fn encrypt_credential<T: Serialize>(
    value: &T,
    env: &dyn CredentialEnv,
) -> Result<String, PushCredentialError> {
    let mut iv = [0u8; IV_BYTES];
    rand::rngs::OsRng.fill_bytes(&mut iv);
    encrypt_credential_with_iv(value, env, &iv)
}

/// [`encrypt_credential`] with an explicit IV (deterministic tests / round-trip
/// vectors). The IV MUST be 12 random bytes in production.
pub fn encrypt_credential_with_iv<T: Serialize>(
    value: &T,
    env: &dyn CredentialEnv,
    iv: &[u8; IV_BYTES],
) -> Result<String, PushCredentialError> {
    let key = read_primary(env).ok_or_else(PushCredentialError::disabled)?;
    let plaintext = serde_json::to_vec(value)
        .map_err(|err| PushCredentialError::corrupt(&format!("serialize failed: {err}")))?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let nonce = Nonce::from_slice(iv);
    // `aes_gcm` returns ciphertext || tag concatenated, matching the TS layout
    // (`Buffer.concat([enc, tag])`). No AAD (the TS never calls setAAD).
    let sealed = cipher
        .encrypt(
            nonce,
            Payload {
                msg: &plaintext,
                aad: &[],
            },
        )
        .map_err(|_| PushCredentialError::corrupt("encryption failed"))?;
    let mut envelope = Vec::with_capacity(IV_BYTES + sealed.len());
    envelope.extend_from_slice(iv);
    envelope.extend_from_slice(&sealed);
    Ok(BASE64_STANDARD.encode(envelope))
}

/// `decryptCredential` (credentials.ts:161-207): open the base64 envelope,
/// trying each configured key in order. Errors:
/// - `push.credentials.disabled` — no valid primary key.
/// - `push.credentials.corrupt` — `not base64` / `envelope too short` /
///   `decrypted blob is not JSON` / `decryption failed` (every key failed).
pub fn decrypt_credential<T: serde::de::DeserializeOwned>(
    ciphertext: &str,
    env: &dyn CredentialEnv,
) -> Result<T, PushCredentialError> {
    let keys = read_keys(env);
    if keys.is_empty() {
        return Err(PushCredentialError::disabled());
    }
    let raw = BASE64_STANDARD
        .decode(ciphertext)
        .map_err(|_| PushCredentialError::corrupt("not base64"))?;
    if raw.len() <= IV_BYTES + TAG_BYTES {
        return Err(PushCredentialError::corrupt("envelope too short"));
    }
    let iv = &raw[..IV_BYTES];
    // `aes_gcm` expects ciphertext || tag, which is exactly `raw[IV_BYTES..]`.
    let sealed = &raw[IV_BYTES..];
    let nonce = Nonce::from_slice(iv);
    for key in &keys {
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
        let Ok(plain) = cipher.decrypt(
            nonce,
            Payload {
                msg: sealed,
                aad: &[],
            },
        ) else {
            // GCM tag mismatch under this key: the blob was written under a
            // different key — fall through and try the next.
            continue;
        };
        return serde_json::from_slice::<T>(&plain)
            .map_err(|_| PushCredentialError::corrupt("decrypted blob is not JSON"));
    }
    Err(PushCredentialError::corrupt("decryption failed"))
}

/// `saveApnsCredentials` (credentials.ts:254-261): seal + persist under the
/// APNs key. `now_ms` stamps the `tenant_settings.updated_at`.
pub async fn save_apns_credentials(
    store: &TenantSettingsStore,
    tenant_id: &str,
    value: &ApnsCredentials,
    env: &dyn CredentialEnv,
    now_ms: i64,
) -> Result<(), PushCredentialError> {
    save_credential(store, tenant_id, value, env, now_ms).await
}

/// `saveFcmCredentials` (credentials.ts:263-270).
pub async fn save_fcm_credentials(
    store: &TenantSettingsStore,
    tenant_id: &str,
    value: &FcmCredentials,
    env: &dyn CredentialEnv,
    now_ms: i64,
) -> Result<(), PushCredentialError> {
    save_credential(store, tenant_id, value, env, now_ms).await
}

/// `saveWebPushCredentials` (credentials.ts:272-279).
pub async fn save_web_push_credentials(
    store: &TenantSettingsStore,
    tenant_id: &str,
    value: &WebPushCredentials,
    env: &dyn CredentialEnv,
    now_ms: i64,
) -> Result<(), PushCredentialError> {
    save_credential(store, tenant_id, value, env, now_ms).await
}

/// `saveCredential` (credentials.ts:281-292): seal then upsert the ciphertext
/// into `tenant_settings` (stored as a JSON string). A store write failure
/// surfaces as `push.credentials.corrupt` carrying the store message.
async fn save_credential<T: PushCredentials>(
    store: &TenantSettingsStore,
    tenant_id: &str,
    value: &T,
    env: &dyn CredentialEnv,
    now_ms: i64,
) -> Result<(), PushCredentialError> {
    let ciphertext = encrypt_credential(value, env)?;
    store
        .set(
            tenant_id,
            T::settings_key(),
            &serde_json::Value::String(ciphertext),
            now_ms,
        )
        .await
        .map_err(|err| PushCredentialError::corrupt(&format!("store write failed: {err}")))
}

/// `loadApnsCredentials` (credentials.ts:213-219).
pub async fn load_apns_credentials(
    store: &TenantSettingsStore,
    tenant_id: &str,
    env: &dyn CredentialEnv,
) -> Result<ApnsCredentials, PushCredentialError> {
    load_credential(store, tenant_id, env).await
}

/// `loadFcmCredentials` (credentials.ts:221-227).
pub async fn load_fcm_credentials(
    store: &TenantSettingsStore,
    tenant_id: &str,
    env: &dyn CredentialEnv,
) -> Result<FcmCredentials, PushCredentialError> {
    load_credential(store, tenant_id, env).await
}

/// `loadWebPushCredentials` (credentials.ts:229-235).
pub async fn load_web_push_credentials(
    store: &TenantSettingsStore,
    tenant_id: &str,
    env: &dyn CredentialEnv,
) -> Result<WebPushCredentials, PushCredentialError> {
    load_credential(store, tenant_id, env).await
}

/// `loadCredential` (credentials.ts:237-251): read the stored ciphertext string
/// then [`decrypt_credential`]. `push.credentials.missing` when the setting is
/// absent or not a string. A store read failure surfaces as `missing`
/// (mirroring the TS `typeof stored !== "string"` check, which a read failure
/// also fails).
async fn load_credential<T: PushCredentials>(
    store: &TenantSettingsStore,
    tenant_id: &str,
    env: &dyn CredentialEnv,
) -> Result<T, PushCredentialError> {
    let key = T::settings_key();
    let stored = store.get(tenant_id, key).await.ok().flatten();
    let Some(serde_json::Value::String(ciphertext)) = stored else {
        return Err(PushCredentialError::missing(key, tenant_id));
    };
    decrypt_credential(&ciphertext, env)
}

// serde's `skip_serializing_if` requires a `&bool` predicate signature.
#[allow(clippy::trivially_copy_pass_by_ref)]
const fn is_false(value: &bool) -> bool {
    !*value
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; KEY_BYTES] = [7u8; KEY_BYTES];

    fn env() -> FixedCredentialEnv {
        FixedCredentialEnv::from_key(&KEY)
    }

    fn apns() -> ApnsCredentials {
        ApnsCredentials {
            key_id: "ABC1234567".to_string(),
            team_id: "TEAM123456".to_string(),
            bundle_id: "dev.frick.app".to_string(),
            private_key_pem: "-----BEGIN PRIVATE KEY-----\nMIG...\n-----END PRIVATE KEY-----"
                .to_string(),
            use_sandbox: true,
        }
    }

    #[test]
    fn seal_open_round_trip_with_fixed_key() {
        let env = env();
        let creds = apns();
        let sealed = encrypt_credential(&creds, &env).unwrap();
        let opened: ApnsCredentials = decrypt_credential(&sealed, &env).unwrap();
        assert_eq!(opened, creds);
    }

    #[test]
    fn envelope_layout_iv_ct_tag_base64() {
        // Fixed IV → deterministic envelope; assert the iv||ct||tag layout.
        let env = env();
        let iv = [9u8; IV_BYTES];
        let sealed = encrypt_credential_with_iv(&apns(), &env, &iv).unwrap();
        let raw = BASE64_STANDARD.decode(&sealed).unwrap();
        // iv(12) prefix matches; tail length includes the 16-byte tag.
        assert_eq!(&raw[..IV_BYTES], &iv);
        assert!(raw.len() > IV_BYTES + TAG_BYTES);
    }

    #[test]
    fn disabled_when_no_primary_key() {
        let env = FixedCredentialEnv::default();
        let err = encrypt_credential(&apns(), &env).unwrap_err();
        assert_eq!(err.code, PushCredentialErrorCode::Disabled);
        assert_eq!(err.message, DISABLED_MESSAGE);
        let derr = decrypt_credential::<ApnsCredentials>("AAAA", &env).unwrap_err();
        assert_eq!(derr.code, PushCredentialErrorCode::Disabled);
    }

    #[test]
    fn corrupt_codes_for_bad_envelopes() {
        let env = env();
        // not base64
        let e = decrypt_credential::<ApnsCredentials>("!!!not base64!!!", &env).unwrap_err();
        assert_eq!(e.code, PushCredentialErrorCode::Corrupt);
        assert_eq!(e.message, "not base64");
        // too short
        let short = BASE64_STANDARD.encode([0u8; IV_BYTES + TAG_BYTES]);
        let e = decrypt_credential::<ApnsCredentials>(&short, &env).unwrap_err();
        assert_eq!(e.message, "envelope too short");
        // wrong key → decryption failed
        let other = FixedCredentialEnv::from_key(&[1u8; KEY_BYTES]);
        let sealed = encrypt_credential(&apns(), &other).unwrap();
        let e = decrypt_credential::<ApnsCredentials>(&sealed, &env).unwrap_err();
        assert_eq!(e.message, "decryption failed");
    }

    #[test]
    fn rotation_decrypts_under_previous_key() {
        // Sealed under the OLD key; the new env lists it as a previous key.
        let old_key = [3u8; KEY_BYTES];
        let old_env = FixedCredentialEnv::from_key(&old_key);
        let sealed = encrypt_credential(&apns(), &old_env).unwrap();

        let rotated = FixedCredentialEnv {
            primary: Some(BASE64_STANDARD.encode(KEY)),
            // blank + invalid entries are skipped; the real old key is honored.
            previous: Some(format!(
                " , not-base64 , {}",
                BASE64_STANDARD.encode(old_key)
            )),
        };
        let opened: ApnsCredentials = decrypt_credential(&sealed, &rotated).unwrap();
        assert_eq!(opened, apns());

        // New writes use the primary — the old env can no longer open them.
        let new_sealed = encrypt_credential(&apns(), &rotated).unwrap();
        assert!(decrypt_credential::<ApnsCredentials>(&new_sealed, &old_env).is_err());
    }

    #[test]
    fn apns_record_serializes_with_camel_case_keys() {
        let json = serde_json::to_value(apns()).unwrap();
        assert!(json.get("keyId").is_some());
        assert!(json.get("teamId").is_some());
        assert!(json.get("bundleId").is_some());
        assert!(json.get("privateKeyPem").is_some());
        assert_eq!(json["useSandbox"], serde_json::Value::Bool(true));
        // useSandbox omitted when false (matches TS optional).
        let mut creds = apns();
        creds.use_sandbox = false;
        let json = serde_json::to_value(creds).unwrap();
        assert!(json.get("useSandbox").is_none());
    }
}
