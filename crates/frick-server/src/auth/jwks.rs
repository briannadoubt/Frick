//! JWKS resolution for id-token verification (FR-269).
//!
//! A [`JwksProvider`] resolves an issuer's JSON Web Key Set (the RSA public
//! keys, by `kid`). The production implementation
//! ([`ReqwestJwksProvider`]) fetches over HTTPS and caches each key set to its
//! `Cache-Control: max-age` TTL, refetching on an unknown `kid` (Apple/Google
//! rotate keys). Tests inject [`FixedJwksProvider`] — a fixed in-memory key set
//! with no network — so the whole verify path is exercised offline.
//!
//! Apple JWKS: <https://appleid.apple.com/auth/keys>.
//! Google JWKS: <https://www.googleapis.com/oauth2/v3/certs>.
//!
//! Only RSA keys are modeled: both providers publish RSA (`kty: "RSA"`) keys
//! with base64url `n`/`e` components, and the verifier pins RS256.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;

use serde::Deserialize;

/// One RSA JWK: the base64url-encoded modulus (`n`) and exponent (`e`) plus the
/// key id. Non-RSA keys are dropped at parse time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RsaJwk {
    /// `kid` — the key id the token header references.
    pub kid: String,
    /// base64url (no padding) big-endian modulus.
    pub n: String,
    /// base64url (no padding) big-endian exponent.
    pub e: String,
}

/// A resolved key set: the RSA keys indexed by `kid`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Jwks {
    keys: Vec<RsaJwk>,
}

impl Jwks {
    /// Build a key set from a list of RSA keys.
    #[must_use]
    pub fn new(keys: Vec<RsaJwk>) -> Self {
        Self { keys }
    }

    /// Look up the RSA key with this `kid`.
    #[must_use]
    pub fn key(&self, kid: &str) -> Option<&RsaJwk> {
        self.keys.iter().find(|k| k.kid == kid)
    }
}

/// A future returning a resolved key set or an opaque error string.
pub type JwksFuture<'a> = Pin<Box<dyn Future<Output = Result<Jwks, String>> + Send + 'a>>;

/// The injectable seam: resolve the key set for an issuer's `jwks_uri`. The
/// verifier calls [`JwksProvider::fetch`] with `force_refresh = true` when it
/// sees a `kid` absent from the cached set, so a freshly-rotated key is picked
/// up without a process restart.
pub trait JwksProvider: Send + Sync {
    /// Resolve the key set at `jwks_uri`. `force_refresh` bypasses any cache.
    fn fetch<'a>(&'a self, jwks_uri: &'a str, force_refresh: bool) -> JwksFuture<'a>;
}

/// JSON shape of a JWKS document (`{ "keys": [ { kty, kid, n, e, ... } ] }`).
#[derive(Debug, Deserialize)]
struct JwksDocument {
    #[serde(default)]
    keys: Vec<JwkEntry>,
}

#[derive(Debug, Deserialize)]
struct JwkEntry {
    kty: String,
    #[serde(default)]
    kid: String,
    #[serde(default)]
    n: String,
    #[serde(default)]
    e: String,
}

/// Parse a raw JWKS JSON body into a [`Jwks`], keeping only usable RSA keys
/// (`kty == "RSA"` with non-empty `kid`/`n`/`e`).
pub fn parse_jwks(body: &str) -> Result<Jwks, String> {
    let doc: JwksDocument =
        serde_json::from_str(body).map_err(|err| format!("invalid JWKS json: {err}"))?;
    let keys = doc
        .keys
        .into_iter()
        .filter(|k| k.kty == "RSA" && !k.kid.is_empty() && !k.n.is_empty() && !k.e.is_empty())
        .map(|k| RsaJwk {
            kid: k.kid,
            n: k.n,
            e: k.e,
        })
        .collect();
    Ok(Jwks::new(keys))
}

/// A fixed, in-memory [`JwksProvider`] for tests — no network. Returns the same
/// key set for every `jwks_uri`.
#[derive(Debug, Clone)]
pub struct FixedJwksProvider {
    jwks: Jwks,
}

impl FixedJwksProvider {
    /// Wrap a key set so every `fetch` resolves it.
    #[must_use]
    pub fn new(jwks: Jwks) -> Self {
        Self { jwks }
    }
}

impl JwksProvider for FixedJwksProvider {
    fn fetch<'a>(&'a self, _jwks_uri: &'a str, _force_refresh: bool) -> JwksFuture<'a> {
        let jwks = self.jwks.clone();
        Box::pin(async move { Ok(jwks) })
    }
}

/// A cached key set with its expiry (epoch ms; `0` ⇒ never auto-expires until a
/// forced refresh).
struct CachedJwks {
    jwks: Jwks,
    expires_at_ms: i64,
}

/// The production [`JwksProvider`]: fetches over HTTPS with `reqwest` and caches
/// each `jwks_uri`'s key set to its `Cache-Control: max-age` (clamped to a sane
/// floor/ceiling). `force_refresh` (unknown-`kid` path) bypasses the cache.
pub struct ReqwestJwksProvider {
    client: reqwest::Client,
    cache: Mutex<HashMap<String, CachedJwks>>,
    clock: Box<dyn Fn() -> i64 + Send + Sync>,
}

/// Minimum cache TTL: don't refetch more than once a minute even if a provider
/// returns a tiny `max-age`.
const MIN_CACHE_TTL_MS: i64 = 60_000;
/// Maximum cache TTL: 24h. Keys are also refetched on an unknown `kid`, so a
/// rotation is picked up promptly regardless of this ceiling.
const MAX_CACHE_TTL_MS: i64 = 86_400_000;
/// Fallback TTL when the response carries no usable `max-age`.
const DEFAULT_CACHE_TTL_MS: i64 = 3_600_000;

impl ReqwestJwksProvider {
    /// Build a provider over a shared HTTP client and a wall-clock seam.
    #[must_use]
    pub fn new(client: reqwest::Client) -> Self {
        Self {
            client,
            cache: Mutex::new(HashMap::new()),
            clock: Box::new(|| {
                use std::time::{SystemTime, UNIX_EPOCH};
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
            }),
        }
    }
}

impl Default for ReqwestJwksProvider {
    fn default() -> Self {
        Self::new(reqwest::Client::new())
    }
}

impl JwksProvider for ReqwestJwksProvider {
    fn fetch<'a>(&'a self, jwks_uri: &'a str, force_refresh: bool) -> JwksFuture<'a> {
        Box::pin(async move {
            let now = (self.clock)();
            if !force_refresh
                && let Ok(cache) = self.cache.lock()
                && let Some(cached) = cache.get(jwks_uri)
                && cached.expires_at_ms > now
            {
                return Ok(cached.jwks.clone());
            }

            let response = self
                .client
                .get(jwks_uri)
                .send()
                .await
                .map_err(|err| format!("JWKS fetch failed: {err}"))?;
            if !response.status().is_success() {
                return Err(format!("JWKS fetch failed: HTTP {}", response.status()));
            }
            let ttl_ms = response
                .headers()
                .get(reqwest::header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok())
                .and_then(parse_max_age_ms)
                .unwrap_or(DEFAULT_CACHE_TTL_MS)
                .clamp(MIN_CACHE_TTL_MS, MAX_CACHE_TTL_MS);
            let body = response
                .text()
                .await
                .map_err(|err| format!("JWKS read failed: {err}"))?;
            let jwks = parse_jwks(&body)?;

            if let Ok(mut cache) = self.cache.lock() {
                cache.insert(
                    jwks_uri.to_string(),
                    CachedJwks {
                        jwks: jwks.clone(),
                        expires_at_ms: now.saturating_add(ttl_ms),
                    },
                );
            }
            Ok(jwks)
        })
    }
}

/// Extract `max-age=<seconds>` from a `Cache-Control` header value, in ms.
fn parse_max_age_ms(header: &str) -> Option<i64> {
    for directive in header.split(',') {
        let directive = directive.trim();
        if let Some(value) = directive.strip_prefix("max-age=")
            && let Ok(seconds) = value.trim().parse::<i64>()
        {
            return Some(seconds.saturating_mul(1000));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_jwks_keeps_only_rsa_keys() {
        let body = r#"{"keys":[
            {"kty":"RSA","kid":"a","n":"AQAB","e":"AQAB","alg":"RS256"},
            {"kty":"EC","kid":"b","crv":"P-256","x":"x","y":"y"},
            {"kty":"RSA","kid":"","n":"AQAB","e":"AQAB"}
        ]}"#;
        let jwks = parse_jwks(body).unwrap();
        assert!(jwks.key("a").is_some());
        assert!(jwks.key("b").is_none(), "EC key dropped");
        assert_eq!(jwks.keys.len(), 1, "empty-kid RSA key dropped");
    }

    #[test]
    fn parse_max_age_reads_directive() {
        assert_eq!(parse_max_age_ms("max-age=300"), Some(300_000));
        assert_eq!(
            parse_max_age_ms("public, max-age=21600, must-revalidate"),
            Some(21_600_000)
        );
        assert_eq!(parse_max_age_ms("no-store"), None);
    }

    #[tokio::test]
    async fn fixed_provider_returns_the_same_set() {
        let provider = FixedJwksProvider::new(Jwks::new(vec![RsaJwk {
            kid: "k1".into(),
            n: "AQAB".into(),
            e: "AQAB".into(),
        }]));
        let jwks = provider.fetch("https://example/keys", false).await.unwrap();
        assert!(jwks.key("k1").is_some());
    }
}
