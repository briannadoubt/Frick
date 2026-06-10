//! Refresh-token store (`apps/server/src/storage/refresh-token-store.ts`,
//! map 03 §9.5, FR-33).
//!
//! A refresh token is a long-lived, opaque, high-entropy credential the client
//! exchanges for a fresh short-lived access token (an `auth_sessions` row).
//! Like reset tokens, only the SHA-256 hash (base64url) hits the DB. Tokens
//! carry the `(tenant_id, user_id, device_id, replica_id)` tuple so the
//! refresh endpoint can mint a session bound to the same device/replica.
//!
//! # Rotation & reuse detection (auth-core-3)
//!
//! Every token in a rotation lineage shares a `family_id` (seeded by `issue`,
//! carried forward on each [`RefreshTokenStore::rotate`]). Replaying an
//! ALREADY-revoked token is the theft signal: `rotate` revokes the ENTIRE
//! family and returns `None`, forcing a full re-login. A token with a NULL
//! `family_id` (issued before migration 0024) falls back to single-token
//! revocation.
//!
//! # Determinism (map "Determinism rule")
//!
//! The store never reads the system clock OR a random source. The caller
//! injects the raw token, the `family_id` (at `issue`), the fresh token (at
//! `rotate`), and `now_ms`. The facade passes
//! `randomBytes(32)`/`randomBytes(16)` base64url values + system time; tests
//! pass fixed values. Hashes are pure functions of the token.

use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

use crate::driver::SqlDriver;
use crate::error::StoreError;
use crate::stores::blob_bytes::iso_from_epoch_ms;

/// The default refresh-token lifetime in seconds (refresh-token-store.ts:71,
/// `ttlSeconds ?? 30 * 24 * 60 * 60`) — 30 days.
pub const DEFAULT_REFRESH_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;

/// A freshly-issued (or rotated) refresh token (`IssuedRefreshToken`,
/// refresh-token-store.ts:25-33). `token` is the opaque value handed to the
/// client — only its hash is stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedRefreshToken {
    pub token: String,
    pub tenant_id: String,
    pub user_id: String,
    pub device_id: String,
    pub replica_id: String,
    pub expires_at: String,
}

/// A resolved active refresh token (`RefreshTokenRecord`,
/// refresh-token-store.ts:35-41).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshTokenRecord {
    pub tenant_id: String,
    pub user_id: String,
    pub device_id: String,
    pub replica_id: String,
    pub expires_at: String,
}

/// `RefreshTokenStore` (`storage/refresh-token-store.ts`).
pub struct RefreshTokenStore {
    sql: Arc<SqlDriver>,
}

impl RefreshTokenStore {
    #[must_use]
    pub fn new(sql: Arc<SqlDriver>) -> Self {
        Self { sql }
    }

    /// `issue` (refresh-token-store.ts:64-100): INSERT a fresh refresh token
    /// for `(tenant, user, device, replica)`, seeding a new rotation
    /// `family_id`. `expires_at = now_ms + ttl_seconds*1000`. Determinism: the
    /// raw `token` and `family_id` are injected by the caller.
    #[allow(clippy::too_many_arguments)] // mirrors the TS issue() argument shape
    pub async fn issue(
        &self,
        token: &str,
        family_id: &str,
        tenant_id: &str,
        user_id: &str,
        device_id: &str,
        replica_id: &str,
        ttl_seconds: i64,
        now_ms: i64,
    ) -> Result<IssuedRefreshToken, StoreError> {
        let now_iso = iso_from_epoch_ms(now_ms);
        let expires_at = iso_from_epoch_ms(now_ms + ttl_seconds * 1_000);
        self.sql
            .run(
                "INSERT INTO auth_refresh_tokens
                    (token_hash, tenant_id, user_id, device_id, replica_id, created_at, expires_at, revoked_at, family_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
                &[
                    hash_token(token).into(),
                    tenant_id.into(),
                    user_id.into(),
                    device_id.into(),
                    replica_id.into(),
                    now_iso.as_str().into(),
                    expires_at.as_str().into(),
                    family_id.into(),
                ],
            )
            .await?;
        Ok(IssuedRefreshToken {
            token: token.to_owned(),
            tenant_id: tenant_id.to_owned(),
            user_id: user_id.to_owned(),
            device_id: device_id.to_owned(),
            replica_id: replica_id.to_owned(),
            expires_at,
        })
    }

    /// `readActive` (refresh-token-store.ts:107-119): resolve a token to its
    /// record, or `None` when unknown, revoked (`revoked_at IS NOT NULL`), or
    /// expired (`Date.parse(expires_at) <= now_ms`). Never mutates.
    pub async fn read_active(
        &self,
        token: &str,
        now_ms: i64,
    ) -> Result<Option<RefreshTokenRecord>, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT * FROM auth_refresh_tokens WHERE token_hash = ?",
                &[hash_token(token).into()],
            )
            .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        if row.text("revoked_at").is_some() {
            return Ok(None);
        }
        let expires_at = row.text("expires_at").unwrap_or_default();
        if let Some(expires_ms) = parse_iso_to_epoch_ms(expires_at)
            && expires_ms <= now_ms
        {
            return Ok(None);
        }
        Ok(Some(record_from_row(&row)))
    }

    /// `rotate` (refresh-token-store.ts:134-190). In ONE transaction:
    ///
    /// - row missing ⇒ `None`;
    /// - **already revoked ⇒ reuse signal**: revoke the ENTIRE family
    ///   (`WHERE family_id = ? AND revoked_at IS NULL`; a NULL `family_id`
    ///   falls back to single-token — here a no-op, since the presented row is
    ///   already revoked) and return `None`;
    /// - expired (`Date.parse(expires_at) <= now_ms`) ⇒ `None`;
    /// - else revoke the presented token and INSERT a fresh token inheriting
    ///   the presented token's `(tenant, user, device, replica, family_id)`,
    ///   returning it.
    ///
    /// Determinism: the `fresh_token` is injected by the caller.
    pub async fn rotate(
        &self,
        token: &str,
        fresh_token: &str,
        ttl_seconds: i64,
        now_ms: i64,
    ) -> Result<Option<IssuedRefreshToken>, StoreError> {
        let presented_hash = hash_token(token);
        let fresh_hash = hash_token(fresh_token);
        let now_iso = iso_from_epoch_ms(now_ms);
        let expires_at = iso_from_epoch_ms(now_ms + ttl_seconds * 1_000);
        let fresh_token_owned = fresh_token.to_string();

        self.sql
            .transaction(move |tx| {
                Box::pin(async move {
                    let row = tx
                        .get(
                            "SELECT * FROM auth_refresh_tokens WHERE token_hash = ?",
                            &[presented_hash.as_str().into()],
                        )
                        .await?;
                    let Some(row) = row else {
                        return Ok(None);
                    };
                    let family_id = row.text("family_id").map(str::to_owned);

                    // Reuse detection: an already-revoked token presented for
                    // rotation means a previously-rotated (possibly stolen)
                    // token is being replayed — burn the whole family.
                    if row.text("revoked_at").is_some() {
                        if let Some(family_id) = family_id.as_deref() {
                            tx.run(
                                "UPDATE auth_refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
                                &[now_iso.as_str().into(), family_id.into()],
                            )
                            .await?;
                        }
                        return Ok(None);
                    }

                    let expires_at_text = row.text("expires_at").unwrap_or_default();
                    if let Some(expires_ms) = parse_iso_to_epoch_ms(expires_at_text)
                        && expires_ms <= now_ms
                    {
                        return Ok(None);
                    }

                    // Revoke the presented token, then issue the fresh one
                    // inheriting the lineage.
                    tx.run(
                        "UPDATE auth_refresh_tokens SET revoked_at = ? WHERE token_hash = ?",
                        &[now_iso.as_str().into(), presented_hash.as_str().into()],
                    )
                    .await?;

                    let tenant_id = row.text("tenant_id").unwrap_or_default().to_owned();
                    let user_id = row.text("user_id").unwrap_or_default().to_owned();
                    let device_id = row.text("device_id").unwrap_or_default().to_owned();
                    let replica_id = row.text("replica_id").unwrap_or_default().to_owned();

                    tx.run(
                        "INSERT INTO auth_refresh_tokens
                            (token_hash, tenant_id, user_id, device_id, replica_id, created_at, expires_at, revoked_at, family_id)
                            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
                        &[
                            fresh_hash.as_str().into(),
                            tenant_id.as_str().into(),
                            user_id.as_str().into(),
                            device_id.as_str().into(),
                            replica_id.as_str().into(),
                            now_iso.as_str().into(),
                            expires_at.as_str().into(),
                            // family_id inherited verbatim (NULL stays NULL).
                            family_id.clone().into(),
                        ],
                    )
                    .await?;

                    Ok(Some(IssuedRefreshToken {
                        token: fresh_token_owned,
                        tenant_id,
                        user_id,
                        device_id,
                        replica_id,
                        expires_at,
                    }))
                })
            })
            .await
    }

    /// `revoke` (refresh-token-store.ts:197-203): revoke a single token by its
    /// raw value, guarded `AND revoked_at IS NULL`. Returns `true` when an
    /// active row was revoked, `false` when unknown or already revoked —
    /// idempotent.
    pub async fn revoke(&self, token: &str, now_ms: i64) -> Result<bool, StoreError> {
        let result = self
            .sql
            .run(
                "UPDATE auth_refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
                &[iso_from_epoch_ms(now_ms).into(), hash_token(token).into()],
            )
            .await?;
        Ok(result.changes > 0)
    }

    /// `revokeForUser` (refresh-token-store.ts:211-225): revoke every active
    /// refresh token for `user_id`, optionally scoped to a single tenant.
    /// Returns the number of rows revoked. `tenant_id = None` revokes across
    /// all tenants.
    pub async fn revoke_for_user(
        &self,
        user_id: &str,
        tenant_id: Option<&str>,
        now_ms: i64,
    ) -> Result<u64, StoreError> {
        let now_iso = iso_from_epoch_ms(now_ms);
        let result = match tenant_id {
            Some(tenant) => {
                self.sql
                    .run(
                        "UPDATE auth_refresh_tokens SET revoked_at = ? WHERE user_id = ? AND tenant_id = ? AND revoked_at IS NULL",
                        &[now_iso.as_str().into(), user_id.into(), tenant.into()],
                    )
                    .await?
            }
            None => {
                self.sql
                    .run(
                        "UPDATE auth_refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
                        &[now_iso.as_str().into(), user_id.into()],
                    )
                    .await?
            }
        };
        Ok(result.changes)
    }

    /// `purgeExpired` (refresh-token-store.ts:228-234): delete tokens whose
    /// `expires_at < now_iso`. Returns the number of rows removed.
    pub async fn purge_expired(&self, now_ms: i64) -> Result<u64, StoreError> {
        let result = self
            .sql
            .run(
                "DELETE FROM auth_refresh_tokens WHERE expires_at < ?",
                &[iso_from_epoch_ms(now_ms).into()],
            )
            .await?;
        Ok(result.changes)
    }
}

/// `fromRow` (refresh-token-store.ts:237-245): `SELECT *` row →
/// [`RefreshTokenRecord`].
fn record_from_row(row: &crate::driver::SqlRow) -> RefreshTokenRecord {
    RefreshTokenRecord {
        tenant_id: row.text("tenant_id").unwrap_or_default().to_owned(),
        user_id: row.text("user_id").unwrap_or_default().to_owned(),
        device_id: row.text("device_id").unwrap_or_default().to_owned(),
        replica_id: row.text("replica_id").unwrap_or_default().to_owned(),
        expires_at: row.text("expires_at").unwrap_or_default().to_owned(),
    }
}

/// `hashToken` (refresh-token-store.ts:247-249): SHA-256 **base64url** of the
/// UTF-8 token (URL-safe alphabet, no padding).
#[must_use]
fn hash_token(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}

/// `Date.parse(expires_at)` for the canonical `YYYY-MM-DDTHH:mm:ss.sssZ` form.
/// `None` on any deviation — the caller treats that as TS's `NaN`, where `NaN
/// <= now` is `false` (so an unparseable expiry leaves the token active).
fn parse_iso_to_epoch_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() != 24 {
        return None;
    }
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
    {
        return None;
    }
    let year = parse_digits(&bytes[0..4])?;
    let month = parse_digits(&bytes[5..7])?;
    let day = parse_digits(&bytes[8..10])?;
    let hour = parse_digits(&bytes[11..13])?;
    let minute = parse_digits(&bytes[14..16])?;
    let second = parse_digits(&bytes[17..19])?;
    let millis = parse_digits(&bytes[20..23])?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millis)
}

fn parse_digits(bytes: &[u8]) -> Option<i64> {
    let mut value: i64 = 0;
    for &byte in bytes {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + i64::from(byte - b'0');
    }
    Some(value)
}

/// Proleptic-Gregorian (year, month, day) → days since the Unix epoch (Howard
/// Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    // The effective post-0018 + 0024 `auth_refresh_tokens` (map 03 §5; no
    // app_id column, family_id nullable).
    const SCHEMA: &str = "
        CREATE TABLE auth_refresh_tokens (
          token_hash TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT '_default',
          user_id TEXT NOT NULL,
          device_id TEXT NOT NULL,
          replica_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          family_id TEXT
        );";

    // 2023-11-14T22:13:20.123Z.
    const NOW: i64 = 1_700_000_000_123;

    async fn store() -> RefreshTokenStore {
        let sql = Arc::new(SqlDriver::open_sqlite(":memory:").unwrap());
        sql.exec(SCHEMA).await.unwrap();
        RefreshTokenStore::new(sql)
    }

    async fn issue(store: &RefreshTokenStore, token: &str, family: &str, now_ms: i64) {
        store
            .issue(
                token,
                family,
                "t1",
                "u1",
                "d1",
                "r1",
                DEFAULT_REFRESH_TTL_SECONDS,
                now_ms,
            )
            .await
            .unwrap();
    }

    #[test]
    fn hash_token_is_sha256_base64url_no_pad() {
        assert_eq!(
            hash_token("hello"),
            "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ"
        );
    }

    #[tokio::test]
    async fn issue_stores_only_the_hash_and_computes_30d_expiry() {
        let store = store().await;
        let issued = store
            .issue(
                "tok-1",
                "fam-1",
                "t1",
                "u1",
                "d1",
                "r1",
                DEFAULT_REFRESH_TTL_SECONDS,
                NOW,
            )
            .await
            .unwrap();
        assert_eq!(
            issued,
            IssuedRefreshToken {
                token: "tok-1".to_owned(),
                tenant_id: "t1".to_owned(),
                user_id: "u1".to_owned(),
                device_id: "d1".to_owned(),
                replica_id: "r1".to_owned(),
                expires_at: iso_from_epoch_ms(NOW + 30 * 24 * 60 * 60 * 1_000),
            }
        );

        let row = store
            .sql
            .get("SELECT * FROM auth_refresh_tokens", &[])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.text("token_hash"), Some(hash_token("tok-1").as_str()));
        assert_eq!(row.text("family_id"), Some("fam-1"));
        assert!(row.text("revoked_at").is_none());
    }

    // ── readActive ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn read_active_none_when_unknown_revoked_or_expired() {
        let store = store().await;
        // Unknown.
        assert!(store.read_active("nope", NOW).await.unwrap().is_none());

        issue(&store, "tok", "fam", NOW).await;
        // Active.
        assert!(
            store
                .read_active("tok", NOW + 1_000)
                .await
                .unwrap()
                .is_some()
        );
        // Expired.
        let after_ttl = NOW + DEFAULT_REFRESH_TTL_SECONDS * 1_000 + 1;
        assert!(store.read_active("tok", after_ttl).await.unwrap().is_none());

        // Revoked.
        assert!(store.revoke("tok", NOW + 2_000).await.unwrap());
        assert!(
            store
                .read_active("tok", NOW + 3_000)
                .await
                .unwrap()
                .is_none()
        );
    }

    // ── Port of audit-auth-storage.test.ts auth-core-3 ──────────────────────

    #[tokio::test]
    async fn revokes_entire_family_when_already_rotated_token_is_replayed() {
        let store = store().await;
        issue(&store, "first", "fam", NOW).await;

        // Legit rotation: first -> second -> third (same family).
        let second = store
            .rotate("first", "second", DEFAULT_REFRESH_TTL_SECONDS, NOW + 1_000)
            .await
            .unwrap();
        assert!(second.is_some());
        let third = store
            .rotate("second", "third", DEFAULT_REFRESH_TTL_SECONDS, NOW + 2_000)
            .await
            .unwrap();
        assert!(third.is_some());
        // The current (third) token is live.
        assert!(
            store
                .read_active("third", NOW + 3_000)
                .await
                .unwrap()
                .is_some()
        );

        // Reuse the ALREADY-rotated `first` token: theft signal. It fails AND
        // burns the whole family, including the otherwise-live `third`.
        let reuse = store
            .rotate("first", "nope", DEFAULT_REFRESH_TTL_SECONDS, NOW + 4_000)
            .await
            .unwrap();
        assert!(reuse.is_none());

        // The live descendant is now revoked too (family burned).
        assert!(
            store
                .read_active("third", NOW + 5_000)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .rotate("third", "nope2", DEFAULT_REFRESH_TTL_SECONDS, NOW + 6_000)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn single_rotation_issues_a_usable_fresh_token() {
        let store = store().await;
        issue(&store, "issued", "fam", NOW).await;
        let rotated = store
            .rotate("issued", "fresh", DEFAULT_REFRESH_TTL_SECONDS, NOW + 1_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(rotated.token, "fresh");
        assert_ne!(rotated.token, "issued");
        // The fresh token is live; the old one is dead.
        assert!(
            store
                .read_active("fresh", NOW + 2_000)
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            store
                .read_active("issued", NOW + 2_000)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn rotate_inherits_family_and_identity() {
        let store = store().await;
        issue(&store, "issued", "fam-xyz", NOW).await;
        let rotated = store
            .rotate("issued", "fresh", DEFAULT_REFRESH_TTL_SECONDS, NOW + 1_000)
            .await
            .unwrap()
            .unwrap();
        // Inherits the identity tuple.
        assert_eq!(rotated.tenant_id, "t1");
        assert_eq!(rotated.user_id, "u1");
        assert_eq!(rotated.device_id, "d1");
        assert_eq!(rotated.replica_id, "r1");
        // The fresh row carries the inherited family_id.
        let row = store
            .sql
            .get(
                "SELECT family_id FROM auth_refresh_tokens WHERE token_hash = ?",
                &[hash_token("fresh").into()],
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.text("family_id"), Some("fam-xyz"));
    }

    #[tokio::test]
    async fn rotate_returns_none_for_unknown_or_expired() {
        let store = store().await;
        // Unknown.
        assert!(
            store
                .rotate("nope", "fresh", DEFAULT_REFRESH_TTL_SECONDS, NOW)
                .await
                .unwrap()
                .is_none()
        );
        // Expired.
        issue(&store, "tok", "fam", NOW).await;
        let after_ttl = NOW + DEFAULT_REFRESH_TTL_SECONDS * 1_000 + 1;
        assert!(
            store
                .rotate("tok", "fresh", DEFAULT_REFRESH_TTL_SECONDS, after_ttl)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn null_family_reuse_falls_back_to_single_token() {
        let store = store().await;
        // Pre-0024 token: NULL family_id. Issue then revoke it directly.
        store
            .sql
            .run(
                "INSERT INTO auth_refresh_tokens
                    (token_hash, tenant_id, user_id, device_id, replica_id, created_at, expires_at, revoked_at, family_id)
                    VALUES (?, 't1', 'u1', 'd1', 'r1', ?, ?, ?, NULL)",
                &[
                    hash_token("legacy").into(),
                    iso_from_epoch_ms(NOW).into(),
                    iso_from_epoch_ms(NOW + DEFAULT_REFRESH_TTL_SECONDS * 1_000).into(),
                    iso_from_epoch_ms(NOW + 500).into(),
                ],
            )
            .await
            .unwrap();
        // Replaying an already-revoked NULL-family token: reuse signal returns
        // None, family fallback is a single-token no-op (nothing else to burn).
        assert!(
            store
                .rotate("legacy", "fresh", DEFAULT_REFRESH_TTL_SECONDS, NOW + 1_000)
                .await
                .unwrap()
                .is_none()
        );
    }

    // ── revoke / revokeForUser / purgeExpired ───────────────────────────────

    #[tokio::test]
    async fn revoke_is_idempotent() {
        let store = store().await;
        issue(&store, "tok", "fam", NOW).await;
        assert!(store.revoke("tok", NOW + 1_000).await.unwrap());
        // Second revoke is a no-op (already revoked).
        assert!(!store.revoke("tok", NOW + 2_000).await.unwrap());
        // Unknown token is also a no-op.
        assert!(!store.revoke("nope", NOW + 2_000).await.unwrap());
    }

    #[tokio::test]
    async fn revoke_for_user_counts_active_only_and_scopes_by_tenant() {
        let store = store().await;
        // u1: two active in t1, one in t2; u2: one in t1.
        for (token, tenant, user) in [
            ("a", "t1", "u1"),
            ("b", "t1", "u1"),
            ("c", "t2", "u1"),
            ("d", "t1", "u2"),
        ] {
            store
                .issue(
                    token,
                    "fam",
                    tenant,
                    user,
                    "d1",
                    "r1",
                    DEFAULT_REFRESH_TTL_SECONDS,
                    NOW,
                )
                .await
                .unwrap();
        }
        // Tenant-scoped: u1's two t1 tokens.
        assert_eq!(
            store
                .revoke_for_user("u1", Some("t1"), NOW + 1_000)
                .await
                .unwrap(),
            2
        );
        // Already-revoked rows aren't re-counted; only u1's t2 token remains
        // active for u1.
        assert_eq!(
            store
                .revoke_for_user("u1", None, NOW + 2_000)
                .await
                .unwrap(),
            1
        );
        // u2 untouched.
        assert!(store.read_active("d", NOW + 3_000).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn purge_expired_deletes_strictly_before_now() {
        let store = store().await;
        issue(&store, "tok", "fam", NOW).await;
        let expiry = NOW + DEFAULT_REFRESH_TTL_SECONDS * 1_000;
        // At expiry boundary: `expires_at < now` is false ⇒ nothing purged.
        assert_eq!(store.purge_expired(expiry).await.unwrap(), 0);
        // Just past: purged.
        assert_eq!(store.purge_expired(expiry + 1).await.unwrap(), 1);
    }
}
