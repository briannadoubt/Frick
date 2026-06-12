//! Tenant ledger + per-tenant settings (`apps/server/src/storage/tenant-store.ts`
//! and `tenant-settings-store.ts`; map 03 §5 and §9.9).
//!
//! [`TenantStore`] owns the `tenants` ledger added by migration
//! `0004_tenants_ledger`: a durable list of known tenant ids so the server can
//! enumerate tenants and refuse traffic for unknown ones. [`TenantSettingsStore`]
//! owns the `tenant_settings` KV (migration `0010_tenant_settings`): JSON-encoded
//! per-tenant runtime knobs (`"limits"`, `"retentionMs"`).
//!
//! Determinism: the TS classes call `new Date().toISOString()` internally; every
//! method here takes `now_ms: i64` (formatted via
//! [`iso_from_epoch_ms`](crate::stores::blob_bytes::iso_from_epoch_ms)) so store
//! logic never reads the system clock — system time belongs at the facade.

use crate::driver::{SqlDriver, SqlRow};
use crate::error::StoreError;
use crate::stores::blob_bytes::iso_from_epoch_ms;

/// A row in the `tenants` ledger (`TenantRow`, tenant-store.ts:9-14).
/// `display_name`/`archived_at` are `None` when the column is SQL NULL (the TS
/// mapper omits the key entirely; the Rust port renders the absent `Option`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TenantRow {
    pub tenant_id: String,
    pub display_name: Option<String>,
    pub created_at: String,
    pub archived_at: Option<String>,
}

/// `TenantAlreadyExistsError` (tenant-store.ts:24-29): thrown by
/// [`TenantStore::create`] when a non-archived row already exists. Message text
/// is byte-for-byte the TS class (`Tenant <id> already exists`); carried through
/// [`StoreError::Store`] since the conformance bar treats the string as contract.
#[must_use]
pub fn tenant_already_exists_message(tenant_id: &str) -> String {
    format!("Tenant {tenant_id} already exists")
}

/// `TenantStore` (`storage/tenant-store.ts`): the `tenants` ledger.
pub struct TenantStore {
    sql: std::sync::Arc<SqlDriver>,
}

impl TenantStore {
    #[must_use]
    pub fn new(sql: std::sync::Arc<SqlDriver>) -> Self {
        Self { sql }
    }

    /// `list` (tenant-store.ts:34-40): every ledger row, `ORDER BY created_at
    /// ASC, tenant_id ASC`. `include_archived = false` filters
    /// `archived_at IS NULL`.
    pub async fn list(&self, include_archived: bool) -> Result<Vec<TenantRow>, StoreError> {
        let query = if include_archived {
            "SELECT * FROM tenants ORDER BY created_at ASC, tenant_id ASC"
        } else {
            "SELECT * FROM tenants WHERE archived_at IS NULL ORDER BY created_at ASC, tenant_id ASC"
        };
        let rows = self.sql.all(query, &[]).await?;
        Ok(rows.iter().map(to_tenant_row).collect())
    }

    /// `get` (tenant-store.ts:42-48): one ledger row by id, or `None`.
    pub async fn get(&self, tenant_id: &str) -> Result<Option<TenantRow>, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT * FROM tenants WHERE tenant_id = ?",
                &[tenant_id.into()],
            )
            .await?;
        Ok(row.as_ref().map(to_tenant_row))
    }

    /// `create` (tenant-store.ts:50-78). A non-archived row already present ⇒
    /// [`StoreError::Store`] carrying [`tenant_already_exists_message`]. An
    /// *archived* row is revived: clear `archived_at` and refresh
    /// `display_name`, keeping the ORIGINAL `created_at`. A fresh tenant is
    /// inserted with `created_at = iso(now_ms)`.
    ///
    /// `now_ms` stamps `created_at` on a fresh insert (unused on a revive,
    /// which preserves the original timestamp — mirroring the TS, which only
    /// reads `new Date()` for the insert branch).
    pub async fn create(
        &self,
        tenant_id: &str,
        display_name: Option<&str>,
        now_ms: i64,
    ) -> Result<TenantRow, StoreError> {
        let existing = self.get(tenant_id).await?;
        if let Some(existing) = &existing
            && existing.archived_at.is_none()
        {
            return Err(StoreError::store(tenant_already_exists_message(tenant_id)));
        }
        if let Some(existing) = existing {
            // existing.archived_at is Some here (the non-archived branch
            // returned above). Revive: clear archived_at, refresh display_name,
            // keep the original created_at.
            self.sql
                .run(
                    "UPDATE tenants SET display_name = ?, archived_at = NULL WHERE tenant_id = ?",
                    &[display_name.into(), tenant_id.into()],
                )
                .await?;
            return Ok(TenantRow {
                tenant_id: tenant_id.to_owned(),
                display_name: display_name.map(str::to_owned),
                created_at: existing.created_at,
                archived_at: None,
            });
        }
        let created_at = iso_from_epoch_ms(now_ms);
        self.sql
            .run(
                "INSERT INTO tenants (tenant_id, display_name, created_at)\n          VALUES (?, ?, ?)",
                &[
                    tenant_id.into(),
                    display_name.into(),
                    created_at.as_str().into(),
                ],
            )
            .await?;
        Ok(TenantRow {
            tenant_id: tenant_id.to_owned(),
            display_name: display_name.map(str::to_owned),
            created_at,
            archived_at: None,
        })
    }

    /// `archive` (tenant-store.ts:80-91): soft-delete. Idempotent — archiving
    /// an absent or already-archived row is a no-op (so the timestamp is never
    /// overwritten). `now_ms` stamps `archived_at`.
    pub async fn archive(&self, tenant_id: &str, now_ms: i64) -> Result<(), StoreError> {
        let existing = self.get(tenant_id).await?;
        let Some(existing) = existing else {
            return Ok(());
        };
        if existing.archived_at.is_some() {
            return Ok(());
        }
        let archived_at = iso_from_epoch_ms(now_ms);
        self.sql
            .run(
                "UPDATE tenants SET archived_at = ? WHERE tenant_id = ?",
                &[archived_at.as_str().into(), tenant_id.into()],
            )
            .await?;
        Ok(())
    }

    /// `ensure` (tenant-store.ts:98-106): insert a tenant if absent, leaving any
    /// existing row (archived or not) untouched. Used by the implicit-tenant-
    /// creation auth path. Bare `ON CONFLICT DO NOTHING` (no conflict target —
    /// map §16.18). `now_ms` stamps `created_at` only on a fresh insert.
    pub async fn ensure(&self, tenant_id: &str, now_ms: i64) -> Result<(), StoreError> {
        let created_at = iso_from_epoch_ms(now_ms);
        self.sql
            .run(
                "INSERT INTO tenants (tenant_id, display_name, created_at)\n          VALUES (?, NULL, ?)\n          ON CONFLICT DO NOTHING",
                &[tenant_id.into(), created_at.as_str().into()],
            )
            .await?;
        Ok(())
    }
}

/// `toTenantRow` (tenant-store.ts:109-116): `SELECT *` row → [`TenantRow`].
/// NULL `display_name`/`archived_at` become `None`.
fn to_tenant_row(row: &SqlRow) -> TenantRow {
    TenantRow {
        tenant_id: row.text("tenant_id").unwrap_or_default().to_owned(),
        display_name: row.text("display_name").map(str::to_owned),
        created_at: row.text("created_at").unwrap_or_default().to_owned(),
        archived_at: row.text("archived_at").map(str::to_owned),
    }
}

/// `TenantSettingsStore` (`storage/tenant-settings-store.ts`): per-tenant
/// JSON-encoded runtime knobs. Values that fail to parse on read are treated as
/// missing — a corrupt row never breaks the hot path.
pub struct TenantSettingsStore {
    sql: std::sync::Arc<SqlDriver>,
}

impl TenantSettingsStore {
    #[must_use]
    pub fn new(sql: std::sync::Arc<SqlDriver>) -> Self {
        Self { sql }
    }

    /// `get` (tenant-settings-store.ts:31-43): the decoded JSON value, or `None`
    /// when the key is unset OR the stored JSON is malformed (parse failure is
    /// swallowed, exactly like the TS `try/catch`).
    pub async fn get(
        &self,
        tenant_id: &str,
        key: &str,
    ) -> Result<Option<serde_json::Value>, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT setting_value FROM tenant_settings\n          WHERE tenant_id = ? AND setting_key = ?",
                &[tenant_id.into(), key.into()],
            )
            .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let Some(raw) = row.text("setting_value") else {
            return Ok(None);
        };
        Ok(serde_json::from_str(raw).ok())
    }

    /// `set` (tenant-settings-store.ts:49-60): upsert a JSON-encoded value with
    /// `updated_at = iso(now_ms)`. The value is serialized exactly like
    /// `JSON.stringify` (the TS encodes at the boundary). `now_ms` stamps
    /// `updated_at` (the TS reads its injected `now()` clock).
    pub async fn set(
        &self,
        tenant_id: &str,
        key: &str,
        value: &serde_json::Value,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        let encoded = serde_json::to_string(value)
            .map_err(|err| StoreError::store(format!("tenant_settings encode: {err}")))?;
        let updated_at = iso_from_epoch_ms(now_ms);
        self.sql
            .run(
                "INSERT INTO tenant_settings (tenant_id, setting_key, setting_value, updated_at)\n          VALUES (?, ?, ?, ?)\n          ON CONFLICT(tenant_id, setting_key) DO UPDATE SET\n            setting_value = excluded.setting_value,\n            updated_at = excluded.updated_at",
                &[
                    tenant_id.into(),
                    key.into(),
                    encoded.as_str().into(),
                    updated_at.as_str().into(),
                ],
            )
            .await?;
        Ok(())
    }

    /// `delete` (tenant-settings-store.ts:63-68): remove a single setting.
    /// Idempotent — deleting a missing row is a no-op.
    pub async fn delete(&self, tenant_id: &str, key: &str) -> Result<(), StoreError> {
        self.sql
            .run(
                "DELETE FROM tenant_settings WHERE tenant_id = ? AND setting_key = ?",
                &[tenant_id.into(), key.into()],
            )
            .await?;
        Ok(())
    }

    /// `list` (tenant-settings-store.ts:74-90): every setting for a tenant as a
    /// `(key, value)` map. Keys whose stored JSON is malformed are omitted
    /// (matching [`get`](Self::get)). Rows are read `ORDER BY setting_key ASC`;
    /// the returned [`BTreeMap`](std::collections::BTreeMap) preserves that
    /// ascending key order.
    pub async fn list(
        &self,
        tenant_id: &str,
    ) -> Result<std::collections::BTreeMap<String, serde_json::Value>, StoreError> {
        let rows = self
            .sql
            .all(
                "SELECT setting_key, setting_value FROM tenant_settings\n          WHERE tenant_id = ?\n          ORDER BY setting_key ASC",
                &[tenant_id.into()],
            )
            .await?;
        let mut out = std::collections::BTreeMap::new();
        for row in &rows {
            let (Some(key), Some(raw)) = (row.text("setting_key"), row.text("setting_value"))
            else {
                continue;
            };
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) {
                out.insert(key.to_owned(), value);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    // Effective post-all-migrations SQLite schema for the tables these stores
    // touch (map 03 §5; tenants from 0004, tenant_settings from 0010).
    const SCHEMA: &str = "
        CREATE TABLE tenants (
          tenant_id TEXT PRIMARY KEY NOT NULL,
          display_name TEXT,
          created_at TEXT NOT NULL,
          archived_at TEXT
        );
        CREATE TABLE tenant_settings (
          tenant_id TEXT NOT NULL,
          setting_key TEXT NOT NULL,
          setting_value TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, setting_key)
        );";

    // A fixed clock so created_at is deterministic: 2023-11-14T22:13:20.123Z.
    const NOW: i64 = 1_700_000_000_123;

    async fn stores() -> (TenantStore, TenantSettingsStore) {
        let sql = Arc::new(SqlDriver::open_sqlite(":memory:").unwrap());
        sql.exec(SCHEMA).await.unwrap();
        (TenantStore::new(sql.clone()), TenantSettingsStore::new(sql))
    }

    // ── TenantStore ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn create_inserts_and_get_round_trips() {
        let (tenants, _) = stores().await;
        let row = tenants.create("acme", Some("Acme Inc"), NOW).await.unwrap();
        assert_eq!(
            row,
            TenantRow {
                tenant_id: "acme".to_owned(),
                display_name: Some("Acme Inc".to_owned()),
                created_at: iso_from_epoch_ms(NOW),
                archived_at: None,
            }
        );
        assert_eq!(tenants.get("acme").await.unwrap(), Some(row));
        assert_eq!(tenants.get("missing").await.unwrap(), None);
    }

    #[tokio::test]
    async fn create_without_display_name_stores_null() {
        let (tenants, _) = stores().await;
        let row = tenants.create("acme", None, NOW).await.unwrap();
        assert_eq!(row.display_name, None);
        // NULL display_name round-trips as None (the TS omits the key).
        assert_eq!(
            tenants.get("acme").await.unwrap().unwrap().display_name,
            None
        );
    }

    #[tokio::test]
    async fn create_on_existing_non_archived_errors_with_exact_message() {
        let (tenants, _) = stores().await;
        tenants.create("acme", Some("Acme"), NOW).await.unwrap();
        let err = tenants
            .create("acme", Some("Acme 2"), NOW + 1)
            .await
            .unwrap_err();
        // Byte-for-byte the TS TenantAlreadyExistsError message.
        assert_eq!(err.to_string(), "Tenant acme already exists");
        assert!(matches!(err, StoreError::Store(_)));
    }

    #[tokio::test]
    async fn create_revives_archived_tenant_keeping_original_created_at() {
        let (tenants, _) = stores().await;
        tenants.create("acme", Some("Acme"), NOW).await.unwrap();
        tenants.archive("acme", NOW + 1_000).await.unwrap();
        assert!(
            tenants
                .get("acme")
                .await
                .unwrap()
                .unwrap()
                .archived_at
                .is_some()
        );

        // Revive with a NEW display_name and a LATER clock; created_at stays
        // the original.
        let revived = tenants
            .create("acme", Some("Acme Revived"), NOW + 5_000)
            .await
            .unwrap();
        assert_eq!(
            revived,
            TenantRow {
                tenant_id: "acme".to_owned(),
                display_name: Some("Acme Revived".to_owned()),
                created_at: iso_from_epoch_ms(NOW), // original, NOT NOW+5000
                archived_at: None,
            }
        );
        let stored = tenants.get("acme").await.unwrap().unwrap();
        assert_eq!(stored.created_at, iso_from_epoch_ms(NOW));
        assert_eq!(stored.display_name, Some("Acme Revived".to_owned()));
        assert_eq!(stored.archived_at, None);
    }

    #[tokio::test]
    async fn revive_can_clear_display_name() {
        let (tenants, _) = stores().await;
        tenants.create("acme", Some("Acme"), NOW).await.unwrap();
        tenants.archive("acme", NOW + 1).await.unwrap();
        let revived = tenants.create("acme", None, NOW + 2).await.unwrap();
        assert_eq!(revived.display_name, None);
        assert_eq!(
            tenants.get("acme").await.unwrap().unwrap().display_name,
            None
        );
    }

    #[tokio::test]
    async fn archive_is_idempotent_and_preserves_timestamp() {
        let (tenants, _) = stores().await;
        tenants.create("acme", None, NOW).await.unwrap();
        tenants.archive("acme", NOW + 1_000).await.unwrap();
        let first = tenants
            .get("acme")
            .await
            .unwrap()
            .unwrap()
            .archived_at
            .unwrap();
        assert_eq!(first, iso_from_epoch_ms(NOW + 1_000));

        // A second archive at a later clock does NOT overwrite the timestamp.
        tenants.archive("acme", NOW + 9_000).await.unwrap();
        assert_eq!(
            tenants
                .get("acme")
                .await
                .unwrap()
                .unwrap()
                .archived_at
                .unwrap(),
            first
        );
    }

    #[tokio::test]
    async fn archive_missing_tenant_is_noop() {
        let (tenants, _) = stores().await;
        tenants.archive("ghost", NOW).await.unwrap();
        assert_eq!(tenants.get("ghost").await.unwrap(), None);
    }

    #[tokio::test]
    async fn list_orders_by_created_at_then_tenant_id_and_excludes_archived() {
        let (tenants, _) = stores().await;
        // Same created_at for b and a ⇒ tie broken by tenant_id ASC; c is newer.
        tenants.create("b", None, NOW).await.unwrap();
        tenants.create("a", None, NOW).await.unwrap();
        tenants.create("c", None, NOW + 1_000).await.unwrap();
        tenants.archive("a", NOW + 2_000).await.unwrap();

        let active: Vec<String> = tenants
            .list(false)
            .await
            .unwrap()
            .into_iter()
            .map(|t| t.tenant_id)
            .collect();
        // created_at ASC, tenant_id ASC; "a" excluded (archived).
        assert_eq!(active, ["b", "c"]);

        let all: Vec<String> = tenants
            .list(true)
            .await
            .unwrap()
            .into_iter()
            .map(|t| t.tenant_id)
            .collect();
        // include_archived ⇒ "a" sorts first (same created_at as "b", id ASC).
        assert_eq!(all, ["a", "b", "c"]);
    }

    #[tokio::test]
    async fn ensure_inserts_once_and_leaves_existing_untouched() {
        let (tenants, _) = stores().await;
        // First ensure inserts with NULL display_name.
        tenants.ensure("acme", NOW).await.unwrap();
        let first = tenants.get("acme").await.unwrap().unwrap();
        assert_eq!(first.display_name, None);
        assert_eq!(first.created_at, iso_from_epoch_ms(NOW));

        // A second ensure at a later clock is a no-op (ON CONFLICT DO NOTHING).
        tenants.ensure("acme", NOW + 9_000).await.unwrap();
        assert_eq!(
            tenants.get("acme").await.unwrap().unwrap().created_at,
            first.created_at
        );
    }

    #[tokio::test]
    async fn ensure_does_not_revive_an_archived_tenant() {
        let (tenants, _) = stores().await;
        tenants.create("acme", Some("Acme"), NOW).await.unwrap();
        tenants.archive("acme", NOW + 1).await.unwrap();
        // ensure hits ON CONFLICT DO NOTHING ⇒ the archived tombstone stays.
        tenants.ensure("acme", NOW + 2).await.unwrap();
        assert!(
            tenants
                .get("acme")
                .await
                .unwrap()
                .unwrap()
                .archived_at
                .is_some()
        );
    }

    // ── TenantSettingsStore ──────────────────────────────────────────────────

    #[tokio::test]
    async fn settings_set_get_round_trips_json() {
        let (_, settings) = stores().await;
        let value = serde_json::json!({ "retentionMs": 60000, "nested": [1, 2, 3] });
        settings.set("acme", "limits", &value, NOW).await.unwrap();
        assert_eq!(settings.get("acme", "limits").await.unwrap(), Some(value));
        // An unset key reads as None.
        assert_eq!(settings.get("acme", "missing").await.unwrap(), None);
        // A different tenant doesn't see acme's setting.
        assert_eq!(settings.get("other", "limits").await.unwrap(), None);
    }

    #[tokio::test]
    async fn settings_set_upserts_and_refreshes_value() {
        let (_, settings) = stores().await;
        settings
            .set("acme", "retentionMs", &serde_json::json!(1000), NOW)
            .await
            .unwrap();
        settings
            .set("acme", "retentionMs", &serde_json::json!(2000), NOW + 5)
            .await
            .unwrap();
        assert_eq!(
            settings.get("acme", "retentionMs").await.unwrap(),
            Some(serde_json::json!(2000))
        );
    }

    #[tokio::test]
    async fn settings_get_returns_none_for_malformed_json() {
        let sql = Arc::new(SqlDriver::open_sqlite(":memory:").unwrap());
        sql.exec(SCHEMA).await.unwrap();
        let settings = TenantSettingsStore::new(sql.clone());
        // Write a deliberately malformed JSON value via raw SQL (the only way
        // to corrupt a row — set() always JSON-encodes).
        sql.run(
            "INSERT INTO tenant_settings (tenant_id, setting_key, setting_value, updated_at) VALUES (?, ?, ?, ?)",
            &[
                "acme".into(),
                "broken".into(),
                "{not json".into(),
                iso_from_epoch_ms(NOW).as_str().into(),
            ],
        )
        .await
        .unwrap();
        assert_eq!(settings.get("acme", "broken").await.unwrap(), None);
    }

    #[tokio::test]
    async fn settings_delete_is_idempotent() {
        let (_, settings) = stores().await;
        settings
            .set("acme", "limits", &serde_json::json!(1), NOW)
            .await
            .unwrap();
        settings.delete("acme", "limits").await.unwrap();
        assert_eq!(settings.get("acme", "limits").await.unwrap(), None);
        // Deleting a missing row is a no-op.
        settings.delete("acme", "limits").await.unwrap();
    }

    #[tokio::test]
    async fn settings_list_orders_by_key_and_skips_malformed() {
        let sql = Arc::new(SqlDriver::open_sqlite(":memory:").unwrap());
        sql.exec(SCHEMA).await.unwrap();
        let settings = TenantSettingsStore::new(sql.clone());

        settings
            .set("acme", "zeta", &serde_json::json!("z"), NOW)
            .await
            .unwrap();
        settings
            .set("acme", "alpha", &serde_json::json!("a"), NOW)
            .await
            .unwrap();
        // A malformed row is skipped by list().
        sql.run(
            "INSERT INTO tenant_settings (tenant_id, setting_key, setting_value, updated_at) VALUES (?, ?, ?, ?)",
            &[
                "acme".into(),
                "mid".into(),
                "}}bad".into(),
                iso_from_epoch_ms(NOW).as_str().into(),
            ],
        )
        .await
        .unwrap();
        // A different tenant's setting is excluded.
        settings
            .set("other", "x", &serde_json::json!(1), NOW)
            .await
            .unwrap();

        let all = settings.list("acme").await.unwrap();
        // BTreeMap iteration is ascending by key; "mid" skipped (malformed).
        let keys: Vec<&str> = all.keys().map(String::as_str).collect();
        assert_eq!(keys, ["alpha", "zeta"]);
        assert_eq!(all.get("alpha"), Some(&serde_json::json!("a")));
        assert_eq!(all.get("zeta"), Some(&serde_json::json!("z")));
    }
}
