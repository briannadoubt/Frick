//! Password-reset token store
//! (`apps/server/src/storage/password-reset-store.ts`, map 03 §9.4).
//!
//! The email password-reset token is opaque, high-entropy random bytes; only
//! its SHA-256 hash (base64url) hits the DB, so a leaked snapshot can't be
//! used to mint reset emails. Tokens are one-shot: [`PasswordResetTokenStore::consume`]
//! validates and marks the row consumed inside a single transaction, so two
//! concurrent confirms with the same token can't both succeed (auth-core-8).
//!
//! # Determinism (map "Determinism rule")
//!
//! The store never reads the system clock OR a random source. The caller
//! supplies the raw token and `now_ms` to [`PasswordResetTokenStore::issue`];
//! the facade passes a CSPRNG token + system time, tests pass fixed values.
//! The hash is a pure function of the token. `created_at`/`expires_at`/
//! `consumed_at` are derived from `now_ms` via [`iso_from_epoch_ms`].

use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

use crate::driver::SqlDriver;
use crate::error::StoreError;
use crate::stores::blob_bytes::iso_from_epoch_ms;

/// The default reset-token lifetime in minutes (password-reset-store.ts:39,
/// `ttlMinutes ?? 60`).
pub const DEFAULT_RESET_TTL_MINUTES: i64 = 60;

/// A freshly-issued reset token (`IssuedResetToken`,
/// password-reset-store.ts:4-12). `token` is the opaque value the email link
/// carries — the only chance the caller has to read the raw token (the store
/// keeps only its hash).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedResetToken {
    pub token: String,
    pub tenant_id: String,
    pub user_id: String,
    pub expires_at: String,
}

/// The `(tenant, user)` tuple a successful [`PasswordResetTokenStore::consume`]
/// returns (`ConsumedResetTokenRow`, password-reset-store.ts:14-17).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsumedResetTokenRow {
    pub tenant_id: String,
    pub user_id: String,
}

/// `PasswordResetTokenStore` (`storage/password-reset-store.ts`).
pub struct PasswordResetTokenStore {
    sql: Arc<SqlDriver>,
}

impl PasswordResetTokenStore {
    #[must_use]
    pub fn new(sql: Arc<SqlDriver>) -> Self {
        Self { sql }
    }

    /// `issue` (password-reset-store.ts:34-69). In ONE transaction:
    /// mark every prior unconsumed token for `(tenant, user)` consumed, THEN
    /// insert the new row — enforcing single-outstanding-token-per-user
    /// (auth-core-8), so a previously-issued (possibly leaked) link stops
    /// verifying the moment a fresh reset is requested.
    ///
    /// Determinism: the raw `token` is injected by the caller (the facade
    /// passes `randomBytes(32).toString("base64url")`; tests pass fixed
    /// values). `now_ms` stamps `created_at`/`consumed_at`; `expires_at =
    /// now_ms + ttl_minutes*60_000`.
    pub async fn issue(
        &self,
        token: &str,
        tenant_id: &str,
        user_id: &str,
        ttl_minutes: i64,
        now_ms: i64,
    ) -> Result<IssuedResetToken, StoreError> {
        let token_hash = hash_token(token);
        let now_iso = iso_from_epoch_ms(now_ms);
        let expires_at = iso_from_epoch_ms(now_ms + ttl_minutes * 60_000);

        let tenant_id_owned = tenant_id.to_string();
        let user_id_owned = user_id.to_string();
        let now_for_tx = now_iso.clone();
        let expires_for_tx = expires_at.clone();
        self.sql
            .transaction(move |tx| {
                Box::pin(async move {
                    tx.run(
                        "UPDATE auth_password_reset_tokens
                            SET consumed_at = ?
                            WHERE tenant_id = ? AND user_id = ? AND consumed_at IS NULL",
                        &[
                            now_for_tx.as_str().into(),
                            tenant_id_owned.as_str().into(),
                            user_id_owned.as_str().into(),
                        ],
                    )
                    .await?;
                    tx.run(
                        "INSERT INTO auth_password_reset_tokens
                            (token_hash, tenant_id, user_id, created_at, expires_at, consumed_at)
                            VALUES (?, ?, ?, ?, ?, NULL)",
                        &[
                            token_hash.as_str().into(),
                            tenant_id_owned.as_str().into(),
                            user_id_owned.as_str().into(),
                            now_for_tx.as_str().into(),
                            expires_for_tx.as_str().into(),
                        ],
                    )
                    .await?;
                    Ok(())
                })
            })
            .await?;

        Ok(IssuedResetToken {
            token: token.to_owned(),
            tenant_id: tenant_id.to_owned(),
            user_id: user_id.to_owned(),
            expires_at,
        })
    }

    /// `consume` (password-reset-store.ts:77-103). In ONE transaction: look up
    /// the row by token hash; reject (return `None`) when missing, already
    /// consumed (`consumed_at IS NOT NULL`), or expired (`expires_at <
    /// now_iso`, a **lexicographic string compare** — valid because the
    /// canonical ISO form is chronological); otherwise set `consumed_at = now`
    /// and return the `(tenant, user)` tuple. Constant-time comparison is
    /// provided by the primary-key lookup on the hashed token.
    pub async fn consume(
        &self,
        token: &str,
        now_ms: i64,
    ) -> Result<Option<ConsumedResetTokenRow>, StoreError> {
        let token_hash = hash_token(token);
        let now_iso = iso_from_epoch_ms(now_ms);
        self.sql
            .transaction(move |tx| {
                Box::pin(async move {
                    let row = tx
                        .get(
                            "SELECT tenant_id, user_id, expires_at, consumed_at
                                 FROM auth_password_reset_tokens
                                 WHERE token_hash = ?",
                            &[token_hash.as_str().into()],
                        )
                        .await?;
                    let Some(row) = row else {
                        return Ok(None);
                    };
                    let consumed = row.text("consumed_at").is_some();
                    let expires_at = row.text("expires_at").unwrap_or_default();
                    // TS: `row.consumed_at !== null || row.expires_at < now`.
                    if consumed || expires_at < now_iso.as_str() {
                        return Ok(None);
                    }
                    let tenant_id = row.text("tenant_id").unwrap_or_default().to_owned();
                    let user_id = row.text("user_id").unwrap_or_default().to_owned();
                    tx.run(
                        "UPDATE auth_password_reset_tokens
                             SET consumed_at = ?
                             WHERE token_hash = ?",
                        &[now_iso.as_str().into(), token_hash.as_str().into()],
                    )
                    .await?;
                    Ok(Some(ConsumedResetTokenRow { tenant_id, user_id }))
                })
            })
            .await
    }

    /// `purgeExpired` (password-reset-store.ts:109-116): delete tokens whose
    /// `expires_at < now_iso`. Returns the number of rows removed.
    pub async fn purge_expired(&self, now_ms: i64) -> Result<u64, StoreError> {
        let now_iso = iso_from_epoch_ms(now_ms);
        let result = self
            .sql
            .run(
                "DELETE FROM auth_password_reset_tokens WHERE expires_at < ?",
                &[now_iso.as_str().into()],
            )
            .await?;
        Ok(result.changes)
    }
}

/// `hashToken` (password-reset-store.ts:119-121): SHA-256 **base64url** of the
/// UTF-8 token. base64url = URL-safe alphabet, no padding (Node's
/// `digest("base64url")`).
#[must_use]
fn hash_token(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The effective post-0016 `auth_password_reset_tokens` (map 03 §5; no
    // app_id column).
    const SCHEMA: &str = "
        CREATE TABLE auth_password_reset_tokens (
          token_hash TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT '_default',
          user_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT
        );";

    // 2023-11-14T22:13:20.123Z.
    const NOW: i64 = 1_700_000_000_123;

    async fn store() -> PasswordResetTokenStore {
        let sql = Arc::new(SqlDriver::open_sqlite(":memory:").unwrap());
        sql.exec(SCHEMA).await.unwrap();
        PasswordResetTokenStore::new(sql)
    }

    #[test]
    fn hash_token_is_sha256_base64url_no_pad() {
        // Vector from node
        // `createHash("sha256").update("hello").digest("base64url")`.
        assert_eq!(
            hash_token("hello"),
            "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ"
        );
    }

    #[tokio::test]
    async fn issue_returns_raw_token_and_computed_expiry() {
        let reset = store().await;
        let issued = reset
            .issue("tok-1", "t1", "u1", DEFAULT_RESET_TTL_MINUTES, NOW)
            .await
            .unwrap();
        assert_eq!(
            issued,
            IssuedResetToken {
                token: "tok-1".to_owned(),
                tenant_id: "t1".to_owned(),
                user_id: "u1".to_owned(),
                expires_at: iso_from_epoch_ms(NOW + 60 * 60_000),
            }
        );

        // Only the hash is stored — never the raw token.
        let row = reset
            .sql
            .get("SELECT * FROM auth_password_reset_tokens", &[])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.text("token_hash"), Some(hash_token("tok-1").as_str()));
        assert_eq!(
            row.text("created_at"),
            Some(iso_from_epoch_ms(NOW).as_str())
        );
        assert!(row.text("consumed_at").is_none());
    }

    // ── Port of audit-auth-storage.test.ts auth-core-8 ──────────────────────

    #[tokio::test]
    async fn issuing_invalidates_prior_outstanding_tokens() {
        let reset = store().await;
        let old = reset
            .issue("old", "t1", "u1", DEFAULT_RESET_TTL_MINUTES, NOW)
            .await
            .unwrap();
        // A second issuance for the same user consumes the first.
        let new = reset
            .issue("new", "t1", "u1", DEFAULT_RESET_TTL_MINUTES, NOW + 1_000)
            .await
            .unwrap();

        // The old (possibly-leaked) token no longer verifies.
        assert!(
            reset
                .consume(&old.token, NOW + 2_000)
                .await
                .unwrap()
                .is_none()
        );
        // The newest token still works.
        assert_eq!(
            reset.consume(&new.token, NOW + 2_000).await.unwrap(),
            Some(ConsumedResetTokenRow {
                tenant_id: "t1".to_owned(),
                user_id: "u1".to_owned(),
            })
        );
    }

    #[tokio::test]
    async fn issuing_does_not_affect_a_different_users_token() {
        let reset = store().await;
        let user_a = reset
            .issue("a", "t1", "userA", DEFAULT_RESET_TTL_MINUTES, NOW)
            .await
            .unwrap();
        reset
            .issue("b1", "t1", "userB", DEFAULT_RESET_TTL_MINUTES, NOW)
            .await
            .unwrap();
        // Re-issuing for userB must not invalidate userA's token.
        reset
            .issue("b2", "t1", "userB", DEFAULT_RESET_TTL_MINUTES, NOW + 1_000)
            .await
            .unwrap();
        assert_eq!(
            reset.consume(&user_a.token, NOW + 2_000).await.unwrap(),
            Some(ConsumedResetTokenRow {
                tenant_id: "t1".to_owned(),
                user_id: "userA".to_owned(),
            })
        );
    }

    // ── consume() rejection cases ───────────────────────────────────────────

    #[tokio::test]
    async fn consume_rejects_unknown_token() {
        let reset = store().await;
        assert!(reset.consume("nope", NOW).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn consume_is_single_use() {
        let reset = store().await;
        let issued = reset
            .issue("tok", "t1", "u1", DEFAULT_RESET_TTL_MINUTES, NOW)
            .await
            .unwrap();
        // First consume succeeds.
        assert!(
            reset
                .consume(&issued.token, NOW + 1_000)
                .await
                .unwrap()
                .is_some()
        );
        // Second consume of the same token is rejected (already consumed).
        assert!(
            reset
                .consume(&issued.token, NOW + 2_000)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn consume_rejects_expired_token_by_string_compare() {
        let reset = store().await;
        let issued = reset
            .issue("tok", "t1", "u1", DEFAULT_RESET_TTL_MINUTES, NOW)
            .await
            .unwrap();
        // expires_at = NOW + 1h. Consuming AT expiry: `expires_at < now` is
        // false at exactly equal, so it still succeeds; just past expiry fails.
        let just_after = NOW + 60 * 60_000 + 1;
        assert!(
            reset
                .consume(&issued.token, just_after)
                .await
                .unwrap()
                .is_none()
        );
        // Confirm: AT the boundary (expires_at == now_iso) it is NOT expired
        // (strict `<`).
        let at_expiry = NOW + 60 * 60_000;
        assert!(
            reset
                .consume(&issued.token, at_expiry)
                .await
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn purge_expired_deletes_strictly_before_now() {
        let reset = store().await;
        // Token expiring at NOW + 1h.
        reset
            .issue("tok", "t1", "u1", DEFAULT_RESET_TTL_MINUTES, NOW)
            .await
            .unwrap();
        // Before expiry: nothing purged.
        assert_eq!(reset.purge_expired(NOW + 60 * 60_000).await.unwrap(), 0);
        // Just after expiry: purged.
        assert_eq!(reset.purge_expired(NOW + 60 * 60_000 + 1).await.unwrap(), 1);
    }
}
