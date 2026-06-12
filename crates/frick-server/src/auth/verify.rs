//! RS256 id-token verification for Sign in with Apple / Google (FR-269).
//!
//! Ported from the deleted TS `auth/apple.ts` + `auth/google.ts` (which leaned
//! on `jose`). This is the SECURITY-CRITICAL primitive: a bug here is an auth
//! bypass. The verification is hand-rolled over the already-vendored, pure-Rust
//! `rsa` crate (no `ring`/native crypto, mirroring the FCM RS256 signer) and
//! pins every safety property explicitly:
//!
//! - **Algorithm is pinned to RS256 by the verifier, never read from the
//!   token.** We only ever run RSASSA-PKCS1-v1.5 over SHA-256 against the RSA
//!   key selected by the header `kid`. The token's `alg` header is required to
//!   be exactly `"RS256"` and is otherwise ignored — so `alg: none`,
//!   `alg: HS256` (HMAC-with-the-public-key), and any other alg-confusion
//!   forgery are rejected before any crypto runs.
//! - **`exp` is required and validated** with a small leeway.
//! - **`iss` must match** the provider's allowed issuer(s) (Apple:
//!   `https://appleid.apple.com`; Google: `accounts.google.com` OR
//!   `https://accounts.google.com`).
//! - **`aud` must match** one of the configured client id(s)/audience(s).
//! - **`nonce`**, when the client supplies one, must match the token's `nonce`
//!   claim (Apple/OIDC replay defense).
//! - `email_verified == false` is rejected where the provider sets it.
//!
//! The JWKS is resolved through the injectable [`JwksProvider`] seam, so the
//! whole path is testable offline with a fixed key set.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rsa::BigUint;
use rsa::RsaPublicKey;
use rsa::pkcs1v15::VerifyingKey;
use rsa::sha2::Sha256;
use rsa::signature::Verifier;
use serde::Deserialize;

use super::jwks::{JwksProvider, RsaJwk};

/// Clock-skew tolerance for `exp`, matching the TS `clockTolerance ?? 60`.
const CLOCK_LEEWAY_SECONDS: i64 = 60;

/// Apple's issuer (`auth/apple.ts` `APPLE_ISSUER`).
pub const APPLE_ISSUER: &str = "https://appleid.apple.com";
/// Apple's JWKS endpoint (`auth/apple.ts` `APPLE_JWKS_URL`).
pub const APPLE_JWKS_URI: &str = "https://appleid.apple.com/auth/keys";
/// Google's issuers (`auth/google.ts` `GOOGLE_ISSUERS`) — both spellings are
/// accepted, Google uses them interchangeably across token versions.
pub const GOOGLE_ISSUERS: [&str; 2] = ["https://accounts.google.com", "accounts.google.com"];
/// Google's JWKS endpoint (`auth/google.ts` `GOOGLE_JWKS_URL`).
pub const GOOGLE_JWKS_URI: &str = "https://www.googleapis.com/oauth2/v3/certs";

/// Why verification failed. The route maps every variant to ONE generic auth
/// error so the client gets no oracle about which specific check failed (beyond
/// the TS behavior). The variant is for server-side logging only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyError {
    /// The token was not three base64url segments / decode failed.
    MalformedToken,
    /// The header `alg` was not exactly `RS256` (alg-confusion / `none`).
    UnsupportedAlgorithm,
    /// No `kid` in the header.
    MissingKid,
    /// The `kid` was not in the JWKS (after a forced refresh).
    UnknownKey,
    /// The RSA key components were unusable.
    BadKey,
    /// The RSASSA-PKCS1-v1.5 signature did not verify.
    BadSignature,
    /// `exp` was absent, malformed, or in the past (beyond leeway).
    Expired,
    /// `iss` did not match the provider's allowed issuer(s).
    IssuerMismatch,
    /// `aud` did not match any configured audience.
    AudienceMismatch,
    /// `sub` was absent.
    MissingSubject,
    /// A supplied nonce did not match the token's `nonce` claim.
    NonceMismatch,
    /// The provider marked the email unverified.
    EmailUnverified,
    /// The JWKS could not be resolved (network/parse).
    JwksUnavailable,
}

impl VerifyError {
    /// A stable label for structured logs (never returned to the client).
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::MalformedToken => "malformed_token",
            Self::UnsupportedAlgorithm => "unsupported_algorithm",
            Self::MissingKid => "missing_kid",
            Self::UnknownKey => "unknown_key",
            Self::BadKey => "bad_key",
            Self::BadSignature => "bad_signature",
            Self::Expired => "expired",
            Self::IssuerMismatch => "issuer_mismatch",
            Self::AudienceMismatch => "audience_mismatch",
            Self::MissingSubject => "missing_subject",
            Self::NonceMismatch => "nonce_mismatch",
            Self::EmailUnverified => "email_unverified",
            Self::JwksUnavailable => "jwks_unavailable",
        }
    }
}

/// The verified identity extracted from a valid id-token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedIdentity {
    /// The provider's stable, app-scoped subject (`sub`). The account key.
    pub subject: String,
    /// The user's email, if the provider shared it.
    pub email: Option<String>,
    /// Whether the provider marked the email verified.
    pub email_verified: bool,
    /// The display name (`name`), if present (Google sets it; Apple does not).
    pub name: Option<String>,
}

/// What a provider's id-token must satisfy. Built per-route from config.
pub struct VerifyParams<'a> {
    /// The allowed issuer(s) — `iss` must equal one of these exactly.
    pub issuers: &'a [&'a str],
    /// The JWKS endpoint to resolve keys from.
    pub jwks_uri: &'a str,
    /// The configured audience(s) — `aud` must match one of these.
    pub audiences: &'a [String],
    /// The client-supplied nonce, if any. When `Some`, the token's `nonce`
    /// claim must equal it.
    pub expected_nonce: Option<&'a str>,
}

/// The JOSE header we care about — strictly the alg pin + the key id.
#[derive(Debug, Deserialize)]
struct JoseHeader {
    alg: String,
    #[serde(default)]
    kid: Option<String>,
}

/// The id-token claims. `aud` is `Option` and may be a string or array; `exp`
/// is a required numeric date; the rest are provider-specific.
#[derive(Debug, Deserialize)]
struct Claims {
    #[serde(default)]
    iss: Option<String>,
    #[serde(default)]
    sub: Option<String>,
    #[serde(default)]
    aud: Option<Audience>,
    #[serde(default)]
    exp: Option<i64>,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    email_verified: Option<FlexibleBool>,
    #[serde(default)]
    name: Option<String>,
}

/// `aud` may be a single string or an array of strings (RFC 7519).
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Audience {
    One(String),
    Many(Vec<String>),
}

impl Audience {
    fn matches(&self, audiences: &[String]) -> bool {
        match self {
            Self::One(value) => audiences.iter().any(|a| a == value),
            Self::Many(values) => values.iter().any(|v| audiences.iter().any(|a| a == v)),
        }
    }
}

/// Apple/Google encode booleans inconsistently across token versions:
/// `email_verified` arrives as a real bool, the string `"true"`, or `1`. Mirror
/// the TS coercion (`ev === true || ev === "true" || ev === 1`).
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum FlexibleBool {
    Bool(bool),
    Str(String),
    Num(i64),
}

impl FlexibleBool {
    fn as_bool(&self) -> bool {
        match self {
            Self::Bool(value) => *value,
            Self::Str(value) => value == "true",
            Self::Num(value) => *value == 1,
        }
    }
}

/// Verify an id-token against the provider parameters at `now_ms`. The JWKS is
/// resolved through `jwks`; an unknown `kid` triggers exactly one forced
/// refresh (key rotation) before giving up.
///
/// EVERY failure returns a [`VerifyError`]; the caller collapses them all into
/// one generic auth error so no per-check oracle leaks.
pub async fn verify_id_token(
    token: &str,
    params: &VerifyParams<'_>,
    jwks: &dyn JwksProvider,
    now_ms: i64,
) -> Result<VerifiedIdentity, VerifyError> {
    // 1. Split into the three JOSE segments and decode header + claims. The
    //    signature is verified over the raw `header.payload` bytes.
    let mut segments = token.split('.');
    let (Some(header_b64), Some(payload_b64), Some(sig_b64), None) = (
        segments.next(),
        segments.next(),
        segments.next(),
        segments.next(),
    ) else {
        return Err(VerifyError::MalformedToken);
    };

    let header_bytes = URL_SAFE_NO_PAD
        .decode(header_b64)
        .map_err(|_| VerifyError::MalformedToken)?;
    let header: JoseHeader =
        serde_json::from_slice(&header_bytes).map_err(|_| VerifyError::MalformedToken)?;

    // 2. PIN THE ALGORITHM. We never dispatch on the token's `alg`: it must be
    //    exactly RS256, and below we only ever run RSASSA-PKCS1-v1.5/SHA-256.
    //    This rejects `alg: none`, `alg: HS256` (HMAC with the RSA public key),
    //    and every other alg-confusion forgery before any key work happens.
    if header.alg != "RS256" {
        return Err(VerifyError::UnsupportedAlgorithm);
    }
    let kid = header
        .kid
        .filter(|k| !k.is_empty())
        .ok_or(VerifyError::MissingKid)?;

    // 3. Resolve the signing key by `kid`, refetching once on a miss (rotation).
    let key_set = jwks
        .fetch(params.jwks_uri, false)
        .await
        .map_err(|_| VerifyError::JwksUnavailable)?;
    let jwk = if let Some(jwk) = key_set.key(&kid) {
        jwk.clone()
    } else {
        let refreshed = jwks
            .fetch(params.jwks_uri, true)
            .await
            .map_err(|_| VerifyError::JwksUnavailable)?;
        refreshed
            .key(&kid)
            .cloned()
            .ok_or(VerifyError::UnknownKey)?
    };

    // 4. Verify the RS256 signature over `header.payload`.
    let signing_input = format!("{header_b64}.{payload_b64}");
    let signature = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| VerifyError::MalformedToken)?;
    verify_rs256(&jwk, signing_input.as_bytes(), &signature)?;

    // 5. Decode + validate the claims. Only AFTER a good signature.
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|_| VerifyError::MalformedToken)?;
    let claims: Claims =
        serde_json::from_slice(&payload_bytes).map_err(|_| VerifyError::MalformedToken)?;

    // exp is REQUIRED and must be in the future (with leeway).
    let exp = claims.exp.ok_or(VerifyError::Expired)?;
    let now_seconds = now_ms.div_euclid(1000);
    if exp + CLOCK_LEEWAY_SECONDS < now_seconds {
        return Err(VerifyError::Expired);
    }

    // iss must match one of the allowed issuers exactly.
    let iss = claims.iss.as_deref().unwrap_or_default();
    if !params.issuers.contains(&iss) {
        return Err(VerifyError::IssuerMismatch);
    }

    // aud must match a configured audience.
    match &claims.aud {
        Some(aud) if aud.matches(params.audiences) => {}
        _ => return Err(VerifyError::AudienceMismatch),
    }

    // nonce, when the client supplied one, must match the token claim.
    if let Some(expected) = params.expected_nonce {
        let token_nonce = claims.nonce.as_deref().unwrap_or_default();
        if token_nonce != expected {
            return Err(VerifyError::NonceMismatch);
        }
    }

    let subject = claims
        .sub
        .filter(|s| !s.is_empty())
        .ok_or(VerifyError::MissingSubject)?;

    let email_verified = claims
        .email_verified
        .as_ref()
        .is_some_and(FlexibleBool::as_bool);
    // Reject an explicitly-unverified email where the provider supplied one
    // (matches the TS `emailVerified` gate). A token with no email claim at all
    // is allowed through — the account is keyed on `sub`, not the email.
    if claims.email.is_some() && !email_verified {
        return Err(VerifyError::EmailUnverified);
    }

    Ok(VerifiedIdentity {
        subject,
        email: claims.email,
        email_verified,
        name: claims.name,
    })
}

/// Verify an RSASSA-PKCS1-v1.5 / SHA-256 signature over `message` with the RSA
/// public key carried by `jwk` (base64url `n`/`e`). The digest algorithm is
/// fixed to SHA-256 here — the only algorithm this module ever runs.
fn verify_rs256(jwk: &RsaJwk, message: &[u8], signature: &[u8]) -> Result<(), VerifyError> {
    let n = URL_SAFE_NO_PAD
        .decode(&jwk.n)
        .map_err(|_| VerifyError::BadKey)?;
    let e = URL_SAFE_NO_PAD
        .decode(&jwk.e)
        .map_err(|_| VerifyError::BadKey)?;
    let public_key = RsaPublicKey::new(BigUint::from_bytes_be(&n), BigUint::from_bytes_be(&e))
        .map_err(|_| VerifyError::BadKey)?;
    let verifying_key = VerifyingKey::<Sha256>::new(public_key);
    let signature =
        rsa::pkcs1v15::Signature::try_from(signature).map_err(|_| VerifyError::BadSignature)?;
    verifying_key
        .verify(message, &signature)
        .map_err(|_| VerifyError::BadSignature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::jwks::{FixedJwksProvider, Jwks};
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
    use rsa::RsaPrivateKey;
    use rsa::pkcs1v15::SigningKey;
    use rsa::sha2::Sha256;
    use rsa::signature::{SignatureEncoding, Signer};
    use rsa::traits::PublicKeyParts;
    use serde_json::json;
    use std::sync::OnceLock;

    const NOW_MS: i64 = 1_700_000_000_000;
    const KID: &str = "test-key-1";

    /// A process-wide deterministic 2048-bit test key (slow to generate once).
    fn test_key() -> &'static RsaPrivateKey {
        use rsa::pkcs8::DecodePrivateKey;
        static KEY: OnceLock<RsaPrivateKey> = OnceLock::new();
        KEY.get_or_init(|| {
            let pem = include_str!("../push/test_rsa_key.pem");
            RsaPrivateKey::from_pkcs8_pem(pem).expect("valid test RSA key")
        })
    }

    /// The JWKS holding the test key's public components under [`KID`].
    fn test_jwks() -> Jwks {
        let key = test_key();
        Jwks::new(vec![RsaJwk {
            kid: KID.to_string(),
            n: B64.encode(key.n().to_bytes_be()),
            e: B64.encode(key.e().to_bytes_be()),
        }])
    }

    fn provider() -> FixedJwksProvider {
        FixedJwksProvider::new(test_jwks())
    }

    /// Sign a JWT with the given header + claims using the test key. Owned
    /// `Value`s keep the `json!(...)` call sites terse (test-only helper).
    #[allow(clippy::needless_pass_by_value)]
    fn sign(header: serde_json::Value, claims: serde_json::Value) -> String {
        let header_b64 = B64.encode(serde_json::to_vec(&header).unwrap());
        let payload_b64 = B64.encode(serde_json::to_vec(&claims).unwrap());
        let signing_input = format!("{header_b64}.{payload_b64}");
        let signing_key = SigningKey::<Sha256>::new(test_key().clone());
        let signature = signing_key.sign(signing_input.as_bytes());
        format!("{signing_input}.{}", B64.encode(signature.to_bytes()))
    }

    fn rs256_header() -> serde_json::Value {
        json!({ "alg": "RS256", "typ": "JWT", "kid": KID })
    }

    fn apple_params(audiences: &[String]) -> VerifyParams<'_> {
        VerifyParams {
            issuers: &[APPLE_ISSUER],
            jwks_uri: APPLE_JWKS_URI,
            audiences,
            expected_nonce: None,
        }
    }

    fn valid_apple_claims() -> serde_json::Value {
        json!({
            "iss": APPLE_ISSUER,
            "sub": "apple-sub-123",
            "aud": "com.example.app",
            "exp": NOW_MS / 1000 + 3600,
            "email": "user@example.com",
            "email_verified": "true",
        })
    }

    #[tokio::test]
    async fn valid_apple_token_verifies() {
        let auds = vec!["com.example.app".to_string()];
        let token = sign(rs256_header(), valid_apple_claims());
        let identity = verify_id_token(&token, &apple_params(&auds), &provider(), NOW_MS)
            .await
            .unwrap();
        assert_eq!(identity.subject, "apple-sub-123");
        assert_eq!(identity.email.as_deref(), Some("user@example.com"));
        assert!(identity.email_verified);
    }

    #[tokio::test]
    async fn valid_google_token_with_array_aud_and_bool_verified() {
        let auds = vec!["client-xyz.apps.googleusercontent.com".to_string()];
        let params = VerifyParams {
            issuers: &GOOGLE_ISSUERS,
            jwks_uri: GOOGLE_JWKS_URI,
            audiences: &auds,
            expected_nonce: None,
        };
        let token = sign(
            rs256_header(),
            json!({
                "iss": "accounts.google.com",
                "sub": "google-sub-9",
                "aud": ["client-xyz.apps.googleusercontent.com"],
                "exp": NOW_MS / 1000 + 600,
                "email": "g@example.com",
                "email_verified": true,
                "name": "Grace H",
            }),
        );
        let identity = verify_id_token(&token, &params, &provider(), NOW_MS)
            .await
            .unwrap();
        assert_eq!(identity.subject, "google-sub-9");
        assert_eq!(identity.name.as_deref(), Some("Grace H"));
    }

    #[tokio::test]
    async fn rejects_wrong_audience() {
        let auds = vec!["com.example.app".to_string()];
        let token = sign(
            rs256_header(),
            json!({ "iss": APPLE_ISSUER, "sub": "s", "aud": "com.attacker.app",
                    "exp": NOW_MS / 1000 + 3600 }),
        );
        let err = verify_id_token(&token, &apple_params(&auds), &provider(), NOW_MS)
            .await
            .unwrap_err();
        assert_eq!(err, VerifyError::AudienceMismatch);
    }

    #[tokio::test]
    async fn rejects_wrong_issuer() {
        let auds = vec!["com.example.app".to_string()];
        let token = sign(
            rs256_header(),
            json!({ "iss": "https://evil.example", "sub": "s", "aud": "com.example.app",
                    "exp": NOW_MS / 1000 + 3600 }),
        );
        let err = verify_id_token(&token, &apple_params(&auds), &provider(), NOW_MS)
            .await
            .unwrap_err();
        assert_eq!(err, VerifyError::IssuerMismatch);
    }

    #[tokio::test]
    async fn rejects_expired_token() {
        let auds = vec!["com.example.app".to_string()];
        let token = sign(
            rs256_header(),
            json!({ "iss": APPLE_ISSUER, "sub": "s", "aud": "com.example.app",
                    "exp": NOW_MS / 1000 - 3600 }),
        );
        let err = verify_id_token(&token, &apple_params(&auds), &provider(), NOW_MS)
            .await
            .unwrap_err();
        assert_eq!(err, VerifyError::Expired);
    }

    #[tokio::test]
    async fn rejects_missing_exp() {
        let auds = vec!["com.example.app".to_string()];
        let token = sign(
            rs256_header(),
            json!({ "iss": APPLE_ISSUER, "sub": "s", "aud": "com.example.app" }),
        );
        let err = verify_id_token(&token, &apple_params(&auds), &provider(), NOW_MS)
            .await
            .unwrap_err();
        assert_eq!(err, VerifyError::Expired);
    }

    #[tokio::test]
    async fn rejects_bad_signature_from_other_key() {
        let auds = vec!["com.example.app".to_string()];
        // Sign with the real test key, but make the JWKS publish a DIFFERENT key
        // under the same kid — the signature must fail to verify.
        let token = sign(rs256_header(), valid_apple_claims());
        let other = RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048).unwrap();
        let bad_jwks = Jwks::new(vec![RsaJwk {
            kid: KID.to_string(),
            n: B64.encode(other.n().to_bytes_be()),
            e: B64.encode(other.e().to_bytes_be()),
        }]);
        let err = verify_id_token(
            &token,
            &apple_params(&auds),
            &FixedJwksProvider::new(bad_jwks),
            NOW_MS,
        )
        .await
        .unwrap_err();
        assert_eq!(err, VerifyError::BadSignature);
    }

    #[tokio::test]
    async fn rejects_alg_none_forgery() {
        let auds = vec!["com.example.app".to_string()];
        // alg=none, empty signature — the classic bypass. Must be rejected
        // BEFORE any key lookup.
        let header_b64 =
            B64.encode(serde_json::to_vec(&json!({ "alg": "none", "kid": KID })).unwrap());
        let payload_b64 = B64.encode(serde_json::to_vec(&valid_apple_claims()).unwrap());
        let token = format!("{header_b64}.{payload_b64}.");
        let err = verify_id_token(&token, &apple_params(&auds), &provider(), NOW_MS)
            .await
            .unwrap_err();
        assert_eq!(err, VerifyError::UnsupportedAlgorithm);
    }

    #[tokio::test]
    async fn rejects_hs256_alg_confusion() {
        let auds = vec!["com.example.app".to_string()];
        // Forge an HS256 token whose HMAC key is the RSA public key bytes — the
        // alg-confusion attack. We pin RS256, so this is rejected at the header.
        let header_b64 =
            B64.encode(serde_json::to_vec(&json!({ "alg": "HS256", "kid": KID })).unwrap());
        let payload_b64 = B64.encode(serde_json::to_vec(&valid_apple_claims()).unwrap());
        let token = format!("{header_b64}.{payload_b64}.AAAA");
        let err = verify_id_token(&token, &apple_params(&auds), &provider(), NOW_MS)
            .await
            .unwrap_err();
        assert_eq!(err, VerifyError::UnsupportedAlgorithm);
    }

    #[tokio::test]
    async fn rejects_unknown_kid() {
        let auds = vec!["com.example.app".to_string()];
        let token = sign(
            json!({ "alg": "RS256", "kid": "rotated-away" }),
            valid_apple_claims(),
        );
        let err = verify_id_token(&token, &apple_params(&auds), &provider(), NOW_MS)
            .await
            .unwrap_err();
        assert_eq!(err, VerifyError::UnknownKey);
    }

    #[tokio::test]
    async fn rejects_unverified_email() {
        let auds = vec!["com.example.app".to_string()];
        let token = sign(
            rs256_header(),
            json!({ "iss": APPLE_ISSUER, "sub": "s", "aud": "com.example.app",
                    "exp": NOW_MS / 1000 + 3600, "email": "x@y.z",
                    "email_verified": false }),
        );
        let err = verify_id_token(&token, &apple_params(&auds), &provider(), NOW_MS)
            .await
            .unwrap_err();
        assert_eq!(err, VerifyError::EmailUnverified);
    }

    #[tokio::test]
    async fn rejects_nonce_mismatch_and_accepts_match() {
        let auds = vec!["com.example.app".to_string()];
        let token = sign(
            rs256_header(),
            json!({ "iss": APPLE_ISSUER, "sub": "s", "aud": "com.example.app",
                    "exp": NOW_MS / 1000 + 3600, "nonce": "expected-nonce" }),
        );

        let mut params = apple_params(&auds);
        params.expected_nonce = Some("wrong-nonce");
        assert_eq!(
            verify_id_token(&token, &params, &provider(), NOW_MS)
                .await
                .unwrap_err(),
            VerifyError::NonceMismatch
        );

        params.expected_nonce = Some("expected-nonce");
        assert!(
            verify_id_token(&token, &params, &provider(), NOW_MS)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn rejects_malformed_token() {
        let auds = vec!["com.example.app".to_string()];
        for bad in ["", "a.b", "not-a-jwt", "a.b.c.d"] {
            let err = verify_id_token(bad, &apple_params(&auds), &provider(), NOW_MS)
                .await
                .unwrap_err();
            assert_eq!(err, VerifyError::MalformedToken, "input {bad:?}");
        }
    }
}
