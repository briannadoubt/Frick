//! Call end-to-end encryption (E2EE) key exchange — FR-289 (calls epic).
//!
//! This is the **Rust port of the key-agreement + sender-key envelope half** of
//! the E2EE-calls design (`docs/e2ee-calls.md`). It is a self-contained, pure-
//! Rust crypto module: **no native deps** (no `ring`, no OpenSSL, no C/asm). The
//! primitives are [`x25519_dalek`] for X25519 ECDH key agreement and
//! [`chacha20poly1305`] for ChaCha20-Poly1305 AEAD, with HKDF-SHA-256
//! ([`hkdf`] + [`sha2`]) for the key schedule.
//!
//! # What this module owns
//!
//! Per `docs/e2ee-calls.md` ("Key-epoch lifecycle", "What FR-158 delivered"):
//!
//! - **Per-call symmetric media key** ([`MediaKey`]): the 32-byte secret every
//!   current member shares for an epoch. [`CallKeyManager`] mints it, rotates it
//!   on membership change, and retains the immediately-previous epoch for a short
//!   transition window (keeps **at most one** prior epoch).
//! - **Per-recipient key wrapping** ([`SealedKeyEnvelope`]): the epoch key is
//!   wrapped **individually to each member's X25519 public key** via ECDH + AEAD
//!   (no shared room secret). A removed member is simply not in the recipient
//!   set, so no envelope is sealed to its key → it cannot obtain future epoch
//!   keys (membership-change forward secrecy, enforced cryptographically).
//! - **The sender-key relay envelope** ([`KeyEpochEnvelope`]): the structure the
//!   gateway relays over `WebRTCSignal`'s additive `"keyEpoch"` path. This module
//!   only does the **encode/decode + crypto**; the gateway wiring is out of
//!   scope (FR-284+).
//! - **Media-frame AEAD** ([`MediaKey::encrypt_frame`] /
//!   [`MediaKey::decrypt_frame`]): seal/open one media frame under the epoch key,
//!   with the SFrame-style header authenticated as associated data.
//!
//! # FR-210: never truncate the sender id
//!
//! FR-210 fixed a bug where the sender id was truncated. Here the **full**
//! sender id is carried verbatim through every envelope and bound into the AEAD
//! associated data — it is **never** truncated, hashed-to-fixed-width, or
//! clamped. See [`KeyEpochEnvelope::sender_id`] and the FR-210 regression test.
//!
//! # What this is NOT
//!
//! This is the **sender-key** distribution scheme (O(members) per epoch), not
//! MLS. MLS (RFC 9420) remains future work behind the same envelope seam. See
//! `docs/e2ee-calls.md` → "Follow-ups".

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use rand::RngCore;
use rand::rngs::OsRng;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

/// Length of a media / epoch key (ChaCha20-Poly1305 key), in bytes.
pub const MEDIA_KEY_BYTES: usize = 32;
/// Length of an X25519 public key, in bytes.
pub const X25519_PUBLIC_BYTES: usize = 32;
/// Length of the AEAD nonce (ChaCha20-Poly1305), in bytes.
pub const NONCE_BYTES: usize = 12;

/// HKDF `info` label binding the per-recipient KEK derivation to this scheme +
/// version. Mirrors the TS `fricken/sframe/v2 ecdh-kek` label
/// (`docs/e2ee-calls.md` → FR-158 §3).
const KEK_INFO: &[u8] = b"fricken/sframe/v2 ecdh-kek";

/// Default transition window: how long the immediately-previous epoch's key is
/// retained on receive after a rotation (`previousEpochWindowMs`, 5s in the
/// design). Represented as a count of rotations is not enough — the manager
/// keeps exactly one prior epoch, and the window is a time concept the caller
/// enforces; here we simply retain the single prior epoch until the next
/// rotation drops it. The constant documents the design default.
pub const PREVIOUS_EPOCH_WINDOW_MS: u64 = 5_000;

/// Errors raised by the E2EE key-exchange + envelope crypto. Every operation
/// returns a `Result`; nothing panics on attacker-controlled input.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum E2eeError {
    /// A key/nonce/public-key byte slice had the wrong length.
    #[error("invalid {what} length: expected {expected}, got {got}")]
    BadLength {
        /// What was being decoded (e.g. "media key", "public key").
        what: &'static str,
        /// Expected byte length.
        expected: usize,
        /// Actual byte length.
        got: usize,
    },
    /// AEAD seal failed (effectively unreachable for valid keys; surfaced rather
    /// than panicked).
    #[error("AEAD encryption failed")]
    EncryptFailed,
    /// AEAD open failed — tampered ciphertext, wrong key, or wrong associated
    /// data. Fail-closed: the caller drops the frame/envelope.
    #[error("AEAD decryption failed (auth tag / wrong key)")]
    DecryptFailed,
    /// No sealed envelope in a relay payload was addressed to this recipient.
    #[error("no sealed envelope for recipient {0:?}")]
    NoEnvelopeForRecipient(String),
}

/// A per-call symmetric **media key** for one epoch: the 32-byte secret every
/// current member shares and uses to AEAD-encrypt media frames.
///
/// The bytes are zeroized on drop (via the inner [`chacha20poly1305::Key`]'s
/// `Zeroize` impl is not automatic; we wrap raw bytes and clear them) — see the
/// `Drop` impl.
#[derive(Clone)]
pub struct MediaKey {
    bytes: [u8; MEDIA_KEY_BYTES],
}

impl core::fmt::Debug for MediaKey {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        // Never print key material.
        f.debug_struct("MediaKey").finish_non_exhaustive()
    }
}

impl Drop for MediaKey {
    fn drop(&mut self) {
        // Best-effort scrub of key material on drop.
        self.bytes.iter_mut().for_each(|b| *b = 0);
    }
}

impl MediaKey {
    /// Generate a fresh random media key from the OS CSPRNG.
    #[must_use]
    pub fn generate() -> Self {
        let mut bytes = [0u8; MEDIA_KEY_BYTES];
        OsRng.fill_bytes(&mut bytes);
        Self { bytes }
    }

    /// Reconstruct a media key from raw bytes (e.g. after unwrapping). Errors if
    /// the length is wrong.
    ///
    /// # Errors
    /// [`E2eeError::BadLength`] when `bytes.len() != MEDIA_KEY_BYTES`.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, E2eeError> {
        let arr: [u8; MEDIA_KEY_BYTES] = bytes.try_into().map_err(|_| E2eeError::BadLength {
            what: "media key",
            expected: MEDIA_KEY_BYTES,
            got: bytes.len(),
        })?;
        Ok(Self { bytes: arr })
    }

    /// The raw key bytes. Handle with care — do not log or persist in the clear.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; MEDIA_KEY_BYTES] {
        &self.bytes
    }

    fn cipher(&self) -> ChaCha20Poly1305 {
        ChaCha20Poly1305::new(Key::from_slice(&self.bytes))
    }

    /// AEAD-encrypt one media frame under this epoch key. The SFrame-style
    /// `header` (carrying epochId + the **full** sender id + counter) is
    /// authenticated as associated data but **not** encrypted — the SFU needs it
    /// readable (`docs/e2ee-calls.md` → FR-156 §5). The 12-byte `nonce` must be
    /// unique per `(key, header)` — the caller derives it from
    /// `salt XOR (senderId || counter)` in the production path; here it is an
    /// explicit input so the construction stays testable.
    ///
    /// # Errors
    /// [`E2eeError::BadLength`] for a wrong nonce length;
    /// [`E2eeError::EncryptFailed`] if the AEAD refuses (unreachable for valid
    /// inputs).
    pub fn encrypt_frame(
        &self,
        nonce: &[u8],
        header: &[u8],
        plaintext: &[u8],
    ) -> Result<Vec<u8>, E2eeError> {
        let nonce = require_nonce(nonce)?;
        self.cipher()
            .encrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: plaintext,
                    aad: header,
                },
            )
            .map_err(|_| E2eeError::EncryptFailed)
    }

    /// AEAD-decrypt one media frame. The `header` must byte-match the one used to
    /// encrypt (it is the associated data), so a frame cannot be tricked into
    /// decrypting under the wrong epoch / sender / counter.
    ///
    /// # Errors
    /// [`E2eeError::BadLength`] for a wrong nonce length;
    /// [`E2eeError::DecryptFailed`] on any auth failure (tamper, wrong key,
    /// wrong header).
    pub fn decrypt_frame(
        &self,
        nonce: &[u8],
        header: &[u8],
        ciphertext: &[u8],
    ) -> Result<Vec<u8>, E2eeError> {
        let nonce = require_nonce(nonce)?;
        self.cipher()
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad: header,
                },
            )
            .map_err(|_| E2eeError::DecryptFailed)
    }
}

fn require_nonce(nonce: &[u8]) -> Result<&[u8], E2eeError> {
    if nonce.len() == NONCE_BYTES {
        Ok(nonce)
    } else {
        Err(E2eeError::BadLength {
            what: "nonce",
            expected: NONCE_BYTES,
            got: nonce.len(),
        })
    }
}

/// A member's long-lived X25519 identity key pair, used to receive sealed epoch
/// keys. The secret half never leaves the device in production; here it is held
/// in memory so a participant can [`MemberKeyPair::unwrap_key`] envelopes
/// addressed to it.
pub struct MemberKeyPair {
    secret: StaticSecret,
    public: PublicKey,
}

impl core::fmt::Debug for MemberKeyPair {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("MemberKeyPair")
            .field("public", &self.public.as_bytes())
            .finish_non_exhaustive()
    }
}

impl MemberKeyPair {
    /// Generate a fresh X25519 identity key pair from the OS CSPRNG.
    #[must_use]
    pub fn generate() -> Self {
        let secret = StaticSecret::random_from_rng(OsRng);
        let public = PublicKey::from(&secret);
        Self { secret, public }
    }

    /// This member's public key — published to the call directory so others can
    /// wrap epoch keys to it.
    #[must_use]
    pub fn public_key(&self) -> MemberPublicKey {
        MemberPublicKey {
            bytes: *self.public.as_bytes(),
        }
    }

    /// Unwrap a [`SealedKeyEnvelope`] addressed to this member, recovering the
    /// epoch [`MediaKey`].
    ///
    /// # Errors
    /// [`E2eeError::DecryptFailed`] if the envelope was not sealed to this key,
    /// was tampered with, or carries mismatched associated data;
    /// [`E2eeError::BadLength`] if the recovered key bytes are malformed.
    pub fn unwrap_key(
        &self,
        envelope: &SealedKeyEnvelope,
        ephemeral_public: &MemberPublicKey,
        aad: &[u8],
    ) -> Result<MediaKey, E2eeError> {
        let shared = self.secret.diffie_hellman(&ephemeral_public.into());
        let kek = derive_kek(shared.as_bytes());
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&kek));
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&envelope.nonce),
                Payload {
                    msg: &envelope.ciphertext,
                    aad,
                },
            )
            .map_err(|_| E2eeError::DecryptFailed)?;
        MediaKey::from_bytes(&plaintext)
    }
}

/// A member's published X25519 **public** key. This is the input the
/// distributor resolves per recipient (the `MemberKeyDirectory` seam in the
/// design); how it is published/authenticated app-side is out of scope.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct MemberPublicKey {
    bytes: [u8; X25519_PUBLIC_BYTES],
}

impl core::fmt::Debug for MemberPublicKey {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_tuple("MemberPublicKey").field(&self.bytes).finish()
    }
}

impl MemberPublicKey {
    /// Decode a public key from its 32 raw bytes.
    ///
    /// # Errors
    /// [`E2eeError::BadLength`] when `bytes.len() != X25519_PUBLIC_BYTES`.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, E2eeError> {
        let arr: [u8; X25519_PUBLIC_BYTES] =
            bytes.try_into().map_err(|_| E2eeError::BadLength {
                what: "public key",
                expected: X25519_PUBLIC_BYTES,
                got: bytes.len(),
            })?;
        Ok(Self { bytes: arr })
    }

    /// The raw 32 public-key bytes.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; X25519_PUBLIC_BYTES] {
        &self.bytes
    }
}

impl From<&MemberPublicKey> for PublicKey {
    fn from(value: &MemberPublicKey) -> Self {
        PublicKey::from(value.bytes)
    }
}

/// HKDF-SHA-256 expand of an ECDH shared secret into a 32-byte ChaCha20-Poly1305
/// key-encryption key (KEK). The shared secret is **never** used directly as an
/// AEAD key (`docs/e2ee-calls.md` → FR-156 §1 / FR-158 §3).
fn derive_kek(shared: &[u8]) -> [u8; MEDIA_KEY_BYTES] {
    let hk = Hkdf::<Sha256>::new(None, shared);
    let mut okm = [0u8; MEDIA_KEY_BYTES];
    // `expand` only fails for absurd output lengths; 32 bytes is always valid.
    hk.expand(KEK_INFO, &mut okm)
        .expect("HKDF expand of 32 bytes never fails");
    okm
}

/// One epoch key sealed to a single recipient: the AEAD nonce + ciphertext over
/// the wrapped [`MediaKey`]. Opaque to the relay/SFU — they see only these bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SealedKeyEnvelope {
    /// The recipient member id this blob is addressed to. Carried in **full** —
    /// never truncated (FR-210).
    pub recipient_id: String,
    /// AEAD nonce (12 bytes).
    pub nonce: [u8; NONCE_BYTES],
    /// AEAD ciphertext over the 32-byte epoch key (+ 16-byte tag).
    pub ciphertext: Vec<u8>,
}

/// The **sender-key relay envelope**: the structure the gateway relays over the
/// `WebRTCSignal` `"keyEpoch"` path on a rotation. It carries the announcing
/// participant's **full** sender id (FR-210), the call + epoch ids, a fresh
/// **ephemeral** X25519 public key, and **one [`SealedKeyEnvelope`] per current
/// recipient**. Only this module encodes/decodes + does the crypto; the gateway
/// merely relays the encoded bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyEpochEnvelope {
    /// Call this epoch belongs to.
    pub call_id: String,
    /// Monotonic per-call epoch id.
    pub epoch_id: u64,
    /// The announcing participant's id, carried **in full** — never truncated
    /// (FR-210). Bound into each recipient's AEAD associated data.
    sender_id: String,
    /// The per-announce ephemeral X25519 public key. Recipients combine this
    /// with their own secret to derive the unwrap KEK.
    pub ephemeral_public: MemberPublicKey,
    /// One sealed epoch-key blob per current recipient.
    pub envelopes: Vec<SealedKeyEnvelope>,
}

impl KeyEpochEnvelope {
    /// The announcing participant's **full** sender id (FR-210: never
    /// truncated).
    #[must_use]
    pub fn sender_id(&self) -> &str {
        &self.sender_id
    }

    /// Find the sealed envelope addressed to `recipient_id` (full-id match).
    #[must_use]
    pub fn envelope_for(&self, recipient_id: &str) -> Option<&SealedKeyEnvelope> {
        self.envelopes
            .iter()
            .find(|e| e.recipient_id == recipient_id)
    }

    /// Recover the epoch [`MediaKey`] for `recipient` from this envelope, given
    /// the recipient's key pair and id.
    ///
    /// # Errors
    /// [`E2eeError::NoEnvelopeForRecipient`] if no blob is addressed to
    /// `recipient_id`; [`E2eeError::DecryptFailed`] / [`E2eeError::BadLength`]
    /// from the unwrap.
    pub fn unwrap_for(
        &self,
        recipient: &MemberKeyPair,
        recipient_id: &str,
    ) -> Result<MediaKey, E2eeError> {
        let sealed = self
            .envelope_for(recipient_id)
            .ok_or_else(|| E2eeError::NoEnvelopeForRecipient(recipient_id.to_string()))?;
        let aad = self.recipient_aad(recipient_id);
        recipient.unwrap_key(sealed, &self.ephemeral_public, &aad)
    }

    /// The associated data binding a sealed blob to `(call, epoch, sender,
    /// recipient)` so it cannot be replayed cross-recipient or cross-epoch
    /// (`docs/e2ee-calls.md` → FR-158 §3). The **full** sender id and recipient
    /// id are both included verbatim (FR-210).
    fn recipient_aad(&self, recipient_id: &str) -> Vec<u8> {
        recipient_aad_bytes(&self.call_id, self.epoch_id, &self.sender_id, recipient_id)
    }
}

/// Build the per-recipient AEAD associated data. Domain-separated and
/// length-prefixed so distinct field values can never produce the same byte
/// string (no delimiter-injection ambiguity). The **full** ids are used — no
/// truncation (FR-210).
fn recipient_aad_bytes(
    call_id: &str,
    epoch_id: u64,
    sender_id: &str,
    recipient_id: &str,
) -> Vec<u8> {
    let mut aad = Vec::new();
    aad.extend_from_slice(b"keyEpoch:ecdh:");
    push_len_prefixed(&mut aad, call_id.as_bytes());
    aad.extend_from_slice(&epoch_id.to_be_bytes());
    push_len_prefixed(&mut aad, sender_id.as_bytes());
    push_len_prefixed(&mut aad, recipient_id.as_bytes());
    aad
}

fn push_len_prefixed(buf: &mut Vec<u8>, field: &[u8]) {
    // u32 big-endian length prefix; call/sender/recipient ids are never this
    // long in practice, and an overflow simply truncates the *prefix*, which we
    // guard against by clamping rather than wrapping.
    let len = u32::try_from(field.len()).unwrap_or(u32::MAX);
    buf.extend_from_slice(&len.to_be_bytes());
    buf.extend_from_slice(field);
}

/// One recipient in a key distribution: their full id + published public key.
#[derive(Clone, Debug)]
pub struct Recipient {
    /// The recipient's member id, carried in **full** (FR-210).
    pub id: String,
    /// The recipient's published X25519 public key.
    pub public_key: MemberPublicKey,
}

/// Seal `media_key` (the epoch key) to every recipient and build the relay
/// envelope the gateway will forward. A fresh **ephemeral** X25519 key pair is
/// generated per call; each recipient gets a [`SealedKeyEnvelope`] under
/// `KEK = HKDF(ECDH(ephemeral_secret, recipient_public))`, with AAD binding
/// `(call, epoch, sender, recipient)`.
///
/// `sender_id` is carried **in full** into the envelope and every AAD — never
/// truncated (FR-210).
///
/// # Errors
/// [`E2eeError::EncryptFailed`] if an AEAD seal refuses (unreachable for valid
/// keys).
pub fn seal_epoch_for_recipients(
    call_id: &str,
    epoch_id: u64,
    sender_id: &str,
    media_key: &MediaKey,
    recipients: &[Recipient],
) -> Result<KeyEpochEnvelope, E2eeError> {
    let ephemeral_secret = StaticSecret::random_from_rng(OsRng);
    let ephemeral_public = PublicKey::from(&ephemeral_secret);

    let mut envelopes = Vec::with_capacity(recipients.len());
    for recipient in recipients {
        let shared = ephemeral_secret.diffie_hellman(&(&recipient.public_key).into());
        let kek = derive_kek(shared.as_bytes());
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&kek));

        let mut nonce = [0u8; NONCE_BYTES];
        OsRng.fill_bytes(&mut nonce);

        let aad = recipient_aad_bytes(call_id, epoch_id, sender_id, &recipient.id);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: media_key.as_bytes(),
                    aad: &aad,
                },
            )
            .map_err(|_| E2eeError::EncryptFailed)?;

        envelopes.push(SealedKeyEnvelope {
            recipient_id: recipient.id.clone(),
            nonce,
            ciphertext,
        });
    }

    Ok(KeyEpochEnvelope {
        call_id: call_id.to_string(),
        epoch_id,
        sender_id: sender_id.to_string(),
        ephemeral_public: MemberPublicKey {
            bytes: *ephemeral_public.as_bytes(),
        },
        envelopes,
    })
}

/// One immutable `(epoch_id, key)` bound to a membership snapshot. The model
/// from `docs/e2ee-calls.md` → "Key-epoch lifecycle".
#[derive(Clone, Debug)]
pub struct KeyEpoch {
    /// Monotonic per-call epoch id.
    pub epoch_id: u64,
    /// The shared media key for this epoch.
    pub key: MediaKey,
}

/// Per-call epoch manager: mints + rotates the epoch key on membership change,
/// retaining the immediately-previous epoch for the transition window
/// ([`PREVIOUS_EPOCH_WINDOW_MS`]). Keeps **at most one** prior epoch
/// (`docs/e2ee-calls.md` → "Transition window").
#[derive(Debug)]
pub struct CallKeyManager {
    call_id: String,
    /// The participant id that mints epochs here (the deterministically-chosen
    /// distributor). Carried **in full** (FR-210).
    self_id: String,
    current: KeyEpoch,
    previous: Option<KeyEpoch>,
}

impl CallKeyManager {
    /// Start a call at epoch 0 with a fresh random media key.
    #[must_use]
    pub fn new(call_id: impl Into<String>, self_id: impl Into<String>) -> Self {
        Self {
            call_id: call_id.into(),
            self_id: self_id.into(),
            current: KeyEpoch {
                epoch_id: 0,
                key: MediaKey::generate(),
            },
            previous: None,
        }
    }

    /// The current epoch id.
    #[must_use]
    pub fn current_epoch_id(&self) -> u64 {
        self.current.epoch_id
    }

    /// The current epoch key.
    #[must_use]
    pub fn current_key(&self) -> &MediaKey {
        &self.current.key
    }

    /// This manager's full sender/self id (FR-210: never truncated).
    #[must_use]
    pub fn self_id(&self) -> &str {
        &self.self_id
    }

    /// Look up the key for `epoch_id`, accepting the current epoch or the single
    /// retained previous epoch (the transition window). Returns `None` once the
    /// previous epoch has been dropped — which is exactly what enforces forward
    /// secrecy for a departed member.
    #[must_use]
    pub fn key_for(&self, epoch_id: u64) -> Option<&MediaKey> {
        if epoch_id == self.current.epoch_id {
            return Some(&self.current.key);
        }
        self.previous
            .as_ref()
            .filter(|p| p.epoch_id == epoch_id)
            .map(|p| &p.key)
    }

    /// Mint a fresh epoch on a **membership change**, advancing the epoch id and
    /// rotating the key. The just-superseded epoch is retained as the single
    /// previous epoch (transition window); any older previous epoch is dropped.
    /// Returns the new current epoch id.
    pub fn rotate(&mut self) -> u64 {
        let next_id = self.current.epoch_id + 1;
        let fresh = KeyEpoch {
            epoch_id: next_id,
            key: MediaKey::generate(),
        };
        let superseded = core::mem::replace(&mut self.current, fresh);
        self.previous = Some(superseded);
        next_id
    }

    /// Adopt an epoch announced by another participant (after unwrapping its
    /// relay envelope), converging the whole call on the same `(epoch_id, key)`.
    /// A stale or duplicate epoch (id not strictly greater than current) is
    /// ignored — fail-closed, mirroring the design's `poll()` semantics.
    /// Returns `true` if adopted.
    pub fn adopt(&mut self, epoch: KeyEpoch) -> bool {
        if epoch.epoch_id <= self.current.epoch_id {
            return false;
        }
        let superseded = core::mem::replace(&mut self.current, epoch);
        self.previous = Some(superseded);
        true
    }

    /// Seal the **current** epoch key to `recipients`, producing the relay
    /// envelope to announce over the `"keyEpoch"` path. The manager's full
    /// `self_id` is the sender id (FR-210).
    ///
    /// # Errors
    /// Propagates [`E2eeError`] from the sealing.
    pub fn announce_current(
        &self,
        recipients: &[Recipient],
    ) -> Result<KeyEpochEnvelope, E2eeError> {
        seal_epoch_for_recipients(
            &self.call_id,
            self.current.epoch_id,
            &self.self_id,
            &self.current.key,
            recipients,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A full sender id with the kind of structure FR-210 must not truncate:
    /// `userId:deviceId` with long, distinct halves.
    const FULL_SENDER_ID: &str =
        "user_01J9ZQ7K3M4N5P6Q7R8S9T0V1W:device_01J9ZQ7K3M4N5P6Q7R8S9T0V1X-primary";

    fn recipient(id: &str, kp: &MemberKeyPair) -> Recipient {
        Recipient {
            id: id.to_string(),
            public_key: kp.public_key(),
        }
    }

    #[test]
    fn wrap_unwrap_round_trip_and_media_frame_aead() {
        // Sender mints an epoch key and wraps it for one recipient.
        let media_key = MediaKey::generate();
        let recipient_kp = MemberKeyPair::generate();
        let recipients = vec![recipient("bob", &recipient_kp)];

        let envelope =
            seal_epoch_for_recipients("call-1", 0, FULL_SENDER_ID, &media_key, &recipients)
                .expect("seal succeeds");

        // Recipient unwraps and recovers the *same* key bytes.
        let recovered = envelope
            .unwrap_for(&recipient_kp, "bob")
            .expect("unwrap succeeds");
        assert_eq!(recovered.as_bytes(), media_key.as_bytes());

        // And the recovered key actually decrypts a media frame the sender
        // encrypted under the epoch key — the end-to-end property.
        let nonce = [7u8; NONCE_BYTES];
        let header = b"sframe-v2-header: epoch=0 sender=... counter=42";
        let frame = b"the quick brown fox jumps over the lazy dog";
        let ct = media_key
            .encrypt_frame(&nonce, header, frame)
            .expect("encrypt frame");
        let pt = recovered
            .decrypt_frame(&nonce, header, &ct)
            .expect("decrypt frame");
        assert_eq!(pt, frame);

        // Tamper: a wrong header (AAD) must fail-closed.
        let bad = recovered.decrypt_frame(&nonce, b"different header", &ct);
        assert_eq!(bad, Err(E2eeError::DecryptFailed));
    }

    #[test]
    fn rotation_produces_a_distinct_key_and_advances_epoch() {
        let mut mgr = CallKeyManager::new("call-1", FULL_SENDER_ID);
        let e0 = mgr.current_epoch_id();
        let k0 = *mgr.current_key().as_bytes();

        let e1 = mgr.rotate();
        let k1 = *mgr.current_key().as_bytes();

        assert_eq!(e0, 0);
        assert_eq!(e1, 1);
        assert_ne!(k0, k1, "rotation must mint a *distinct* key");

        // Transition window: the previous epoch's key is still resolvable, the
        // current one too, but nothing else.
        assert_eq!(mgr.key_for(1).map(|k| *k.as_bytes()), Some(k1));
        assert_eq!(mgr.key_for(0).map(|k| *k.as_bytes()), Some(k0));
        assert!(mgr.key_for(2).is_none());

        // Keeps at most one prior epoch: a second rotation drops epoch 0.
        mgr.rotate();
        assert!(
            mgr.key_for(0).is_none(),
            "only the single immediately-previous epoch is retained"
        );
        assert!(mgr.key_for(1).is_some());
        assert!(mgr.key_for(2).is_some());
    }

    #[test]
    fn membership_change_rewraps_for_the_new_set_and_drops_removed_member() {
        // Initial set {A, B, C}; C will be removed on the next epoch.
        let a = MemberKeyPair::generate();
        let b = MemberKeyPair::generate();
        let c = MemberKeyPair::generate();

        let mut mgr = CallKeyManager::new("call-7", FULL_SENDER_ID);

        // Epoch 0 announced to {A, B, C}: everyone can unwrap.
        let e0 = mgr
            .announce_current(&[recipient("A", &a), recipient("B", &b), recipient("C", &c)])
            .expect("seal epoch 0");
        let k0 = *mgr.current_key().as_bytes();
        assert_eq!(e0.unwrap_for(&c, "C").unwrap().as_bytes(), &k0);

        // Membership change: C leaves → rotate, re-wrap for {A, B} only.
        mgr.rotate();
        let e1 = mgr
            .announce_current(&[recipient("A", &a), recipient("B", &b)])
            .expect("seal epoch 1");
        let k1 = *mgr.current_key().as_bytes();

        // A and B converge on the new key.
        assert_eq!(e1.unwrap_for(&a, "A").unwrap().as_bytes(), &k1);
        assert_eq!(e1.unwrap_for(&b, "B").unwrap().as_bytes(), &k1);

        // C is not in the recipient set: no blob addressed to it, and it cannot
        // obtain the new epoch key (membership-change forward secrecy).
        assert!(e1.envelope_for("C").is_none());
        assert_eq!(
            e1.unwrap_for(&c, "C").err(),
            Some(E2eeError::NoEnvelopeForRecipient("C".to_string()))
        );

        // Even if C lies about which blob is "its own", it can't unwrap A's: the
        // AAD is bound to the recipient id, and the blob is sealed to A's key.
        let a_blob = e1.envelope_for("A").unwrap();
        let stolen = c.unwrap_key(
            a_blob,
            &e1.ephemeral_public,
            &recipient_aad_bytes("call-7", 1, FULL_SENDER_ID, "A"),
        );
        assert_eq!(stolen.err(), Some(E2eeError::DecryptFailed));
    }

    #[test]
    fn adopt_converges_peers_on_the_same_epoch_key() {
        // Distributor A mints + announces; peer B adopts and they share a key.
        let a_kp = MemberKeyPair::generate();
        let b_kp = MemberKeyPair::generate();

        let mut distributor = CallKeyManager::new("call-9", "A-full-id");
        distributor.rotate(); // epoch 1
        let envelope = distributor
            .announce_current(&[recipient("A", &a_kp), recipient("B", &b_kp)])
            .expect("announce");
        let shared_key = *distributor.current_key().as_bytes();

        // Peer B's manager is at epoch 0; it unwraps the announcement and adopts.
        let mut peer = CallKeyManager::new("call-9", "B-full-id");
        let key = envelope.unwrap_for(&b_kp, "B").expect("unwrap");
        let adopted = peer.adopt(KeyEpoch {
            epoch_id: envelope.epoch_id,
            key,
        });
        assert!(adopted);
        assert_eq!(peer.current_epoch_id(), 1);
        assert_eq!(peer.current_key().as_bytes(), &shared_key);

        // A stale re-announcement (epoch <= current) is ignored (fail-closed).
        let stale = peer.adopt(KeyEpoch {
            epoch_id: 1,
            key: MediaKey::generate(),
        });
        assert!(!stale);
        assert_eq!(peer.current_key().as_bytes(), &shared_key);
    }

    #[test]
    fn fr210_sender_id_is_preserved_in_full_everywhere() {
        // FR-210 regression: the full sender id survives sealing/encoding and is
        // bound into the AAD verbatim — never truncated, hashed, or clamped.
        let recipient_kp = MemberKeyPair::generate();
        let media_key = MediaKey::generate();

        let envelope = seal_epoch_for_recipients(
            "call-fr210",
            3,
            FULL_SENDER_ID,
            &media_key,
            &[recipient("rcpt", &recipient_kp)],
        )
        .expect("seal");

        // The envelope carries the *exact* full id.
        assert_eq!(envelope.sender_id(), FULL_SENDER_ID);
        assert_eq!(envelope.sender_id().len(), FULL_SENDER_ID.len());
        assert!(envelope.sender_id().contains("device_"));

        // The AAD is bound to the full id: unwrapping with a *truncated* id (the
        // FR-210 bug) must fail, because the AAD no longer matches.
        let truncated = &FULL_SENDER_ID[..8];
        let sealed = envelope.envelope_for("rcpt").unwrap();
        let with_truncated_aad = recipient_kp.unwrap_key(
            sealed,
            &envelope.ephemeral_public,
            &recipient_aad_bytes("call-fr210", 3, truncated, "rcpt"),
        );
        assert_eq!(
            with_truncated_aad.err(),
            Some(E2eeError::DecryptFailed),
            "a truncated sender id must NOT unwrap — FR-210 regression guard"
        );

        // The correct full id unwraps fine.
        let ok = envelope.unwrap_for(&recipient_kp, "rcpt").expect("unwrap");
        assert_eq!(ok.as_bytes(), media_key.as_bytes());
    }
}
