//! Registration-lock store (AURA-178): the server half of the Signal-style
//! recovery-PIN registration lock.
//!
//! One row per `(tenant_id, user_id)` in `auth_registration_locks` (migration
//! `0025_auth_registration_locks`). The client derives a verifier from the
//! recovery PIN with PBKDF2-SHA256 (310,000 iterations, 16-byte salt, 256-bit
//! output — the exact parameters of the web `reglock` module) and submits the
//! base64 verifier; only the SHA-256 base64url hash of that verifier hits the
//! database, mirroring the refresh-token and reset-token stores. The `salt`
//! is stored verbatim because the challenge must hand it back to a fresh
//! device so it can derive the same verifier from the user-entered PIN.
//!
//! Wrong-attempt lockout mirrors the web module byte for byte: after
//! [`LOCKOUT_THRESHOLD`] consecutive failures the next attempt must wait
//! `2^(failures - LOCKOUT_THRESHOLD)` seconds, capped at
//! [`LOCKOUT_MAX_SECONDS`]. The store never reads the system clock; callers
//! inject `now_ms` (determinism rule).

use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

use crate::driver::SqlDriver;
use crate::error::StoreError;
use crate::stores::blob_bytes::iso_from_epoch_ms;

/// Consecutive failures before lockout waits begin (web `LOCKOUT_THRESHOLD`).
pub const LOCKOUT_THRESHOLD: i64 = 3;

/// Cap on the lockout wait in seconds (web `LOCKOUT_MAX_SECONDS`).
pub const LOCKOUT_MAX_SECONDS: i64 = 3600;

/// Seconds a locked account must wait after `failures` consecutive wrong
/// attempts (web `lockoutWaitSeconds`): `0` below the threshold, then
/// `min(2^(failures - threshold), cap)`.
#[must_use]
pub fn lockout_wait_seconds(failures: i64) -> i64 {
    if failures < LOCKOUT_THRESHOLD {
        return 0;
    }
    let exp = failures - LOCKOUT_THRESHOLD;
    if exp >= 12 {
        // 2^12 = 4096 already exceeds the 3600s cap.
        return LOCKOUT_MAX_SECONDS;
    }
    (1_i64 << exp).min(LOCKOUT_MAX_SECONDS)
}

/// One `auth_registration_locks` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistrationLockRecord {
    pub tenant_id: String,
    pub user_id: String,
    /// SHA-256 base64url hash of the client-submitted PBKDF2 verifier.
    pub verifier_hash: String,
    /// The PBKDF2 salt (base64), returned to challenged clients verbatim.
    pub salt: String,
    pub enabled: bool,
    pub failed_attempts: i64,
    /// Epoch ms until which PIN attempts are refused (0 ⇒ not locked out).
    pub locked_until_ms: i64,
    /// Epoch ms of the last authenticated activity; drives the Signal-style
    /// inactivity expiry (the lock stops being enforced once this is older
    /// than the configured window).
    pub last_activity_ms: i64,
    pub updated_at: String,
}

/// Store over `auth_registration_locks` (AURA-178).
pub struct RegistrationLockStore {
    sql: Arc<SqlDriver>,
}

impl RegistrationLockStore {
    #[must_use]
    pub fn new(sql: Arc<SqlDriver>) -> Self {
        Self { sql }
    }

    /// Enable (or replace — "change PIN") the registration lock. Stores the
    /// verifier hash + salt, resets the failure counters, and stamps
    /// `last_activity_ms = now_ms` so the expiry window starts fresh.
    pub async fn enable(
        &self,
        tenant_id: &str,
        user_id: &str,
        verifier: &str,
        salt: &str,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        let now_iso = iso_from_epoch_ms(now_ms);
        self.sql
            .run(
                "INSERT INTO auth_registration_locks
                    (tenant_id, user_id, verifier_hash, salt, enabled, failed_attempts,
                     locked_until_ms, last_activity_ms, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?, ?)
                    ON CONFLICT (tenant_id, user_id) DO UPDATE SET
                      verifier_hash = excluded.verifier_hash,
                      salt = excluded.salt,
                      enabled = 1,
                      failed_attempts = 0,
                      locked_until_ms = 0,
                      last_activity_ms = excluded.last_activity_ms,
                      updated_at = excluded.updated_at",
                &[
                    tenant_id.into(),
                    user_id.into(),
                    hash_verifier(verifier).into(),
                    salt.into(),
                    now_ms.into(),
                    now_iso.as_str().into(),
                    now_iso.as_str().into(),
                ],
            )
            .await?;
        Ok(())
    }

    /// Disable the lock. Returns `true` when an enabled row was disabled,
    /// `false` when absent or already disabled — idempotent.
    pub async fn disable(
        &self,
        tenant_id: &str,
        user_id: &str,
        now_ms: i64,
    ) -> Result<bool, StoreError> {
        let result = self
            .sql
            .run(
                "UPDATE auth_registration_locks
                    SET enabled = 0, failed_attempts = 0, locked_until_ms = 0, updated_at = ?
                    WHERE tenant_id = ? AND user_id = ? AND enabled = 1",
                &[
                    iso_from_epoch_ms(now_ms).into(),
                    tenant_id.into(),
                    user_id.into(),
                ],
            )
            .await?;
        Ok(result.changes > 0)
    }

    /// Read the lock record (enabled or not); `None` when never enrolled.
    pub async fn read(
        &self,
        tenant_id: &str,
        user_id: &str,
    ) -> Result<Option<RegistrationLockRecord>, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT * FROM auth_registration_locks WHERE tenant_id = ? AND user_id = ?",
                &[tenant_id.into(), user_id.into()],
            )
            .await?;
        Ok(row.as_ref().map(record_from_row))
    }

    /// Whether a submitted verifier matches the stored one. Pure lookup — the
    /// caller drives the failure/lockout bookkeeping via
    /// [`register_failure`](Self::register_failure) /
    /// [`register_success`](Self::register_success). The comparison hashes the
    /// candidate and constant-time-compares the two digests.
    pub async fn verify(
        &self,
        tenant_id: &str,
        user_id: &str,
        verifier: &str,
    ) -> Result<bool, StoreError> {
        let Some(record) = self.read(tenant_id, user_id).await? else {
            return Ok(false);
        };
        Ok(constant_time_eq(
            hash_verifier(verifier).as_bytes(),
            record.verifier_hash.as_bytes(),
        ))
    }

    /// Record a wrong PIN attempt: increments `failed_attempts` and computes
    /// the next `locked_until_ms` from [`lockout_wait_seconds`]. Returns the
    /// updated record (`None` when no row exists).
    pub async fn register_failure(
        &self,
        tenant_id: &str,
        user_id: &str,
        now_ms: i64,
    ) -> Result<Option<RegistrationLockRecord>, StoreError> {
        let Some(record) = self.read(tenant_id, user_id).await? else {
            return Ok(None);
        };
        let failures = record.failed_attempts + 1;
        let wait_seconds = lockout_wait_seconds(failures);
        let locked_until_ms = if wait_seconds > 0 {
            now_ms + wait_seconds * 1_000
        } else {
            0
        };
        self.sql
            .run(
                "UPDATE auth_registration_locks
                    SET failed_attempts = ?, locked_until_ms = ?, updated_at = ?
                    WHERE tenant_id = ? AND user_id = ?",
                &[
                    failures.into(),
                    locked_until_ms.into(),
                    iso_from_epoch_ms(now_ms).into(),
                    tenant_id.into(),
                    user_id.into(),
                ],
            )
            .await?;
        self.read(tenant_id, user_id).await
    }

    /// Record a correct PIN attempt: resets the failure counters and stamps
    /// `last_activity_ms = now_ms` (a successful challenge IS authenticated
    /// activity, restarting the expiry window).
    pub async fn register_success(
        &self,
        tenant_id: &str,
        user_id: &str,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        self.sql
            .run(
                "UPDATE auth_registration_locks
                    SET failed_attempts = 0, locked_until_ms = 0, last_activity_ms = ?,
                        updated_at = ?
                    WHERE tenant_id = ? AND user_id = ?",
                &[
                    now_ms.into(),
                    iso_from_epoch_ms(now_ms).into(),
                    tenant_id.into(),
                    user_id.into(),
                ],
            )
            .await?;
        Ok(())
    }

    /// Stamp `last_activity_ms` — called on authenticated activity (login,
    /// token refresh, reglock management) to keep the enforcement window
    /// alive. Also lets tests backdate activity to exercise the expiry.
    pub async fn touch_activity(
        &self,
        tenant_id: &str,
        user_id: &str,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        self.sql
            .run(
                "UPDATE auth_registration_locks SET last_activity_ms = ?
                    WHERE tenant_id = ? AND user_id = ?",
                &[now_ms.into(), tenant_id.into(), user_id.into()],
            )
            .await?;
        Ok(())
    }
}

/// SHA-256 **base64url** (no padding) of the UTF-8 verifier — the same
/// only-hashes-hit-the-DB rule as the refresh-token store.
#[must_use]
pub fn hash_verifier(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Constant-time byte comparison (fold-XOR, like the web module's PIN check).
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

fn record_from_row(row: &crate::driver::SqlRow) -> RegistrationLockRecord {
    RegistrationLockRecord {
        tenant_id: row.text("tenant_id").unwrap_or_default().to_owned(),
        user_id: row.text("user_id").unwrap_or_default().to_owned(),
        verifier_hash: row.text("verifier_hash").unwrap_or_default().to_owned(),
        salt: row.text("salt").unwrap_or_default().to_owned(),
        enabled: row.i64("enabled").unwrap_or(0) != 0,
        failed_attempts: row.i64("failed_attempts").unwrap_or(0),
        locked_until_ms: row.i64("locked_until_ms").unwrap_or(0),
        last_activity_ms: row.i64("last_activity_ms").unwrap_or(0),
        updated_at: row.text("updated_at").unwrap_or_default().to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The effective 0025 table shape.
    const SCHEMA: &str = "
        CREATE TABLE auth_registration_locks (
          tenant_id TEXT NOT NULL DEFAULT '_default',
          user_id TEXT NOT NULL,
          verifier_hash TEXT NOT NULL,
          salt TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          failed_attempts INTEGER NOT NULL DEFAULT 0,
          locked_until_ms INTEGER NOT NULL DEFAULT 0,
          last_activity_ms INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, user_id)
        );";

    // 2023-11-14T22:13:20.123Z.
    const NOW: i64 = 1_700_000_000_123;

    async fn store() -> RegistrationLockStore {
        let sql = Arc::new(SqlDriver::open_sqlite(":memory:").unwrap());
        sql.exec(SCHEMA).await.unwrap();
        RegistrationLockStore::new(sql)
    }

    #[test]
    fn lockout_waits_mirror_the_web_module() {
        assert_eq!(lockout_wait_seconds(0), 0);
        assert_eq!(lockout_wait_seconds(1), 0);
        assert_eq!(lockout_wait_seconds(2), 0);
        assert_eq!(lockout_wait_seconds(3), 1);
        assert_eq!(lockout_wait_seconds(4), 2);
        assert_eq!(lockout_wait_seconds(5), 4);
        assert_eq!(lockout_wait_seconds(14), 2048);
        assert_eq!(lockout_wait_seconds(15), 3600);
        assert_eq!(lockout_wait_seconds(60), 3600);
    }

    #[tokio::test]
    async fn enable_stores_hash_not_verifier_and_read_round_trips() {
        let store = store().await;
        store
            .enable("t1", "u1", "verifier-abc", "salt-xyz", NOW)
            .await
            .unwrap();

        let record = store.read("t1", "u1").await.unwrap().unwrap();
        assert!(record.enabled);
        assert_eq!(record.salt, "salt-xyz");
        assert_eq!(record.verifier_hash, hash_verifier("verifier-abc"));
        assert_ne!(record.verifier_hash, "verifier-abc");
        assert_eq!(record.failed_attempts, 0);
        assert_eq!(record.locked_until_ms, 0);
        assert_eq!(record.last_activity_ms, NOW);

        assert!(store.verify("t1", "u1", "verifier-abc").await.unwrap());
        assert!(!store.verify("t1", "u1", "wrong").await.unwrap());
        // Unknown user never verifies.
        assert!(!store.verify("t1", "nobody", "verifier-abc").await.unwrap());
    }

    #[tokio::test]
    async fn enable_replaces_pin_and_resets_counters() {
        let store = store().await;
        store
            .enable("t1", "u1", "old", "salt-1", NOW)
            .await
            .unwrap();
        for _ in 0..4 {
            store
                .register_failure("t1", "u1", NOW + 1_000)
                .await
                .unwrap();
        }
        let locked = store.read("t1", "u1").await.unwrap().unwrap();
        assert!(locked.locked_until_ms > 0);

        // Change PIN: new verifier + salt, counters cleared.
        store
            .enable("t1", "u1", "new", "salt-2", NOW + 2_000)
            .await
            .unwrap();
        let record = store.read("t1", "u1").await.unwrap().unwrap();
        assert_eq!(record.salt, "salt-2");
        assert_eq!(record.failed_attempts, 0);
        assert_eq!(record.locked_until_ms, 0);
        assert!(store.verify("t1", "u1", "new").await.unwrap());
        assert!(!store.verify("t1", "u1", "old").await.unwrap());
    }

    #[tokio::test]
    async fn disable_is_idempotent() {
        let store = store().await;
        store.enable("t1", "u1", "v", "s", NOW).await.unwrap();
        assert!(store.disable("t1", "u1", NOW + 1_000).await.unwrap());
        assert!(!store.disable("t1", "u1", NOW + 2_000).await.unwrap());
        assert!(!store.disable("t1", "nobody", NOW).await.unwrap());
        let record = store.read("t1", "u1").await.unwrap().unwrap();
        assert!(!record.enabled);
    }

    #[tokio::test]
    async fn failures_back_off_and_success_resets() {
        let store = store().await;
        store.enable("t1", "u1", "v", "s", NOW).await.unwrap();

        // Two failures: still no lockout (threshold 3).
        for expected in 1..=2 {
            let record = store
                .register_failure("t1", "u1", NOW)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(record.failed_attempts, expected);
            assert_eq!(record.locked_until_ms, 0);
        }
        // Third failure: 1s lockout; fourth: 2s.
        let third = store
            .register_failure("t1", "u1", NOW)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(third.locked_until_ms, NOW + 1_000);
        let fourth = store
            .register_failure("t1", "u1", NOW)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(fourth.locked_until_ms, NOW + 2_000);

        // Success clears counters and stamps activity.
        store
            .register_success("t1", "u1", NOW + 9_000)
            .await
            .unwrap();
        let record = store.read("t1", "u1").await.unwrap().unwrap();
        assert_eq!(record.failed_attempts, 0);
        assert_eq!(record.locked_until_ms, 0);
        assert_eq!(record.last_activity_ms, NOW + 9_000);
    }

    #[tokio::test]
    async fn register_failure_without_a_row_is_none() {
        let store = store().await;
        assert!(
            store
                .register_failure("t1", "nobody", NOW)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn touch_activity_moves_the_window_in_both_directions() {
        let store = store().await;
        store.enable("t1", "u1", "v", "s", NOW).await.unwrap();
        store.touch_activity("t1", "u1", NOW + 5_000).await.unwrap();
        assert_eq!(
            store
                .read("t1", "u1")
                .await
                .unwrap()
                .unwrap()
                .last_activity_ms,
            NOW + 5_000
        );
        // Backdating works too (tests use this to exercise expiry).
        store
            .touch_activity("t1", "u1", NOW - 100_000)
            .await
            .unwrap();
        assert_eq!(
            store
                .read("t1", "u1")
                .await
                .unwrap()
                .unwrap()
                .last_activity_ms,
            NOW - 100_000
        );
    }
}
