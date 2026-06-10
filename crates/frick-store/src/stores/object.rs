//! `ObjectStore` (`apps/server/src/storage/object-store.ts`, map 03 §8.1).
//!
//! The durable record store. Two partitioning axes thread through every query:
//! `tenant_id` and `app_id`. The `objects` PRIMARY KEY is
//! `(tenant_id, object_type, object_id)` — `app_id` is an *additive* column
//! (FR-36/FR-37), NOT part of the key. So a second app writing the same
//! `(tenant, type, id)` would clobber the owning app's row via `ON CONFLICT`;
//! [`write_row_tx`](ObjectStore::write_row_tx) closes that hole with an explicit
//! cross-app guard (SELECT the owner's `app_id` by PK with no app filter, reject
//! a mismatch). Reads already filter by `app_id`, so the two together isolate
//! apps despite the shared key.
//!
//! Two write entry points mirror the TS class:
//! - [`upsert`](ObjectStore::upsert) — unconditional last-write-wins, NOT in a
//!   transaction (the legacy positional signature: projections, seeds,
//!   dev-login).
//! - [`upsert_with_policy`](ObjectStore::upsert_with_policy) — the whole
//!   read-then-write runs inside one `BEGIN IMMEDIATE` transaction so two
//!   concurrent updates cannot both observe the same `current_version` and
//!   succeed. Implements the `versionPrecondition` create-only / expected-version
//!   / conflict logic and the `lastWriteWins` increment.
//!
//! Clock: the TS `#writeRowTx` stamps `updated_at` with `new Date().toISOString()`.
//! Store logic never reads the system clock here — callers pass `now_ms` from the
//! facade boundary and it is rendered with [`iso_from_epoch_ms`].

use frick_protocol::schema::FrickObjectMergePolicy;
use frick_protocol::{
    FrickSchema, PackedRecord, ProtocolError, Value, pack_object_record, unpack_object_record,
};

use crate::driver::{RunResult, SqlDriver, SqlExec, SqlRow, SqlValue};
use crate::error::StoreError;
use crate::packed::{decode_packed, encode_packed, without_record_id};
use crate::stores::blob_bytes::iso_from_epoch_ms;

/// Outcome of an [`ObjectStore::upsert_with_policy`] write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObjectUpsertResult {
    /// Version present on disk before this call. `0` for a fresh insert.
    pub previous_version: i64,
    /// Version written to disk.
    pub next_version: i64,
    /// True when the row did not exist before this call.
    pub created: bool,
}

pub struct ObjectStore<'a> {
    sql: &'a SqlDriver,
    schema: &'a FrickSchema,
}

impl<'a> ObjectStore<'a> {
    #[must_use]
    pub const fn new(sql: &'a SqlDriver, schema: &'a FrickSchema) -> Self {
        Self { sql, schema }
    }

    /// Legacy positional signature. Always writes unconditionally — equivalent
    /// to [`upsert_with_policy`](Self::upsert_with_policy) with
    /// `lastWriteWins`. Kept so existing call sites (projections, seeds,
    /// dev-login) continue to work without churn. NOT wrapped in a transaction.
    // The TS signature already carries the positional args; the injected clock
    // is the extra parameter — grouping them would diverge from the port.
    #[expect(clippy::too_many_arguments)]
    pub async fn upsert(
        &self,
        tenant_id: &str,
        object_type: &str,
        object_id: &str,
        value: &Value,
        version: i64,
        app_id: &str,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        self.write_row_tx(
            self.sql,
            app_id,
            tenant_id,
            object_type,
            object_id,
            value,
            version,
            now_ms,
        )
        .await
    }

    /// Tenant-aware write with optional version precondition. The full
    /// read-and-write happens inside a SQLite `BEGIN IMMEDIATE` transaction so
    /// two concurrent updates cannot both observe the same `current_version`
    /// and succeed.
    ///
    /// `merge_policy` is resolved by the caller from the schema (defaults to
    /// `lastWriteWins`); `expected_version` is `None` to express "create only"
    /// intent under `versionPrecondition` and is ignored under `lastWriteWins`.
    #[expect(clippy::too_many_arguments)]
    pub async fn upsert_with_policy(
        &self,
        app_id: &str,
        tenant_id: &str,
        object_type: &str,
        object_id: &str,
        value: &Value,
        expected_version: Option<i64>,
        merge_policy: FrickObjectMergePolicy,
        now_ms: i64,
    ) -> Result<ObjectUpsertResult, StoreError> {
        // Pack outside the transaction: an unknown type / field is a caller
        // error, not a storage one, and must surface before we BEGIN.
        let packed = self.pack(object_type, object_id, value)?;
        // The transaction callback is `for<'a> FnOnce(&'a SqlExec<'a>)`, so the
        // returned future may only borrow data valid for the (universally
        // quantified) transaction lifetime — it cannot hold these `&str` args
        // by reference. Capture owned copies and move them in.
        let app_id = app_id.to_string();
        let tenant_id = tenant_id.to_string();
        let object_type = object_type.to_string();
        let object_id = object_id.to_string();
        self.sql
            .transaction(move |tx| {
                Box::pin(async move {
                    let current = tx
                        .get(
                            "SELECT version FROM objects WHERE app_id = ? AND tenant_id = ? AND object_type = ? AND object_id = ?",
                            &[app_id.as_str().into(), tenant_id.as_str().into(), object_type.as_str().into(), object_id.as_str().into()],
                        )
                        .await?;
                    let previous_version = current.as_ref().and_then(|row| row.i64("version")).unwrap_or(0);
                    let exists = current.is_some();

                    if merge_policy == FrickObjectMergePolicy::VersionPrecondition {
                        match expected_version {
                            None => {
                                if exists {
                                    return Err(StoreError::ObjectVersionConflict {
                                        tenant_id,
                                        object_type,
                                        object_id,
                                        expected_version: None,
                                        actual_version: previous_version,
                                    });
                                }
                            }
                            Some(expected) if previous_version != expected => {
                                return Err(StoreError::ObjectVersionConflict {
                                    tenant_id,
                                    object_type,
                                    object_id,
                                    expected_version: Some(expected),
                                    actual_version: previous_version,
                                });
                            }
                            Some(_) => {}
                        }
                    }

                    let next_version = match merge_policy {
                        FrickObjectMergePolicy::VersionPrecondition => match expected_version {
                            None => 1,
                            Some(expected) => expected + 1,
                        },
                        FrickObjectMergePolicy::LastWriteWins => previous_version + 1,
                    };

                    write_row_packed(tx, &app_id, &tenant_id, &object_type, &object_id, &packed, next_version, now_ms).await?;
                    Ok(ObjectUpsertResult { previous_version, next_version, created: !exists })
                })
            })
            .await
    }

    pub async fn read(
        &self,
        tenant_id: &str,
        object_type: &str,
        object_id: &str,
        app_id: &str,
    ) -> Result<Option<Value>, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT packed FROM objects WHERE app_id = ? AND tenant_id = ? AND object_type = ? AND object_id = ?",
                &[app_id.into(), tenant_id.into(), object_type.into(), object_id.into()],
            )
            .await?;
        match row {
            None => Ok(None),
            Some(row) => Ok(Some(self.unpack(&row)?)),
        }
    }

    /// Return the current on-disk version, or `0` if the row does not exist.
    /// Exposed so the HTTP layer can populate ETag headers without a second
    /// unpack.
    pub async fn read_version(
        &self,
        tenant_id: &str,
        object_type: &str,
        object_id: &str,
        app_id: &str,
    ) -> Result<i64, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT version FROM objects WHERE app_id = ? AND tenant_id = ? AND object_type = ? AND object_id = ?",
                &[app_id.into(), tenant_id.into(), object_type.into(), object_id.into()],
            )
            .await?;
        Ok(row.and_then(|row| row.i64("version")).unwrap_or(0))
    }

    /// Remove a single object row. Returns `true` when a row was deleted,
    /// `false` when the `(tenant, type, id)` tuple was already absent. The
    /// framework does not soft-delete — once removed, the row is gone, and a
    /// follow-up upsert with the same id starts at version 1 again.
    pub async fn delete(
        &self,
        tenant_id: &str,
        object_type: &str,
        object_id: &str,
        app_id: &str,
    ) -> Result<bool, StoreError> {
        let result = self
            .sql
            .run(
                "DELETE FROM objects WHERE app_id = ? AND tenant_id = ? AND object_type = ? AND object_id = ?",
                &[app_id.into(), tenant_id.into(), object_type.into(), object_id.into()],
            )
            .await?;
        Ok(result.changes > 0)
    }

    pub async fn list(
        &self,
        tenant_id: &str,
        object_type: &str,
        app_id: &str,
    ) -> Result<Vec<Value>, StoreError> {
        let rows = self
            .sql
            .all(
                "SELECT packed FROM objects WHERE app_id = ? AND tenant_id = ? AND object_type = ? ORDER BY object_id ASC",
                &[app_id.into(), tenant_id.into(), object_type.into()],
            )
            .await?;
        rows.iter().map(|row| self.unpack(row)).collect()
    }

    /// Pack a value for the `packed` column: strip the record `id` key first
    /// (`without_record_id`), schema-pack via the protocol codec, then msgpack
    /// the positional tuple. Unknown type / field surfaces the TS codec error.
    fn pack(
        &self,
        object_type: &str,
        object_id: &str,
        value: &Value,
    ) -> Result<Vec<u8>, StoreError> {
        let record = pack_object_record(
            self.schema,
            object_type,
            object_id,
            &without_record_id(value),
        )
        .map_err(|err| protocol_error(&err))?;
        encode_packed(&record)
    }

    /// Decode a `packed` column back into the object value (`id` re-injected
    /// first by `unpack_object_record`).
    fn unpack(&self, row: &SqlRow) -> Result<Value, StoreError> {
        let packed: PackedRecord = decode_packed(
            row.blob("packed")
                .ok_or_else(|| StoreError::driver("objects.packed missing"))?,
        )?;
        let record =
            unpack_object_record(self.schema, &packed).map_err(|err| protocol_error(&err))?;
        Ok(record.value)
    }

    /// Cross-app write guard + the canonical `ON CONFLICT(tenant, type, id)`
    /// upsert. Generic over [`Exec`] so the bare driver (unconditional
    /// [`upsert`](Self::upsert)) and the tx executor
    /// ([`upsert_with_policy`](Self::upsert_with_policy)) share one body, just
    /// like the TS `#writeRowTx(tx)`.
    #[expect(clippy::too_many_arguments)]
    async fn write_row_tx<E: Exec>(
        &self,
        exec: E,
        app_id: &str,
        tenant_id: &str,
        object_type: &str,
        object_id: &str,
        value: &Value,
        version: i64,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        let packed = self.pack(object_type, object_id, value)?;
        write_row_packed(
            exec,
            app_id,
            tenant_id,
            object_type,
            object_id,
            &packed,
            version,
            now_ms,
        )
        .await
    }
}

/// The cross-app guard + upsert, given already-packed bytes. Split out so the
/// policy path (which packs before `BEGIN`) and the legacy path share it.
#[expect(clippy::too_many_arguments)]
async fn write_row_packed<E: Exec>(
    exec: E,
    app_id: &str,
    tenant_id: &str,
    object_type: &str,
    object_id: &str,
    packed: &[u8],
    version: i64,
    now_ms: i64,
) -> Result<(), StoreError> {
    // Cross-app write guard (FR-37): the objects PRIMARY KEY is
    // (tenant_id, object_type, object_id) — app_id is additive (FR-36), not in
    // the key. So a write from a *different* app to the same (tenant, type, id)
    // would otherwise clobber the owning app's row via ON CONFLICT. Reject it:
    // an app may only write rows it owns (or a brand-new row). Reads already
    // filter by app_id, so this closes the write side of the boundary.
    let owner = exec
        .get(
            "SELECT app_id FROM objects WHERE tenant_id = ? AND object_type = ? AND object_id = ?",
            &[tenant_id.into(), object_type.into(), object_id.into()],
        )
        .await?;
    if let Some(owner_app_id) = owner.as_ref().and_then(|row| row.text("app_id"))
        && owner_app_id != app_id
    {
        return Err(StoreError::CrossAppAccess {
            requested_app_id: app_id.to_string(),
            owner_app_id: owner_app_id.to_string(),
            tenant_id: tenant_id.to_string(),
            object_type: object_type.to_string(),
            object_id: object_id.to_string(),
        });
    }

    // The ON CONFLICT target stays the PK; app_id is set on both the insert and
    // the update branch so an existing row's app stamp is preserved.
    exec.run(
        "INSERT INTO objects
            (app_id, tenant_id, object_type, object_id, version, packed, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, object_type, object_id) DO UPDATE SET
              app_id = excluded.app_id,
              version = excluded.version,
              packed = excluded.packed,
              updated_at = excluded.updated_at",
        &[
            app_id.into(),
            tenant_id.into(),
            object_type.into(),
            object_id.into(),
            version.into(),
            packed.to_vec().into(),
            iso_from_epoch_ms(now_ms).into(),
        ],
    )
    .await?;
    Ok(())
}

/// The slice of the query surface [`write_row_packed`] needs, implemented by
/// both `&SqlDriver` (no transaction) and `&SqlExec` (inside one). Mirrors the
/// TS `#writeRowTx(tx)` taking either the bare driver or a tx-scoped one.
trait Exec {
    fn get(
        &self,
        sql: &str,
        params: &[SqlValue],
    ) -> impl Future<Output = Result<Option<SqlRow>, StoreError>>;
    fn run(
        &self,
        sql: &str,
        params: &[SqlValue],
    ) -> impl Future<Output = Result<RunResult, StoreError>>;
}

impl Exec for &SqlDriver {
    fn get(
        &self,
        sql: &str,
        params: &[SqlValue],
    ) -> impl Future<Output = Result<Option<SqlRow>, StoreError>> {
        SqlDriver::get(self, sql, params)
    }
    fn run(
        &self,
        sql: &str,
        params: &[SqlValue],
    ) -> impl Future<Output = Result<RunResult, StoreError>> {
        SqlDriver::run(self, sql, params)
    }
}

impl Exec for &SqlExec<'_> {
    fn get(
        &self,
        sql: &str,
        params: &[SqlValue],
    ) -> impl Future<Output = Result<Option<SqlRow>, StoreError>> {
        SqlExec::get(self, sql, params)
    }
    fn run(
        &self,
        sql: &str,
        params: &[SqlValue],
    ) -> impl Future<Output = Result<RunResult, StoreError>> {
        SqlExec::run(self, sql, params)
    }
}

/// TS protocol helpers throw plain `Error`s; their `Display` text is the
/// contract, so the message carries over verbatim.
fn protocol_error(err: &ProtocolError) -> StoreError {
    StoreError::store(err.message())
}

#[cfg(test)]
mod tests {
    use frick_protocol::schema::{FieldDef, FieldKind, ObjectDef};

    use super::*;
    use crate::stores::blob_bytes::DEFAULT_APP_ID;

    /// Effective `objects` DDL (map 03 §5; migration 0021 added `app_id` and
    /// the sibling index). FKs are OFF (production parity) so documentary FKs
    /// never block inserts.
    const DDL: &str = "
      CREATE TABLE objects (
        tenant_id TEXT NOT NULL DEFAULT '_default',
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        packed BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        app_id TEXT NOT NULL DEFAULT '_default',
        PRIMARY KEY (tenant_id, object_type, object_id)
      );
      CREATE INDEX idx_objects_app_tenant
        ON objects (app_id, tenant_id, object_type, object_id);
    ";

    const TENANT: &str = "tenant-1";
    const TYPE: &str = "Conversation";
    const NOW: i64 = 1_700_000_000_123;

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

    /// A `Conversation` object (matching `productTestSchema` ids/fields) plus a
    /// `Note` object configured for `versionPrecondition`
    /// (the `schemaWithNote` derived schema from `object-versioning.test.ts`).
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
            objects: vec![
                ObjectDef {
                    id: 2,
                    name: "Conversation".into(),
                    fields: vec![
                        field(2, "title", FieldKind::String, false),
                        field(4, "lastMessageEventId", FieldKind::String, false),
                    ],
                    indexes: vec![],
                    merge_policy: None,
                },
                ObjectDef {
                    id: 99,
                    name: "Note".into(),
                    fields: vec![
                        field(1, "body", FieldKind::String, true),
                        field(2, "tag", FieldKind::String, false),
                    ],
                    indexes: vec![],
                    merge_policy: Some(FrickObjectMergePolicy::VersionPrecondition),
                },
            ],
            streams: vec![],
            events: vec![],
            presences: vec![],
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

    /// `{ id, title }` — the cross-app/round-trip test value. `id` is stripped
    /// before packing (`without_record_id`) and re-injected on read.
    fn convo(id: &str, title: &str) -> Value {
        Value::Map(vec![
            ("id".into(), id.into()),
            ("title".into(), title.into()),
        ])
    }

    fn note(body: &str) -> Value {
        Value::Map(vec![("body".into(), body.into())])
    }

    fn title_of(value: &Value) -> Option<&str> {
        let Value::Map(entries) = value else {
            return None;
        };
        entries
            .iter()
            .find(|(key, _)| key.as_str() == Some("title"))
            .and_then(|(_, value)| value.as_str())
    }

    fn id_of(value: &Value) -> Option<&str> {
        let Value::Map(entries) = value else {
            return None;
        };
        entries
            .iter()
            .find(|(key, _)| key.as_str() == Some("id"))
            .and_then(|(_, value)| value.as_str())
    }

    async fn object_count(driver: &SqlDriver) -> i64 {
        driver
            .get("SELECT COUNT(*) AS n FROM objects", &[])
            .await
            .unwrap()
            .unwrap()
            .i64("n")
            .unwrap()
    }

    // ── per-app scoping (app-scoping.test.ts) ──────────────────────────────

    /// "isolates reads: app B cannot read app A's object at the same tenant+id".
    #[tokio::test]
    async fn isolates_reads_across_apps() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = ObjectStore::new(&driver, &schema);

        store
            .upsert(
                TENANT,
                TYPE,
                "c-1",
                &convo("c-1", "A's convo"),
                1,
                "app-a",
                NOW,
            )
            .await
            .unwrap();

        // Same tenant + type + id, different app: invisible to app B.
        assert_eq!(
            store.read(TENANT, TYPE, "c-1", "app-b").await.unwrap(),
            None
        );
        // Visible to its owner.
        assert_eq!(
            store
                .read(TENANT, TYPE, "c-1", "app-a")
                .await
                .unwrap()
                .as_ref()
                .and_then(title_of),
            Some("A's convo")
        );
        // And invisible to the default app too.
        assert_eq!(
            store
                .read(TENANT, TYPE, "c-1", DEFAULT_APP_ID)
                .await
                .unwrap(),
            None
        );
    }

    /// "isolates lists: each app only lists its own objects".
    #[tokio::test]
    async fn isolates_lists_across_apps() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = ObjectStore::new(&driver, &schema);

        store
            .upsert(TENANT, TYPE, "a-1", &convo("a-1", "A1"), 1, "app-a", NOW)
            .await
            .unwrap();
        store
            .upsert(TENANT, TYPE, "b-1", &convo("b-1", "B1"), 1, "app-b", NOW)
            .await
            .unwrap();

        let a = store.list(TENANT, TYPE, "app-a").await.unwrap();
        let b = store.list(TENANT, TYPE, "app-b").await.unwrap();
        assert_eq!(a.iter().filter_map(id_of).collect::<Vec<_>>(), vec!["a-1"]);
        assert_eq!(b.iter().filter_map(id_of).collect::<Vec<_>>(), vec!["b-1"]);
    }

    /// "rejects a cross-app write to a row owned by another app" — both the
    /// legacy `upsert` and the policy path are guarded.
    #[tokio::test]
    async fn rejects_cross_app_write() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = ObjectStore::new(&driver, &schema);

        store
            .upsert(
                TENANT,
                TYPE,
                "c-1",
                &convo("c-1", "A's convo"),
                1,
                "app-a",
                NOW,
            )
            .await
            .unwrap();

        // app B tries to clobber the same PK row — denied.
        let err = store
            .upsert(
                TENANT,
                TYPE,
                "c-1",
                &convo("c-1", "B's hijack"),
                2,
                "app-b",
                NOW,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, StoreError::CrossAppAccess { .. }));
        assert_eq!(
            err.to_string(),
            "Cross-app access denied on Conversation/c-1: app 'app-b' may not write a row owned by app 'app-a'"
        );

        // The policy write path is guarded too.
        let err = store
            .upsert_with_policy(
                "app-b",
                TENANT,
                TYPE,
                "c-1",
                &convo("c-1", "B's hijack"),
                None,
                FrickObjectMergePolicy::LastWriteWins,
                NOW,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, StoreError::CrossAppAccess { .. }));

        // A's row is untouched.
        assert_eq!(
            store
                .read(TENANT, TYPE, "c-1", "app-a")
                .await
                .unwrap()
                .as_ref()
                .and_then(title_of),
            Some("A's convo")
        );
    }

    /// "isolates deletes: app B deleting app A's id is a no-op".
    #[tokio::test]
    async fn isolates_deletes_across_apps() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = ObjectStore::new(&driver, &schema);

        store
            .upsert(
                TENANT,
                TYPE,
                "c-1",
                &convo("c-1", "A's convo"),
                1,
                "app-a",
                NOW,
            )
            .await
            .unwrap();

        assert!(!store.delete(TENANT, TYPE, "c-1", "app-b").await.unwrap());
        assert_eq!(
            store
                .read(TENANT, TYPE, "c-1", "app-a")
                .await
                .unwrap()
                .as_ref()
                .and_then(title_of),
            Some("A's convo")
        );

        assert!(store.delete(TENANT, TYPE, "c-1", "app-a").await.unwrap());
        assert_eq!(
            store.read(TENANT, TYPE, "c-1", "app-a").await.unwrap(),
            None
        );
    }

    /// "defaults to '_default' so single-app callers are unaffected".
    #[tokio::test]
    async fn default_app_callers_round_trip() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = ObjectStore::new(&driver, &schema);

        store
            .upsert(
                TENANT,
                TYPE,
                "c-1",
                &convo("c-1", "Default"),
                1,
                DEFAULT_APP_ID,
                NOW,
            )
            .await
            .unwrap();
        assert_eq!(
            store
                .read(TENANT, TYPE, "c-1", DEFAULT_APP_ID)
                .await
                .unwrap()
                .as_ref()
                .and_then(title_of),
            Some("Default")
        );
        // The re-injected record id round-trips.
        assert_eq!(
            store
                .read(TENANT, TYPE, "c-1", DEFAULT_APP_ID)
                .await
                .unwrap()
                .as_ref()
                .and_then(id_of),
            Some("c-1")
        );
    }

    /// `read_version` returns the current version, or 0 when absent.
    #[tokio::test]
    async fn read_version_reports_current_or_zero() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = ObjectStore::new(&driver, &schema);

        assert_eq!(
            store
                .read_version(TENANT, TYPE, "c-1", DEFAULT_APP_ID)
                .await
                .unwrap(),
            0
        );
        store
            .upsert(
                TENANT,
                TYPE,
                "c-1",
                &convo("c-1", "x"),
                7,
                DEFAULT_APP_ID,
                NOW,
            )
            .await
            .unwrap();
        assert_eq!(
            store
                .read_version(TENANT, TYPE, "c-1", DEFAULT_APP_ID)
                .await
                .unwrap(),
            7
        );
        // Version is app-scoped: another app sees 0.
        assert_eq!(
            store
                .read_version(TENANT, TYPE, "c-1", "app-b")
                .await
                .unwrap(),
            0
        );
    }

    /// `list` orders by `object_id ASC` and re-injects ids.
    #[tokio::test]
    async fn list_orders_by_object_id_asc() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = ObjectStore::new(&driver, &schema);

        for id in ["c-3", "c-1", "c-2"] {
            store
                .upsert(TENANT, TYPE, id, &convo(id, id), 1, DEFAULT_APP_ID, NOW)
                .await
                .unwrap();
        }
        let listed = store.list(TENANT, TYPE, DEFAULT_APP_ID).await.unwrap();
        assert_eq!(
            listed.iter().filter_map(id_of).collect::<Vec<_>>(),
            vec!["c-1", "c-2", "c-3"]
        );
    }

    /// Tenant isolation: same (type, id) across tenants are distinct rows.
    #[tokio::test]
    async fn isolates_tenants() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = ObjectStore::new(&driver, &schema);

        store
            .upsert(
                "tenant-1",
                TYPE,
                "c-1",
                &convo("c-1", "T1"),
                1,
                DEFAULT_APP_ID,
                NOW,
            )
            .await
            .unwrap();
        store
            .upsert(
                "tenant-2",
                TYPE,
                "c-1",
                &convo("c-1", "T2"),
                1,
                DEFAULT_APP_ID,
                NOW,
            )
            .await
            .unwrap();

        assert_eq!(
            store
                .read("tenant-1", TYPE, "c-1", DEFAULT_APP_ID)
                .await
                .unwrap()
                .as_ref()
                .and_then(title_of),
            Some("T1")
        );
        assert_eq!(
            store
                .read("tenant-2", TYPE, "c-1", DEFAULT_APP_ID)
                .await
                .unwrap()
                .as_ref()
                .and_then(title_of),
            Some("T2")
        );
    }

    // ── upsert / lastWriteWins ─────────────────────────────────────────────

    /// Unconditional `upsert` overwrites in place (one row, latest value).
    #[tokio::test]
    async fn upsert_overwrites_in_place() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = ObjectStore::new(&driver, &schema);

        store
            .upsert(
                TENANT,
                TYPE,
                "c-1",
                &convo("c-1", "first"),
                1,
                DEFAULT_APP_ID,
                NOW,
            )
            .await
            .unwrap();
        store
            .upsert(
                TENANT,
                TYPE,
                "c-1",
                &convo("c-1", "second"),
                2,
                DEFAULT_APP_ID,
                NOW,
            )
            .await
            .unwrap();

        assert_eq!(object_count(&driver).await, 1);
        assert_eq!(
            store
                .read(TENANT, TYPE, "c-1", DEFAULT_APP_ID)
                .await
                .unwrap()
                .as_ref()
                .and_then(title_of),
            Some("second")
        );
    }

    /// `lastWriteWins` increments `previous_version + 1` and reports `created`.
    #[tokio::test]
    async fn last_write_wins_increments_and_reports_created() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = ObjectStore::new(&driver, &schema);

        let first = store
            .upsert_with_policy(
                DEFAULT_APP_ID,
                TENANT,
                TYPE,
                "c-1",
                &convo("c-1", "v1"),
                None,
                FrickObjectMergePolicy::LastWriteWins,
                NOW,
            )
            .await
            .unwrap();
        assert_eq!(
            first,
            ObjectUpsertResult {
                previous_version: 0,
                next_version: 1,
                created: true
            }
        );

        let second = store
            .upsert_with_policy(
                DEFAULT_APP_ID,
                TENANT,
                TYPE,
                "c-1",
                &convo("c-1", "v2"),
                None,
                FrickObjectMergePolicy::LastWriteWins,
                NOW,
            )
            .await
            .unwrap();
        assert_eq!(
            second,
            ObjectUpsertResult {
                previous_version: 1,
                next_version: 2,
                created: false
            }
        );
    }

    // ── versionPrecondition (object-versioning.test.ts) ────────────────────

    /// Create-only intent (`expected_version = None`): fresh insert ⇒ version 1.
    #[tokio::test]
    async fn version_precondition_create_only_inserts_at_one() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = ObjectStore::new(&driver, &schema);

        let result = store
            .upsert_with_policy(
                DEFAULT_APP_ID,
                TENANT,
                "Note",
                "note-1",
                &note("first"),
                None,
                FrickObjectMergePolicy::VersionPrecondition,
                NOW,
            )
            .await
            .unwrap();
        assert_eq!(
            result,
            ObjectUpsertResult {
                previous_version: 0,
                next_version: 1,
                created: true
            }
        );
    }

    /// Create-only intent against an existing row ⇒ conflict ("expected create").
    #[tokio::test]
    async fn version_precondition_create_only_conflicts_when_exists() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = ObjectStore::new(&driver, &schema);

        store
            .upsert_with_policy(
                DEFAULT_APP_ID,
                TENANT,
                "Note",
                "note-1",
                &note("first"),
                None,
                FrickObjectMergePolicy::VersionPrecondition,
                NOW,
            )
            .await
            .unwrap();

        let err = store
            .upsert_with_policy(
                DEFAULT_APP_ID,
                TENANT,
                "Note",
                "note-1",
                &note("again"),
                None,
                FrickObjectMergePolicy::VersionPrecondition,
                NOW,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            StoreError::ObjectVersionConflict {
                expected_version: None,
                actual_version: 1,
                ..
            }
        ));
        assert_eq!(
            err.to_string(),
            "Version conflict on Note/note-1: expected create, actual 1"
        );
    }

    /// Matching `expected_version` ⇒ next = expected + 1.
    #[tokio::test]
    async fn version_precondition_matching_expected_increments() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = ObjectStore::new(&driver, &schema);

        store
            .upsert_with_policy(
                DEFAULT_APP_ID,
                TENANT,
                "Note",
                "note-1",
                &note("v1"),
                None,
                FrickObjectMergePolicy::VersionPrecondition,
                NOW,
            )
            .await
            .unwrap();

        let updated = store
            .upsert_with_policy(
                DEFAULT_APP_ID,
                TENANT,
                "Note",
                "note-1",
                &note("v2"),
                Some(1),
                FrickObjectMergePolicy::VersionPrecondition,
                NOW,
            )
            .await
            .unwrap();
        assert_eq!(
            updated,
            ObjectUpsertResult {
                previous_version: 1,
                next_version: 2,
                created: false
            }
        );
    }

    /// "FrickObjectVersionConflictError carries tenant/object/version metadata"
    /// (`object-versioning.test.ts:171-205`): create at 1, then a stale
    /// `expected_version: 99` conflicts with `actual 1`.
    #[tokio::test]
    async fn version_precondition_stale_expected_conflicts() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = ObjectStore::new(&driver, &schema);

        store
            .upsert_with_policy(
                DEFAULT_APP_ID,
                TENANT,
                "Note",
                "note-storage",
                &note("v1"),
                None,
                FrickObjectMergePolicy::VersionPrecondition,
                NOW,
            )
            .await
            .unwrap();

        let err = store
            .upsert_with_policy(
                DEFAULT_APP_ID,
                TENANT,
                "Note",
                "note-storage",
                &note("v2"),
                Some(99),
                FrickObjectMergePolicy::VersionPrecondition,
                NOW,
            )
            .await
            .unwrap_err();

        let StoreError::ObjectVersionConflict {
            tenant_id,
            object_type,
            object_id,
            expected_version,
            actual_version,
        } = &err
        else {
            panic!("expected ObjectVersionConflict, got {err:?}");
        };
        assert_eq!(tenant_id, TENANT);
        assert_eq!(object_type, "Note");
        assert_eq!(object_id, "note-storage");
        assert_eq!(*expected_version, Some(99));
        assert_eq!(*actual_version, 1);
        assert_eq!(
            err.to_string(),
            "Version conflict on Note/note-storage: expected 99, actual 1"
        );
    }

    /// A failed precondition rolls back the transaction — no row is written and
    /// the prior value survives.
    #[tokio::test]
    async fn conflict_leaves_prior_row_intact() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = ObjectStore::new(&driver, &schema);

        store
            .upsert_with_policy(
                DEFAULT_APP_ID,
                TENANT,
                "Note",
                "note-1",
                &note("keep-me"),
                None,
                FrickObjectMergePolicy::VersionPrecondition,
                NOW,
            )
            .await
            .unwrap();

        let _ = store
            .upsert_with_policy(
                DEFAULT_APP_ID,
                TENANT,
                "Note",
                "note-1",
                &note("never"),
                Some(99),
                FrickObjectMergePolicy::VersionPrecondition,
                NOW,
            )
            .await
            .unwrap_err();

        assert_eq!(object_count(&driver).await, 1);
        assert_eq!(
            store
                .read_version(TENANT, "Note", "note-1", DEFAULT_APP_ID)
                .await
                .unwrap(),
            1
        );
    }

    /// `updated_at` is stamped from the injected `now_ms` (ISO-8601 Z), never
    /// the system clock.
    #[tokio::test]
    async fn stamps_updated_at_from_now_ms() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = ObjectStore::new(&driver, &schema);

        store
            .upsert(
                TENANT,
                TYPE,
                "c-1",
                &convo("c-1", "x"),
                1,
                DEFAULT_APP_ID,
                NOW,
            )
            .await
            .unwrap();
        let row = driver
            .get(
                "SELECT updated_at FROM objects WHERE object_id = ?",
                &["c-1".into()],
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.text("updated_at"), Some("2023-11-14T22:13:20.123Z"));
    }

    /// Unknown object type surfaces the TS codec error verbatim, before any
    /// `BEGIN` (so no partial transaction is left open).
    #[tokio::test]
    async fn unknown_object_type_matches_ts_error() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = ObjectStore::new(&driver, &schema);

        let err = store
            .upsert(
                TENANT,
                "Nope",
                "x",
                &Value::Map(vec![]),
                1,
                DEFAULT_APP_ID,
                NOW,
            )
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "Unknown object: Nope");

        let err = store
            .upsert_with_policy(
                DEFAULT_APP_ID,
                TENANT,
                "Nope",
                "x",
                &Value::Map(vec![]),
                None,
                FrickObjectMergePolicy::LastWriteWins,
                NOW,
            )
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "Unknown object: Nope");
    }
}
