//! Sealed-sender unidentified-access token store (AURA-326).
//!
//! One row per `(tenant_id, user_id)` in `sealed_sender_access` (migration
//! `0026_sealed_sender_access`). The token is the recipient-facing anti-abuse
//! credential for the sealed (sender-hidden) delivery route: a sender who
//! knows a recipient's current token may deliver a sealed envelope without
//! authenticating, and the server throttles per recipient. Recipients mint or
//! derive the token client-side (e.g. from their profile key), register it
//! here, and can rotate or revoke it at any time; rotation replaces the row,
//! revocation flips `revoked` so sealed delivery is refused until a new token
//! is registered.
//!
//! Only the SHA-256 base64url hash of the token hits the database, mirroring
//! the refresh-token and registration-lock stores. The store never reads the
//! system clock; callers inject `now_ms` (determinism rule).

use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

use crate::driver::SqlDriver;
use crate::error::StoreError;
use crate::stores::blob_bytes::iso_from_epoch_ms;

/// One `sealed_sender_access` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedSenderAccessRecord {
    pub tenant_id: String,
    pub user_id: String,
    /// SHA-256 base64url hash of the registered access token.
    pub token_hash: String,
    /// `true` once the recipient revoked sealed delivery; a new
    /// [`issue`](SealedSenderAccessStore::issue) re-enables it.
    pub revoked: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// Store over `sealed_sender_access` (AURA-326).
pub struct SealedSenderAccessStore {
    sql: Arc<SqlDriver>,
}

impl SealedSenderAccessStore {
    #[must_use]
    pub fn new(sql: Arc<SqlDriver>) -> Self {
        Self { sql }
    }

    /// Register (or rotate) the recipient's unidentified-access token. Stores
    /// only the token hash, clears any revocation, and stamps `updated_at`.
    pub async fn issue(
        &self,
        tenant_id: &str,
        user_id: &str,
        token: &str,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        let now_iso = iso_from_epoch_ms(now_ms);
        self.sql
            .run(
                "INSERT INTO sealed_sender_access
                    (tenant_id, user_id, token_hash, revoked, created_at, updated_at)
                    VALUES (?, ?, ?, 0, ?, ?)
                    ON CONFLICT (tenant_id, user_id) DO UPDATE SET
                      token_hash = excluded.token_hash,
                      revoked = 0,
                      updated_at = excluded.updated_at",
                &[
                    tenant_id.into(),
                    user_id.into(),
                    hash_access_token(token).into(),
                    now_iso.as_str().into(),
                    now_iso.as_str().into(),
                ],
            )
            .await?;
        Ok(())
    }

    /// Read the recipient's record (revoked or not); `None` when the
    /// recipient never registered a token.
    pub async fn read(
        &self,
        tenant_id: &str,
        user_id: &str,
    ) -> Result<Option<SealedSenderAccessRecord>, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT * FROM sealed_sender_access WHERE tenant_id = ? AND user_id = ?",
                &[tenant_id.into(), user_id.into()],
            )
            .await?;
        Ok(row.as_ref().map(record_from_row))
    }

    /// Whether a presented token authorizes sealed delivery to the recipient:
    /// a row must exist, must not be revoked, and the hashed candidate must
    /// match in constant time. Unknown recipients simply fail — the route
    /// layer answers identically for "no row" and "wrong token" so senders
    /// cannot probe who has enrolled.
    pub async fn verify(
        &self,
        tenant_id: &str,
        user_id: &str,
        token: &str,
    ) -> Result<bool, StoreError> {
        let Some(record) = self.read(tenant_id, user_id).await? else {
            return Ok(false);
        };
        if record.revoked {
            return Ok(false);
        }
        Ok(constant_time_eq(
            hash_access_token(token).as_bytes(),
            record.token_hash.as_bytes(),
        ))
    }

    /// Revoke sealed delivery for the recipient. Returns `true` when an
    /// active row was revoked, `false` when absent or already revoked —
    /// idempotent.
    pub async fn revoke(
        &self,
        tenant_id: &str,
        user_id: &str,
        now_ms: i64,
    ) -> Result<bool, StoreError> {
        let result = self
            .sql
            .run(
                "UPDATE sealed_sender_access
                    SET revoked = 1, updated_at = ?
                    WHERE tenant_id = ? AND user_id = ? AND revoked = 0",
                &[
                    iso_from_epoch_ms(now_ms).into(),
                    tenant_id.into(),
                    user_id.into(),
                ],
            )
            .await?;
        Ok(result.changes > 0)
    }
}

/// SHA-256 **base64url** (no padding) of the UTF-8 token — the same
/// only-hashes-hit-the-DB rule as the refresh-token store.
#[must_use]
pub fn hash_access_token(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}

/// Constant-time byte comparison (fold-XOR, matching the reglock store).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn record_from_row(row: &crate::driver::SqlRow) -> SealedSenderAccessRecord {
    SealedSenderAccessRecord {
        tenant_id: row.text("tenant_id").unwrap_or_default().to_owned(),
        user_id: row.text("user_id").unwrap_or_default().to_owned(),
        token_hash: row.text("token_hash").unwrap_or_default().to_owned(),
        revoked: row.i64("revoked").unwrap_or(0) != 0,
        created_at: row.text("created_at").unwrap_or_default().to_owned(),
        updated_at: row.text("updated_at").unwrap_or_default().to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The effective 0026 table shape.
    const SCHEMA: &str = "
        CREATE TABLE sealed_sender_access (
          tenant_id TEXT NOT NULL DEFAULT '_default',
          user_id TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, user_id)
        );";

    // 2023-11-14T22:13:20.123Z.
    const NOW: i64 = 1_700_000_000_123;

    async fn store() -> SealedSenderAccessStore {
        let sql = Arc::new(SqlDriver::open_sqlite(":memory:").unwrap());
        sql.exec(SCHEMA).await.unwrap();
        SealedSenderAccessStore::new(sql)
    }

    #[tokio::test]
    async fn issue_stores_hash_not_token_and_verify_round_trips() {
        let store = store().await;
        store.issue("t1", "alice", "token-abc", NOW).await.unwrap();

        let record = store.read("t1", "alice").await.unwrap().unwrap();
        assert!(!record.revoked);
        assert_eq!(record.token_hash, hash_access_token("token-abc"));
        assert_ne!(record.token_hash, "token-abc");

        assert!(store.verify("t1", "alice", "token-abc").await.unwrap());
        assert!(!store.verify("t1", "alice", "wrong").await.unwrap());
        // Unknown recipients never verify.
        assert!(!store.verify("t1", "nobody", "token-abc").await.unwrap());
        // Cross-tenant tokens never verify.
        assert!(!store.verify("t2", "alice", "token-abc").await.unwrap());
    }

    #[tokio::test]
    async fn rotation_replaces_the_token() {
        let store = store().await;
        store.issue("t1", "alice", "old", NOW).await.unwrap();
        store
            .issue("t1", "alice", "new", NOW + 1_000)
            .await
            .unwrap();

        assert!(store.verify("t1", "alice", "new").await.unwrap());
        assert!(!store.verify("t1", "alice", "old").await.unwrap());
    }

    #[tokio::test]
    async fn revoke_blocks_verification_until_reissued() {
        let store = store().await;
        store.issue("t1", "alice", "token", NOW).await.unwrap();

        assert!(store.revoke("t1", "alice", NOW + 1_000).await.unwrap());
        // Idempotent: already revoked / unknown rows report false.
        assert!(!store.revoke("t1", "alice", NOW + 2_000).await.unwrap());
        assert!(!store.revoke("t1", "nobody", NOW).await.unwrap());

        assert!(!store.verify("t1", "alice", "token").await.unwrap());
        let record = store.read("t1", "alice").await.unwrap().unwrap();
        assert!(record.revoked);

        // Re-issuing re-enables sealed delivery with the new token only.
        store
            .issue("t1", "alice", "token-2", NOW + 3_000)
            .await
            .unwrap();
        assert!(store.verify("t1", "alice", "token-2").await.unwrap());
        assert!(!store.verify("t1", "alice", "token").await.unwrap());
    }
}
