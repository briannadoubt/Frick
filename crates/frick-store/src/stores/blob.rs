//! Blob *metadata* store (`apps/server/src/storage/blob-store.ts`, map 03 §8.6,
//! map 05 blobs). Blob metadata always lives in SQL (`blob_metadata`); the raw
//! *bytes* are served by a pluggable driver — see [`crate::stores::blob_bytes`]
//! ([`SqlBlobBytesDriver`](crate::stores::blob_bytes::SqlBlobBytesDriver) et al.)
//! This module owns the metadata rows and the inline-bytes `blob_derivatives`
//! rows; it deliberately does NOT reimplement the bytes drivers.
//!
//! # Partitioning (FR-153)
//!
//! Every method takes a trailing `app_id` (callers pass
//! [`DEFAULT_APP_ID`](crate::stores::blob_bytes::DEFAULT_APP_ID) for single-app
//! servers). Reads filter by `app_id`; writes stamp it. The
//! `blob_metadata` PRIMARY KEY is `blob_id` ALONE — `tenant_id`/`app_id` are
//! additive columns (FR-36), NOT part of the key. So an `ON CONFLICT(blob_id)`
//! upsert from a *different* app would clobber the owning app's row; the
//! cross-app pre-check in [`BlobStore::create`] rejects that, mirroring
//! `ObjectStore`.
//!
//! # Delete ordering contract (map 05)
//!
//! Reclaiming a blob deletes in the order **derivatives → bytes → metadata**.
//! This store owns the metadata + derivative deletes ([`delete_derivatives`],
//! [`delete_metadata`]); byte deletion is the caller's, via
//! [`crate::stores::blob_bytes`] ([`BlobBytesDriver::delete`]). On the SQLite
//! `blob_content` byte backend a `blob_metadata`→`blob_content` FK is declared
//! `ON DELETE CASCADE`, but the driver runs with `foreign_keys=OFF` (matching
//! production), and the filesystem/S3 byte drivers are not cascade-backed — so
//! byte deletion is always the caller's explicit job, never relied upon to
//! cascade.
//!
//! [`BlobBytesDriver::delete`]: crate::stores::blob_bytes::BlobBytesDriver::delete
//! [`delete_derivatives`]: BlobStore::delete_derivatives
//! [`delete_metadata`]: BlobStore::delete_metadata

use std::sync::Arc;

use crate::driver::SqlDriver;
use crate::error::StoreError;
use crate::stores::blob_bytes::iso_from_epoch_ms;

/// Input to [`BlobStore::create`] (`BlobMetadataInput`, blob-store.ts:9-16).
/// `storage_key` is optional and stored as SQL NULL when absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobMetadataInput {
    pub blob_id: String,
    pub owner_id: String,
    /// Content hash, by convention `"sha256-" + hex(sha256(bytes))`.
    pub content_hash: String,
    pub byte_length: i64,
    pub mime_type: String,
    pub storage_key: Option<String>,
}

/// A stored blob-metadata row (`BlobMetadata`, blob-store.ts:18-23): the input
/// plus the partitioning axes and `created_at`. `storage_key` is `None` when
/// the column is NULL (the TS mapper omits the key entirely; the Rust port
/// renders it as the absent `Option`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobMetadata {
    pub blob_id: String,
    pub owner_id: String,
    pub content_hash: String,
    pub byte_length: i64,
    pub mime_type: String,
    pub storage_key: Option<String>,
    pub tenant_id: String,
    /// App partition (FR-153);
    /// [`DEFAULT_APP_ID`](crate::stores::blob_bytes::DEFAULT_APP_ID) for
    /// single-app servers.
    pub app_id: String,
    pub created_at: String,
}

/// Keyset-pagination cursor for [`BlobStore::list_oldest_first_page`]: the
/// `(created_at, blob_id)` of the last row of the prior page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobPageCursor {
    pub created_at: String,
    pub blob_id: String,
}

/// `derivativeStorageKey(parent, deriv)` (blob-derivative-store.ts:60-65): the
/// canonical, stable path-style storage key for a derivative.
#[must_use]
pub fn derivative_storage_key(parent_blob_id: &str, derivative_id: &str) -> String {
    format!("derivative/{parent_blob_id}/{derivative_id}")
}

/// `BlobStore` (`storage/blob-store.ts`): metadata operations over
/// [`SqlDriver`], plus the inline-bytes `blob_derivatives` rows this store
/// owns. Bytes pass-throughs are intentionally absent — callers go through
/// [`crate::stores::blob_bytes`] directly (see the module-level delete-ordering
/// contract).
pub struct BlobStore {
    sql: Arc<SqlDriver>,
}

impl BlobStore {
    #[must_use]
    pub fn new(sql: Arc<SqlDriver>) -> Self {
        Self { sql }
    }

    /// `create` (blob-store.ts:63-108). Cross-app write guard (FR-153): the PK
    /// is `blob_id`, so an `ON CONFLICT` update from another app would
    /// overwrite the owner's row. SELECT the owner's `app_id` by `blob_id`
    /// (NO app filter); a different owner ⇒ [`StoreError::CrossAppAccess`] with
    /// object type `"blob_metadata"`. Otherwise UPSERT every column (re-create
    /// refreshes `created_at`). `now_ms` stamps `created_at` (the TS calls
    /// `new Date().toISOString()`).
    pub async fn create(
        &self,
        tenant_id: &str,
        metadata: &BlobMetadataInput,
        app_id: &str,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        // Cross-app write guard: SELECT the existing owner by blob_id alone.
        let owner = self
            .sql
            .get(
                "SELECT app_id FROM blob_metadata WHERE blob_id = ?",
                &[metadata.blob_id.as_str().into()],
            )
            .await?;
        if let Some(owner_app_id) = owner.as_ref().and_then(|row| row.text("app_id"))
            && owner_app_id != app_id
        {
            return Err(StoreError::CrossAppAccess {
                requested_app_id: app_id.to_owned(),
                owner_app_id: owner_app_id.to_owned(),
                tenant_id: tenant_id.to_owned(),
                object_type: "blob_metadata".to_owned(),
                object_id: metadata.blob_id.clone(),
            });
        }
        self.sql
            .run(
                "INSERT INTO blob_metadata
                    (app_id, tenant_id, blob_id, owner_id, content_hash, byte_length, mime_type, storage_key, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(blob_id) DO UPDATE SET
                      app_id = excluded.app_id,
                      tenant_id = excluded.tenant_id,
                      owner_id = excluded.owner_id,
                      content_hash = excluded.content_hash,
                      byte_length = excluded.byte_length,
                      mime_type = excluded.mime_type,
                      storage_key = excluded.storage_key,
                      created_at = excluded.created_at",
                &[
                    app_id.into(),
                    tenant_id.into(),
                    metadata.blob_id.as_str().into(),
                    metadata.owner_id.as_str().into(),
                    metadata.content_hash.as_str().into(),
                    metadata.byte_length.into(),
                    metadata.mime_type.as_str().into(),
                    metadata.storage_key.clone().into(),
                    iso_from_epoch_ms(now_ms).into(),
                ],
            )
            .await?;
        Ok(())
    }

    /// `read` (blob-store.ts:110-123): one row by `(app_id, tenant_id,
    /// blob_id)`, or `None`.
    pub async fn read(
        &self,
        tenant_id: &str,
        blob_id: &str,
        app_id: &str,
    ) -> Result<Option<BlobMetadata>, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT * FROM blob_metadata WHERE app_id = ? AND tenant_id = ? AND blob_id = ?",
                &[app_id.into(), tenant_id.into(), blob_id.into()],
            )
            .await?;
        Ok(row.as_ref().map(map_blob_row))
    }

    /// `list` (blob-store.ts:125-140): rows for a tenant (optionally
    /// owner-filtered), `ORDER BY created_at DESC, blob_id ASC`.
    pub async fn list(
        &self,
        tenant_id: &str,
        owner_id: Option<&str>,
        app_id: &str,
    ) -> Result<Vec<BlobMetadata>, StoreError> {
        let rows = match owner_id {
            Some(owner) => {
                self.sql
                    .all(
                        "SELECT * FROM blob_metadata WHERE app_id = ? AND tenant_id = ? AND owner_id = ? ORDER BY created_at DESC, blob_id ASC",
                        &[app_id.into(), tenant_id.into(), owner.into()],
                    )
                    .await?
            }
            None => {
                self.sql
                    .all(
                        "SELECT * FROM blob_metadata WHERE app_id = ? AND tenant_id = ? ORDER BY created_at DESC, blob_id ASC",
                        &[app_id.into(), tenant_id.into()],
                    )
                    .await?
            }
        };
        Ok(rows.iter().map(map_blob_row).collect())
    }

    /// `totalBytesForOwner` (blob-store.ts:149-159): sum `byte_length` for
    /// `(app_id, tenant_id, owner_id)` — the per-principal usage the upload
    /// route checks against the quota (FR-56). `0` when the owner has no blobs.
    pub async fn total_bytes_for_owner(
        &self,
        tenant_id: &str,
        owner_id: &str,
        app_id: &str,
    ) -> Result<i64, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT COALESCE(SUM(byte_length), 0) AS total FROM blob_metadata WHERE app_id = ? AND tenant_id = ? AND owner_id = ?",
                &[app_id.into(), tenant_id.into(), owner_id.into()],
            )
            .await?;
        Ok(row.and_then(|row| row.i64("total")).unwrap_or(0))
    }

    /// `deleteMetadata` (blob-store.ts:169-179): remove the metadata row.
    /// Returns `true` when a row was deleted, `false` when already absent —
    /// idempotent. Callers MUST also delete the bytes (and any derivatives);
    /// see the module-level delete-ordering contract.
    pub async fn delete_metadata(
        &self,
        tenant_id: &str,
        blob_id: &str,
        app_id: &str,
    ) -> Result<bool, StoreError> {
        let result = self
            .sql
            .run(
                "DELETE FROM blob_metadata WHERE app_id = ? AND tenant_id = ? AND blob_id = ?",
                &[app_id.into(), tenant_id.into(), blob_id.into()],
            )
            .await?;
        Ok(result.changes > 0)
    }

    /// `listAllOldestFirst` (blob-store.ts:187-196): every row for a tenant,
    /// `ORDER BY created_at ASC, blob_id ASC` — the orphaned-blob GC (FR-57)
    /// examines the oldest (most likely orphaned) blobs first. Loads the whole
    /// tenant into memory; prefer [`BlobStore::list_oldest_first_page`] for
    /// large tenants.
    pub async fn list_all_oldest_first(
        &self,
        tenant_id: &str,
        app_id: &str,
    ) -> Result<Vec<BlobMetadata>, StoreError> {
        let rows = self
            .sql
            .all(
                "SELECT * FROM blob_metadata WHERE app_id = ? AND tenant_id = ? ORDER BY created_at ASC, blob_id ASC",
                &[app_id.into(), tenant_id.into()],
            )
            .await?;
        Ok(rows.iter().map(map_blob_row).collect())
    }

    /// `listOldestFirstPage` (blob-store.ts:209-233): a bounded keyset page,
    /// oldest-first, for the orphaned-blob GC (FR-57). Returns at most `limit`
    /// rows; pass `cursor` = the last row's `(created_at, blob_id)` to resume.
    /// A non-finite/non-positive limit clamps to 1 (mirrors the TS
    /// `Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1`).
    pub async fn list_oldest_first_page(
        &self,
        tenant_id: &str,
        limit: i64,
        cursor: Option<&BlobPageCursor>,
        app_id: &str,
    ) -> Result<Vec<BlobMetadata>, StoreError> {
        let safe_limit = if limit > 0 { limit } else { 1 };
        let rows = match cursor {
            Some(cursor) => {
                self.sql
                    .all(
                        "SELECT * FROM blob_metadata
                            WHERE app_id = ? AND tenant_id = ?
                              AND (created_at > ? OR (created_at = ? AND blob_id > ?))
                            ORDER BY created_at ASC, blob_id ASC
                            LIMIT ?",
                        &[
                            app_id.into(),
                            tenant_id.into(),
                            cursor.created_at.as_str().into(),
                            cursor.created_at.as_str().into(),
                            cursor.blob_id.as_str().into(),
                            safe_limit.into(),
                        ],
                    )
                    .await?
            }
            None => {
                self.sql
                    .all(
                        "SELECT * FROM blob_metadata
                            WHERE app_id = ? AND tenant_id = ?
                            ORDER BY created_at ASC, blob_id ASC
                            LIMIT ?",
                        &[app_id.into(), tenant_id.into(), safe_limit.into()],
                    )
                    .await?
            }
        };
        Ok(rows.iter().map(map_blob_row).collect())
    }

    /// `listAppIdsWithBlobs` (blob-store.ts:242-248): the distinct `app_id`s
    /// owning at least one row for a tenant, ascending — the orphaned-blob GC
    /// (FR-57) fans a sweep across every app that holds blobs.
    pub async fn list_app_ids_with_blobs(
        &self,
        tenant_id: &str,
    ) -> Result<Vec<String>, StoreError> {
        let rows = self
            .sql
            .all(
                "SELECT DISTINCT app_id FROM blob_metadata WHERE tenant_id = ? ORDER BY app_id ASC",
                &[tenant_id.into()],
            )
            .await?;
        Ok(rows
            .iter()
            .filter_map(|row| row.text("app_id").map(str::to_owned))
            .collect())
    }

    // ── blob_derivatives (inline bytes; NO app_id axis) ─────────────────────

    /// `BlobDerivativeStore.record` (blob-derivative-store.ts:75-118): insert
    /// or replace a derivative row, with bytes stored INLINE in `content`.
    /// Replacement happens on the `(tenant_id, parent_blob_id, derivative_id)`
    /// primary key — re-running a processor overwrites. `now_ms` stamps
    /// `created_at`. `metadata` is a pre-serialized JSON string (NULL when
    /// absent); the TS does `JSON.stringify` at the facade.
    #[allow(clippy::too_many_arguments)] // mirrors the TS RecordDerivativeInput shape
    pub async fn record_derivative(
        &self,
        parent_blob_id: &str,
        derivative_id: &str,
        tenant_id: &str,
        processor_id: &str,
        mime_type: &str,
        byte_length: i64,
        content_hash: &str,
        storage_key: &str,
        content: &[u8],
        metadata_json: Option<&str>,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        self.sql
            .run(
                "INSERT INTO blob_derivatives
                    (parent_blob_id, derivative_id, tenant_id, processor_id, mime_type,
                     byte_length, content_hash, storage_key, content, metadata, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(tenant_id, parent_blob_id, derivative_id) DO UPDATE SET
                      processor_id = excluded.processor_id,
                      mime_type = excluded.mime_type,
                      byte_length = excluded.byte_length,
                      content_hash = excluded.content_hash,
                      storage_key = excluded.storage_key,
                      content = excluded.content,
                      metadata = excluded.metadata,
                      created_at = excluded.created_at",
                &[
                    parent_blob_id.into(),
                    derivative_id.into(),
                    tenant_id.into(),
                    processor_id.into(),
                    mime_type.into(),
                    byte_length.into(),
                    content_hash.into(),
                    storage_key.into(),
                    content.to_vec().into(),
                    metadata_json.into(),
                    iso_from_epoch_ms(now_ms).into(),
                ],
            )
            .await?;
        Ok(())
    }

    /// `BlobDerivativeStore.deleteForParent` (blob-derivative-store.ts:136-142):
    /// delete every derivative row for a parent blob within a tenant. Returns
    /// the number of rows removed. First step of the delete-ordering contract
    /// (derivatives → bytes → metadata). The derivative *bytes* are inline on
    /// the row, so this delete reclaims them; a filesystem/S3 byte driver for
    /// the parent still needs an explicit byte delete by the caller.
    pub async fn delete_derivatives(
        &self,
        parent_blob_id: &str,
        tenant_id: &str,
    ) -> Result<u64, StoreError> {
        let result = self
            .sql
            .run(
                "DELETE FROM blob_derivatives WHERE tenant_id = ? AND parent_blob_id = ?",
                &[tenant_id.into(), parent_blob_id.into()],
            )
            .await?;
        Ok(result.changes)
    }

    /// Count the `blob_derivatives` rows for a parent (test/inspection helper;
    /// the TS surfaces them via `listForParent`).
    pub async fn count_derivatives(
        &self,
        parent_blob_id: &str,
        tenant_id: &str,
    ) -> Result<i64, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT COUNT(*) AS n FROM blob_derivatives WHERE tenant_id = ? AND parent_blob_id = ?",
                &[tenant_id.into(), parent_blob_id.into()],
            )
            .await?;
        Ok(row.and_then(|row| row.i64("n")).unwrap_or(0))
    }
}

/// `mapBlobRow` (blob-store.ts:284-296): `SELECT *` row → [`BlobMetadata`].
/// Relies on column NAMES, not positions (map §16.17). A NULL `storage_key`
/// becomes `None` (the TS omits the key).
fn map_blob_row(row: &crate::driver::SqlRow) -> BlobMetadata {
    BlobMetadata {
        blob_id: row.text("blob_id").unwrap_or_default().to_owned(),
        owner_id: row.text("owner_id").unwrap_or_default().to_owned(),
        content_hash: row.text("content_hash").unwrap_or_default().to_owned(),
        byte_length: row.i64("byte_length").unwrap_or_default(),
        mime_type: row.text("mime_type").unwrap_or_default().to_owned(),
        storage_key: row.text("storage_key").map(str::to_owned),
        tenant_id: row.text("tenant_id").unwrap_or_default().to_owned(),
        app_id: row.text("app_id").unwrap_or_default().to_owned(),
        created_at: row.text("created_at").unwrap_or_default().to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stores::blob_bytes::DEFAULT_APP_ID;

    // ── Test schema bootstrap ───────────────────────────────────────────────
    // The effective post-all-migrations SQLite schema for the tables this store
    // touches (map 03 §5; matches `conformance/fixtures/migrations/sqlite.json`
    // after 0003/0008/0021). The driver runs `foreign_keys=OFF` (production
    // parity), so the documentary blob_content FK never blocks inserts.

    const SCHEMA: &str = "
        CREATE TABLE blob_metadata (
          blob_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          mime_type TEXT NOT NULL,
          storage_key TEXT,
          created_at TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT '_default',
          app_id TEXT NOT NULL DEFAULT '_default'
        );
        CREATE TABLE blob_derivatives (
          parent_blob_id TEXT NOT NULL,
          derivative_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT '_default',
          processor_id TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          storage_key TEXT NOT NULL,
          content BLOB,
          metadata TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, parent_blob_id, derivative_id)
        );";

    const TENANT: &str = "tenant-1";
    // A fixed clock so created_at is deterministic: 2023-11-14T22:13:20.123Z.
    const NOW: i64 = 1_700_000_000_123;

    async fn store() -> BlobStore {
        let sql = Arc::new(SqlDriver::open_sqlite(":memory:").unwrap());
        sql.exec(SCHEMA).await.unwrap();
        BlobStore::new(sql)
    }

    fn meta(blob_id: &str) -> BlobMetadataInput {
        meta_owned(blob_id, "owner-1")
    }

    fn meta_owned(blob_id: &str, owner_id: &str) -> BlobMetadataInput {
        BlobMetadataInput {
            blob_id: blob_id.to_owned(),
            owner_id: owner_id.to_owned(),
            content_hash: format!("hash-{blob_id}"),
            byte_length: 3,
            mime_type: "text/plain".to_owned(),
            storage_key: None,
        }
    }

    // ── Port of app-scoping-tail-stores.test.ts (BlobStore section) ──────────

    #[tokio::test]
    async fn isolates_metadata_reads_lists_across_apps() {
        let blobs = store().await;

        blobs
            .create(TENANT, &meta("a-1"), "app-a", NOW)
            .await
            .unwrap();
        blobs
            .create(TENANT, &meta("b-1"), "app-b", NOW)
            .await
            .unwrap();

        let a = blobs.read(TENANT, "a-1", "app-a").await.unwrap().unwrap();
        assert_eq!(a.blob_id, "a-1");
        assert_eq!(a.app_id, "app-a");
        assert!(blobs.read(TENANT, "a-1", "app-b").await.unwrap().is_none());
        assert!(
            blobs
                .read(TENANT, "a-1", DEFAULT_APP_ID)
                .await
                .unwrap()
                .is_none()
        );

        let from_app_a: Vec<String> = blobs
            .list(TENANT, None, "app-a")
            .await
            .unwrap()
            .into_iter()
            .map(|b| b.blob_id)
            .collect();
        assert_eq!(from_app_a, ["a-1"]);
        let from_app_b: Vec<String> = blobs
            .list(TENANT, None, "app-b")
            .await
            .unwrap()
            .into_iter()
            .map(|b| b.blob_id)
            .collect();
        assert_eq!(from_app_b, ["b-1"]);
    }

    #[tokio::test]
    async fn rejects_cross_app_metadata_write_to_blob_owned_by_another_app() {
        let blobs = store().await;
        blobs
            .create(TENANT, &meta("shared"), "app-a", NOW)
            .await
            .unwrap();

        let err = blobs
            .create(TENANT, &meta_owned("shared", "owner-2"), "app-b", NOW)
            .await
            .unwrap_err();
        match &err {
            StoreError::CrossAppAccess {
                requested_app_id,
                owner_app_id,
                tenant_id,
                object_type,
                object_id,
            } => {
                assert_eq!(requested_app_id, "app-b");
                assert_eq!(owner_app_id, "app-a");
                assert_eq!(tenant_id, TENANT);
                assert_eq!(object_type, "blob_metadata");
                assert_eq!(object_id, "shared");
            }
            other => panic!("expected CrossAppAccess, got {other:?}"),
        }
        // Byte-for-byte the TS FrickCrossAppAccessError message.
        assert_eq!(
            err.to_string(),
            "Cross-app access denied on blob_metadata/shared: app 'app-b' may not write a row owned by app 'app-a'"
        );

        // app-a's row is untouched.
        let row = blobs
            .read(TENANT, "shared", "app-a")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.owner_id, "owner-1");
    }

    #[tokio::test]
    async fn total_bytes_for_owner_is_app_scoped() {
        let blobs = store().await;
        for (id, app, len) in [
            ("a-1", "app-a", 10),
            ("a-2", "app-a", 5),
            ("b-1", "app-b", 99),
        ] {
            let mut m = meta(id);
            m.byte_length = len;
            blobs.create(TENANT, &m, app, NOW).await.unwrap();
        }

        assert_eq!(
            blobs
                .total_bytes_for_owner(TENANT, "owner-1", "app-a")
                .await
                .unwrap(),
            15
        );
        assert_eq!(
            blobs
                .total_bytes_for_owner(TENANT, "owner-1", "app-b")
                .await
                .unwrap(),
            99
        );
        // The default app owns nothing ⇒ COALESCE(SUM(...), 0) = 0.
        assert_eq!(
            blobs
                .total_bytes_for_owner(TENANT, "owner-1", DEFAULT_APP_ID)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn defaults_to_default_app_for_single_app_callers() {
        let blobs = store().await;
        blobs
            .create(TENANT, &meta("d-1"), DEFAULT_APP_ID, NOW)
            .await
            .unwrap();

        let row = blobs
            .read(TENANT, "d-1", DEFAULT_APP_ID)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.blob_id, "d-1");
        assert_eq!(row.app_id, DEFAULT_APP_ID);
    }

    // ── create() semantics: createdAt stamp, upsert refresh, storage_key ─────

    #[tokio::test]
    async fn create_stamps_created_at_from_now_ms_and_round_trips_fields() {
        let blobs = store().await;
        let m = BlobMetadataInput {
            blob_id: "blob-x".to_owned(),
            owner_id: "owner-x".to_owned(),
            // The "sha256-"+hex content-hash convention (map §15).
            content_hash: "sha256-deadbeef".to_owned(),
            byte_length: 42,
            mime_type: "image/png".to_owned(),
            storage_key: Some("bucket/key".to_owned()),
        };
        blobs.create(TENANT, &m, DEFAULT_APP_ID, NOW).await.unwrap();

        let row = blobs
            .read(TENANT, "blob-x", DEFAULT_APP_ID)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            row,
            BlobMetadata {
                blob_id: "blob-x".to_owned(),
                owner_id: "owner-x".to_owned(),
                content_hash: "sha256-deadbeef".to_owned(),
                byte_length: 42,
                mime_type: "image/png".to_owned(),
                storage_key: Some("bucket/key".to_owned()),
                tenant_id: TENANT.to_owned(),
                app_id: DEFAULT_APP_ID.to_owned(),
                created_at: "2023-11-14T22:13:20.123Z".to_owned(),
            }
        );
    }

    #[tokio::test]
    async fn create_upsert_on_same_app_refreshes_every_column_including_created_at() {
        let blobs = store().await;
        blobs
            .create(TENANT, &meta("blob-1"), "app-a", NOW)
            .await
            .unwrap();

        // Re-create from the SAME app overwrites via ON CONFLICT(blob_id),
        // refreshing owner, byte_length, storage_key and created_at.
        let updated = BlobMetadataInput {
            blob_id: "blob-1".to_owned(),
            owner_id: "owner-2".to_owned(),
            content_hash: "sha256-new".to_owned(),
            byte_length: 100,
            mime_type: "application/json".to_owned(),
            storage_key: Some("k2".to_owned()),
        };
        let later = NOW + 5_000;
        blobs
            .create(TENANT, &updated, "app-a", later)
            .await
            .unwrap();

        let row = blobs
            .read(TENANT, "blob-1", "app-a")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.owner_id, "owner-2");
        assert_eq!(row.byte_length, 100);
        assert_eq!(row.mime_type, "application/json");
        assert_eq!(row.storage_key, Some("k2".to_owned()));
        assert_eq!(row.created_at, iso_from_epoch_ms(later));
    }

    #[tokio::test]
    async fn null_storage_key_round_trips_as_none() {
        let blobs = store().await;
        blobs
            .create(TENANT, &meta("nokey"), DEFAULT_APP_ID, NOW)
            .await
            .unwrap();
        let row = blobs
            .read(TENANT, "nokey", DEFAULT_APP_ID)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.storage_key, None);
    }

    // ── list ordering ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn list_orders_created_at_desc_then_blob_id_asc_and_owner_filters() {
        let blobs = store().await;
        // Two blobs share a created_at ⇒ tie broken by blob_id ASC; a newer
        // blob sorts first (created_at DESC).
        blobs
            .create(TENANT, &meta("b"), DEFAULT_APP_ID, NOW)
            .await
            .unwrap();
        blobs
            .create(TENANT, &meta("a"), DEFAULT_APP_ID, NOW)
            .await
            .unwrap();
        blobs
            .create(
                TENANT,
                &meta_owned("c", "owner-2"),
                DEFAULT_APP_ID,
                NOW + 1_000,
            )
            .await
            .unwrap();

        let all: Vec<String> = blobs
            .list(TENANT, None, DEFAULT_APP_ID)
            .await
            .unwrap()
            .into_iter()
            .map(|b| b.blob_id)
            .collect();
        assert_eq!(all, ["c", "a", "b"]);

        // owner-filtered list excludes owner-2's "c".
        let owned: Vec<String> = blobs
            .list(TENANT, Some("owner-1"), DEFAULT_APP_ID)
            .await
            .unwrap()
            .into_iter()
            .map(|b| b.blob_id)
            .collect();
        assert_eq!(owned, ["a", "b"]);
    }

    // ── deleteMetadata: idempotent, app-scoped ───────────────────────────────

    #[tokio::test]
    async fn delete_metadata_is_idempotent_and_app_scoped() {
        let blobs = store().await;
        blobs
            .create(TENANT, &meta("blob-1"), "app-a", NOW)
            .await
            .unwrap();

        // Wrong app ⇒ no row deleted.
        assert!(
            !blobs
                .delete_metadata(TENANT, "blob-1", "app-b")
                .await
                .unwrap()
        );
        assert!(
            blobs
                .read(TENANT, "blob-1", "app-a")
                .await
                .unwrap()
                .is_some()
        );

        // Right app ⇒ deleted; second delete is a no-op (false).
        assert!(
            blobs
                .delete_metadata(TENANT, "blob-1", "app-a")
                .await
                .unwrap()
        );
        assert!(
            !blobs
                .delete_metadata(TENANT, "blob-1", "app-a")
                .await
                .unwrap()
        );
        assert!(
            blobs
                .read(TENANT, "blob-1", "app-a")
                .await
                .unwrap()
                .is_none()
        );
    }

    // ── orphan-GC list helpers (FR-57) ───────────────────────────────────────

    #[tokio::test]
    async fn list_all_oldest_first_orders_ascending() {
        let blobs = store().await;
        blobs
            .create(TENANT, &meta("newer"), DEFAULT_APP_ID, NOW + 1_000)
            .await
            .unwrap();
        blobs
            .create(TENANT, &meta("older"), DEFAULT_APP_ID, NOW)
            .await
            .unwrap();
        blobs
            .create(TENANT, &meta("oldera"), DEFAULT_APP_ID, NOW)
            .await
            .unwrap();

        let ids: Vec<String> = blobs
            .list_all_oldest_first(TENANT, DEFAULT_APP_ID)
            .await
            .unwrap()
            .into_iter()
            .map(|b| b.blob_id)
            .collect();
        // created_at ASC, then blob_id ASC for the tie at NOW.
        assert_eq!(ids, ["older", "oldera", "newer"]);
    }

    #[tokio::test]
    async fn list_oldest_first_page_keyset_paginates() {
        let blobs = store().await;
        for (i, id) in ["a", "b", "c", "d"].iter().enumerate() {
            // Distinct created_at values, ascending with the id order.
            #[allow(clippy::cast_possible_truncation, clippy::cast_possible_wrap)]
            let ts = NOW + (i as i64) * 1_000;
            blobs
                .create(TENANT, &meta(id), DEFAULT_APP_ID, ts)
                .await
                .unwrap();
        }

        let page1 = blobs
            .list_oldest_first_page(TENANT, 2, None, DEFAULT_APP_ID)
            .await
            .unwrap();
        let ids1: Vec<&str> = page1.iter().map(|b| b.blob_id.as_str()).collect();
        assert_eq!(ids1, ["a", "b"]);

        let last = page1.last().unwrap();
        let cursor = BlobPageCursor {
            created_at: last.created_at.clone(),
            blob_id: last.blob_id.clone(),
        };
        let page2 = blobs
            .list_oldest_first_page(TENANT, 2, Some(&cursor), DEFAULT_APP_ID)
            .await
            .unwrap();
        let ids2: Vec<&str> = page2.iter().map(|b| b.blob_id.as_str()).collect();
        assert_eq!(ids2, ["c", "d"]);
    }

    #[tokio::test]
    async fn list_oldest_first_page_clamps_nonpositive_limit_to_one() {
        let blobs = store().await;
        blobs
            .create(TENANT, &meta("a"), DEFAULT_APP_ID, NOW)
            .await
            .unwrap();
        blobs
            .create(TENANT, &meta("b"), DEFAULT_APP_ID, NOW + 1_000)
            .await
            .unwrap();
        for limit in [0_i64, -5] {
            let page = blobs
                .list_oldest_first_page(TENANT, limit, None, DEFAULT_APP_ID)
                .await
                .unwrap();
            assert_eq!(page.len(), 1, "limit {limit} should clamp to 1");
            assert_eq!(page[0].blob_id, "a");
        }
    }

    #[tokio::test]
    async fn list_app_ids_with_blobs_returns_distinct_ascending() {
        let blobs = store().await;
        blobs
            .create(TENANT, &meta("a-1"), "app-b", NOW)
            .await
            .unwrap();
        blobs
            .create(TENANT, &meta("a-2"), "app-a", NOW)
            .await
            .unwrap();
        blobs
            .create(TENANT, &meta("a-3"), "app-a", NOW)
            .await
            .unwrap();
        blobs
            .create("other-tenant", &meta("z-1"), "app-z", NOW)
            .await
            .unwrap();

        let app_ids = blobs.list_app_ids_with_blobs(TENANT).await.unwrap();
        assert_eq!(app_ids, ["app-a", "app-b"]);
    }

    // ── blob_derivatives (inline bytes; delete-ordering contract) ────────────

    #[tokio::test]
    async fn derivative_storage_key_is_canonical() {
        assert_eq!(
            derivative_storage_key("parent-1", "thumb"),
            "derivative/parent-1/thumb"
        );
    }

    #[tokio::test]
    async fn record_derivative_upserts_on_primary_key_and_delete_for_parent_reclaims() {
        let blobs = store().await;
        let storage_key = derivative_storage_key("parent-1", "thumb");

        blobs
            .record_derivative(
                "parent-1",
                "thumb",
                TENANT,
                "image-thumbnail",
                "image/png",
                3,
                "sha256-aaa",
                &storage_key,
                b"PNG",
                Some(r#"{"width":16}"#),
                NOW,
            )
            .await
            .unwrap();
        assert_eq!(
            blobs.count_derivatives("parent-1", TENANT).await.unwrap(),
            1
        );

        // Re-running the processor overwrites on (tenant, parent, derivative).
        blobs
            .record_derivative(
                "parent-1",
                "thumb",
                TENANT,
                "image-thumbnail",
                "image/webp",
                4,
                "sha256-bbb",
                &storage_key,
                b"WEBP",
                None,
                NOW + 1_000,
            )
            .await
            .unwrap();
        assert_eq!(
            blobs.count_derivatives("parent-1", TENANT).await.unwrap(),
            1
        );

        // A second derivative for the same parent is a distinct row.
        blobs
            .record_derivative(
                "parent-1",
                "meta",
                TENANT,
                "exif",
                "application/json",
                2,
                "sha256-ccc",
                &derivative_storage_key("parent-1", "meta"),
                b"{}",
                None,
                NOW,
            )
            .await
            .unwrap();
        assert_eq!(
            blobs.count_derivatives("parent-1", TENANT).await.unwrap(),
            2
        );

        // deleteForParent removes every derivative of the parent (returns the
        // count) and is tenant-scoped — the first delete step of the
        // derivatives → bytes → metadata ordering contract.
        assert_eq!(
            blobs
                .delete_derivatives("parent-1", "other-tenant")
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            blobs.delete_derivatives("parent-1", TENANT).await.unwrap(),
            2
        );
        assert_eq!(
            blobs.count_derivatives("parent-1", TENANT).await.unwrap(),
            0
        );
    }
}
