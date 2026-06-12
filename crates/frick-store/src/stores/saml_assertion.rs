//! SAML assertion-replay guard (`apps/server/src/storage/saml-assertion-store.ts`,
//! map 03 §9.6, FR-31).
//!
//! Each SAML assertion carries a unique `ID`; the SAML profile requires the SP
//! to reject a previously-seen assertion ID so a captured (still-signed,
//! still-in-window) assertion cannot be replayed against the ACS endpoint. This
//! store records every consumed assertion ID — scoped by `provider_id` so two
//! IdPs that mint colliding IDs don't alias — and reports whether an ID has been
//! seen before.
//!
//! [`SamlAssertionStore::mark_seen`] is the security-critical operation: a plain
//! INSERT whose success/failure tells the caller whether THIS request is the
//! first to consume the assertion. The composite PRIMARY KEY
//! `(provider_id, assertion_id)` makes a duplicate insert fail, so even two
//! concurrent submissions of the same assertion can't both win — the loser sees
//! the constraint error and treats it as a replay (`false`).
//!
//! Rows are kept until `expires_at` (the assertion's `NotOnOrAfter`, plus a skew
//! pad the caller supplies); afterward the replay row is GC-eligible via
//! [`SamlAssertionStore::purge_expired`]. No global scheduler invokes it, so a
//! winning `mark_seen` opportunistically sweeps already-expired rows (best
//! effort — a failed sweep must never fail the login), keeping the table bounded
//! by the number of *currently in-window* assertions.
//!
//! # Determinism (map 03 §9, "Determinism rule")
//!
//! The TS store reads `new Date().toISOString()` twice (the `seen_at` stamp and
//! the `purge_expired` cutoff). Both are hoisted to explicit `now_ms` parameters
//! at the facade boundary so store logic never touches the clock; the facade
//! passes the same instant to both, exactly as the TS call sequence does.

use std::sync::Arc;

use crate::driver::SqlDriver;
use crate::error::StoreError;
use crate::stores::blob_bytes::iso_from_epoch_ms;

/// Input to [`SamlAssertionStore::mark_seen`] (`markSeen` arg,
/// saml-assertion-store.ts:37-41).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkSeenInput {
    pub provider_id: String,
    pub assertion_id: String,
    /// The skew-padded replay TTL (ISO-8601); the row is GC-eligible after it
    /// passes. The TS takes this as a pre-rendered string from the caller.
    pub expires_at: String,
}

/// `SamlAssertionStore` (`storage/saml-assertion-store.ts`): the SAML
/// assertion-replay guard over [`SqlDriver`].
pub struct SamlAssertionStore {
    sql: Arc<SqlDriver>,
}

impl SamlAssertionStore {
    #[must_use]
    pub fn new(sql: Arc<SqlDriver>) -> Self {
        Self { sql }
    }

    /// `markSeen` (saml-assertion-store.ts:37-68). Atomically record that
    /// `assertion_id` (for `provider_id`) has been consumed. Returns `true` when
    /// this call was the FIRST to record it (fresh — the caller may accept), or
    /// `false` when the ID was already present (a replay — the caller MUST
    /// reject).
    ///
    /// The TS catches ANY throw from the INSERT and returns `false`: a
    /// PK/unique-constraint violation means the assertion was already recorded.
    /// We narrow on the changes-count instead (a winning insert reports
    /// `changes > 0`); a constraint violation surfaces as an `Err` from the
    /// driver, which we map to `false` — matching the TS `try/catch`.
    ///
    /// On a win, opportunistically [`purge_expired`](Self::purge_expired) (auth-
    /// saml-4): best-effort, a failed sweep must never fail the login, so its
    /// error is swallowed. `now_ms` stamps `seen_at` AND serves as the purge
    /// cutoff (the TS reads `new Date().toISOString()` for each; the facade
    /// passes one instant).
    pub async fn mark_seen(&self, input: &MarkSeenInput, now_ms: i64) -> Result<bool, StoreError> {
        let now = iso_from_epoch_ms(now_ms);
        let result = self
            .sql
            .run(
                "INSERT INTO auth_saml_seen_assertions
                    (provider_id, assertion_id, seen_at, expires_at)
                    VALUES (?, ?, ?, ?)",
                &[
                    input.provider_id.as_str().into(),
                    input.assertion_id.as_str().into(),
                    now.into(),
                    input.expires_at.as_str().into(),
                ],
            )
            .await;
        let won = match result {
            Ok(run) => run.changes > 0,
            // Unique-constraint violation (SQLite + Postgres both throw) → the
            // assertion ID was already recorded: this is a replay.
            Err(_) => return Ok(false),
        };
        if won {
            // auth-saml-4: opportunistically GC expired replay rows on the way
            // in so the table is bounded without an external scheduler.
            // Best-effort — a failed sweep must never fail the login.
            let _ = self.purge_expired(now_ms).await;
        }
        Ok(won)
    }

    /// `hasSeen` (saml-assertion-store.ts:71-77): whether an assertion ID has
    /// already been recorded (a non-mutating peek).
    pub async fn has_seen(
        &self,
        provider_id: &str,
        assertion_id: &str,
    ) -> Result<bool, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT assertion_id FROM auth_saml_seen_assertions WHERE provider_id = ? AND assertion_id = ?",
                &[provider_id.into(), assertion_id.into()],
            )
            .await?;
        Ok(row.is_some())
    }

    /// `purgeExpired` (saml-assertion-store.ts:80-86): garbage-collect replay
    /// rows whose freshness window has passed (`expires_at < now`). Returns the
    /// number of rows removed. `now_ms` is the cutoff (the TS reads
    /// `new Date().toISOString()`).
    pub async fn purge_expired(&self, now_ms: i64) -> Result<u64, StoreError> {
        let result = self
            .sql
            .run(
                "DELETE FROM auth_saml_seen_assertions WHERE expires_at < ?",
                &[iso_from_epoch_ms(now_ms).into()],
            )
            .await?;
        Ok(result.changes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The effective post-migration-0020 SQLite schema for
    // `auth_saml_seen_assertions` (map 03 §5).
    const SCHEMA: &str = "
        CREATE TABLE auth_saml_seen_assertions (
          provider_id TEXT NOT NULL,
          assertion_id TEXT NOT NULL,
          seen_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          PRIMARY KEY (provider_id, assertion_id)
        );
        CREATE INDEX idx_saml_seen_expires_at ON auth_saml_seen_assertions (expires_at);";

    // A fixed clock so seen_at is deterministic: 2023-11-14T22:13:20.123Z.
    const NOW: i64 = 1_700_000_000_123;

    async fn store() -> (SamlAssertionStore, Arc<SqlDriver>) {
        let sql = Arc::new(SqlDriver::open_sqlite(":memory:").unwrap());
        sql.exec(SCHEMA).await.unwrap();
        (SamlAssertionStore::new(Arc::clone(&sql)), sql)
    }

    fn input(provider: &str, assertion: &str, expires_ms: i64) -> MarkSeenInput {
        MarkSeenInput {
            provider_id: provider.to_owned(),
            assertion_id: assertion.to_owned(),
            expires_at: iso_from_epoch_ms(expires_ms),
        }
    }

    async fn count(sql: &SqlDriver) -> i64 {
        sql.get("SELECT COUNT(*) AS c FROM auth_saml_seen_assertions", &[])
            .await
            .unwrap()
            .and_then(|row| row.i64("c"))
            .unwrap()
    }

    // ── Port of audit-auth-storage.test.ts (auth-saml-4 describe block) ──────

    /// "does not let expired replay rows accumulate (opportunistic GC)".
    #[tokio::test]
    async fn opportunistic_gc_keeps_table_bounded_to_in_window_rows() {
        let (store, sql) = store().await;

        // Record an in-window assertion (it must survive its own GC sweep).
        assert!(
            store
                .mark_seen(&input("p1", "live-assertion", NOW + 60_000), NOW)
                .await
                .unwrap()
        );

        // Several already-expired assertions: each win triggers purgeExpired,
        // which sweeps the prior expired rows so they never accumulate.
        for i in 0..3 {
            store
                .mark_seen(&input("p1", &format!("expired-{i}"), NOW - 60_000), NOW)
                .await
                .unwrap();
        }

        // Only the in-window row remains; the expired rows were GC'd.
        assert_eq!(count(&sql).await, 1);
        assert!(store.has_seen("p1", "live-assertion").await.unwrap());
    }

    /// "a duplicate (replay) is still rejected".
    #[tokio::test]
    async fn duplicate_is_rejected_as_replay() {
        let (store, _sql) = store().await;
        let inp = input("p1", "a1", NOW + 60_000);
        assert!(store.mark_seen(&inp, NOW).await.unwrap());
        // Same id again → replay.
        assert!(!store.mark_seen(&inp, NOW).await.unwrap());
    }

    // ── Additional coverage of the store surface ─────────────────────────────

    #[tokio::test]
    async fn provider_id_scopes_the_replay_namespace() {
        let (store, _sql) = store().await;
        // The same assertion id under two providers does NOT collide — the PK is
        // (provider_id, assertion_id).
        assert!(
            store
                .mark_seen(&input("idp-a", "shared-id", NOW + 60_000), NOW)
                .await
                .unwrap()
        );
        assert!(
            store
                .mark_seen(&input("idp-b", "shared-id", NOW + 60_000), NOW)
                .await
                .unwrap()
        );
        assert!(store.has_seen("idp-a", "shared-id").await.unwrap());
        assert!(store.has_seen("idp-b", "shared-id").await.unwrap());
        assert!(!store.has_seen("idp-c", "shared-id").await.unwrap());
    }

    #[tokio::test]
    async fn has_seen_is_false_for_unrecorded_assertions() {
        let (store, _sql) = store().await;
        assert!(!store.has_seen("p1", "never").await.unwrap());
    }

    #[tokio::test]
    async fn purge_expired_removes_only_past_window_rows_and_counts_them() {
        let (store, sql) = store().await;
        // Two expired, one in-window. mark_seen would auto-sweep, so insert the
        // expired rows directly to isolate purge_expired's own behavior.
        sql.run(
            "INSERT INTO auth_saml_seen_assertions (provider_id, assertion_id, seen_at, expires_at) VALUES (?, ?, ?, ?)",
            &[
                "p1".into(),
                "old-1".into(),
                iso_from_epoch_ms(NOW).into(),
                iso_from_epoch_ms(NOW - 1).into(),
            ],
        )
        .await
        .unwrap();
        sql.run(
            "INSERT INTO auth_saml_seen_assertions (provider_id, assertion_id, seen_at, expires_at) VALUES (?, ?, ?, ?)",
            &[
                "p1".into(),
                "old-2".into(),
                iso_from_epoch_ms(NOW).into(),
                iso_from_epoch_ms(NOW - 2).into(),
            ],
        )
        .await
        .unwrap();
        sql.run(
            "INSERT INTO auth_saml_seen_assertions (provider_id, assertion_id, seen_at, expires_at) VALUES (?, ?, ?, ?)",
            &[
                "p1".into(),
                "live".into(),
                iso_from_epoch_ms(NOW).into(),
                iso_from_epoch_ms(NOW + 60_000).into(),
            ],
        )
        .await
        .unwrap();

        // Cutoff == NOW: rows with expires_at strictly < NOW are deleted; a row
        // expiring exactly at NOW is kept (`<`, not `<=`).
        assert_eq!(store.purge_expired(NOW).await.unwrap(), 2);
        assert_eq!(count(&sql).await, 1);
        assert!(store.has_seen("p1", "live").await.unwrap());
    }
}
