//! Server-side at-rest encryption for sensitive stored values (AURA-328).
//!
//! The store encrypts a deliberately scoped set of value columns before they
//! reach the SQL driver (or the filesystem / S3 blob-bytes drivers) and
//! decrypts them on the way back out. Covered surfaces: `objects.packed`
//! (object-store values, which is where application record data such as
//! drafts lives), blob content bytes on every bytes driver (routed through
//! the facade's `write_content` / `read_content`), and
//! `push_device_registrations.token` (push tokens are device-identifying
//! PII). Deliberately NOT covered, with reasons: `auth_sessions`,
//! `auth_refresh_tokens`, and `auth_password_reset_tokens` store one-way
//! SHA-256 digests rather than recoverable secrets; `signal_outbox` rows are
//! ephemeral with a thirty-second TTL; `search_indexes` must hold matchable
//! derived text to function; `stream_events.packed` and `jobs.packed` are
//! named follow-up surfaces (they thread through the idempotency cache and
//! tombstone-rewrite paths and get their own ticket).
//!
//! The scheme is envelope encryption. A 32-byte master key comes from a
//! [`KeyProvider`]; the production default is [`EnvKeyProvider`], which reads
//! `FRICK_STORE_KEY` (falling back to `FRICK_AT_REST_KEY`) as 64 hex chars or
//! base64 for 32 bytes. Each value is sealed with ChaCha20-Poly1305 under a
//! per-tenant key derived via HKDF-SHA256 from the master key with the tenant
//! id as the `info` input, so ciphertext never decrypts across tenants. The
//! stored envelope is self-describing: a magic prefix, the key id that sealed
//! it, the nonce, then the ciphertext. Because the key id/version travels
//! inside the envelope, swapping [`EnvKeyProvider`] for a cloud-KMS-backed
//! provider later requires no re-migration: new writes carry the new key id
//! while old rows keep decrypting through [`KeyProvider::master_key`] lookup.
//!
//! Backwards compatibility is encrypt-on-write. A value without the envelope
//! prefix is returned verbatim, so pre-existing plaintext rows keep reading
//! after a key is configured, and a store with no key configured behaves
//! byte-for-byte as before. No schema migration is required, which is why the
//! canonical migration fixtures are untouched by this feature.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;

use crate::error::StoreError;

/// Primary environment variable holding the master key (64 hex chars or
/// base64, 32 bytes either way).
pub const STORE_KEY_ENV: &str = "FRICK_STORE_KEY";

/// Fallback environment variable consulted when [`STORE_KEY_ENV`] is unset,
/// matching the name floated in the original AURA-328 design notes.
pub const STORE_KEY_FALLBACK_ENV: &str = "FRICK_AT_REST_KEY";

/// Optional environment variable overriding the key id recorded in envelopes
/// sealed by the env-provided key. Bump it when rotating the env key so old
/// envelopes remain distinguishable from new ones.
pub const STORE_KEY_ID_ENV: &str = "FRICK_STORE_KEY_ID";

/// Key id recorded for env-provided keys when [`STORE_KEY_ID_ENV`] is unset.
pub const DEFAULT_ENV_KEY_ID: &str = "env-1";

/// Binary envelope magic. Eight bytes chosen to be vanishingly improbable as
/// a legacy plaintext prefix (`objects.packed` always starts with a msgpack
/// fixarray byte, and push tokens are printable text).
const ENVELOPE_MAGIC: &[u8; 8] = b"FRICKAE1";

/// Text envelope prefix for TEXT columns: the base64 of the binary envelope
/// rides behind it.
const TEXT_ENVELOPE_PREFIX: &str = "frickenc:v1:";

/// ChaCha20-Poly1305 nonce length in bytes.
const NONCE_LEN: usize = 12;

/// HKDF salt fixing the per-tenant derivation domain.
const HKDF_SALT: &[u8] = b"frick-store-at-rest:v1";

/// Pluggable master-key source. The env provider is the default; a cloud KMS
/// provider implements the same two methods and slots in without touching
/// stored data, because every envelope records the key id that sealed it.
pub trait KeyProvider: Send + Sync {
    /// Key id new writes are sealed under. `None` means encryption is off and
    /// writes stay plaintext.
    fn active_key_id(&self) -> Option<String>;

    /// Fetch the 32-byte master key for `key_id`, or `Ok(None)` when the id
    /// is unknown to this provider (which fails the read loudly rather than
    /// returning ciphertext).
    fn master_key(&self, key_id: &str) -> Result<Option<[u8; 32]>, StoreError>;
}

/// [`KeyProvider`] backed by a single in-memory key, normally sourced from
/// the environment via [`EnvKeyProvider::from_env`].
pub struct EnvKeyProvider {
    key_id: String,
    key: [u8; 32],
}

impl EnvKeyProvider {
    /// Wrap an explicit key under `key_id`. The id must be one to 255 bytes
    /// so it fits the envelope's length-prefixed field.
    pub fn new(key_id: impl Into<String>, key: [u8; 32]) -> Result<Self, StoreError> {
        let key_id = key_id.into();
        validate_key_id(&key_id)?;
        Ok(Self { key_id, key })
    }

    /// Read the master key from [`STORE_KEY_ENV`] (fallback
    /// [`STORE_KEY_FALLBACK_ENV`]). `Ok(None)` when neither is set or both
    /// are empty, which keeps the store running plaintext exactly as before;
    /// a present-but-malformed value is a hard error so a typo never silently
    /// disables at-rest encryption.
    pub fn from_env() -> Result<Option<Self>, StoreError> {
        let raw = std::env::var(STORE_KEY_ENV)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                std::env::var(STORE_KEY_FALLBACK_ENV)
                    .ok()
                    .filter(|value| !value.trim().is_empty())
            });
        let Some(raw) = raw else {
            return Ok(None);
        };
        let key = Self::parse_key(&raw)?;
        let key_id = std::env::var(STORE_KEY_ID_ENV)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_ENV_KEY_ID.to_string());
        Ok(Some(Self::new(key_id, key)?))
    }

    /// Parse a master-key string: 64 hex characters, or base64 (standard
    /// alphabet, padded or unpadded) decoding to exactly 32 bytes.
    pub fn parse_key(value: &str) -> Result<[u8; 32], StoreError> {
        let trimmed = value.trim();
        let bytes = if trimmed.len() == 64 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
            hex::decode(trimmed)
                .map_err(|err| StoreError::store(format!("invalid hex at-rest key: {err}")))?
        } else {
            STANDARD
                .decode(trimmed)
                .or_else(|_| STANDARD_NO_PAD.decode(trimmed))
                .map_err(|_| {
                    StoreError::store(
                        "at-rest key must be 64 hex chars or base64 for 32 bytes".to_string(),
                    )
                })?
        };
        <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| {
            StoreError::store(format!(
                "at-rest key must decode to exactly 32 bytes, got {}",
                bytes.len()
            ))
        })
    }
}

impl KeyProvider for EnvKeyProvider {
    fn active_key_id(&self) -> Option<String> {
        Some(self.key_id.clone())
    }

    fn master_key(&self, key_id: &str) -> Result<Option<[u8; 32]>, StoreError> {
        if key_id == self.key_id {
            Ok(Some(self.key))
        } else {
            Ok(None)
        }
    }
}

fn validate_key_id(key_id: &str) -> Result<(), StoreError> {
    if key_id.is_empty() || key_id.len() > 255 {
        return Err(StoreError::store(format!(
            "at-rest key id must be 1..=255 bytes, got {}",
            key_id.len()
        )));
    }
    Ok(())
}

/// The at-rest encryption engine the stores call through. Holds the pluggable
/// [`KeyProvider`] and implements the envelope format described in the module
/// docs. Cheap to share behind an `Arc`.
pub struct AtRestEncryption {
    provider: Arc<dyn KeyProvider>,
}

impl AtRestEncryption {
    /// Build the engine over any [`KeyProvider`].
    #[must_use]
    pub fn new(provider: Arc<dyn KeyProvider>) -> Self {
        Self { provider }
    }

    /// Build the env-keyed engine, or `Ok(None)` when no key is configured
    /// (plaintext mode, byte-for-byte today's behavior).
    pub fn from_env() -> Result<Option<Self>, StoreError> {
        Ok(EnvKeyProvider::from_env()?.map(|provider| Self::new(Arc::new(provider))))
    }

    /// Whether new writes will be sealed (the provider advertises an active
    /// key id).
    #[must_use]
    pub fn is_active(&self) -> bool {
        self.provider.active_key_id().is_some()
    }

    /// Seal `plaintext` for `tenant_id` under the provider's active key.
    /// Returns the plaintext unchanged when the provider has no active key.
    pub fn encrypt(&self, tenant_id: &str, plaintext: &[u8]) -> Result<Vec<u8>, StoreError> {
        let Some(key_id) = self.provider.active_key_id() else {
            return Ok(plaintext.to_vec());
        };
        validate_key_id(&key_id)?;
        let cipher = self.tenant_cipher(&key_id, tenant_id)?;
        let mut nonce_bytes = [0u8; NONCE_LEN];
        rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
        let aad = envelope_aad(tenant_id, &key_id);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: plaintext,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| StoreError::store("at-rest encryption failed".to_string()))?;
        let key_id_len = u8::try_from(key_id.len())
            .map_err(|_| StoreError::store("at-rest key id too long".to_string()))?;
        let mut envelope = Vec::with_capacity(
            ENVELOPE_MAGIC.len() + 1 + key_id.len() + NONCE_LEN + ciphertext.len(),
        );
        envelope.extend_from_slice(ENVELOPE_MAGIC);
        envelope.push(key_id_len);
        envelope.extend_from_slice(key_id.as_bytes());
        envelope.extend_from_slice(&nonce_bytes);
        envelope.extend_from_slice(&ciphertext);
        Ok(envelope)
    }

    /// Open a stored value for `tenant_id`. A value without the envelope
    /// magic is legacy plaintext and is returned verbatim (encrypt-on-write
    /// compatibility); an enveloped value decrypts under the key id it
    /// records, so rotated-away keys keep working as long as the provider can
    /// still resolve them.
    pub fn decrypt(&self, tenant_id: &str, stored: &[u8]) -> Result<Vec<u8>, StoreError> {
        if !stored.starts_with(ENVELOPE_MAGIC) {
            return Ok(stored.to_vec());
        }
        let body = &stored[ENVELOPE_MAGIC.len()..];
        let (&key_id_len, body) = body
            .split_first()
            .ok_or_else(|| malformed("missing key id length"))?;
        let key_id_len = usize::from(key_id_len);
        if key_id_len == 0 || body.len() < key_id_len + NONCE_LEN + 1 {
            return Err(malformed("truncated envelope"));
        }
        let (key_id_bytes, body) = body.split_at(key_id_len);
        let key_id = std::str::from_utf8(key_id_bytes)
            .map_err(|_| malformed("key id is not UTF-8"))?
            .to_string();
        let (nonce_bytes, ciphertext) = body.split_at(NONCE_LEN);
        let cipher = self.tenant_cipher(&key_id, tenant_id)?;
        let aad = envelope_aad(tenant_id, &key_id);
        cipher
            .decrypt(
                Nonce::from_slice(nonce_bytes),
                Payload {
                    msg: ciphertext,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| {
                StoreError::store(format!(
                    "at-rest decryption failed for key '{key_id}': wrong key, wrong tenant, or corrupted value"
                ))
            })
    }

    /// Seal a TEXT-column value: the binary envelope rides base64-encoded
    /// behind the `frickenc:v1:` prefix. Passthrough when no key is active.
    pub fn encrypt_text(&self, tenant_id: &str, plaintext: &str) -> Result<String, StoreError> {
        if !self.is_active() {
            return Ok(plaintext.to_string());
        }
        let envelope = self.encrypt(tenant_id, plaintext.as_bytes())?;
        Ok(format!(
            "{TEXT_ENVELOPE_PREFIX}{}",
            STANDARD_NO_PAD.encode(envelope)
        ))
    }

    /// Open a TEXT-column value; non-prefixed values are legacy plaintext and
    /// pass through verbatim.
    pub fn decrypt_text(&self, tenant_id: &str, stored: &str) -> Result<String, StoreError> {
        let Some(encoded) = stored.strip_prefix(TEXT_ENVELOPE_PREFIX) else {
            return Ok(stored.to_string());
        };
        let envelope = STANDARD_NO_PAD
            .decode(encoded)
            .or_else(|_| STANDARD.decode(encoded))
            .map_err(|_| malformed("text envelope is not base64"))?;
        let plaintext = self.decrypt(tenant_id, &envelope)?;
        String::from_utf8(plaintext).map_err(|_| malformed("decrypted text is not UTF-8"))
    }

    /// Derive the per-tenant ChaCha20-Poly1305 cipher for `key_id`:
    /// HKDF-SHA256(salt = domain constant, ikm = master key, info = tenant id).
    fn tenant_cipher(&self, key_id: &str, tenant_id: &str) -> Result<ChaCha20Poly1305, StoreError> {
        let master = self.provider.master_key(key_id)?.ok_or_else(|| {
            StoreError::store(format!(
                "at-rest key id '{key_id}' is unknown to the configured key provider"
            ))
        })?;
        let hkdf = Hkdf::<Sha256>::new(Some(HKDF_SALT), &master);
        let mut tenant_key = [0u8; 32];
        hkdf.expand(tenant_id.as_bytes(), &mut tenant_key)
            .map_err(|_| StoreError::store("at-rest tenant key derivation failed".to_string()))?;
        Ok(ChaCha20Poly1305::new(Key::from_slice(&tenant_key)))
    }
}

impl std::fmt::Debug for AtRestEncryption {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AtRestEncryption")
            .field("active_key_id", &self.provider.active_key_id())
            .finish()
    }
}

/// Additional authenticated data binding an envelope to its tenant and key
/// id, so a ciphertext moved between rows or tenants fails authentication
/// even if key derivation were ever weakened.
fn envelope_aad(tenant_id: &str, key_id: &str) -> String {
    format!("frick-store-at-rest:v1:{tenant_id}:{key_id}")
}

fn malformed(detail: &str) -> StoreError {
    StoreError::store(format!("at-rest envelope malformed: {detail}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TENANT: &str = "tenant-1";

    fn engine_with(key_id: &str, key: [u8; 32]) -> AtRestEncryption {
        AtRestEncryption::new(Arc::new(
            EnvKeyProvider::new(key_id, key).expect("valid key id"),
        ))
    }

    fn engine() -> AtRestEncryption {
        engine_with("test-1", [7u8; 32])
    }

    /// Provider with a rotated-in active key that can still resolve the old
    /// key id, modeling a KMS after rotation.
    struct RotatedProvider;

    impl KeyProvider for RotatedProvider {
        fn active_key_id(&self) -> Option<String> {
            Some("v2".to_string())
        }

        fn master_key(&self, key_id: &str) -> Result<Option<[u8; 32]>, StoreError> {
            match key_id {
                "v1" => Ok(Some([1u8; 32])),
                "v2" => Ok(Some([2u8; 32])),
                _ => Ok(None),
            }
        }
    }

    /// Provider that advertises no active key: writes stay plaintext.
    struct InactiveProvider;

    impl KeyProvider for InactiveProvider {
        fn active_key_id(&self) -> Option<String> {
            None
        }

        fn master_key(&self, _key_id: &str) -> Result<Option<[u8; 32]>, StoreError> {
            Ok(None)
        }
    }

    #[test]
    fn bytes_round_trip_and_envelope_is_not_plaintext() {
        let engine = engine();
        let plaintext = b"drafts are sensitive".to_vec();
        let sealed = engine.encrypt(TENANT, &plaintext).unwrap();
        assert!(sealed.starts_with(ENVELOPE_MAGIC));
        assert_ne!(sealed, plaintext);
        // The plaintext bytes must not appear inside the envelope.
        assert!(
            !sealed
                .windows(plaintext.len())
                .any(|window| window == plaintext.as_slice())
        );
        assert_eq!(engine.decrypt(TENANT, &sealed).unwrap(), plaintext);
    }

    #[test]
    fn text_round_trips_behind_the_prefix() {
        let engine = engine();
        let sealed = engine.encrypt_text(TENANT, "apns-token-123").unwrap();
        assert!(sealed.starts_with(TEXT_ENVELOPE_PREFIX));
        assert!(!sealed.contains("apns-token-123"));
        assert_eq!(
            engine.decrypt_text(TENANT, &sealed).unwrap(),
            "apns-token-123"
        );
    }

    #[test]
    fn wrong_key_fails_decryption() {
        let sealed = engine().encrypt(TENANT, b"secret").unwrap();
        // Same key id, different key material: authentication must fail.
        let wrong = engine_with("test-1", [9u8; 32]);
        let error = wrong
            .decrypt(TENANT, &sealed)
            .expect_err("wrong key must fail");
        assert!(error.to_string().contains("at-rest decryption failed"));
    }

    #[test]
    fn plaintext_values_pass_through_on_read() {
        let engine = engine();
        assert_eq!(
            engine.decrypt(TENANT, b"\x93legacy-msgpack").unwrap(),
            b"\x93legacy-msgpack".to_vec()
        );
        assert_eq!(
            engine.decrypt_text(TENANT, "legacy-plain-token").unwrap(),
            "legacy-plain-token"
        );
    }

    #[test]
    fn tenant_keys_are_separated() {
        let engine = engine();
        let sealed = engine.encrypt("tenant-a", b"cross-tenant").unwrap();
        let error = engine
            .decrypt("tenant-b", &sealed)
            .expect_err("another tenant's derived key must not open the envelope");
        assert!(error.to_string().contains("at-rest decryption failed"));
        assert_eq!(
            engine.decrypt("tenant-a", &sealed).unwrap(),
            b"cross-tenant"
        );
    }

    #[test]
    fn rotated_provider_still_opens_old_key_id_envelopes() {
        // Seal under v1 with a single-key provider.
        let old = engine_with("v1", [1u8; 32]);
        let sealed_v1 = old.encrypt(TENANT, b"pre-rotation").unwrap();

        // The rotated provider seals new writes under v2 but resolves v1.
        let rotated = AtRestEncryption::new(Arc::new(RotatedProvider));
        assert_eq!(
            rotated.decrypt(TENANT, &sealed_v1).unwrap(),
            b"pre-rotation"
        );
        let sealed_v2 = rotated.encrypt(TENANT, b"post-rotation").unwrap();
        assert_eq!(
            rotated.decrypt(TENANT, &sealed_v2).unwrap(),
            b"post-rotation"
        );
        // And the new envelope records v2, not v1.
        let key_id_len = usize::from(sealed_v2[ENVELOPE_MAGIC.len()]);
        let key_id = &sealed_v2[ENVELOPE_MAGIC.len() + 1..ENVELOPE_MAGIC.len() + 1 + key_id_len];
        assert_eq!(key_id, b"v2");
    }

    #[test]
    fn unknown_key_id_is_a_loud_error() {
        let sealed = engine_with("gone-1", [3u8; 32])
            .encrypt(TENANT, b"x")
            .unwrap();
        let error = engine()
            .decrypt(TENANT, &sealed)
            .expect_err("unknown key id must not silently return ciphertext");
        assert!(
            error
                .to_string()
                .contains("unknown to the configured key provider")
        );
    }

    #[test]
    fn inactive_provider_writes_plaintext() {
        let engine = AtRestEncryption::new(Arc::new(InactiveProvider));
        assert!(!engine.is_active());
        assert_eq!(engine.encrypt(TENANT, b"open").unwrap(), b"open".to_vec());
        assert_eq!(engine.encrypt_text(TENANT, "open").unwrap(), "open");
    }

    #[test]
    fn malformed_envelopes_error_instead_of_panicking() {
        let engine = engine();
        // Magic with nothing behind it.
        assert!(engine.decrypt(TENANT, ENVELOPE_MAGIC).is_err());
        // Magic + a key id length pointing past the end.
        let mut truncated = ENVELOPE_MAGIC.to_vec();
        truncated.push(200);
        truncated.extend_from_slice(b"short");
        assert!(engine.decrypt(TENANT, &truncated).is_err());
        // Text prefix with junk behind it.
        assert!(
            engine
                .decrypt_text(TENANT, "frickenc:v1:!!!not-base64!!!")
                .is_err()
        );
    }

    #[test]
    fn master_key_strings_parse_as_hex_and_base64() {
        let key = [0xABu8; 32];
        let hex_form = hex::encode(key);
        assert_eq!(EnvKeyProvider::parse_key(&hex_form).unwrap(), key);
        let b64_form = STANDARD.encode(key);
        assert_eq!(EnvKeyProvider::parse_key(&b64_form).unwrap(), key);
        let b64_nopad = STANDARD_NO_PAD.encode(key);
        assert_eq!(EnvKeyProvider::parse_key(&b64_nopad).unwrap(), key);
        // Wrong length and garbage both fail loudly.
        assert!(EnvKeyProvider::parse_key("deadbeef").is_err());
        assert!(EnvKeyProvider::parse_key(&STANDARD.encode([1u8; 16])).is_err());
        assert!(EnvKeyProvider::parse_key("not a key at all").is_err());
    }

    #[test]
    fn key_id_length_limits_are_enforced() {
        assert!(EnvKeyProvider::new("", [0u8; 32]).is_err());
        assert!(EnvKeyProvider::new("x".repeat(256), [0u8; 32]).is_err());
        assert!(EnvKeyProvider::new("x".repeat(255), [0u8; 32]).is_ok());
    }
}
