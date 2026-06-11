//! Pure-Rust [`ece::crypto::Cryptographer`] backend for the Web Push aes128gcm
//! content encoding (map 06 §3.9).
//!
//! The [`ece`] crate orchestrates RFC 8291 / RFC 8188 (ECDH → HKDF key/nonce →
//! single-record AES-128-GCM → RFC 8188 framing) but defers the primitive
//! operations to a pluggable `Cryptographer`. Its only shipped backend is
//! `openssl` (a native C dependency). The rest of the Frick push subsystem is
//! deliberately pure-Rust (`p256` / `hkdf` / `aes-gcm`, no `ring`/`openssl`), so
//! this module supplies an [`EceCryptographer`] over those same crates and
//! installs it once via [`install_cryptographer`].
//!
//! Correctness is not taken on faith: the crate ships
//! [`ece::crypto::test_cryptographer`], which runs the RFC 8291 Appendix A.2
//! published encrypt + decrypt known-answer vectors against any backend. The
//! unit tests run it against [`EceCryptographer`].

use std::any::Any;
use std::sync::OnceLock;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes128Gcm, Key, Nonce};
use ece::crypto::{Cryptographer, EcKeyComponents, LocalKeyPair, RemotePublicKey};
use ece::{Error as EceError, Result as EceResult};
use hkdf::Hkdf;
use p256::ecdh::diffie_hellman;
use p256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use p256::{EncodedPoint, PublicKey, SecretKey};
use rand::RngCore;
use sha2::Sha256;

/// A local P-256 key pair (the ephemeral application-server keypair the ece
/// crate generates per encryption).
struct LocalP256 {
    secret: SecretKey,
    public_raw: Vec<u8>,
}

impl LocalKeyPair for LocalP256 {
    fn pub_as_raw(&self) -> EceResult<Vec<u8>> {
        Ok(self.public_raw.clone())
    }

    fn raw_components(&self) -> EceResult<EcKeyComponents> {
        Ok(EcKeyComponents::new(
            self.secret.to_bytes().to_vec(),
            self.public_raw.clone(),
        ))
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// A remote P-256 public key (the subscription's `p256dh` user-agent key).
struct RemoteP256 {
    public: PublicKey,
    raw: Vec<u8>,
}

impl RemotePublicKey for RemoteP256 {
    fn as_raw(&self) -> EceResult<Vec<u8>> {
        Ok(self.raw.clone())
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// The pure-Rust [`Cryptographer`] backend (P-256 ECDH via `p256`, HKDF-SHA256
/// via `hkdf`, AES-128-GCM via `aes-gcm`, randomness via `OsRng`).
pub(super) struct EceCryptographer;

fn import_public(raw: &[u8]) -> EceResult<PublicKey> {
    let point = EncodedPoint::from_bytes(raw).map_err(|_| EceError::InvalidKeyLength)?;
    Option::<PublicKey>::from(PublicKey::from_encoded_point(&point))
        .ok_or(EceError::InvalidKeyLength)
}

impl Cryptographer for EceCryptographer {
    fn generate_ephemeral_keypair(&self) -> EceResult<Box<dyn LocalKeyPair>> {
        let secret = SecretKey::random(&mut rand::rngs::OsRng);
        let public_raw = secret
            .public_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec();
        Ok(Box::new(LocalP256 { secret, public_raw }))
    }

    fn import_key_pair(&self, components: &EcKeyComponents) -> EceResult<Box<dyn LocalKeyPair>> {
        let secret = SecretKey::from_slice(components.private_key())
            .map_err(|_| EceError::InvalidKeyLength)?;
        Ok(Box::new(LocalP256 {
            secret,
            public_raw: components.public_key().to_vec(),
        }))
    }

    fn import_public_key(&self, raw: &[u8]) -> EceResult<Box<dyn RemotePublicKey>> {
        let public = import_public(raw)?;
        Ok(Box::new(RemoteP256 {
            public,
            raw: raw.to_vec(),
        }))
    }

    fn compute_ecdh_secret(
        &self,
        remote: &dyn RemotePublicKey,
        local: &dyn LocalKeyPair,
    ) -> EceResult<Vec<u8>> {
        let remote = remote
            .as_any()
            .downcast_ref::<RemoteP256>()
            .ok_or(EceError::InvalidKeyLength)?;
        let local = local
            .as_any()
            .downcast_ref::<LocalP256>()
            .ok_or(EceError::InvalidKeyLength)?;
        let shared = diffie_hellman(local.secret.to_nonzero_scalar(), remote.public.as_affine());
        let bytes: &[u8] = shared.raw_secret_bytes().as_ref();
        Ok(bytes.to_vec())
    }

    fn hkdf_sha256(
        &self,
        salt: &[u8],
        secret: &[u8],
        info: &[u8],
        len: usize,
    ) -> EceResult<Vec<u8>> {
        let hkdf = Hkdf::<Sha256>::new(Some(salt), secret);
        let mut okm = vec![0u8; len];
        hkdf.expand(info, &mut okm)
            .map_err(|_| EceError::InvalidKeyLength)?;
        Ok(okm)
    }

    fn aes_gcm_128_encrypt(&self, key: &[u8], iv: &[u8], data: &[u8]) -> EceResult<Vec<u8>> {
        let cipher = Aes128Gcm::new(Key::<Aes128Gcm>::from_slice(key));
        cipher
            .encrypt(
                Nonce::from_slice(iv),
                Payload {
                    msg: data,
                    aad: &[],
                },
            )
            .map_err(|_| EceError::InvalidKeyLength)
    }

    fn aes_gcm_128_decrypt(&self, key: &[u8], iv: &[u8], ct: &[u8]) -> EceResult<Vec<u8>> {
        let cipher = Aes128Gcm::new(Key::<Aes128Gcm>::from_slice(key));
        cipher
            .decrypt(Nonce::from_slice(iv), Payload { msg: ct, aad: &[] })
            .map_err(|_| EceError::InvalidKeyLength)
    }

    fn random_bytes(&self, dest: &mut [u8]) -> EceResult<()> {
        rand::rngs::OsRng.fill_bytes(dest);
        Ok(())
    }
}

/// Process-global one-shot install of [`EceCryptographer`]. `ece::set_*` may be
/// called at most once per process; the [`OnceLock`] makes concurrent first
/// calls safe and idempotent. A lost race (another caller installed first) is
/// fine — the installed backend is functionally identical.
static INSTALLED: OnceLock<()> = OnceLock::new();

/// Install the pure-Rust cryptographer backend if it has not been installed yet.
/// Idempotent and thread-safe; cheap on the hot path after the first call.
pub(super) fn install_cryptographer() {
    INSTALLED.get_or_init(|| {
        // A second `set_*` (e.g. lost race with the crate's own auto-init, which
        // is disabled here since `backend-openssl` is off) returns Err — ignore
        // it; the backend is already in place either way.
        let _ = ece::crypto::set_boxed_cryptographer(Box::new(EceCryptographer));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_passes_rfc8291_known_answer_vectors() {
        // `test_cryptographer` drives `aes128gcm::{encrypt,decrypt}`, which read
        // the GLOBAL cryptographer — install ours first.
        install_cryptographer();
        // The ece crate's own RFC 8291 Appendix A.2 encrypt + decrypt
        // known-answer suite. Panics on any mismatch → proves the pure-Rust
        // ECDH/HKDF/AES-128-GCM primitives are wired correctly.
        ece::crypto::test_cryptographer(EceCryptographer);
    }

    #[test]
    fn install_is_idempotent() {
        install_cryptographer();
        install_cryptographer();
        // After install, the public API round-trips a payload.
        let (key, auth) = ece::generate_keypair_and_auth_secret().unwrap();
        let plaintext = b"frick web push";
        let ciphertext = ece::encrypt(&key.pub_as_raw().unwrap(), &auth, plaintext).unwrap();
        let decrypted = ece::decrypt(&key.raw_components().unwrap(), &auth, &ciphertext).unwrap();
        assert_eq!(decrypted, plaintext);
    }
}
