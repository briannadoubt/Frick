//! `PresenceStore` (`apps/server/src/storage/presence-store.ts`, map 03 §8.4).
//!
//! App partitioning (FR-153): every method takes an `app_id` (the TS class
//! defaults it to `_default`; the Rust facade supplies that default). Reads
//! filter by `app_id`; writes stamp it. The `presence_leases` PRIMARY KEY is
//! `(app_id, tenant_id, presence_type, presence_key)` as of migration 0023 —
//! app_id is part of the key, so two apps holding a lease at the same
//! (tenant, type, key) occupy DISTINCT rows. `set`'s ON CONFLICT can therefore
//! only match a row of the same app, so app B can neither overwrite nor evict
//! app A's lease (server-storage-3), and `read`/`clear` filter by app_id so
//! app A never observes or clears app B's presence at the same key.
//!
//! Timestamps: the TS class calls `Date.now()` inline; here every
//! time-sensitive method takes `now_ms` so store logic never reads system
//! time (that belongs at the facade boundary).

use frick_protocol::{
    FrickSchema, PackedPresenceRecord, ProtocolError, Value, pack_presence_record,
    unpack_presence_record,
};

use crate::driver::SqlDriver;
use crate::error::StoreError;
use crate::packed::{decode_packed, encode_packed};

pub struct PresenceStore<'a> {
    sql: &'a SqlDriver,
    schema: &'a FrickSchema,
}

impl<'a> PresenceStore<'a> {
    #[must_use]
    pub const fn new(sql: &'a SqlDriver, schema: &'a FrickSchema) -> Self {
        Self { sql, schema }
    }

    /// UPSERT a lease; `expires_at = now_ms + ttl_ms` (INTEGER epoch ms).
    // The TS signature already carries six parameters; the injected clock is
    // the seventh-plus-receiver — grouping them would diverge from the port.
    #[expect(clippy::too_many_arguments)]
    pub async fn set(
        &self,
        tenant_id: &str,
        presence_type: &str,
        presence_key: &str,
        value: &Value,
        ttl_ms: i64,
        app_id: &str,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        let packed = pack_presence_record(self.schema, presence_type, presence_key, value)
            .map_err(|err| protocol_error(&err))?;
        self.sql
            .run(
                "INSERT INTO presence_leases
          (app_id, tenant_id, presence_type, presence_key, packed, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(app_id, tenant_id, presence_type, presence_key) DO UPDATE SET
            packed = excluded.packed,
            expires_at = excluded.expires_at",
                &[
                    app_id.into(),
                    tenant_id.into(),
                    presence_type.into(),
                    presence_key.into(),
                    encode_packed(&packed)?.into(),
                    (now_ms + ttl_ms).into(),
                ],
            )
            .await?;
        Ok(())
    }

    /// Read a live lease. Returns `None` AND **lazily deletes** the row when
    /// `expires_at <= now_ms` (TS lines 68-71).
    pub async fn read(
        &self,
        tenant_id: &str,
        presence_type: &str,
        presence_key: &str,
        app_id: &str,
        now_ms: i64,
    ) -> Result<Option<Value>, StoreError> {
        let Some(row) = self
            .sql
            .get(
                "SELECT packed, expires_at FROM presence_leases WHERE app_id = ? AND tenant_id = ? AND presence_type = ? AND presence_key = ?",
                &[app_id.into(), tenant_id.into(), presence_type.into(), presence_key.into()],
            )
            .await?
        else {
            return Ok(None);
        };
        if row
            .i64("expires_at")
            .is_some_and(|expires_at| expires_at <= now_ms)
        {
            self.clear(tenant_id, presence_type, presence_key, app_id)
                .await?;
            return Ok(None);
        }
        let packed: PackedPresenceRecord = decode_packed(
            row.blob("packed")
                .ok_or_else(|| StoreError::driver("presence_leases.packed missing"))?,
        )?;
        let record =
            unpack_presence_record(self.schema, &packed).map_err(|err| protocol_error(&err))?;
        Ok(Some(record.value))
    }

    /// DELETE by full app-scoped key.
    pub async fn clear(
        &self,
        tenant_id: &str,
        presence_type: &str,
        presence_key: &str,
        app_id: &str,
    ) -> Result<(), StoreError> {
        self.sql
            .run(
                "DELETE FROM presence_leases WHERE app_id = ? AND tenant_id = ? AND presence_type = ? AND presence_key = ?",
                &[app_id.into(), tenant_id.into(), presence_type.into(), presence_key.into()],
            )
            .await?;
        Ok(())
    }
}

/// TS protocol helpers throw plain `Error`s; their `Display` text is the
/// contract, so the message carries over verbatim.
fn protocol_error(err: &ProtocolError) -> StoreError {
    StoreError::store(err.message())
}

#[cfg(test)]
mod tests {
    use frick_protocol::schema::{FieldDef, FieldKind, PresenceDef};

    use super::*;

    /// Effective `presence_leases` DDL (map 03 §5; migration 0023 rebuild).
    const DDL: &str = "
      CREATE TABLE presence_leases (
        app_id TEXT NOT NULL DEFAULT '_default',
        tenant_id TEXT NOT NULL DEFAULT '_default',
        presence_type TEXT NOT NULL,
        presence_key TEXT NOT NULL,
        packed BLOB NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (app_id, tenant_id, presence_type, presence_key)
      );
      CREATE INDEX idx_presence_leases_app_tenant
        ON presence_leases (app_id, tenant_id, presence_type, presence_key);
    ";

    const TENANT: &str = "tenant-1";
    const TYPE: &str = "TypingState";
    const KEY_A: &str = "conversation-general:user-ada:device-1";
    const KEY_B: &str = "conversation-general:user-grace:device-2";
    const DEFAULT_APP_ID: &str = "_default";
    const NOW: i64 = 1_700_000_000_000;

    fn field(id: i64, name: &str, kind: FieldKind, required: bool) -> FieldDef {
        FieldDef {
            id,
            name: name.into(),
            kind,
            required,
            ref_: None,
            enum_values: None,
            sensitivity: None,
        }
    }

    fn ref_field(id: i64, name: &str, target: &str) -> FieldDef {
        FieldDef {
            ref_: Some(target.into()),
            ..field(id, name, FieldKind::Ref, true)
        }
    }

    /// The `TypingState` presence from `productTestSchema`
    /// (`packages/protocol/src/fixtures/product-test-schema.ts`).
    fn test_schema() -> FrickSchema {
        FrickSchema {
            name: "product-test".into(),
            schema_id: "product-test".into(),
            schema_version: "1.0.0".into(),
            schema_revision: 1,
            minimum_client_revision: 1,
            minimum_server_revision: 1,
            protocol: "frick.realtime".into(),
            protocol_version: 1,
            compatibility: "greenfield-cutover".into(),
            hash: "test-hash".into(),
            objects: vec![],
            streams: vec![],
            events: vec![],
            presences: vec![PresenceDef {
                id: 1,
                name: "TypingState".into(),
                key_fields: vec![
                    ref_field(1, "conversationId", "Conversation"),
                    ref_field(2, "userId", "User"),
                    field(3, "deviceId", FieldKind::String, true),
                ],
                fields: vec![field(1, "isTyping", FieldKind::Bool, true)],
                ttl_ms: 5000,
            }],
            signals: vec![],
            blobs: vec![],
            jobs: vec![],
            projections: vec![],
        }
    }

    async fn memory_driver() -> SqlDriver {
        let driver = SqlDriver::open_sqlite(":memory:").unwrap();
        driver.exec(DDL).await.unwrap();
        driver
    }

    fn typing(is_typing: bool) -> Value {
        Value::Map(vec![("isTyping".into(), Value::Boolean(is_typing))])
    }

    async fn lease_count(driver: &SqlDriver) -> i64 {
        driver
            .get("SELECT COUNT(*) AS n FROM presence_leases", &[])
            .await
            .unwrap()
            .unwrap()
            .i64("n")
            .unwrap()
    }

    /// Port of "stamps app_id and isolates reads across apps"
    /// (`apps/server/tests/app-scoping-tail-stores.test.ts`).
    #[tokio::test]
    async fn stamps_app_id_and_isolates_reads_across_apps() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let presence = PresenceStore::new(&driver, &schema);

        presence
            .set(TENANT, TYPE, KEY_A, &typing(true), 60_000, "app-a", NOW)
            .await
            .unwrap();
        presence
            .set(TENANT, TYPE, KEY_B, &typing(false), 60_000, "app-b", NOW)
            .await
            .unwrap();

        // Each app reads only its own lease; cross-app reads return None.
        assert_eq!(
            presence
                .read(TENANT, TYPE, KEY_A, "app-a", NOW)
                .await
                .unwrap(),
            Some(typing(true))
        );
        assert_eq!(
            presence
                .read(TENANT, TYPE, KEY_A, "app-b", NOW)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            presence
                .read(TENANT, TYPE, KEY_B, "app-b", NOW)
                .await
                .unwrap(),
            Some(typing(false))
        );
        assert_eq!(
            presence
                .read(TENANT, TYPE, KEY_B, "app-a", NOW)
                .await
                .unwrap(),
            None
        );
        // Default app sees neither.
        assert_eq!(
            presence
                .read(TENANT, TYPE, KEY_A, DEFAULT_APP_ID, NOW)
                .await
                .unwrap(),
            None
        );

        // Clearing under app-b (wrong app for KEY_A) is a no-op; the owning
        // app's lease survives.
        presence.clear(TENANT, TYPE, KEY_A, "app-b").await.unwrap();
        assert_eq!(
            presence
                .read(TENANT, TYPE, KEY_A, "app-a", NOW)
                .await
                .unwrap(),
            Some(typing(true))
        );
        presence.clear(TENANT, TYPE, KEY_A, "app-a").await.unwrap();
        assert_eq!(
            presence
                .read(TENANT, TYPE, KEY_A, "app-a", NOW)
                .await
                .unwrap(),
            None
        );
    }

    /// Port of "defaults to '_default' so single-app callers are unaffected".
    #[tokio::test]
    async fn default_app_callers_round_trip() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let presence = PresenceStore::new(&driver, &schema);

        presence
            .set(
                TENANT,
                TYPE,
                KEY_A,
                &typing(true),
                60_000,
                DEFAULT_APP_ID,
                NOW,
            )
            .await
            .unwrap();
        assert_eq!(
            presence
                .read(TENANT, TYPE, KEY_A, DEFAULT_APP_ID, NOW)
                .await
                .unwrap(),
            Some(typing(true))
        );
    }

    /// server-storage-3: the PK includes app_id, so two apps at the same
    /// (tenant, type, key) hold DISTINCT rows and set() can't clobber across.
    #[tokio::test]
    async fn two_apps_hold_distinct_leases_at_the_same_key() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let presence = PresenceStore::new(&driver, &schema);

        presence
            .set(TENANT, TYPE, KEY_A, &typing(true), 60_000, "app-a", NOW)
            .await
            .unwrap();
        presence
            .set(TENANT, TYPE, KEY_A, &typing(false), 60_000, "app-b", NOW)
            .await
            .unwrap();

        assert_eq!(lease_count(&driver).await, 2);
        assert_eq!(
            presence
                .read(TENANT, TYPE, KEY_A, "app-a", NOW)
                .await
                .unwrap(),
            Some(typing(true))
        );
        assert_eq!(
            presence
                .read(TENANT, TYPE, KEY_A, "app-b", NOW)
                .await
                .unwrap(),
            Some(typing(false))
        );
    }

    #[tokio::test]
    async fn set_upserts_packed_and_expires_at() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let presence = PresenceStore::new(&driver, &schema);

        presence
            .set(TENANT, TYPE, KEY_A, &typing(true), 1_000, "app-a", NOW)
            .await
            .unwrap();
        presence
            .set(TENANT, TYPE, KEY_A, &typing(false), 60_000, "app-a", NOW)
            .await
            .unwrap();

        assert_eq!(lease_count(&driver).await, 1);
        // The refreshed expiry keeps the lease alive past the original TTL.
        assert_eq!(
            presence
                .read(TENANT, TYPE, KEY_A, "app-a", NOW + 30_000)
                .await
                .unwrap(),
            Some(typing(false))
        );
    }

    /// `read` returns None AND lazily deletes once `expires_at <= now`
    /// (presence-store.ts lines 68-71); the boundary is inclusive.
    #[tokio::test]
    async fn read_expires_lazily_at_the_boundary() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let presence = PresenceStore::new(&driver, &schema);

        presence
            .set(TENANT, TYPE, KEY_A, &typing(true), 5_000, "app-a", NOW)
            .await
            .unwrap();

        // Strictly before expiry the lease is live.
        assert_eq!(
            presence
                .read(TENANT, TYPE, KEY_A, "app-a", NOW + 4_999)
                .await
                .unwrap(),
            Some(typing(true))
        );
        assert_eq!(lease_count(&driver).await, 1);

        // At exactly expires_at the lease is expired — and swept.
        assert_eq!(
            presence
                .read(TENANT, TYPE, KEY_A, "app-a", NOW + 5_000)
                .await
                .unwrap(),
            None
        );
        assert_eq!(lease_count(&driver).await, 0);

        // The sweep is durable: even an earlier clock finds nothing.
        assert_eq!(
            presence
                .read(TENANT, TYPE, KEY_A, "app-a", NOW)
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn isolates_tenants() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let presence = PresenceStore::new(&driver, &schema);

        presence
            .set(
                "tenant-1",
                TYPE,
                KEY_A,
                &typing(true),
                60_000,
                DEFAULT_APP_ID,
                NOW,
            )
            .await
            .unwrap();
        presence
            .set(
                "tenant-2",
                TYPE,
                KEY_A,
                &typing(false),
                60_000,
                DEFAULT_APP_ID,
                NOW,
            )
            .await
            .unwrap();

        assert_eq!(
            presence
                .read("tenant-1", TYPE, KEY_A, DEFAULT_APP_ID, NOW)
                .await
                .unwrap(),
            Some(typing(true))
        );
        assert_eq!(
            presence
                .read("tenant-2", TYPE, KEY_A, DEFAULT_APP_ID, NOW)
                .await
                .unwrap(),
            Some(typing(false))
        );

        presence
            .clear("tenant-1", TYPE, KEY_A, DEFAULT_APP_ID)
            .await
            .unwrap();
        assert_eq!(
            presence
                .read("tenant-1", TYPE, KEY_A, DEFAULT_APP_ID, NOW)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            presence
                .read("tenant-2", TYPE, KEY_A, DEFAULT_APP_ID, NOW)
                .await
                .unwrap(),
            Some(typing(false))
        );
    }

    /// Unknown presence names surface the TS codec error message verbatim.
    #[tokio::test]
    async fn unknown_presence_type_matches_ts_error() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let presence = PresenceStore::new(&driver, &schema);

        let error = presence
            .set(
                TENANT,
                "Nope",
                KEY_A,
                &typing(true),
                5_000,
                DEFAULT_APP_ID,
                NOW,
            )
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Unknown presence: Nope");
    }
}
