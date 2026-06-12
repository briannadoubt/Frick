//! Pluggable password hashing for Frick account credentials
//! (`apps/server/src/storage/password-hasher.ts`, map 03 §9.1, FR-35).
//!
//! The stored credential is a single **self-describing** string; the tag before
//! the first `$` is what [`FrickPasswordHasher::verify`] and
//! [`FrickPasswordHasher::needs_rehash`] dispatch on:
//!
//! - `argon2$<PHC>` — Argon2id. The `<PHC>` after the `argon2$` prefix is a
//!   standard PHC string (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`)
//!   emitted by the RustCrypto `argon2` crate, byte-compatible with the TS
//!   `@node-rs/argon2` output. Defaults `memoryCost=19456 KiB, timeCost=2,
//!   parallelism=1` (the argon2 crate's own defaults). `needs_rehash` parses the
//!   PHC params and requires exact `m`/`t`/`p` AND variant `argon2id`.
//! - `scrypt$<N>$<r>$<p>$<keylen>$<saltB64url>$<digestB64url>` — defaults
//!   `N=16384, r=8, p=1, keylen=32`, 16-byte salt. Verify is a constant-time
//!   compare of the recomputed digest.
//! - `legacy-scrypt$<salt>$<digestB64url>` — the pre-FR-35 two-column format,
//!   reconstructed by [`to_stored_hash`]. **Bug-compatible**: the original code
//!   called `scryptSync(password, saltString, 32)` with the salt used as a
//!   *UTF-8 string*, NOT base64-decoded, so we reproduce that exactly. Always
//!   `needs_rehash = true`.
//!
//! # Determinism seam
//!
//! Hashing draws a random salt, which would make hashes irreproducible in
//! tests. The salt source is injected via the [`SaltSource`] seam: production
//! passes [`OsSaltSource`] (a CSPRNG); tests pass [`FixedSaltSource`] so a hash
//! is reproducible and known-answer vectors are stable. `verify` is fully
//! deterministic given a stored hash — it never draws randomness.

use argon2::password_hash::{PasswordHash, PasswordHasher as _, PasswordVerifier as _, SaltString};
use argon2::{Algorithm, Argon2, Params as Argon2Params, Version};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use rand::rngs::OsRng;
use scrypt::{Params as ScryptParams, scrypt};
use subtle::ConstantTimeEq;

const LEGACY_SCRYPT_PREFIX: &str = "legacy-scrypt";
const SCRYPT_PREFIX: &str = "scrypt";
const ARGON2_PREFIX: &str = "argon2";

/// Default scrypt parameters (`SCRYPT_DEFAULTS`, password-hasher.ts:71). `N`
/// must be a power of two; `N=16384` is the Node `scryptSync` default and
/// `keylen=32` matches the original 32-byte digest.
const SCRYPT_DEFAULT_N: u32 = 16384;
const SCRYPT_DEFAULT_R: u32 = 8;
const SCRYPT_DEFAULT_P: u32 = 1;
const SCRYPT_DEFAULT_KEYLEN: usize = 32;
/// The scrypt salt is 16 random bytes (`randomBytes(16)`,
/// password-hasher.ts:205).
const SCRYPT_SALT_BYTES: usize = 16;

/// Argon2id defaults (`ARGON2_DEFAULTS`, password-hasher.ts:76-80): these are
/// also the `argon2` crate's own [`Argon2Params`] defaults, so a default
/// [`Argon2PasswordHasher`] and `Argon2::default()` agree.
const ARGON2_DEFAULT_M_COST: u32 = 19456;
const ARGON2_DEFAULT_T_COST: u32 = 2;
const ARGON2_DEFAULT_P_COST: u32 = 1;
/// Argon2 salt length in bytes; matches `@node-rs/argon2` (16 bytes).
const ARGON2_SALT_BYTES: usize = 16;

/// Injectable salt source so hashing is reproducible in tests. Production uses
/// a CSPRNG ([`OsSaltSource`]); tests use [`FixedSaltSource`]. Only *hashing*
/// pulls salt — `verify`/`needs_rehash` are deterministic.
pub trait SaltSource {
    /// Fill `out` with salt bytes.
    fn fill(&self, out: &mut [u8]);
}

/// CSPRNG-backed salt source (`randomBytes`), the production default.
#[derive(Debug, Clone, Copy, Default)]
pub struct OsSaltSource;

impl SaltSource for OsSaltSource {
    fn fill(&self, out: &mut [u8]) {
        OsRng.fill_bytes(out);
    }
}

/// A deterministic salt source for tests: repeats a fixed seed byte pattern,
/// so a hash with the same password + params is byte-for-byte reproducible.
#[derive(Debug, Clone)]
pub struct FixedSaltSource {
    seed: Vec<u8>,
}

impl FixedSaltSource {
    /// A salt source that fills with the given seed bytes (cycled to length).
    /// An empty seed fills with zeroes.
    #[must_use]
    pub fn new(seed: impl Into<Vec<u8>>) -> Self {
        Self { seed: seed.into() }
    }
}

impl SaltSource for FixedSaltSource {
    fn fill(&self, out: &mut [u8]) {
        if self.seed.is_empty() {
            out.fill(0);
            return;
        }
        for (index, byte) in out.iter_mut().enumerate() {
            *byte = self.seed[index % self.seed.len()];
        }
    }
}

/// `FrickPasswordHasher` (password-hasher.ts:45-62). A hasher dispatches
/// `verify` on the stored tag, so any hasher verifies any supported algorithm
/// (needed for lazy migration). `id` is the active algorithm's stable id.
pub trait FrickPasswordHasher: Send + Sync {
    /// Stable id for the active algorithm (`"argon2"` or `"scrypt"`).
    fn id(&self) -> &'static str;
    /// Hash a plaintext into a self-describing stored string.
    fn hash(&self, password: &str) -> Result<String, PasswordHashError>;
    /// Verify a plaintext against a stored string, dispatching on the tag.
    fn verify(&self, password: &str, stored: &str) -> bool;
    /// True when `stored` is weaker than this hasher's active configuration and
    /// should be re-hashed on the next successful login.
    fn needs_rehash(&self, stored: &str) -> bool;
}

/// A hashing failure (parameter or encoding error). Verification never
/// produces this — a malformed/incorrect hash simply verifies `false`, exactly
/// like the TS `try/catch` arms that `return false`.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct PasswordHashError(String);

/// `splitTag` (password-hasher.ts:89-93): split on the first `$`. No `$` ⇒ the
/// whole string is the tag and `rest` is empty.
fn split_tag(stored: &str) -> (&str, &str) {
    match stored.find('$') {
        Some(index) => (&stored[..index], &stored[index + 1..]),
        None => (stored, ""),
    }
}

/// Bug-compatible legacy verify (`verifyLegacyScrypt`, password-hasher.ts:155-163):
/// `scryptSync(password, saltSTRING, 32)` — the salt is the raw UTF-8 string,
/// NOT base64-decoded — with Node's default `N=16384, r=8, p=1`.
fn verify_legacy_scrypt(password: &str, rest: &str) -> bool {
    let Some(separator) = rest.find('$') else {
        return false;
    };
    let salt = &rest[..separator];
    let digest_b64 = &rest[separator + 1..];
    let Ok(expected) = URL_SAFE_NO_PAD.decode(digest_b64) else {
        return false;
    };
    let Ok(params) = ScryptParams::new(
        14,
        SCRYPT_DEFAULT_R,
        SCRYPT_DEFAULT_P,
        SCRYPT_DEFAULT_KEYLEN,
    ) else {
        return false;
    };
    let mut actual = vec![0u8; SCRYPT_DEFAULT_KEYLEN];
    if scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut actual).is_err() {
        return false;
    }
    constant_time_eq(&expected, &actual)
}

/// Parse + verify a `scrypt$N$r$p$keylen$saltB64url$digestB64url` hash
/// (`verifyScrypt`, password-hasher.ts:117-147). Any malformed field ⇒ `false`.
fn verify_scrypt(password: &str, rest: &str) -> bool {
    let parts: Vec<&str> = rest.split('$').collect();
    if parts.len() != 6 {
        return false;
    }
    let (Ok(n), Ok(r), Ok(p), Ok(keylen)) = (
        parts[0].parse::<u32>(),
        parts[1].parse::<u32>(),
        parts[2].parse::<u32>(),
        parts[3].parse::<usize>(),
    ) else {
        return false;
    };
    let Ok(salt) = URL_SAFE_NO_PAD.decode(parts[4]) else {
        return false;
    };
    let Ok(expected) = URL_SAFE_NO_PAD.decode(parts[5]) else {
        return false;
    };
    let Some(log_n) = log2_exact(n) else {
        return false;
    };
    let Ok(params) = ScryptParams::new(log_n, r, p, keylen) else {
        return false;
    };
    let mut actual = vec![0u8; keylen];
    if scrypt(password.as_bytes(), &salt, &params, &mut actual).is_err() {
        return false;
    }
    constant_time_eq(&expected, &actual)
}

/// `log₂(n)` when `n` is an exact power of two, else `None`. The scrypt crate
/// takes `log_n`; the stored format carries `N`, so we convert (and reject a
/// non-power-of-two `N`, which `ScryptParams::new` would also reject).
fn log2_exact(n: u32) -> Option<u8> {
    if n == 0 || !n.is_power_of_two() {
        return None;
    }
    // A u32 power of two has at most 31 trailing zeros, so this never truncates.
    u8::try_from(n.trailing_zeros()).ok()
}

/// Encode a `scrypt$…` self-describing hash (`encodeScrypt`,
/// password-hasher.ts:105-115).
fn encode_scrypt(salt: &[u8], digest: &[u8], n: u32, r: u32, p: u32, keylen: usize) -> String {
    format!(
        "{SCRYPT_PREFIX}${n}${r}${p}${keylen}${}${}",
        URL_SAFE_NO_PAD.encode(salt),
        URL_SAFE_NO_PAD.encode(digest),
    )
}

/// Constant-time byte compare with an up-front length check
/// (`constantTimeEqual`, password-hasher.ts:165-168). Unequal lengths short-
/// circuit to `false` (a length difference is not itself secret).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

/// Parsed argon2 PHC cost params (`Argon2Params` TS interface,
/// password-hasher.ts:262-267), used only by [`Argon2PasswordHasher::needs_rehash`].
struct ParsedArgon2 {
    variant: String,
    memory_cost: u32,
    time_cost: u32,
    parallelism: u32,
}

/// `parseArgon2Params` (password-hasher.ts:276-304): pull `variant` and
/// `m`/`t`/`p` out of `$argon2id$v=19$m=…,t=…,p=…$salt$hash`. `None` when the
/// string is not a recognisable argon2 PHC encoding.
fn parse_argon2_params(encoded: &str) -> Option<ParsedArgon2> {
    // Splitting `$argon2id$v=19$m=…$salt$hash` yields
    // ["", "argon2id", "v=19", "m=…,t=…,p=…", salt, hash].
    let segments: Vec<&str> = encoded.split('$').collect();
    if segments.len() < 4 {
        return None;
    }
    let variant = segments[1];
    let param_segment = segments[3];
    if !variant.starts_with("argon2") {
        return None;
    }
    let mut memory_cost: Option<u32> = None;
    let mut time_cost: Option<u32> = None;
    let mut parallelism: Option<u32> = None;
    for kv in param_segment.split(',') {
        let mut split = kv.splitn(2, '=');
        let (Some(key), Some(value)) = (split.next(), split.next()) else {
            return None;
        };
        let Ok(parsed) = value.parse::<u32>() else {
            return None;
        };
        match key {
            "m" => memory_cost = Some(parsed),
            "t" => time_cost = Some(parsed),
            "p" => parallelism = Some(parsed),
            _ => {}
        }
    }
    Some(ParsedArgon2 {
        variant: variant.to_owned(),
        memory_cost: memory_cost?,
        time_cost: time_cost?,
        parallelism: parallelism?,
    })
}

/// Dispatch `verify` on the stored tag (`BaseHasher.verify`,
/// password-hasher.ts:175-191). Shared by both hashers; an unknown tag ⇒
/// `false`.
fn verify_dispatch(password: &str, stored: &str) -> bool {
    let (tag, rest) = split_tag(stored);
    match tag {
        LEGACY_SCRYPT_PREFIX => verify_legacy_scrypt(password, rest),
        SCRYPT_PREFIX => verify_scrypt(password, rest),
        ARGON2_PREFIX => verify_argon2(password, rest),
        _ => false,
    }
}

/// Verify an `argon2$<PHC>` hash: parse the PHC `rest` and check the password.
/// Any parse/verify error ⇒ `false` (TS `try { argon2.verify } catch`).
fn verify_argon2(password: &str, rest: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(rest) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

/// `ScryptPasswordHasher` (password-hasher.ts:195-226): emits tagged scrypt
/// hashes and flags non-scrypt / mismatched-parameter scrypt for rehash, but
/// never downgrades an argon2 hash.
pub struct ScryptPasswordHasher<S: SaltSource = OsSaltSource> {
    n: u32,
    r: u32,
    p: u32,
    keylen: usize,
    salt_source: S,
}

impl Default for ScryptPasswordHasher<OsSaltSource> {
    fn default() -> Self {
        Self::new(OsSaltSource)
    }
}

impl<S: SaltSource> ScryptPasswordHasher<S> {
    /// A scrypt hasher with the default parameters and the given salt source.
    #[must_use]
    pub fn new(salt_source: S) -> Self {
        Self {
            n: SCRYPT_DEFAULT_N,
            r: SCRYPT_DEFAULT_R,
            p: SCRYPT_DEFAULT_P,
            keylen: SCRYPT_DEFAULT_KEYLEN,
            salt_source,
        }
    }

    /// A scrypt hasher with explicit parameters (test seam; mirrors the TS
    /// `Partial<ScryptParams>` constructor).
    #[must_use]
    pub fn with_params(n: u32, r: u32, p: u32, keylen: usize, salt_source: S) -> Self {
        Self {
            n,
            r,
            p,
            keylen,
            salt_source,
        }
    }
}

impl<S: SaltSource + Send + Sync> FrickPasswordHasher for ScryptPasswordHasher<S> {
    fn id(&self) -> &'static str {
        SCRYPT_PREFIX
    }

    fn hash(&self, password: &str) -> Result<String, PasswordHashError> {
        let mut salt = vec![0u8; SCRYPT_SALT_BYTES];
        self.salt_source.fill(&mut salt);
        let log_n = log2_exact(self.n).ok_or_else(|| {
            PasswordHashError(format!("scrypt N must be a power of two: {}", self.n))
        })?;
        let params = ScryptParams::new(log_n, self.r, self.p, self.keylen)
            .map_err(|err| PasswordHashError(format!("invalid scrypt params: {err}")))?;
        let mut digest = vec![0u8; self.keylen];
        scrypt(password.as_bytes(), &salt, &params, &mut digest)
            .map_err(|err| PasswordHashError(format!("scrypt failed: {err}")))?;
        Ok(encode_scrypt(
            &salt,
            &digest,
            self.n,
            self.r,
            self.p,
            self.keylen,
        ))
    }

    fn verify(&self, password: &str, stored: &str) -> bool {
        verify_dispatch(password, stored)
    }

    fn needs_rehash(&self, stored: &str) -> bool {
        let (tag, rest) = split_tag(stored);
        if tag == LEGACY_SCRYPT_PREFIX {
            return true;
        }
        // A hash from a stronger algorithm must not be downgraded.
        if tag == ARGON2_PREFIX {
            return false;
        }
        if tag != SCRYPT_PREFIX {
            return true;
        }
        let parts: Vec<&str> = rest.split('$').collect();
        if parts.len() != 6 {
            return true;
        }
        // Mismatched parameters (parse failure ⇒ never equal ⇒ rehash).
        parts[0].parse::<u32>().ok() != Some(self.n)
            || parts[1].parse::<u32>().ok() != Some(self.r)
            || parts[2].parse::<u32>().ok() != Some(self.p)
            || parts[3].parse::<usize>().ok() != Some(self.keylen)
    }
}

/// `Argon2PasswordHasher` (password-hasher.ts:229-260): Argon2id, the default
/// for new credentials. Flags anything non-argon2 — or argon2 with mismatched
/// `m`/`t`/`p` or a non-`argon2id` variant — for rehash.
pub struct Argon2PasswordHasher<S: SaltSource = OsSaltSource> {
    memory_cost: u32,
    time_cost: u32,
    parallelism: u32,
    salt_source: S,
}

impl Default for Argon2PasswordHasher<OsSaltSource> {
    fn default() -> Self {
        Self::new(OsSaltSource)
    }
}

impl<S: SaltSource> Argon2PasswordHasher<S> {
    /// An argon2 hasher with the default parameters and the given salt source.
    #[must_use]
    pub fn new(salt_source: S) -> Self {
        Self {
            memory_cost: ARGON2_DEFAULT_M_COST,
            time_cost: ARGON2_DEFAULT_T_COST,
            parallelism: ARGON2_DEFAULT_P_COST,
            salt_source,
        }
    }

    /// An argon2 hasher with explicit cost parameters (test seam; mirrors the
    /// TS `Partial<typeof ARGON2_DEFAULTS>` constructor).
    #[must_use]
    pub fn with_params(memory_cost: u32, time_cost: u32, parallelism: u32, salt_source: S) -> Self {
        Self {
            memory_cost,
            time_cost,
            parallelism,
            salt_source,
        }
    }

    fn argon2(&self) -> Result<Argon2<'static>, PasswordHashError> {
        let params = Argon2Params::new(self.memory_cost, self.time_cost, self.parallelism, None)
            .map_err(|err| PasswordHashError(format!("invalid argon2 params: {err}")))?;
        Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
    }
}

impl<S: SaltSource + Send + Sync> FrickPasswordHasher for Argon2PasswordHasher<S> {
    fn id(&self) -> &'static str {
        ARGON2_PREFIX
    }

    fn hash(&self, password: &str) -> Result<String, PasswordHashError> {
        let mut salt_bytes = vec![0u8; ARGON2_SALT_BYTES];
        self.salt_source.fill(&mut salt_bytes);
        let salt = SaltString::encode_b64(&salt_bytes)
            .map_err(|err| PasswordHashError(format!("invalid argon2 salt: {err}")))?;
        let phc = self
            .argon2()?
            .hash_password(password.as_bytes(), &salt)
            .map_err(|err| PasswordHashError(format!("argon2 hash failed: {err}")))?
            .to_string();
        // The argon2 crate emits the PHC string; prefix it with `argon2$` to
        // keep dispatch uniform (password-hasher.ts:244).
        Ok(format!("{ARGON2_PREFIX}${phc}"))
    }

    fn verify(&self, password: &str, stored: &str) -> bool {
        verify_dispatch(password, stored)
    }

    fn needs_rehash(&self, stored: &str) -> bool {
        let (tag, rest) = split_tag(stored);
        // Anything not argon2 (legacy / self-describing scrypt) is weaker.
        if tag != ARGON2_PREFIX {
            return true;
        }
        let Some(parsed) = parse_argon2_params(rest) else {
            // Unparseable — re-hash to be safe.
            return true;
        };
        parsed.memory_cost != self.memory_cost
            || parsed.time_cost != self.time_cost
            || parsed.parallelism != self.parallelism
            || parsed.variant != "argon2id"
    }
}

/// `FrickPasswordHasherId` (password-hasher.ts:306): the hasher selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrickPasswordHasherId {
    Argon2,
    Scrypt,
}

/// `createPasswordHasher` (password-hasher.ts:313-326): build a hasher from a
/// selector, defaulting to argon2. The production CSPRNG salt source is used;
/// for a deterministic salt seam construct [`Argon2PasswordHasher::new`] /
/// [`ScryptPasswordHasher::new`] with a [`FixedSaltSource`] directly.
#[must_use]
pub fn create_password_hasher(id: FrickPasswordHasherId) -> Box<dyn FrickPasswordHasher> {
    match id {
        FrickPasswordHasherId::Argon2 => Box::new(Argon2PasswordHasher::default()),
        FrickPasswordHasherId::Scrypt => Box::new(ScryptPasswordHasher::default()),
    }
}

/// The default hasher (argon2), matching `createPasswordHasher()` with no
/// argument (password-hasher.ts:313-315).
#[must_use]
pub fn default_password_hasher() -> Box<dyn FrickPasswordHasher> {
    create_password_hasher(FrickPasswordHasherId::Argon2)
}

/// `toStoredHash` (password-hasher.ts:334-341): reconstruct the self-describing
/// stored string for the pre-FR-35 two-column format. A `password_hash` that
/// already contains `$` is a tagged self-describing hash and passes through
/// unchanged; otherwise the salt lived in its own column and the digest was
/// untagged, so wrap them as `legacy-scrypt$<salt>$<digest>`.
#[must_use]
pub fn to_stored_hash(password_hash: &str, password_salt: &str) -> String {
    if password_hash.contains('$') {
        return password_hash.to_owned();
    }
    format!("{LEGACY_SCRYPT_PREFIX}${password_salt}${password_hash}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic argon2 hasher for reproducible hashes / known answers.
    fn fixed_argon2() -> Argon2PasswordHasher<FixedSaltSource> {
        Argon2PasswordHasher::new(FixedSaltSource::new([0xAB, 0xCD]))
    }

    /// A deterministic scrypt hasher.
    fn fixed_scrypt() -> ScryptPasswordHasher<FixedSaltSource> {
        ScryptPasswordHasher::new(FixedSaltSource::new([0x11, 0x22, 0x33]))
    }

    // ── Port of password-hasher.test.ts: self-describing formats ─────────────

    #[test]
    fn argon2_hashes_are_tagged_verify_and_reject_wrong() {
        let hasher = fixed_argon2();
        let stored = hasher.hash("hunter2").unwrap();
        assert!(stored.starts_with("argon2$"));
        assert!(hasher.verify("hunter2", &stored));
        assert!(!hasher.verify("nope", &stored));
    }

    #[test]
    fn scrypt_hashes_are_tagged_verify_and_reject_wrong() {
        let hasher = fixed_scrypt();
        let stored = hasher.hash("hunter2").unwrap();
        assert!(stored.starts_with("scrypt$"));
        assert!(hasher.verify("hunter2", &stored));
        assert!(!hasher.verify("nope", &stored));
    }

    #[test]
    fn cross_algorithm_dispatch() {
        let argon = fixed_argon2();
        let scrypt = fixed_scrypt();
        // An argon2 hasher must still verify a scrypt hash (so migration can
        // detect it), and vice versa.
        let scrypt_stored = scrypt.hash("hunter2").unwrap();
        assert!(argon.verify("hunter2", &scrypt_stored));
        let argon_stored = argon.hash("hunter2").unwrap();
        assert!(scrypt.verify("hunter2", &argon_stored));
    }

    #[test]
    fn create_password_hasher_defaults_to_argon2() {
        let hasher = default_password_hasher();
        assert_eq!(hasher.id(), "argon2");
        assert!(hasher.hash("x").unwrap().starts_with("argon2$"));
    }

    // ── needsRehash ──────────────────────────────────────────────────────────

    #[test]
    fn argon2_flags_legacy_and_scrypt_for_rehash() {
        let argon = fixed_argon2();
        let scrypt_stored = fixed_scrypt().hash("pw").unwrap();
        assert!(argon.needs_rehash(&scrypt_stored));
        assert!(argon.needs_rehash(&to_stored_hash("abc", "salt")));
        // Its own fresh hash does not need rehashing.
        assert!(!argon.needs_rehash(&argon.hash("pw").unwrap()));
    }

    #[test]
    fn argon2_flags_weaker_parameter_argon2_for_rehash() {
        let weak = Argon2PasswordHasher::with_params(8192, 1, 1, FixedSaltSource::new([0x01]));
        let strong = fixed_argon2();
        let weak_stored = weak.hash("pw").unwrap();
        assert!(strong.needs_rehash(&weak_stored));
        // The strong hasher still verifies the weak hash.
        assert!(strong.verify("pw", &weak_stored));
    }

    #[test]
    fn scrypt_does_not_downgrade_argon2() {
        let scrypt = fixed_scrypt();
        let argon_stored = fixed_argon2().hash("pw").unwrap();
        assert!(!scrypt.needs_rehash(&argon_stored));
    }

    #[test]
    fn scrypt_flags_mismatched_parameters_for_rehash() {
        let hasher = fixed_scrypt();
        let other = ScryptPasswordHasher::with_params(8192, 8, 1, 32, FixedSaltSource::new([0x05]));
        let other_stored = other.hash("pw").unwrap();
        // N differs from the default hasher's 16384 ⇒ rehash.
        assert!(hasher.needs_rehash(&other_stored));
        // Its own default-parameter hash does not.
        assert!(!hasher.needs_rehash(&hasher.hash("pw").unwrap()));
    }

    // ── legacy scrypt compatibility (bug-compatible string salt) ─────────────

    #[test]
    fn verifies_pre_fr35_bare_scrypt_format() {
        // Reproduce the old on-disk format: separate salt column + untagged
        // digest. The legacy digest is `scryptSync(password, saltString, 32)`
        // with Node defaults (N=16384, r=8, p=1), salt used as a UTF-8 STRING.
        let salt = "abc123salt";
        let params = ScryptParams::new(14, 8, 1, 32).unwrap();
        let mut digest = vec![0u8; 32];
        scrypt(b"hunter2", salt.as_bytes(), &params, &mut digest).unwrap();
        let digest_b64 = URL_SAFE_NO_PAD.encode(&digest);
        let stored = to_stored_hash(&digest_b64, salt);
        assert!(stored.starts_with("legacy-scrypt$"));

        let hasher = default_password_hasher();
        assert!(hasher.verify("hunter2", &stored));
        assert!(!hasher.verify("wrong", &stored));
        assert!(hasher.needs_rehash(&stored));
    }

    // ── Known-answer vectors (deterministic salt) ────────────────────────────

    #[test]
    fn scrypt_known_answer_vector() {
        // FixedSaltSource([0x11,0x22,0x33]) over 16 bytes ⇒ a fixed salt, so
        // the entire stored string is reproducible.
        let salt = {
            let mut buf = vec![0u8; SCRYPT_SALT_BYTES];
            FixedSaltSource::new([0x11, 0x22, 0x33]).fill(&mut buf);
            buf
        };
        let params = ScryptParams::new(14, 8, 1, 32).unwrap();
        let mut digest = vec![0u8; 32];
        scrypt(b"correct horse", &salt, &params, &mut digest).unwrap();
        let expected = encode_scrypt(&salt, &digest, 16384, 8, 1, 32);

        let actual = fixed_scrypt().hash("correct horse").unwrap();
        assert_eq!(
            actual, expected,
            "scrypt hash is reproducible from the seam"
        );
        assert!(fixed_scrypt().verify("correct horse", &actual));
    }

    #[test]
    fn argon2_hash_is_reproducible_from_fixed_salt() {
        // Same password + fixed salt + params ⇒ identical PHC string.
        let a = fixed_argon2().hash("repeatable").unwrap();
        let b = fixed_argon2().hash("repeatable").unwrap();
        assert_eq!(a, b);
        // The encoded params reflect the defaults (m=19456,t=2,p=1, argon2id).
        assert!(a.contains("$argon2id$"));
        assert!(a.contains("m=19456,t=2,p=1"));
    }

    // ── split_tag / to_stored_hash unit behavior ─────────────────────────────

    #[test]
    fn split_tag_handles_missing_dollar() {
        assert_eq!(split_tag("notag"), ("notag", ""));
        assert_eq!(split_tag("scrypt$rest$more"), ("scrypt", "rest$more"));
    }

    #[test]
    fn to_stored_hash_passes_through_tagged_and_wraps_legacy() {
        // A tagged hash passes through unchanged.
        assert_eq!(to_stored_hash("argon2$xyz", ""), "argon2$xyz");
        assert_eq!(to_stored_hash("scrypt$1$2", "ignored"), "scrypt$1$2");
        // An untagged digest is wrapped with its separate salt column.
        assert_eq!(
            to_stored_hash("rawdigest", "rawsalt"),
            "legacy-scrypt$rawsalt$rawdigest"
        );
    }

    #[test]
    fn verify_rejects_unknown_tag_and_malformed_scrypt() {
        let hasher = fixed_scrypt();
        assert!(!hasher.verify("pw", "unknown$whatever"));
        // Too few `$`-fields for scrypt.
        assert!(!hasher.verify("pw", "scrypt$16384$8$1"));
        // Non-power-of-two N ⇒ rejected.
        assert!(!hasher.verify("pw", "scrypt$1000$8$1$32$c2FsdA$ZGln"));
    }
}
