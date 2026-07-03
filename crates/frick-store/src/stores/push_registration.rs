//! Push-notification device registrations
//! (`apps/server/src/storage/push-registration-store.ts`; map 03 §5 and §9.9).
//!
//! One *active* row per `(tenant_id, user_id, device_id, platform)` — uniqueness
//! is enforced by the partial unique index from migration `0007` (only over rows
//! where `revoked_at IS NULL`). [`PushRegistrationStore::register`] is
//! upsert-by-reactivation: an existing active row is refreshed in place (keeping
//! a stable `registration_id`); otherwise a fresh row is inserted. Revoked rows
//! are TOMBSTONES — kept forever so operators can audit "was this token ever
//! registered to this user" even after a logout.
//!
//! Determinism: the TS class calls `randomUUID()` and `new Date().toISOString()`
//! internally; here the caller injects both. [`PushRegistrationStore::register`]
//! takes a `new_registration_id` (the facade passes `"push-" + uuid`) used ONLY
//! when a fresh row is inserted, plus `now_ms` for every timestamp. The other
//! mutators take `now_ms`. Store logic never touches the clock or a CSPRNG.

use crate::driver::{SqlDriver, SqlRow};
use crate::encryption::AtRestEncryption;
use crate::error::StoreError;
use crate::stores::blob_bytes::iso_from_epoch_ms;

/// `PushPlatform` (push-registration-store.ts:20). The wire literals are
/// `"apns" | "fcm" | "webPush" | "test"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushPlatform {
    Apns,
    Fcm,
    WebPush,
    Test,
}

impl PushPlatform {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Apns => "apns",
            Self::Fcm => "fcm",
            Self::WebPush => "webPush",
            Self::Test => "test",
        }
    }

    /// `isPushPlatform` (push-registration-store.ts:56-58): parse a wire literal.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "apns" => Some(Self::Apns),
            "fcm" => Some(Self::Fcm),
            "webPush" => Some(Self::WebPush),
            "test" => Some(Self::Test),
            _ => None,
        }
    }
}

/// `PUSH_PLATFORMS` (push-registration-store.ts:54): the canonical platform set,
/// in declaration order.
pub const PUSH_PLATFORMS: [PushPlatform; 4] = [
    PushPlatform::Apns,
    PushPlatform::Fcm,
    PushPlatform::WebPush,
    PushPlatform::Test,
];

/// `PushEnvironment` (push-registration-store.ts:21): `"production" | "sandbox"`.
/// The `push_device_registrations.environment` column defaults to `'production'`
/// at the schema level (migration 0007); see [`PushEnvironment::default`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PushEnvironment {
    #[default]
    Production,
    Sandbox,
}

impl PushEnvironment {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Production => "production",
            Self::Sandbox => "sandbox",
        }
    }

    /// Parse the stored `environment` column. Falls back to the
    /// schema-default `production` for any value other than `"sandbox"` —
    /// matching the column default and the TS cast (`row.environment as
    /// PushEnvironment` with the DEFAULT 'production').
    #[must_use]
    pub fn from_column(value: &str) -> Self {
        match value {
            "sandbox" => Self::Sandbox,
            _ => Self::Production,
        }
    }
}

/// `PushDeviceRegistration` (push-registration-store.ts:23-34). `revoked_at` is
/// `None` for an active row (the TS mapper omits the key when NULL).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushDeviceRegistration {
    pub registration_id: String,
    pub tenant_id: String,
    pub user_id: String,
    pub device_id: String,
    pub platform: PushPlatform,
    pub token: String,
    pub environment: PushEnvironment,
    pub created_at: String,
    pub last_seen_at: String,
    pub revoked_at: Option<String>,
}

/// `PushRegistrationInput` (push-registration-store.ts:36-39): the
/// caller-supplied fields for [`PushRegistrationStore::register`] (everything
/// except the server-assigned id and timestamps).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushRegistrationInput {
    pub tenant_id: String,
    pub user_id: String,
    pub device_id: String,
    pub platform: PushPlatform,
    pub token: String,
    pub environment: PushEnvironment,
}

/// `PushRegistrationStore` (`storage/push-registration-store.ts`).
pub struct PushRegistrationStore {
    sql: std::sync::Arc<SqlDriver>,
    /// Optional at-rest encryption engine (AURA-328). When set, the `token`
    /// column is sealed under the tenant-derived key on write and opened on
    /// read; legacy plaintext tokens pass through untouched.
    encryption: Option<std::sync::Arc<AtRestEncryption>>,
}

impl PushRegistrationStore {
    #[must_use]
    pub fn new(sql: std::sync::Arc<SqlDriver>) -> Self {
        Self {
            sql,
            encryption: None,
        }
    }

    /// Attach (or detach) the at-rest encryption engine; the facade threads
    /// its configured engine through here at construction.
    #[must_use]
    pub fn with_encryption(mut self, encryption: Option<std::sync::Arc<AtRestEncryption>>) -> Self {
        self.encryption = encryption;
        self
    }

    /// Seal a token for storage, or pass it through when encryption is off.
    fn seal_token(&self, tenant_id: &str, token: &str) -> Result<String, StoreError> {
        match &self.encryption {
            Some(encryption) => encryption.encrypt_text(tenant_id, token),
            None => Ok(token.to_owned()),
        }
    }

    /// Map a `SELECT *` row and open its token (legacy plaintext rows pass
    /// through). The tenant id comes from the row itself, so every read path
    /// decrypts under the tenant that owns the registration.
    fn map_row_opened(&self, row: &SqlRow) -> Result<PushDeviceRegistration, StoreError> {
        let mut registration = map_row(row);
        if let Some(encryption) = &self.encryption {
            registration.token =
                encryption.decrypt_text(&registration.tenant_id, &registration.token)?;
        }
        Ok(registration)
    }

    /// `register` (push-registration-store.ts:78-125): reactivate-or-refresh.
    ///
    /// - If an active row already exists for `(tenant, user, device, platform)`,
    ///   refresh its `token`/`environment`/`last_seen_at` in place and return it
    ///   — the `registration_id` stays STABLE so a caller that stored an id can
    ///   still revoke by id.
    /// - Otherwise insert a fresh row with `new_registration_id` (the facade
    ///   passes `"push-" + uuid`).
    ///
    /// Tombstoned (revoked) rows are never reactivated — a new active row is
    /// inserted alongside the tombstone, preserving the original
    /// `revoked_at`. `now_ms` stamps `created_at`/`last_seen_at`;
    /// `new_registration_id` is used ONLY on the insert branch.
    pub async fn register(
        &self,
        input: &PushRegistrationInput,
        new_registration_id: &str,
        now_ms: i64,
    ) -> Result<PushDeviceRegistration, StoreError> {
        let existing = self
            .find_active(
                &input.tenant_id,
                &input.user_id,
                &input.device_id,
                input.platform,
            )
            .await?;
        let now = iso_from_epoch_ms(now_ms);
        let stored_token = self.seal_token(&input.tenant_id, &input.token)?;
        if let Some(existing) = existing {
            self.sql
                .run(
                    "UPDATE push_device_registrations\n             SET token = ?, environment = ?, last_seen_at = ?\n             WHERE registration_id = ?",
                    &[
                        stored_token.as_str().into(),
                        input.environment.as_str().into(),
                        now.as_str().into(),
                        existing.registration_id.as_str().into(),
                    ],
                )
                .await?;
            return Ok(PushDeviceRegistration {
                token: input.token.clone(),
                environment: input.environment,
                last_seen_at: now,
                ..existing
            });
        }
        self.sql
            .run(
                "INSERT INTO push_device_registrations\n            (registration_id, tenant_id, user_id, device_id, platform, token,\n             environment, created_at, last_seen_at)\n          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                &[
                    new_registration_id.into(),
                    input.tenant_id.as_str().into(),
                    input.user_id.as_str().into(),
                    input.device_id.as_str().into(),
                    input.platform.as_str().into(),
                    stored_token.as_str().into(),
                    input.environment.as_str().into(),
                    now.as_str().into(),
                    now.as_str().into(),
                ],
            )
            .await?;
        Ok(PushDeviceRegistration {
            registration_id: new_registration_id.to_owned(),
            tenant_id: input.tenant_id.clone(),
            user_id: input.user_id.clone(),
            device_id: input.device_id.clone(),
            platform: input.platform,
            token: input.token.clone(),
            environment: input.environment,
            created_at: now.clone(),
            last_seen_at: now,
            revoked_at: None,
        })
    }

    /// `revoke` (push-registration-store.ts:136-145): tenant-scoped soft-revoke.
    /// Returns `true` only when a row was moved from active → revoked on THIS
    /// call (the guarded `WHERE … revoked_at IS NULL` makes a second revoke, an
    /// absent row, or another tenant's row a no-op returning `false`). Idempotent
    /// — the original `revoked_at` is never overwritten. `now_ms` stamps
    /// `revoked_at`.
    pub async fn revoke(
        &self,
        registration_id: &str,
        tenant_id: &str,
        now_ms: i64,
    ) -> Result<bool, StoreError> {
        let now = iso_from_epoch_ms(now_ms);
        let result = self
            .sql
            .run(
                "UPDATE push_device_registrations\n            SET revoked_at = ?\n            WHERE registration_id = ? AND tenant_id = ? AND revoked_at IS NULL",
                &[now.as_str().into(), registration_id.into(), tenant_id.into()],
            )
            .await?;
        Ok(result.changes > 0)
    }

    /// `getById` (push-registration-store.ts:148-159): one row by
    /// `(registration_id, tenant_id)` regardless of revocation state, or `None`.
    pub async fn get_by_id(
        &self,
        registration_id: &str,
        tenant_id: &str,
    ) -> Result<Option<PushDeviceRegistration>, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT * FROM push_device_registrations\n          WHERE registration_id = ? AND tenant_id = ?\n          LIMIT 1",
                &[registration_id.into(), tenant_id.into()],
            )
            .await?;
        row.as_ref().map(|row| self.map_row_opened(row)).transpose()
    }

    /// `listByUser` (push-registration-store.ts:162-170): a user's ACTIVE
    /// registrations (tombstones excluded), `ORDER BY created_at ASC`.
    pub async fn list_by_user(
        &self,
        tenant_id: &str,
        user_id: &str,
    ) -> Result<Vec<PushDeviceRegistration>, StoreError> {
        let rows = self
            .sql
            .all(
                "SELECT * FROM push_device_registrations\n          WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL\n          ORDER BY created_at ASC",
                &[tenant_id.into(), user_id.into()],
            )
            .await?;
        rows.iter().map(|row| self.map_row_opened(row)).collect()
    }

    /// `touch` (push-registration-store.ts:173-181): bump `last_seen_at` after a
    /// successful delivery. Tenant-scoped; affects any matching row (revoked or
    /// not — mirroring the TS, which omits the `revoked_at IS NULL` guard here).
    /// `now_ms` stamps `last_seen_at`.
    pub async fn touch(
        &self,
        registration_id: &str,
        tenant_id: &str,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        let now = iso_from_epoch_ms(now_ms);
        self.sql
            .run(
                "UPDATE push_device_registrations\n            SET last_seen_at = ?\n            WHERE registration_id = ? AND tenant_id = ?",
                &[now.as_str().into(), registration_id.into(), tenant_id.into()],
            )
            .await?;
        Ok(())
    }

    /// `findActive` (push-registration-store.ts:183-197): the active row for
    /// `(tenant, user, device, platform)`, or `None`.
    async fn find_active(
        &self,
        tenant_id: &str,
        user_id: &str,
        device_id: &str,
        platform: PushPlatform,
    ) -> Result<Option<PushDeviceRegistration>, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT * FROM push_device_registrations\n          WHERE tenant_id = ? AND user_id = ? AND device_id = ? AND platform = ?\n            AND revoked_at IS NULL\n          LIMIT 1",
                &[
                    tenant_id.into(),
                    user_id.into(),
                    device_id.into(),
                    platform.as_str().into(),
                ],
            )
            .await?;
        row.as_ref().map(|row| self.map_row_opened(row)).transpose()
    }
}

/// `mapRow` (push-registration-store.ts:200-214): `SELECT *` row →
/// [`PushDeviceRegistration`]. NULL/empty `revoked_at` becomes `None` (the TS
/// `if (row.revoked_at)` treats both NULL and empty string as absent).
fn map_row(row: &SqlRow) -> PushDeviceRegistration {
    let revoked_at = row
        .text("revoked_at")
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    PushDeviceRegistration {
        registration_id: row.text("registration_id").unwrap_or_default().to_owned(),
        tenant_id: row.text("tenant_id").unwrap_or_default().to_owned(),
        user_id: row.text("user_id").unwrap_or_default().to_owned(),
        device_id: row.text("device_id").unwrap_or_default().to_owned(),
        platform: row
            .text("platform")
            .and_then(PushPlatform::parse)
            .unwrap_or(PushPlatform::Test),
        token: row.text("token").unwrap_or_default().to_owned(),
        environment: row
            .text("environment")
            .map_or(PushEnvironment::Production, PushEnvironment::from_column),
        created_at: row.text("created_at").unwrap_or_default().to_owned(),
        last_seen_at: row.text("last_seen_at").unwrap_or_default().to_owned(),
        revoked_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    // Effective post-0007 SQLite schema for `push_device_registrations` (map
    // 03 §5), including the partial unique index over active rows.
    const SCHEMA: &str = "
        CREATE TABLE push_device_registrations (
          registration_id TEXT PRIMARY KEY NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT '_default',
          user_id TEXT NOT NULL,
          device_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          token TEXT NOT NULL,
          environment TEXT NOT NULL DEFAULT 'production',
          created_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          revoked_at TEXT
        );
        CREATE UNIQUE INDEX idx_push_active
          ON push_device_registrations (tenant_id, user_id, device_id, platform)
          WHERE revoked_at IS NULL;
        CREATE INDEX idx_push_user
          ON push_device_registrations (tenant_id, user_id)
          WHERE revoked_at IS NULL;";

    const TENANT: &str = "tenant-1";
    const NOW: i64 = 1_700_000_000_123;

    async fn store() -> PushRegistrationStore {
        let sql = Arc::new(SqlDriver::open_sqlite(":memory:").unwrap());
        sql.exec(SCHEMA).await.unwrap();
        PushRegistrationStore::new(sql)
    }

    fn input(device: &str, token: &str) -> PushRegistrationInput {
        PushRegistrationInput {
            tenant_id: TENANT.to_owned(),
            user_id: "user-1".to_owned(),
            device_id: device.to_owned(),
            platform: PushPlatform::Apns,
            token: token.to_owned(),
            environment: PushEnvironment::Production,
        }
    }

    // ── platform / environment parsing ───────────────────────────────────────

    #[test]
    fn platform_round_trips_wire_literals() {
        for p in PUSH_PLATFORMS {
            assert_eq!(PushPlatform::parse(p.as_str()), Some(p));
        }
        assert_eq!(PushPlatform::parse("unknown"), None);
        assert_eq!(PushPlatform::WebPush.as_str(), "webPush");
    }

    #[test]
    fn environment_defaults_to_production() {
        assert_eq!(PushEnvironment::default(), PushEnvironment::Production);
        assert_eq!(
            PushEnvironment::from_column("sandbox"),
            PushEnvironment::Sandbox
        );
        // Anything else (incl. the column default) reads as production.
        assert_eq!(
            PushEnvironment::from_column("production"),
            PushEnvironment::Production
        );
        assert_eq!(
            PushEnvironment::from_column("garbage"),
            PushEnvironment::Production
        );
    }

    // ── register: insert, refresh-in-place, stable id ────────────────────────

    #[tokio::test]
    async fn register_inserts_with_supplied_id_and_round_trips() {
        let store = store().await;
        let reg = store
            .register(&input("dev-1", "tok-1"), "push-fixed-1", NOW)
            .await
            .unwrap();
        assert_eq!(
            reg,
            PushDeviceRegistration {
                registration_id: "push-fixed-1".to_owned(),
                tenant_id: TENANT.to_owned(),
                user_id: "user-1".to_owned(),
                device_id: "dev-1".to_owned(),
                platform: PushPlatform::Apns,
                token: "tok-1".to_owned(),
                environment: PushEnvironment::Production,
                created_at: iso_from_epoch_ms(NOW),
                last_seen_at: iso_from_epoch_ms(NOW),
                revoked_at: None,
            }
        );
        assert_eq!(
            store.get_by_id("push-fixed-1", TENANT).await.unwrap(),
            Some(reg)
        );
    }

    #[tokio::test]
    async fn register_refreshes_active_row_in_place_keeping_stable_id() {
        let store = store().await;
        store
            .register(&input("dev-1", "tok-1"), "push-fixed-1", NOW)
            .await
            .unwrap();

        // Re-register the same (tenant, user, device, platform) with a NEW
        // token/env and a fresh candidate id: the id is IGNORED, the existing
        // row is refreshed in place.
        let mut updated = input("dev-1", "tok-2");
        updated.environment = PushEnvironment::Sandbox;
        let reg = store
            .register(&updated, "push-IGNORED", NOW + 5_000)
            .await
            .unwrap();
        assert_eq!(reg.registration_id, "push-fixed-1");
        assert_eq!(reg.token, "tok-2");
        assert_eq!(reg.environment, PushEnvironment::Sandbox);
        assert_eq!(reg.last_seen_at, iso_from_epoch_ms(NOW + 5_000));
        // created_at is preserved from the original insert.
        assert_eq!(reg.created_at, iso_from_epoch_ms(NOW));

        // Exactly one row exists (the candidate id was never inserted).
        assert!(
            store
                .get_by_id("push-IGNORED", TENANT)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(store.list_by_user(TENANT, "user-1").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn register_after_revoke_inserts_new_row_keeping_tombstone() {
        let store = store().await;
        store
            .register(&input("dev-1", "tok-1"), "push-old", NOW)
            .await
            .unwrap();
        assert!(store.revoke("push-old", TENANT, NOW + 1_000).await.unwrap());

        // A new registration for the same tuple inserts a fresh active row; the
        // tombstone stays.
        let reg = store
            .register(&input("dev-1", "tok-2"), "push-new", NOW + 2_000)
            .await
            .unwrap();
        assert_eq!(reg.registration_id, "push-new");
        assert_eq!(reg.revoked_at, None);

        // Tombstone is still there with its original revoked_at.
        let tombstone = store.get_by_id("push-old", TENANT).await.unwrap().unwrap();
        assert_eq!(tombstone.revoked_at, Some(iso_from_epoch_ms(NOW + 1_000)));
        // Only the new row is active.
        let active: Vec<String> = store
            .list_by_user(TENANT, "user-1")
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.registration_id)
            .collect();
        assert_eq!(active, ["push-new"]);
    }

    // ── revoke: tenant-scoped, true only active→revoked ──────────────────────

    #[tokio::test]
    async fn revoke_is_tenant_scoped_and_idempotent() {
        let store = store().await;
        store
            .register(&input("dev-1", "tok-1"), "push-1", NOW)
            .await
            .unwrap();

        // Wrong tenant ⇒ no transition, false.
        assert!(
            !store
                .revoke("push-1", "other-tenant", NOW + 1_000)
                .await
                .unwrap()
        );
        // Unknown id ⇒ false.
        assert!(!store.revoke("ghost", TENANT, NOW + 1_000).await.unwrap());

        // First real revoke ⇒ true, stamps revoked_at.
        assert!(store.revoke("push-1", TENANT, NOW + 1_000).await.unwrap());
        let row = store.get_by_id("push-1", TENANT).await.unwrap().unwrap();
        assert_eq!(row.revoked_at, Some(iso_from_epoch_ms(NOW + 1_000)));

        // Second revoke ⇒ false (already revoked), timestamp preserved.
        assert!(!store.revoke("push-1", TENANT, NOW + 9_000).await.unwrap());
        assert_eq!(
            store
                .get_by_id("push-1", TENANT)
                .await
                .unwrap()
                .unwrap()
                .revoked_at,
            Some(iso_from_epoch_ms(NOW + 1_000))
        );
    }

    // ── listByUser: active only, created_at ASC ──────────────────────────────

    #[tokio::test]
    async fn list_by_user_returns_active_only_ordered_by_created_at() {
        let store = store().await;
        // Three devices at distinct created_at; one gets revoked.
        store
            .register(&input("dev-b", "t"), "push-b", NOW + 1_000)
            .await
            .unwrap();
        store
            .register(&input("dev-a", "t"), "push-a", NOW)
            .await
            .unwrap();
        store
            .register(&input("dev-c", "t"), "push-c", NOW + 2_000)
            .await
            .unwrap();
        store.revoke("push-c", TENANT, NOW + 3_000).await.unwrap();

        let ids: Vec<String> = store
            .list_by_user(TENANT, "user-1")
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.registration_id)
            .collect();
        // created_at ASC; push-c excluded (revoked).
        assert_eq!(ids, ["push-a", "push-b"]);
        // A different user sees nothing.
        assert!(
            store
                .list_by_user(TENANT, "user-2")
                .await
                .unwrap()
                .is_empty()
        );
    }

    // ── getById: any state, tenant-scoped ────────────────────────────────────

    #[tokio::test]
    async fn get_by_id_returns_revoked_rows_and_is_tenant_scoped() {
        let store = store().await;
        store
            .register(&input("dev-1", "tok-1"), "push-1", NOW)
            .await
            .unwrap();
        store.revoke("push-1", TENANT, NOW + 1).await.unwrap();
        // getById ignores revocation state.
        assert!(store.get_by_id("push-1", TENANT).await.unwrap().is_some());
        // Wrong tenant ⇒ None.
        assert!(store.get_by_id("push-1", "other").await.unwrap().is_none());
    }

    // ── touch: bumps last_seen_at, tenant-scoped ─────────────────────────────

    #[tokio::test]
    async fn touch_bumps_last_seen_at_only_for_matching_tenant() {
        let store = store().await;
        store
            .register(&input("dev-1", "tok-1"), "push-1", NOW)
            .await
            .unwrap();

        store.touch("push-1", TENANT, NOW + 5_000).await.unwrap();
        assert_eq!(
            store
                .get_by_id("push-1", TENANT)
                .await
                .unwrap()
                .unwrap()
                .last_seen_at,
            iso_from_epoch_ms(NOW + 5_000)
        );

        // Wrong tenant ⇒ no change.
        store.touch("push-1", "other", NOW + 9_000).await.unwrap();
        assert_eq!(
            store
                .get_by_id("push-1", TENANT)
                .await
                .unwrap()
                .unwrap()
                .last_seen_at,
            iso_from_epoch_ms(NOW + 5_000)
        );
    }
}
