//! Session store (`apps/server/src/storage/session-store.ts`, map 03 §9.3).
//!
//! A session is keyed by the SHA-256 **hex** digest of the opaque bearer token
//! (`session_token_digest`); the raw token is never stored, so a leaked DB
//! snapshot cannot be replayed. The `auth_sessions` row carries the
//! `(tenant_id, user_id, device_id, replica_id)` tuple, an `expires_at`
//! ISO-8601 timestamp, and `created_at`/`last_seen_at` stamps.
//!
//! # Determinism (map "Determinism rule")
//!
//! The store never reads the system clock. `create`/`read_active` take the
//! current time as an explicit `now_ms` parameter (the facade passes real
//! system time; tests pass fixed values). `created_at`/`last_seen_at` are
//! stamped via [`iso_from_epoch_ms`]; the active-vs-expired decision compares
//! `Date.parse(expires_at)` against `now_ms` exactly like the TS
//! `Date.parse(row.expires_at) <= Date.now()`.
//!
//! # `app_id` (map §9.3)
//!
//! `create` deliberately does NOT stamp `app_id` — the column DEFAULT
//! `_default` applies, byte-for-byte the TS INSERT (which omits the column).

use std::sync::Arc;

use sha2::{Digest, Sha256};

use crate::driver::SqlDriver;
use crate::error::StoreError;
use crate::stores::blob_bytes::iso_from_epoch_ms;

/// A stored session row (`StoredSession`, session-store.ts:4-13). The raw
/// `session_token` is echoed back from the input (never re-read from the DB,
/// which only holds the digest).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredSession {
    pub session_token: String,
    pub tenant_id: String,
    pub user_id: String,
    pub device_id: String,
    pub replica_id: String,
    pub expires_at: String,
    pub created_at: String,
    pub last_seen_at: String,
}

/// Input to [`SessionStore::create`] (`CreateSessionInput`,
/// session-store.ts:15-22). `expires_at` is a caller-supplied ISO-8601
/// timestamp (the auth layer computes it from the session TTL).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateSessionInput {
    pub session_token: String,
    pub tenant_id: String,
    pub user_id: String,
    pub device_id: String,
    pub replica_id: String,
    pub expires_at: String,
}

/// `SessionStore` (`storage/session-store.ts`): bearer-token-backed sessions
/// over [`SqlDriver`].
pub struct SessionStore {
    sql: Arc<SqlDriver>,
}

impl SessionStore {
    #[must_use]
    pub fn new(sql: Arc<SqlDriver>) -> Self {
        Self { sql }
    }

    /// `create` (session-store.ts:38-66): INSERT a fresh session keyed by the
    /// token digest. `created_at` and `last_seen_at` are both stamped from
    /// `now_ms`. Does NOT stamp `app_id` — the column DEFAULT `_default`
    /// applies (map §9.3).
    pub async fn create(
        &self,
        input: &CreateSessionInput,
        now_ms: i64,
    ) -> Result<StoredSession, StoreError> {
        let now = iso_from_epoch_ms(now_ms);
        self.sql
            .run(
                "INSERT INTO auth_sessions
                    (session_token_digest, tenant_id, user_id, device_id, replica_id, expires_at, created_at, last_seen_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                &[
                    session_token_digest(&input.session_token).into(),
                    input.tenant_id.as_str().into(),
                    input.user_id.as_str().into(),
                    input.device_id.as_str().into(),
                    input.replica_id.as_str().into(),
                    input.expires_at.as_str().into(),
                    now.as_str().into(),
                    now.as_str().into(),
                ],
            )
            .await?;
        Ok(StoredSession {
            session_token: input.session_token.clone(),
            tenant_id: input.tenant_id.clone(),
            user_id: input.user_id.clone(),
            device_id: input.device_id.clone(),
            replica_id: input.replica_id.clone(),
            expires_at: input.expires_at.clone(),
            created_at: now.clone(),
            last_seen_at: now,
        })
    }

    /// `readActive` (session-store.ts:68-89): look up by token digest; return
    /// `None` when absent OR when `Date.parse(expires_at) <= now`; otherwise
    /// **bump `last_seen_at` (write-on-read)** to `now_ms` and return the row
    /// with the bumped value. An `expires_at` that does not parse mirrors TS
    /// `Date.parse(...) <= Date.now()`: `NaN <= now` is `false`, so the session
    /// is treated as active.
    pub async fn read_active(
        &self,
        session_token: &str,
        now_ms: i64,
    ) -> Result<Option<StoredSession>, StoreError> {
        let digest = session_token_digest(session_token);
        let row = self
            .sql
            .get(
                "SELECT * FROM auth_sessions WHERE session_token_digest = ?",
                &[digest.as_str().into()],
            )
            .await?;
        let Some(row) = row else {
            return Ok(None);
        };

        let expires_at = row.text("expires_at").unwrap_or_default();
        // TS: `Date.parse(expires_at) <= Date.now()`. An unparseable timestamp
        // yields NaN, and `NaN <= now` is false ⇒ treated active.
        if let Some(expires_ms) = parse_iso_to_epoch_ms(expires_at)
            && expires_ms <= now_ms
        {
            return Ok(None);
        }

        let now = iso_from_epoch_ms(now_ms);
        self.sql
            .run(
                "UPDATE auth_sessions SET last_seen_at = ? WHERE session_token_digest = ?",
                &[now.as_str().into(), digest.as_str().into()],
            )
            .await?;

        Ok(Some(from_row_with_last_seen(&row, session_token, &now)))
    }

    /// `readAny` (session-store.ts:96-102): look up by token digest regardless
    /// of expiry. Callers use this to distinguish "no such session" from
    /// "session expired" so the server can emit the correct error code. Never
    /// mutates.
    pub async fn read_any(&self, session_token: &str) -> Result<Option<StoredSession>, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT * FROM auth_sessions WHERE session_token_digest = ?",
                &[session_token_digest(session_token).into()],
            )
            .await?;
        Ok(row.map(|row| from_row(&row, session_token)))
    }

    /// `delete` (session-store.ts:104-110): remove a single session by its raw
    /// token. Returns `true` when a row was deleted, `false` when absent.
    pub async fn delete(&self, session_token: &str) -> Result<bool, StoreError> {
        let result = self
            .sql
            .run(
                "DELETE FROM auth_sessions WHERE session_token_digest = ?",
                &[session_token_digest(session_token).into()],
            )
            .await?;
        Ok(result.changes > 0)
    }

    /// `deleteForUser` (session-store.ts:121-134): invalidate every session for
    /// `user_id`, optionally scoped to a single tenant. Returns the number of
    /// rows removed. `tenant_id = None` kills sessions in all tenants.
    pub async fn delete_for_user(
        &self,
        user_id: &str,
        tenant_id: Option<&str>,
    ) -> Result<u64, StoreError> {
        let result = match tenant_id {
            Some(tenant) => {
                self.sql
                    .run(
                        "DELETE FROM auth_sessions WHERE user_id = ? AND tenant_id = ?",
                        &[user_id.into(), tenant.into()],
                    )
                    .await?
            }
            None => {
                self.sql
                    .run(
                        "DELETE FROM auth_sessions WHERE user_id = ?",
                        &[user_id.into()],
                    )
                    .await?
            }
        };
        Ok(result.changes)
    }

    /// `pruneExpired` (session-store.ts:145-151): delete sessions whose
    /// `expires_at <= cutoff_iso` — the retention sweep (FR-42). The caller
    /// supplies the cutoff as ISO text (usually `now`; a past timestamp keeps a
    /// grace window of recently-expired rows). Returns the number of rows
    /// removed.
    pub async fn prune_expired(&self, cutoff_iso: &str) -> Result<u64, StoreError> {
        let result = self
            .sql
            .run(
                "DELETE FROM auth_sessions WHERE expires_at <= ?",
                &[cutoff_iso.into()],
            )
            .await?;
        Ok(result.changes)
    }

    /// Per-user device directory primitive (AURA-325): list the distinct
    /// **active** (non-expired) devices a user currently has, optionally scoped
    /// to a single tenant (`None` spans all tenants). This is the framework
    /// support multi-device E2EE (AURA-41) builds on: a sender derives the
    /// fan-out set for sender-key distribution / multi-device delivery from
    /// this directory.
    ///
    /// A device may back several session rows (re-login, replica churn); the
    /// result is de-duplicated on `device_id`, keeping the most recently seen
    /// row, and ordered by `device_id` for deterministic output. Expiry uses
    /// the same `Date.parse(expires_at) <= now` rule as [`read_active`]: an
    /// unparseable `expires_at` is treated as active.
    pub async fn list_active_devices_for_user(
        &self,
        user_id: &str,
        tenant_id: Option<&str>,
        now_ms: i64,
    ) -> Result<Vec<UserDevice>, StoreError> {
        let rows = match tenant_id {
            Some(tenant) => {
                self.sql
                    .all(
                        "SELECT * FROM auth_sessions WHERE user_id = ? AND tenant_id = ? \
                         ORDER BY device_id, last_seen_at DESC",
                        &[user_id.into(), tenant.into()],
                    )
                    .await?
            }
            None => {
                self.sql
                    .all(
                        "SELECT * FROM auth_sessions WHERE user_id = ? \
                         ORDER BY device_id, last_seen_at DESC",
                        &[user_id.into()],
                    )
                    .await?
            }
        };

        let mut seen = std::collections::BTreeSet::new();
        let mut devices = Vec::new();
        for row in &rows {
            // TS parity: `Date.parse(expires_at) <= now` ⇒ expired; NaN stays active.
            if let Some(expires_ms) =
                parse_iso_to_epoch_ms(row.text("expires_at").unwrap_or_default())
                && expires_ms <= now_ms
            {
                continue;
            }
            let device_id = row.text("device_id").unwrap_or_default().to_owned();
            if !seen.insert(device_id.clone()) {
                continue; // already captured the most-recent row for this device
            }
            devices.push(UserDevice {
                device_id,
                replica_id: row.text("replica_id").unwrap_or_default().to_owned(),
                last_seen_at: row.text("last_seen_at").unwrap_or_default().to_owned(),
            });
        }
        Ok(devices)
    }
}

/// One active device of a user, as surfaced by the device directory
/// ([`SessionStore::list_active_devices_for_user`], AURA-325).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserDevice {
    pub device_id: String,
    pub replica_id: String,
    pub last_seen_at: String,
}

/// Sender-key fan-out target computation (AURA-325). Given a user's active
/// `devices` (from the directory) and the `origin_device_id` that authored the
/// message, return the distinct set of *other* device ids the sender-key /
/// multi-device payload must be delivered to. The origin is excluded (it
/// already holds the key); input order is preserved and duplicates removed.
#[must_use]
pub fn fan_out_targets(devices: &[UserDevice], origin_device_id: &str) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    devices
        .iter()
        .map(|device| device.device_id.clone())
        .filter(|id| id != origin_device_id)
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

/// `sessionTokenDigest` (session-store.ts:167-169): SHA-256 **hex** of the
/// UTF-8 token. The raw token never hits the DB.
#[must_use]
fn session_token_digest(session_token: &str) -> String {
    hex::encode(Sha256::digest(session_token.as_bytes()))
}

/// `Date.parse(expires_at)` for the canonical `YYYY-MM-DDTHH:mm:ss.sssZ` form
/// (`new Date().toISOString()`, the only shape stores ever write/read). `None`
/// on any deviation — the caller treats that as TS's `NaN`, where `NaN <= now`
/// is `false` (so an unparseable expiry leaves the session active in
/// `read_active`, byte-for-byte the TS branch).
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
/// Hinnant's algorithm); the inverse of [`iso_from_epoch_ms`]'s decomposition.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `fromRow` (session-store.ts:154-165): map a `SELECT *` row + the raw token
/// to a [`StoredSession`].
fn from_row(row: &crate::driver::SqlRow, session_token: &str) -> StoredSession {
    StoredSession {
        session_token: session_token.to_owned(),
        tenant_id: row.text("tenant_id").unwrap_or_default().to_owned(),
        user_id: row.text("user_id").unwrap_or_default().to_owned(),
        device_id: row.text("device_id").unwrap_or_default().to_owned(),
        replica_id: row.text("replica_id").unwrap_or_default().to_owned(),
        expires_at: row.text("expires_at").unwrap_or_default().to_owned(),
        created_at: row.text("created_at").unwrap_or_default().to_owned(),
        last_seen_at: row.text("last_seen_at").unwrap_or_default().to_owned(),
    }
}

/// `read_active`'s `fromRow({ ...row, last_seen_at: now }, token)`: like
/// [`from_row`] but with `last_seen_at` overridden by the just-written value.
fn from_row_with_last_seen(
    row: &crate::driver::SqlRow,
    session_token: &str,
    last_seen_at: &str,
) -> StoredSession {
    StoredSession {
        last_seen_at: last_seen_at.to_owned(),
        ..from_row(row, session_token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Test schema bootstrap ───────────────────────────────────────────────
    // The effective post-all-migrations `auth_sessions` (map 03 §5; after the
    // 0013 token-digest rebuild + 0021 app_id column). `app_id` defaults to
    // `_default`, which `create` relies on (it never stamps the column).
    const SCHEMA: &str = "
        CREATE TABLE auth_sessions (
          session_token_digest TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT '_default',
          user_id TEXT NOT NULL,
          device_id TEXT NOT NULL,
          replica_id TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          app_id TEXT NOT NULL DEFAULT '_default'
        );";

    // 2023-11-14T22:13:20.123Z.
    const NOW: i64 = 1_700_000_000_123;

    async fn store() -> SessionStore {
        let sql = Arc::new(SqlDriver::open_sqlite(":memory:").unwrap());
        sql.exec(SCHEMA).await.unwrap();
        SessionStore::new(sql)
    }

    fn input(token: &str, expires_at: &str) -> CreateSessionInput {
        CreateSessionInput {
            session_token: token.to_owned(),
            tenant_id: "t1".to_owned(),
            user_id: "u1".to_owned(),
            device_id: "d1".to_owned(),
            replica_id: "r1".to_owned(),
            expires_at: expires_at.to_owned(),
        }
    }

    #[tokio::test]
    async fn token_digest_is_sha256_hex_of_utf8() {
        // Vector from node `createHash("sha256").update("hello").digest("hex")`.
        assert_eq!(
            session_token_digest("hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[tokio::test]
    async fn create_stamps_created_and_last_seen_and_stores_only_the_digest() {
        let sessions = store().await;
        let future = iso_from_epoch_ms(NOW + 60_000);
        let created = sessions
            .create(&input("tok-1", &future), NOW)
            .await
            .unwrap();

        assert_eq!(
            created,
            StoredSession {
                session_token: "tok-1".to_owned(),
                tenant_id: "t1".to_owned(),
                user_id: "u1".to_owned(),
                device_id: "d1".to_owned(),
                replica_id: "r1".to_owned(),
                expires_at: future.clone(),
                created_at: iso_from_epoch_ms(NOW),
                last_seen_at: iso_from_epoch_ms(NOW),
            }
        );

        // The raw token is never stored — only its hex digest, under the
        // default app partition (create() never stamps app_id).
        let row = sessions
            .sql
            .get("SELECT * FROM auth_sessions", &[])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            row.text("session_token_digest"),
            Some(session_token_digest("tok-1").as_str())
        );
        assert_eq!(row.text("app_id"), Some("_default"));
        assert!(row.text("session_token").is_none(), "no raw-token column");
    }

    // ── Device directory + fan-out (AURA-325) ───────────────────────────────

    fn dev_input(
        token: &str,
        user: &str,
        device: &str,
        tenant: &str,
        expires_at: &str,
    ) -> CreateSessionInput {
        CreateSessionInput {
            session_token: token.to_owned(),
            tenant_id: tenant.to_owned(),
            user_id: user.to_owned(),
            device_id: device.to_owned(),
            replica_id: "r1".to_owned(),
            expires_at: expires_at.to_owned(),
        }
    }

    #[tokio::test]
    async fn directory_lists_distinct_active_devices_excluding_expired_and_other_users() {
        let sessions = store().await;
        let active = iso_from_epoch_ms(NOW + 60_000);
        let expired = iso_from_epoch_ms(NOW - 1);
        // u1 has two devices, plus a second (newer) session row for da (dedup),
        // plus an expired session on dc. u2 is a different user.
        sessions
            .create(&dev_input("t-a1", "u1", "da", "t1", &active), NOW)
            .await
            .unwrap();
        sessions
            .create(&dev_input("t-a2", "u1", "da", "t1", &active), NOW + 5)
            .await
            .unwrap();
        sessions
            .create(&dev_input("t-b", "u1", "db", "t1", &active), NOW)
            .await
            .unwrap();
        sessions
            .create(&dev_input("t-c", "u1", "dc", "t1", &expired), NOW)
            .await
            .unwrap();
        sessions
            .create(&dev_input("t-z", "u2", "dz", "t1", &active), NOW)
            .await
            .unwrap();

        let devices = sessions
            .list_active_devices_for_user("u1", Some("t1"), NOW)
            .await
            .unwrap();
        let ids: Vec<&str> = devices.iter().map(|d| d.device_id.as_str()).collect();
        // Distinct, active, ordered; dc (expired) and dz (u2) excluded.
        assert_eq!(ids, vec!["da", "db"]);
    }

    #[tokio::test]
    async fn directory_scopes_to_tenant_or_spans_all() {
        let sessions = store().await;
        let active = iso_from_epoch_ms(NOW + 60_000);
        sessions
            .create(&dev_input("t-1", "u1", "da", "t1", &active), NOW)
            .await
            .unwrap();
        sessions
            .create(&dev_input("t-2", "u1", "db", "t2", &active), NOW)
            .await
            .unwrap();

        let scoped = sessions
            .list_active_devices_for_user("u1", Some("t1"), NOW)
            .await
            .unwrap();
        assert_eq!(
            scoped
                .iter()
                .map(|d| d.device_id.as_str())
                .collect::<Vec<_>>(),
            vec!["da"]
        );

        let all = sessions
            .list_active_devices_for_user("u1", None, NOW)
            .await
            .unwrap();
        assert_eq!(
            all.iter().map(|d| d.device_id.as_str()).collect::<Vec<_>>(),
            vec!["da", "db"]
        );
    }

    #[test]
    fn fan_out_excludes_origin_and_dedups_preserving_order() {
        let dev = |id: &str| UserDevice {
            device_id: id.to_owned(),
            replica_id: "r".to_owned(),
            last_seen_at: "t".to_owned(),
        };
        let devices = vec![dev("db"), dev("da"), dev("db"), dev("origin")];
        // Origin removed, duplicate db collapsed, input order preserved.
        assert_eq!(fan_out_targets(&devices, "origin"), vec!["db", "da"]);
        // No origin present ⇒ every distinct device is a target.
        assert_eq!(
            fan_out_targets(&devices, "nope"),
            vec!["db", "da", "origin"]
        );
        // Empty directory ⇒ no targets.
        assert!(fan_out_targets(&[], "origin").is_empty());
    }

    #[tokio::test]
    async fn read_active_returns_none_when_unknown() {
        let sessions = store().await;
        assert!(sessions.read_active("nope", NOW).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn read_active_returns_none_at_or_after_expiry() {
        let sessions = store().await;
        let expires_at = iso_from_epoch_ms(NOW + 1_000);
        sessions
            .create(&input("tok-1", &expires_at), NOW)
            .await
            .unwrap();

        // Exactly at expiry ⇒ `expires <= now` ⇒ None (TS `<=`).
        assert!(
            sessions
                .read_active("tok-1", NOW + 1_000)
                .await
                .unwrap()
                .is_none()
        );
        // After expiry ⇒ None.
        assert!(
            sessions
                .read_active("tok-1", NOW + 5_000)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn read_active_bumps_last_seen_on_read() {
        let sessions = store().await;
        let expires_at = iso_from_epoch_ms(NOW + 60_000);
        sessions
            .create(&input("tok-1", &expires_at), NOW)
            .await
            .unwrap();

        let bumped_at = NOW + 30_000;
        let active = sessions
            .read_active("tok-1", bumped_at)
            .await
            .unwrap()
            .unwrap();
        // The returned row carries the bumped last_seen_at...
        assert_eq!(active.last_seen_at, iso_from_epoch_ms(bumped_at));
        assert_eq!(active.created_at, iso_from_epoch_ms(NOW));
        assert_eq!(active.session_token, "tok-1");

        // ...and the write-on-read persisted it.
        let again = sessions
            .read_active("tok-1", bumped_at + 5_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(again.last_seen_at, iso_from_epoch_ms(bumped_at + 5_000));
    }

    #[tokio::test]
    async fn read_any_ignores_expiry_and_never_mutates() {
        let sessions = store().await;
        let expires_at = iso_from_epoch_ms(NOW + 1_000);
        let created = sessions
            .create(&input("tok-1", &expires_at), NOW)
            .await
            .unwrap();

        // Well past expiry, readAny still returns the row with the ORIGINAL
        // last_seen_at (no write-on-read).
        let any = sessions.read_any("tok-1").await.unwrap().unwrap();
        assert_eq!(any, created);
        assert!(
            sessions
                .read_active("tok-1", NOW + 99_999)
                .await
                .unwrap()
                .is_none()
        );
        // Confirm read_any did not bump last_seen_at.
        let still = sessions.read_any("tok-1").await.unwrap().unwrap();
        assert_eq!(still.last_seen_at, iso_from_epoch_ms(NOW));
    }

    #[tokio::test]
    async fn delete_is_idempotent() {
        let sessions = store().await;
        let expires_at = iso_from_epoch_ms(NOW + 60_000);
        sessions
            .create(&input("tok-1", &expires_at), NOW)
            .await
            .unwrap();

        assert!(sessions.delete("tok-1").await.unwrap());
        assert!(!sessions.delete("tok-1").await.unwrap());
        assert!(sessions.read_any("tok-1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_for_user_counts_and_scopes_by_tenant() {
        let sessions = store().await;
        let expires_at = iso_from_epoch_ms(NOW + 60_000);
        // u1 has two sessions in t1, one in t2; u2 has one in t1.
        for (token, tenant, user) in [
            ("a", "t1", "u1"),
            ("b", "t1", "u1"),
            ("c", "t2", "u1"),
            ("d", "t1", "u2"),
        ] {
            let mut inp = input(token, &expires_at);
            inp.tenant_id = tenant.to_owned();
            inp.user_id = user.to_owned();
            sessions.create(&inp, NOW).await.unwrap();
        }

        // Tenant-scoped: only u1's t1 sessions.
        assert_eq!(sessions.delete_for_user("u1", Some("t1")).await.unwrap(), 2);
        // u1's t2 session survives.
        assert!(sessions.read_any("c").await.unwrap().is_some());
        // u2's session survives.
        assert!(sessions.read_any("d").await.unwrap().is_some());

        // Unscoped: kills u1 everywhere (only "c" remains for u1).
        assert_eq!(sessions.delete_for_user("u1", None).await.unwrap(), 1);
        assert!(sessions.read_any("c").await.unwrap().is_none());
        // u2 untouched.
        assert!(sessions.read_any("d").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn prune_expired_deletes_at_or_before_cutoff() {
        let sessions = store().await;
        // Three sessions expiring at NOW, NOW+1s, NOW+2s.
        for (token, dt) in [("a", 0), ("b", 1_000), ("c", 2_000)] {
            let expires_at = iso_from_epoch_ms(NOW + dt);
            sessions
                .create(&input(token, &expires_at), NOW)
                .await
                .unwrap();
        }

        // Cutoff = NOW+1s ⇒ deletes "a" and "b" (`expires_at <= cutoff`),
        // keeps "c".
        let cutoff = iso_from_epoch_ms(NOW + 1_000);
        assert_eq!(sessions.prune_expired(&cutoff).await.unwrap(), 2);
        assert!(sessions.read_any("a").await.unwrap().is_none());
        assert!(sessions.read_any("b").await.unwrap().is_none());
        assert!(sessions.read_any("c").await.unwrap().is_some());
    }
}
