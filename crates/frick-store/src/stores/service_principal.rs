//! Service principals (`apps/server/src/storage/service-principal-store.ts`,
//! map 03 §9.7, FR-46).
//!
//! A service principal is a non-human (machine) identity authenticated by a
//! long-lived API key rather than a user session. It carries a fixed set of
//! scopes that bound what it may do and acts within a single tenant.
//!
//! The API key is a high-entropy opaque secret presented as a bearer token.
//! Only the SHA-256 hash of the FULL key (including the `key_id` prefix) is ever
//! persisted (`key_hash`), so a leaked database snapshot can't be replayed to
//! authenticate. A short, non-secret `key_id` prefix is stored alongside so
//! operators can identify a key in audit logs and the issue/list UI without
//! revealing the secret. The raw key is returned exactly once, at issue time.
//!
//! Revocation is a soft delete (`revoked_at`); [`authenticate`] ignores revoked
//! rows, so revoking a key immediately stops it from resolving to a principal.
//!
//! # Determinism (map 03 §9, "Determinism rule")
//!
//! [`issue`] is the one method that consumes randomness (three CSPRNG draws) and
//! the clock. Both are hoisted to seams the caller provides:
//!
//! - a [`PrincipalRng`] yields the `id`/`key_id`/secret random bytes ([`OsRng`]
//!   in production, a fixed buffer in tests);
//! - `now_ms` stamps `created_at`/`revoked_at` (the TS reads `this.now()`).
//!
//! Store logic never touches `OsRng` or the system clock directly, so issued
//! keys are reproducible under test.
//!
//! [`authenticate`]: ServicePrincipalStore::authenticate
//! [`issue`]: ServicePrincipalStore::issue

use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::driver::{SqlDriver, SqlRow};
use crate::error::StoreError;
use crate::stores::blob_bytes::iso_from_epoch_ms;

/// The random-bytes seam for [`ServicePrincipalStore::issue`]. Production uses
/// [`OsRng`] (a CSPRNG); tests use a deterministic source so issued keys are
/// reproducible. Mirrors the TS `randomBytes(n)` calls.
pub trait PrincipalRng {
    /// Fill `dest` with cryptographically-strong random bytes.
    fn fill(&mut self, dest: &mut [u8]);
}

/// The default CSPRNG seam: [`rand::rngs::OsRng`]. Used by the facade.
#[derive(Debug, Default, Clone, Copy)]
pub struct OsRng;

impl PrincipalRng for OsRng {
    fn fill(&mut self, dest: &mut [u8]) {
        rand::rngs::OsRng.fill_bytes(dest);
    }
}

/// The set of scopes a service principal carries (`ServicePrincipalScopes`,
/// service-principal-store.ts:24). Opaque strings; the caller decides the
/// vocabulary. Stored as a JSON array.
pub type ServicePrincipalScopes = Vec<String>;

/// `IssuedServicePrincipal` (service-principal-store.ts:26-41): the result of
/// [`ServicePrincipalStore::issue`] — the raw key (readable ONCE) plus metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedServicePrincipal {
    /// Stable identifier for the principal (also the audit subject id).
    pub id: String,
    /// Non-secret short prefix that identifies the key in logs/UI.
    pub key_id: String,
    /// The raw API key handed to the caller. The ONLY time it is readable —
    /// only its hash is stored. The full value (including the `key_id` prefix)
    /// is the bearer token used to authenticate.
    pub api_key: String,
    pub tenant_id: String,
    pub name: String,
    pub scopes: ServicePrincipalScopes,
    pub created_at: String,
}

/// `ServicePrincipalRecord` (service-principal-store.ts:43-51): a stored
/// principal without its key hash. `revoked_at` is `None` for an active row
/// (the TS omits the key entirely when NULL).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServicePrincipalRecord {
    pub id: String,
    pub key_id: String,
    pub tenant_id: String,
    pub name: String,
    pub scopes: ServicePrincipalScopes,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

/// Input to [`ServicePrincipalStore::issue`] (`IssueServicePrincipalInput`,
/// service-principal-store.ts:64-69).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueServicePrincipalInput {
    pub tenant_id: String,
    /// Human-readable label, e.g. `"ci-deploy-bot"`.
    pub name: String,
    pub scopes: ServicePrincipalScopes,
}

/// `ServicePrincipalStore` (`storage/service-principal-store.ts`).
pub struct ServicePrincipalStore {
    sql: Arc<SqlDriver>,
}

impl ServicePrincipalStore {
    #[must_use]
    pub fn new(sql: Arc<SqlDriver>) -> Self {
        Self { sql }
    }

    /// `issue` (service-principal-store.ts:81-107). Mint a new principal + API
    /// key for `tenant_id` and return the raw key (the only chance to read it).
    ///
    /// `id = "sp_" + base64url(rng 12B)`, `key_id = "sk_" + base64url(rng 6B)`,
    /// `secret = base64url(rng 32B)`, presented bearer `api_key = keyId.secret`.
    /// Stored `key_hash = base64url(sha256(api_key))` over the FULL key (prefix
    /// included). Scopes are normalized (trim, drop empties, dedupe, sort) and
    /// stored as a JSON array. The three CSPRNG draws come from `rng`; `now_ms`
    /// stamps `created_at`.
    pub async fn issue<R: PrincipalRng>(
        &self,
        input: &IssueServicePrincipalInput,
        rng: &mut R,
        now_ms: i64,
    ) -> Result<IssuedServicePrincipal, StoreError> {
        let id = format!("sp_{}", random_b64url(rng, 12));
        let key_id = format!("sk_{}", random_b64url(rng, 6));
        let secret = random_b64url(rng, 32);
        // The presented bearer is `keyId.secret` so authenticate() can pull the
        // non-secret prefix for cheap lookup without storing the secret.
        let api_key = format!("{key_id}.{secret}");
        let created_at = iso_from_epoch_ms(now_ms);
        let scopes = normalize_scopes(&input.scopes);

        self.sql
            .run(
                "INSERT INTO service_principals
                    (id, key_id, key_hash, tenant_id, name, scopes, created_at, revoked_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
                &[
                    id.as_str().into(),
                    key_id.as_str().into(),
                    hash_key(&api_key).into(),
                    input.tenant_id.as_str().into(),
                    input.name.as_str().into(),
                    serialize_scopes(&scopes).into(),
                    created_at.as_str().into(),
                ],
            )
            .await?;

        Ok(IssuedServicePrincipal {
            id,
            key_id,
            api_key,
            tenant_id: input.tenant_id.clone(),
            name: input.name.clone(),
            scopes,
            created_at,
        })
    }

    /// `authenticate` (service-principal-store.ts:113-129). Resolve a presented
    /// API key to its (non-revoked) record, or `None` when the key is unknown or
    /// revoked. Parses the `key_id` before the first `.` (must be at index > 0),
    /// looks up by `key_id`, rejects revoked rows, then compares the stored hash
    /// against `sha256(api_key)` in constant time.
    pub async fn authenticate(
        &self,
        api_key: &str,
    ) -> Result<Option<ServicePrincipalRecord>, StoreError> {
        let Some(key_id) = key_id_from_api_key(api_key) else {
            return Ok(None);
        };
        let Some(row) = self
            .sql
            .get(
                "SELECT * FROM service_principals WHERE key_id = ?",
                &[key_id.into()],
            )
            .await?
        else {
            return Ok(None);
        };
        // Reject revoked rows (revoked_at IS NOT NULL).
        if row.text("revoked_at").is_some() {
            return Ok(None);
        }
        let stored_hash = row.text("key_hash").unwrap_or_default();
        if !constant_time_equals(&hash_key(api_key), stored_hash) {
            return Ok(None);
        }
        Ok(Some(from_row(&row)))
    }

    /// `list` (service-principal-store.ts:132-138): principals for a tenant,
    /// newest first (`ORDER BY created_at DESC, id DESC`). Never returns key
    /// hashes.
    pub async fn list(&self, tenant_id: &str) -> Result<Vec<ServicePrincipalRecord>, StoreError> {
        let rows = self
            .sql
            .all(
                "SELECT * FROM service_principals WHERE tenant_id = ? ORDER BY created_at DESC, id DESC",
                &[tenant_id.into()],
            )
            .await?;
        Ok(rows.iter().map(from_row).collect())
    }

    /// `get` (service-principal-store.ts:141-147): a single principal by id
    /// within a tenant, or `None`.
    pub async fn get(
        &self,
        tenant_id: &str,
        id: &str,
    ) -> Result<Option<ServicePrincipalRecord>, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT * FROM service_principals WHERE tenant_id = ? AND id = ?",
                &[tenant_id.into(), id.into()],
            )
            .await?;
        Ok(row.as_ref().map(from_row))
    }

    /// `revoke` (service-principal-store.ts:154-160). Revoke a principal by id.
    /// Idempotent: `true` when an active row was revoked, `false` when the id is
    /// unknown or already revoked. Tenant-scoped, so one tenant cannot revoke
    /// another's principal. `now_ms` stamps `revoked_at`.
    pub async fn revoke(&self, tenant_id: &str, id: &str, now_ms: i64) -> Result<bool, StoreError> {
        let result = self
            .sql
            .run(
                "UPDATE service_principals SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL",
                &[iso_from_epoch_ms(now_ms).into(), tenant_id.into(), id.into()],
            )
            .await?;
        Ok(result.changes > 0)
    }
}

fn random_b64url<R: PrincipalRng>(rng: &mut R, len: usize) -> String {
    let mut bytes = vec![0u8; len];
    rng.fill(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `normalizeScopes` (service-principal-store.ts:163-165): trim each scope, drop
/// empties, dedupe, and SORT. The dedupe-then-sort order matches the TS
/// `[...new Set(...)].sort()`.
fn normalize_scopes(scopes: &[String]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for scope in scopes {
        let trimmed = scope.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !seen.iter().any(|existing| existing == trimmed) {
            seen.push(trimmed.to_owned());
        }
    }
    seen.sort();
    seen
}

/// `JSON.stringify(scopes)` for a string array — a compact JSON array. Built by
/// hand so the encoding is byte-identical to `JSON.stringify` (no spaces, and
/// `serde_json` escapes the same set of characters).
fn serialize_scopes(scopes: &[String]) -> String {
    serde_json::to_string(scopes).unwrap_or_else(|_| "[]".to_owned())
}

/// `parseScopes` (service-principal-store.ts:179-186): JSON-parse the stored
/// scopes array, keeping only string elements; any parse failure or non-array
/// yields `[]`.
fn parse_scopes(raw: &str) -> Vec<String> {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::Array(items)) => items
            .into_iter()
            .filter_map(|value| match value {
                serde_json::Value::String(text) => Some(text),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// `fromRow` (service-principal-store.ts:167-177): `SELECT *` row → record
/// (sans key hash). A NULL `revoked_at` becomes `None` (the TS omits the key).
fn from_row(row: &SqlRow) -> ServicePrincipalRecord {
    ServicePrincipalRecord {
        id: row.text("id").unwrap_or_default().to_owned(),
        key_id: row.text("key_id").unwrap_or_default().to_owned(),
        tenant_id: row.text("tenant_id").unwrap_or_default().to_owned(),
        name: row.text("name").unwrap_or_default().to_owned(),
        scopes: parse_scopes(row.text("scopes").unwrap_or("[]")),
        created_at: row.text("created_at").unwrap_or_default().to_owned(),
        revoked_at: row.text("revoked_at").map(str::to_owned),
    }
}

/// `keyIdFromApiKey` (service-principal-store.ts:188-194): the substring before
/// the first `.`, which must be at index > 0. `None` when there is no `.` or it
/// is the leading character.
fn key_id_from_api_key(api_key: &str) -> Option<&str> {
    match api_key.find('.') {
        Some(dot) if dot > 0 => Some(&api_key[..dot]),
        _ => None,
    }
}

/// `hashKey` (service-principal-store.ts:196-198): `base64url(sha256(api_key))`
/// over the UTF-8 bytes of the FULL key (prefix included).
fn hash_key(api_key: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(api_key.as_bytes()))
}

/// `constantTimeEquals` (service-principal-store.ts:200-207): length check, then
/// a constant-time byte compare (`subtle::ConstantTimeEq`, the Rust analogue of
/// `timingSafeEqual` on equal-length buffers).
fn constant_time_equals(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    // The effective post-migration-0019 SQLite schema for `service_principals`
    // (map 03 §5).
    const SCHEMA: &str = "
        CREATE TABLE service_principals (
          id TEXT PRIMARY KEY NOT NULL,
          key_id TEXT NOT NULL UNIQUE,
          key_hash TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT '_default',
          name TEXT NOT NULL,
          scopes TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          revoked_at TEXT
        );
        CREATE INDEX idx_service_principals_tenant ON service_principals (tenant_id, created_at DESC);";

    const NOW: i64 = 1_700_000_000_123;

    /// A deterministic RNG seam: hands out bytes from a fixed buffer, cycling so
    /// each `issue` produces stable, distinct-by-counter material.
    struct SeqRng {
        next: u8,
    }

    impl SeqRng {
        fn new(seed: u8) -> Self {
            Self { next: seed }
        }
    }

    impl PrincipalRng for SeqRng {
        fn fill(&mut self, dest: &mut [u8]) {
            for byte in dest.iter_mut() {
                *byte = self.next;
                self.next = self.next.wrapping_add(1);
            }
        }
    }

    async fn store() -> ServicePrincipalStore {
        let sql = Arc::new(SqlDriver::open_sqlite(":memory:").unwrap());
        sql.exec(SCHEMA).await.unwrap();
        ServicePrincipalStore::new(sql)
    }

    fn input(tenant: &str, name: &str, scopes: &[&str]) -> IssueServicePrincipalInput {
        IssueServicePrincipalInput {
            tenant_id: tenant.to_owned(),
            name: name.to_owned(),
            scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    // ── Port of service-principals.test.ts (store-lifecycle describe block) ──

    /// "issues a key, returns it once, and never stores the plaintext".
    #[tokio::test]
    async fn issues_a_key_and_never_stores_the_plaintext() {
        let store = store().await;
        let mut rng = SeqRng::new(1);
        let issued = store
            .issue(
                &input(
                    "_default",
                    "ci-deploy-bot",
                    &["object.read", "stream.append"],
                ),
                &mut rng,
                NOW,
            )
            .await
            .unwrap();

        assert!(issued.api_key.contains('.'));
        assert!(issued.key_id.starts_with("sk_"));
        assert!(issued.id.starts_with("sp_"));
        assert!(issued.api_key.starts_with(&issued.key_id));
        // Already-sorted input round-trips unchanged.
        assert_eq!(issued.scopes, ["object.read", "stream.append"]);

        // The plaintext key (and the secret half) must not be persisted.
        let secret = issued.api_key.split('.').nth(1).unwrap();
        let store2 = &store;
        let row = store2
            .sql
            .get(
                "SELECT * FROM service_principals WHERE id = ?",
                &[issued.id.as_str().into()],
            )
            .await
            .unwrap()
            .unwrap();
        let key_hash = row.text("key_hash").unwrap();
        assert!(!key_hash.is_empty());
        assert_ne!(key_hash, issued.api_key);
        assert!(!key_hash.contains(secret));
        // The stored hash is base64url(sha256(full apiKey)).
        assert_eq!(key_hash, hash_key(&issued.api_key));
    }

    /// "authenticates a valid key into a tenant-scoped service principal record".
    #[tokio::test]
    async fn authenticates_a_valid_key() {
        let store = store().await;
        let mut rng = SeqRng::new(7);
        let issued = store
            .issue(&input("tenant-a", "bot", &["object.read"]), &mut rng, NOW)
            .await
            .unwrap();

        let record = store.authenticate(&issued.api_key).await.unwrap().unwrap();
        assert_eq!(record.id, issued.id);
        assert_eq!(record.tenant_id, "tenant-a");
        assert_eq!(record.scopes, ["object.read"]);
        assert_eq!(record.revoked_at, None);
    }

    /// "rejects an unknown or tampered key".
    #[tokio::test]
    async fn rejects_unknown_or_tampered_keys() {
        let store = store().await;
        let mut rng = SeqRng::new(3);
        let issued = store
            .issue(&input("_default", "bot", &[]), &mut rng, NOW)
            .await
            .unwrap();

        // Unknown key_id.
        assert!(
            store
                .authenticate("sk_nope.invalid")
                .await
                .unwrap()
                .is_none()
        );
        // Known key_id, wrong secret.
        assert!(
            store
                .authenticate(&format!("{}.wrongsecret", issued.key_id))
                .await
                .unwrap()
                .is_none()
        );
        // No `.` at all ⇒ no key_id ⇒ rejected before any lookup.
        assert!(store.authenticate("not-a-key").await.unwrap().is_none());
        // Leading `.` ⇒ dot at index 0 ⇒ no key_id.
        assert!(store.authenticate(".secret").await.unwrap().is_none());
    }

    /// "revokes a key so it no longer authenticates (idempotent)".
    #[tokio::test]
    async fn revoke_stops_authentication_and_is_idempotent() {
        let store = store().await;
        let mut rng = SeqRng::new(9);
        let issued = store
            .issue(&input("tenant-r", "bot", &["object.read"]), &mut rng, NOW)
            .await
            .unwrap();
        assert!(store.authenticate(&issued.api_key).await.unwrap().is_some());

        assert!(store.revoke("tenant-r", &issued.id, NOW).await.unwrap());
        assert!(store.authenticate(&issued.api_key).await.unwrap().is_none());
        // Second revoke is a no-op.
        assert!(!store.revoke("tenant-r", &issued.id, NOW).await.unwrap());
    }

    /// "scopes list/revoke per tenant — one tenant cannot revoke another's".
    #[tokio::test]
    async fn list_and_revoke_are_tenant_scoped() {
        let store = store().await;
        let mut rng = SeqRng::new(40);
        let a = store
            .issue(&input("ta", "a", &[]), &mut rng, NOW)
            .await
            .unwrap();
        store
            .issue(&input("tb", "b", &[]), &mut rng, NOW)
            .await
            .unwrap();

        let list_a: Vec<String> = store
            .list("ta")
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(list_a, std::slice::from_ref(&a.id));

        // Wrong-tenant revoke does nothing; the key still authenticates.
        assert!(!store.revoke("tb", &a.id, NOW).await.unwrap());
        assert!(store.authenticate(&a.api_key).await.unwrap().is_some());
    }

    // ── normalizeScopes semantics (trim / drop-empty / dedupe / sort) ────────

    #[tokio::test]
    async fn issue_normalizes_scopes_trim_dropempty_dedupe_sort() {
        let store = store().await;
        let mut rng = SeqRng::new(50);
        let issued = store
            .issue(
                &input(
                    "_default",
                    "bot",
                    &[
                        "  stream.append ",
                        "object.read",
                        "object.read",
                        "",
                        "  ",
                        "a.b",
                    ],
                ),
                &mut rng,
                NOW,
            )
            .await
            .unwrap();
        // Trimmed, empties dropped, deduped, and sorted ascending.
        assert_eq!(issued.scopes, ["a.b", "object.read", "stream.append"]);

        // The stored JSON array reflects the normalized order exactly.
        let row = store
            .sql
            .get(
                "SELECT scopes FROM service_principals WHERE id = ?",
                &[issued.id.as_str().into()],
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            row.text("scopes").unwrap(),
            r#"["a.b","object.read","stream.append"]"#
        );

        // And authenticate round-trips the same parsed scopes.
        let record = store.authenticate(&issued.api_key).await.unwrap().unwrap();
        assert_eq!(record.scopes, ["a.b", "object.read", "stream.append"]);
    }

    // ── list ordering: created_at DESC, then id DESC ─────────────────────────

    #[tokio::test]
    async fn list_orders_created_at_desc_then_id_desc() {
        let store = store().await;
        let mut rng = SeqRng::new(60);
        // Two principals share a created_at ⇒ tie broken by id DESC; a newer
        // principal sorts first (created_at DESC).
        let older_a = store
            .issue(&input("t", "older-a", &[]), &mut rng, NOW)
            .await
            .unwrap();
        let older_b = store
            .issue(&input("t", "older-b", &[]), &mut rng, NOW)
            .await
            .unwrap();
        let newer = store
            .issue(&input("t", "newer", &[]), &mut rng, NOW + 1_000)
            .await
            .unwrap();

        let ids: Vec<String> = store
            .list("t")
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        // newest first, then id DESC for the NOW tie.
        let (hi, lo) = if older_a.id > older_b.id {
            (older_a.id.clone(), older_b.id.clone())
        } else {
            (older_b.id.clone(), older_a.id.clone())
        };
        assert_eq!(ids, [newer.id.clone(), hi, lo]);
    }

    // ── get fetches by (tenant, id) and exposes revoked_at after revocation ──

    #[tokio::test]
    async fn get_is_tenant_scoped_and_reflects_revocation() {
        let store = store().await;
        let mut rng = SeqRng::new(70);
        let issued = store
            .issue(&input("t1", "bot", &["x"]), &mut rng, NOW)
            .await
            .unwrap();

        assert!(store.get("t2", &issued.id).await.unwrap().is_none());
        let active = store.get("t1", &issued.id).await.unwrap().unwrap();
        assert_eq!(active.revoked_at, None);

        store.revoke("t1", &issued.id, NOW + 5).await.unwrap();
        let revoked = store.get("t1", &issued.id).await.unwrap().unwrap();
        assert_eq!(revoked.revoked_at, Some(iso_from_epoch_ms(NOW + 5)));
    }

    // ── pure-helper coverage ─────────────────────────────────────────────────

    #[test]
    fn key_id_parsing_requires_dot_at_index_gt_zero() {
        assert_eq!(key_id_from_api_key("sk_abc.secret"), Some("sk_abc"));
        assert_eq!(key_id_from_api_key("a.b.c"), Some("a"));
        assert_eq!(key_id_from_api_key("no-dot"), None);
        assert_eq!(key_id_from_api_key(".leading"), None);
        assert_eq!(key_id_from_api_key(""), None);
    }

    #[test]
    fn hash_key_matches_node_base64url_sha256() {
        // Reference vector from Node:
        //   createHash("sha256").update("sk_abc.thesecret","utf8").digest("base64url")
        assert_eq!(
            hash_key("sk_abc.thesecret"),
            "u05iqPUEJ_tk6dN5SJh74_pZ1pnjoRik9YWROeY0Lpo"
        );
    }

    #[test]
    fn constant_time_equals_matches_on_content_only() {
        assert!(constant_time_equals("abc", "abc"));
        assert!(!constant_time_equals("abc", "abd"));
        assert!(!constant_time_equals("abc", "abcd"));
    }
}
