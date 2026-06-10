//! `SignalStore` (`apps/server/src/storage/signal-store.ts`, map 03 §8.5).
//!
//! App partitioning (FR-153): every method takes an `app_id` (the TS class
//! defaults it to `_default`; the Rust facade supplies that default).
//! `enqueue` stamps `app_id`; `drain` filters by it (and only deletes rows it
//! drained), so app A can neither read nor consume app B's queued signals at
//! the same (tenant, type, key).
//!
//! Timestamps: the TS class calls `Date.now()` inline; here every
//! time-sensitive method takes `now_ms` so store logic never reads system
//! time (that belongs at the facade boundary).

use frick_protocol::{
    FrickSchema, PackedSignalEnvelope, ProtocolError, Value, pack_signal_envelope,
    unpack_signal_envelope,
};

use crate::driver::SqlDriver;
use crate::error::StoreError;
use crate::packed::{decode_packed, encode_packed};

pub struct SignalStore<'a> {
    sql: &'a SqlDriver,
    schema: &'a FrickSchema,
}

impl<'a> SignalStore<'a> {
    #[must_use]
    pub const fn new(sql: &'a SqlDriver, schema: &'a FrickSchema) -> Self {
        Self { sql, schema }
    }

    /// Plain INSERT; `expires_at = now_ms + ttl_ms` (INTEGER epoch ms).
    // The TS signature already carries six parameters; the injected clock is
    // the seventh-plus-receiver — grouping them would diverge from the port.
    #[expect(clippy::too_many_arguments)]
    pub async fn enqueue(
        &self,
        tenant_id: &str,
        signal_type: &str,
        signal_key: &str,
        value: &Value,
        ttl_ms: i64,
        app_id: &str,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        let packed = pack_signal_envelope(self.schema, signal_type, signal_key, value)
            .map_err(|err| protocol_error(&err))?;
        self.sql
            .run(
                "INSERT INTO signal_outbox (app_id, tenant_id, signal_type, signal_key, packed, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)",
                &[
                    app_id.into(),
                    tenant_id.into(),
                    signal_type.into(),
                    signal_key.into(),
                    encode_packed(&packed)?.into(),
                    (now_ms + ttl_ms).into(),
                ],
            )
            .await?;
        Ok(())
    }

    /// Drain every live signal at the key, at-most-once.
    ///
    /// server-storage-4: read-then-delete MUST be a single atomic statement,
    /// or two concurrent drains can both SELECT the same rows before either
    /// DELETEs and each return the same payloads — at-least-once instead of
    /// at-most-once delivery. A single `DELETE … RETURNING` reads and deletes
    /// in one statement (supported by both SQLite and Postgres), so each row
    /// is claimed by exactly one drain. RETURNING does not guarantee row
    /// order on either dialect, so we re-impose the original `id ASC` order
    /// after the fact.
    ///
    /// Expired rows (`expires_at <= now_ms`) are never drained — and are left
    /// in place; no expired-signal GC exists.
    pub async fn drain(
        &self,
        tenant_id: &str,
        signal_type: &str,
        signal_key: &str,
        app_id: &str,
        now_ms: i64,
    ) -> Result<Vec<Value>, StoreError> {
        let mut rows = self
            .sql
            .all(
                "DELETE FROM signal_outbox
          WHERE app_id = ? AND tenant_id = ? AND signal_type = ? AND signal_key = ? AND expires_at > ?
          RETURNING id, packed",
                &[
                    app_id.into(),
                    tenant_id.into(),
                    signal_type.into(),
                    signal_key.into(),
                    now_ms.into(),
                ],
            )
            .await?;
        if rows.is_empty() {
            return Ok(Vec::new());
        }

        rows.sort_by_key(|row| row.i64("id"));
        rows.iter()
            .map(|row| {
                let packed: PackedSignalEnvelope = decode_packed(
                    row.blob("packed")
                        .ok_or_else(|| StoreError::driver("signal_outbox.packed missing"))?,
                )?;
                let envelope = unpack_signal_envelope(self.schema, &packed)
                    .map_err(|err| protocol_error(&err))?;
                Ok(envelope.value)
            })
            .collect()
    }
}

/// TS protocol helpers throw plain `Error`s; their `Display` text is the
/// contract, so the message carries over verbatim.
fn protocol_error(err: &ProtocolError) -> StoreError {
    StoreError::store(err.message())
}

#[cfg(test)]
mod tests {
    use frick_protocol::schema::{FieldDef, FieldKind, SignalDef};

    use super::*;

    /// Effective `signal_outbox` DDL (map 03 §5: base table from migration
    /// 0001 plus the tenant_id/app_id columns and indexes added later).
    const DDL: &str = "
      CREATE TABLE signal_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_type TEXT NOT NULL,
        signal_key TEXT NOT NULL,
        packed BLOB NOT NULL,
        expires_at INTEGER NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT '_default',
        app_id TEXT NOT NULL DEFAULT '_default'
      );
      CREATE INDEX idx_signal_outbox_tenant
        ON signal_outbox (tenant_id, signal_type, signal_key, expires_at);
      CREATE INDEX idx_signal_outbox_app_tenant
        ON signal_outbox (app_id, tenant_id, signal_type, signal_key, expires_at);
    ";

    const TENANT: &str = "tenant-1";
    const TYPE: &str = "WebRTCSignal";
    const KEY: &str = "call-1";
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

    /// The `WebRTCSignal` signal from `productTestSchema`
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
            presences: vec![],
            signals: vec![SignalDef {
                id: 1,
                name: "WebRTCSignal".into(),
                key_fields: vec![FieldDef {
                    ref_: Some("CallRoom".into()),
                    ..field(1, "callId", FieldKind::Ref, true)
                }],
                fields: vec![
                    field(1, "senderDeviceId", FieldKind::String, true),
                    field(2, "recipientDeviceId", FieldKind::String, false),
                    FieldDef {
                        enum_values: Some(
                            ["offer", "answer", "ice", "renegotiate", "sfuToken"]
                                .map(String::from)
                                .to_vec(),
                        ),
                        ..field(3, "kind", FieldKind::Enum, true)
                    },
                    field(4, "payload", FieldKind::Bytes, true),
                ],
                ttl_ms: 30_000,
            }],
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

    fn sig(sender: &str) -> Value {
        Value::Map(vec![
            ("senderDeviceId".into(), sender.into()),
            ("kind".into(), "offer".into()),
            ("payload".into(), Value::Binary(vec![1])),
        ])
    }

    async fn outbox_count(driver: &SqlDriver) -> i64 {
        driver
            .get("SELECT COUNT(*) AS n FROM signal_outbox", &[])
            .await
            .unwrap()
            .unwrap()
            .i64("n")
            .unwrap()
    }

    /// Port of "isolates signal drains across apps"
    /// (`apps/server/tests/app-scoping-tail-stores.test.ts`).
    #[tokio::test]
    async fn isolates_signal_drains_across_apps() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let signals = SignalStore::new(&driver, &schema);

        signals
            .enqueue(TENANT, TYPE, KEY, &sig("a"), 60_000, "app-a", NOW)
            .await
            .unwrap();
        signals
            .enqueue(TENANT, TYPE, KEY, &sig("b"), 60_000, "app-b", NOW)
            .await
            .unwrap();

        // app-a only drains its own queued signal; app-b's stays put.
        let a = signals
            .drain(TENANT, TYPE, KEY, "app-a", NOW)
            .await
            .unwrap();
        assert_eq!(a, vec![sig("a")]);
        // app-a is now empty; app-b still has its signal.
        assert_eq!(
            signals
                .drain(TENANT, TYPE, KEY, "app-a", NOW)
                .await
                .unwrap(),
            Vec::<Value>::new()
        );
        let b = signals
            .drain(TENANT, TYPE, KEY, "app-b", NOW)
            .await
            .unwrap();
        assert_eq!(b, vec![sig("b")]);
        // Default app never saw either.
        assert_eq!(
            signals
                .drain(TENANT, TYPE, KEY, DEFAULT_APP_ID, NOW)
                .await
                .unwrap(),
            Vec::<Value>::new()
        );
    }

    /// Drained values come back in `id ASC` (enqueue) order, and a drain
    /// claims each row at most once.
    #[tokio::test]
    async fn drain_returns_values_in_id_order_and_empties_the_queue() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let signals = SignalStore::new(&driver, &schema);

        signals
            .enqueue(TENANT, TYPE, KEY, &sig("d-1"), 60_000, DEFAULT_APP_ID, NOW)
            .await
            .unwrap();
        signals
            .enqueue(TENANT, TYPE, KEY, &sig("d-2"), 60_000, DEFAULT_APP_ID, NOW)
            .await
            .unwrap();
        signals
            .enqueue(TENANT, TYPE, KEY, &sig("d-3"), 60_000, DEFAULT_APP_ID, NOW)
            .await
            .unwrap();

        let drained = signals
            .drain(TENANT, TYPE, KEY, DEFAULT_APP_ID, NOW)
            .await
            .unwrap();
        assert_eq!(drained, vec![sig("d-1"), sig("d-2"), sig("d-3")]);

        assert_eq!(
            signals
                .drain(TENANT, TYPE, KEY, DEFAULT_APP_ID, NOW)
                .await
                .unwrap(),
            Vec::<Value>::new()
        );
        assert_eq!(outbox_count(&driver).await, 0);
    }

    /// Expired rows are never drained (`expires_at > ?` is strict) and are
    /// left in place — no expired-signal GC exists.
    #[tokio::test]
    async fn expired_signals_are_never_drained_and_left_in_place() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let signals = SignalStore::new(&driver, &schema);

        signals
            .enqueue(TENANT, TYPE, KEY, &sig("stale"), 1_000, DEFAULT_APP_ID, NOW)
            .await
            .unwrap();

        // Strictly before expiry the row is drainable... (checked on a copy)
        // ...but at exactly expires_at it is not.
        assert_eq!(
            signals
                .drain(TENANT, TYPE, KEY, DEFAULT_APP_ID, NOW + 1_000)
                .await
                .unwrap(),
            Vec::<Value>::new()
        );
        // The expired row was NOT deleted.
        assert_eq!(outbox_count(&driver).await, 1);

        // A fresh signal drains past the stale one, which still stays put.
        signals
            .enqueue(
                TENANT,
                TYPE,
                KEY,
                &sig("fresh"),
                60_000,
                DEFAULT_APP_ID,
                NOW + 1_000,
            )
            .await
            .unwrap();
        assert_eq!(
            signals
                .drain(TENANT, TYPE, KEY, DEFAULT_APP_ID, NOW + 1_000)
                .await
                .unwrap(),
            vec![sig("fresh")]
        );
        assert_eq!(outbox_count(&driver).await, 1);
    }

    /// The `expires_at > now` boundary: one millisecond before expiry the
    /// signal still drains.
    #[tokio::test]
    async fn drains_up_to_the_expiry_boundary() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let signals = SignalStore::new(&driver, &schema);

        signals
            .enqueue(TENANT, TYPE, KEY, &sig("edge"), 1_000, DEFAULT_APP_ID, NOW)
            .await
            .unwrap();
        assert_eq!(
            signals
                .drain(TENANT, TYPE, KEY, DEFAULT_APP_ID, NOW + 999)
                .await
                .unwrap(),
            vec![sig("edge")]
        );
    }

    #[tokio::test]
    async fn isolates_tenants() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let signals = SignalStore::new(&driver, &schema);

        signals
            .enqueue(
                "tenant-1",
                TYPE,
                KEY,
                &sig("t1"),
                60_000,
                DEFAULT_APP_ID,
                NOW,
            )
            .await
            .unwrap();
        signals
            .enqueue(
                "tenant-2",
                TYPE,
                KEY,
                &sig("t2"),
                60_000,
                DEFAULT_APP_ID,
                NOW,
            )
            .await
            .unwrap();

        assert_eq!(
            signals
                .drain("tenant-1", TYPE, KEY, DEFAULT_APP_ID, NOW)
                .await
                .unwrap(),
            vec![sig("t1")]
        );
        // tenant-2's signal was untouched by tenant-1's drain.
        assert_eq!(
            signals
                .drain("tenant-2", TYPE, KEY, DEFAULT_APP_ID, NOW)
                .await
                .unwrap(),
            vec![sig("t2")]
        );
    }

    /// Unknown signal names surface the TS codec error message verbatim.
    #[tokio::test]
    async fn unknown_signal_type_matches_ts_error() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let signals = SignalStore::new(&driver, &schema);

        let error = signals
            .enqueue(TENANT, "Nope", KEY, &sig("x"), 5_000, DEFAULT_APP_ID, NOW)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Unknown signal: Nope");
    }
}
