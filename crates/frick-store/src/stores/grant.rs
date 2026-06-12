//! Grant store (`apps/server/src/storage/grant-store.ts`; map 03 §5 and §9.9).
//! The durable half of the two-phase sharing model
//! (`packages/protocol/src/sharing.ts`): "user G has permission P on record R
//! until revoked." Created by the redeem path, listed/revoked by owners, and
//! consulted on the authorization hot path.
//!
//! Determinism: the caller supplies the grant `id` and every timestamp
//! (`created_at` on create, `now` on revoke). The store never reads the system
//! clock — mirroring the TS `CreateGrantArgs`/`revoke({now})` signatures.

use crate::driver::{SqlDriver, SqlRow};
use crate::error::StoreError;

/// `frickSharingPermissionSatisfies` (`packages/protocol/src/sharing.ts:129-137`):
/// true iff `permission` is at least as strong as `required`. A `"read"`
/// requirement is met by either `"read"` or `"write"`; a `"write"` requirement
/// needs exactly `"write"`.
///
/// Ported over raw column strings (the TS casts `row.permission as
/// FrickSharingPermission` without validating), so any value other than the two
/// canonical literals satisfies nothing — byte-for-byte the TS `===` checks.
#[must_use]
pub fn sharing_permission_satisfies(permission: &str, required: &str) -> bool {
    if required == "read" {
        permission == "read" || permission == "write"
    } else {
        permission == "write"
    }
}

/// `FrickGrant` (`sharing.ts:49-63`). `permission` keeps the raw column string
/// (the TS casts without validating). `revoked_at` is `None` when the column is
/// SQL NULL (the TS mapper omits the key).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    pub id: String,
    pub tenant_id: String,
    pub owner_user_id: String,
    pub record_type: String,
    pub record_id: String,
    pub grantee_user_id: String,
    pub permission: String,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

/// `CreateGrantArgs` (grant-store.ts:20-29). The grant `id` and `created_at`
/// are caller-supplied — the store performs no generation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateGrantArgs {
    pub id: String,
    pub tenant_id: String,
    pub owner_user_id: String,
    pub record_type: String,
    pub record_id: String,
    pub grantee_user_id: String,
    pub permission: String,
    pub created_at: String,
}

/// `ListGrantsArgs` (grant-store.ts:31-39). `principal_user_id` is mandatory:
/// results are limited to grants where the principal is owner OR grantee (there
/// is no "list every grant in the tenant" call). `record_type`/`record_id` are
/// optional narrowing filters; `include_revoked` defaults to `false`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListGrantsArgs<'a> {
    pub tenant_id: &'a str,
    pub principal_user_id: &'a str,
    pub record_type: Option<&'a str>,
    pub record_id: Option<&'a str>,
    pub include_revoked: bool,
}

/// `GrantStore` (`storage/grant-store.ts`).
pub struct GrantStore {
    sql: std::sync::Arc<SqlDriver>,
}

impl GrantStore {
    #[must_use]
    pub fn new(sql: std::sync::Arc<SqlDriver>) -> Self {
        Self { sql }
    }

    /// `isEmptyAsync` (grant-store.ts:55-62): `true` while the `grants` table
    /// holds no rows at all (revoked rows still count as present). The sync
    /// delivery path (FR-116) uses it as a cheap `EXISTS` short-circuit. The
    /// `present` column is integer `0`/`1` on SQLite (boolean on PG) — both
    /// treated truthy, so the store is empty iff `present` is falsy.
    pub async fn is_empty_async(&self) -> Result<bool, StoreError> {
        let row = self
            .sql
            .get("SELECT EXISTS(SELECT 1 FROM grants) AS present", &[])
            .await?;
        // `!row?.present` in TS: undefined row OR present == 0 ⇒ empty.
        let present = row.and_then(|row| row.i64("present")).unwrap_or(0);
        Ok(present == 0)
    }

    /// `create` (grant-store.ts:64-91): insert the grant row and echo it back as
    /// a fresh (non-revoked) [`Grant`]. Column order is load-bearing.
    pub async fn create(&self, args: &CreateGrantArgs) -> Result<Grant, StoreError> {
        self.sql
            .run(
                "INSERT INTO grants (\n            id, tenant_id, owner_user_id, record_type, record_id,\n            grantee_user_id, permission, created_at\n          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                &[
                    args.id.as_str().into(),
                    args.tenant_id.as_str().into(),
                    args.owner_user_id.as_str().into(),
                    args.record_type.as_str().into(),
                    args.record_id.as_str().into(),
                    args.grantee_user_id.as_str().into(),
                    args.permission.as_str().into(),
                    args.created_at.as_str().into(),
                ],
            )
            .await?;
        Ok(Grant {
            id: args.id.clone(),
            tenant_id: args.tenant_id.clone(),
            owner_user_id: args.owner_user_id.clone(),
            record_type: args.record_type.clone(),
            record_id: args.record_id.clone(),
            grantee_user_id: args.grantee_user_id.clone(),
            permission: args.permission.clone(),
            created_at: args.created_at.clone(),
            revoked_at: None,
        })
    }

    /// `getById` (grant-store.ts:93-99): one grant by `(tenant_id, id)`, or
    /// `None`.
    pub async fn get_by_id(&self, tenant_id: &str, id: &str) -> Result<Option<Grant>, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT * FROM grants WHERE tenant_id = ? AND id = ?",
                &[tenant_id.into(), id.into()],
            )
            .await?;
        Ok(row.as_ref().map(to_grant))
    }

    /// `list` (grant-store.ts:101-125): grants in `tenant_id` where the
    /// principal is owner OR grantee, optionally narrowed by `record_type`
    /// and/or `record_id`, optionally including revoked rows. `ORDER BY
    /// created_at DESC, id ASC`. The dynamic filter set (and its parameter
    /// order) mirrors the TS exactly.
    pub async fn list(&self, args: &ListGrantsArgs<'_>) -> Result<Vec<Grant>, StoreError> {
        let mut filters: Vec<&str> = vec![
            "tenant_id = ?",
            "(owner_user_id = ? OR grantee_user_id = ?)",
        ];
        let mut params: Vec<crate::driver::SqlValue> = vec![
            args.tenant_id.into(),
            args.principal_user_id.into(),
            args.principal_user_id.into(),
        ];
        if let Some(record_type) = args.record_type {
            filters.push("record_type = ?");
            params.push(record_type.into());
        }
        if let Some(record_id) = args.record_id {
            filters.push("record_id = ?");
            params.push(record_id.into());
        }
        if !args.include_revoked {
            filters.push("revoked_at IS NULL");
        }
        let sql = format!(
            "SELECT * FROM grants WHERE {} ORDER BY created_at DESC, id ASC",
            filters.join(" AND ")
        );
        let rows = self.sql.all(&sql, &params).await?;
        Ok(rows.iter().map(to_grant).collect())
    }

    /// `revoke` (grant-store.ts:128-142): idempotent soft-revoke. Returns the
    /// updated row, or `None` when the id is unknown. An already-revoked grant
    /// is returned unchanged (the guarded UPDATE never overwrites the original
    /// `revoked_at`). `now` is the caller-supplied ISO timestamp.
    pub async fn revoke(
        &self,
        tenant_id: &str,
        id: &str,
        now: &str,
    ) -> Result<Option<Grant>, StoreError> {
        let Some(existing) = self.get_by_id(tenant_id, id).await? else {
            return Ok(None);
        };
        if existing.revoked_at.is_some() {
            return Ok(Some(existing));
        }
        self.sql
            .run(
                "UPDATE grants SET revoked_at = ?\n          WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL",
                &[now.into(), tenant_id.into(), id.into()],
            )
            .await?;
        Ok(Some(Grant {
            revoked_at: Some(now.to_owned()),
            ..existing
        }))
    }

    /// `hasActiveGrantFor` (grant-store.ts:150-170): true iff an active
    /// (non-revoked) grant exists for `grantee_user_id` on `(record_type,
    /// record_id)` within `tenant_id` whose permission satisfies `required`.
    /// Permission satisfaction is evaluated in Rust via
    /// [`sharing_permission_satisfies`] (the TS does it in JS, not SQL).
    pub async fn has_active_grant_for(
        &self,
        tenant_id: &str,
        grantee_user_id: &str,
        record_type: &str,
        record_id: &str,
        required: &str,
    ) -> Result<bool, StoreError> {
        let rows = self
            .sql
            .all(
                "SELECT permission FROM grants\n          WHERE tenant_id = ? AND grantee_user_id = ?\n            AND record_type = ? AND record_id = ?\n            AND revoked_at IS NULL",
                &[
                    tenant_id.into(),
                    grantee_user_id.into(),
                    record_type.into(),
                    record_id.into(),
                ],
            )
            .await?;
        Ok(rows.iter().any(|row| {
            row.text("permission")
                .is_some_and(|permission| sharing_permission_satisfies(permission, required))
        }))
    }

    /// `hasActiveGrantForRecordId` (grant-store.ts:185-203): the cascade lookup
    /// used by stream + projection read authorization (FR-70). True iff an
    /// active grant exists for `grantee_user_id` on ANY record whose `record_id`
    /// equals `record_id` within `tenant_id`, whose permission satisfies
    /// `"read"` (streams/projections are keyed by id, not by `(type, id)`, and a
    /// `"read"` grant always suffices for the read-only cascade — `"write"`
    /// satisfies `"read"`).
    pub async fn has_active_grant_for_record_id(
        &self,
        tenant_id: &str,
        grantee_user_id: &str,
        record_id: &str,
    ) -> Result<bool, StoreError> {
        let rows = self
            .sql
            .all(
                "SELECT permission FROM grants\n          WHERE tenant_id = ? AND grantee_user_id = ?\n            AND record_id = ?\n            AND revoked_at IS NULL",
                &[tenant_id.into(), grantee_user_id.into(), record_id.into()],
            )
            .await?;
        Ok(rows.iter().any(|row| {
            row.text("permission")
                .is_some_and(|permission| sharing_permission_satisfies(permission, "read"))
        }))
    }
}

/// `toGrant` (grant-store.ts:206-218): `SELECT *` row → [`Grant`]. NULL
/// `revoked_at` becomes `None`.
fn to_grant(row: &SqlRow) -> Grant {
    Grant {
        id: row.text("id").unwrap_or_default().to_owned(),
        tenant_id: row.text("tenant_id").unwrap_or_default().to_owned(),
        owner_user_id: row.text("owner_user_id").unwrap_or_default().to_owned(),
        record_type: row.text("record_type").unwrap_or_default().to_owned(),
        record_id: row.text("record_id").unwrap_or_default().to_owned(),
        grantee_user_id: row.text("grantee_user_id").unwrap_or_default().to_owned(),
        permission: row.text("permission").unwrap_or_default().to_owned(),
        created_at: row.text("created_at").unwrap_or_default().to_owned(),
        revoked_at: row.text("revoked_at").map(str::to_owned),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stores::blob_bytes::iso_from_epoch_ms;
    use std::sync::Arc;

    // Effective post-0017 SQLite schema for `grants` (map 03 §5).
    const SCHEMA: &str = "
        CREATE TABLE grants (
          id TEXT PRIMARY KEY NOT NULL,
          tenant_id TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          record_type TEXT NOT NULL,
          record_id TEXT NOT NULL,
          grantee_user_id TEXT NOT NULL,
          permission TEXT NOT NULL,
          created_at TEXT NOT NULL,
          revoked_at TEXT
        );";

    const TENANT: &str = "tenant-1";
    const NOW: i64 = 1_700_000_000_123;

    async fn store() -> GrantStore {
        let sql = Arc::new(SqlDriver::open_sqlite(":memory:").unwrap());
        sql.exec(SCHEMA).await.unwrap();
        GrantStore::new(sql)
    }

    #[allow(clippy::too_many_arguments)]
    fn grant_args(
        id: &str,
        owner: &str,
        grantee: &str,
        record_type: &str,
        record_id: &str,
        permission: &str,
        created_ms: i64,
    ) -> CreateGrantArgs {
        CreateGrantArgs {
            id: id.to_owned(),
            tenant_id: TENANT.to_owned(),
            owner_user_id: owner.to_owned(),
            record_type: record_type.to_owned(),
            record_id: record_id.to_owned(),
            grantee_user_id: grantee.to_owned(),
            permission: permission.to_owned(),
            created_at: iso_from_epoch_ms(created_ms),
        }
    }

    // ── frickSharingPermissionSatisfies ──────────────────────────────────────

    #[test]
    fn permission_satisfies_matches_ts_predicate() {
        // read requirement: read or write satisfies.
        assert!(sharing_permission_satisfies("read", "read"));
        assert!(sharing_permission_satisfies("write", "read"));
        // write requirement: only write satisfies.
        assert!(sharing_permission_satisfies("write", "write"));
        assert!(!sharing_permission_satisfies("read", "write"));
        // unknown permission satisfies nothing.
        assert!(!sharing_permission_satisfies("admin", "read"));
        assert!(!sharing_permission_satisfies("", "read"));
    }

    // ── isEmptyAsync ─────────────────────────────────────────────────────────

    #[tokio::test]
    async fn is_empty_async_true_until_a_row_exists_then_false_even_if_revoked() {
        let store = store().await;
        assert!(store.is_empty_async().await.unwrap());
        store
            .create(&grant_args(
                "g-1", "owner", "grantee", "note", "n-1", "read", NOW,
            ))
            .await
            .unwrap();
        assert!(!store.is_empty_async().await.unwrap());
        // Revoking does not delete the row ⇒ still non-empty.
        store
            .revoke(TENANT, "g-1", &iso_from_epoch_ms(NOW + 1))
            .await
            .unwrap();
        assert!(!store.is_empty_async().await.unwrap());
    }

    // ── create / getById ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn create_round_trips_and_get_by_id_is_tenant_scoped() {
        let store = store().await;
        let created = store
            .create(&grant_args(
                "g-1", "owner", "grantee", "note", "n-1", "write", NOW,
            ))
            .await
            .unwrap();
        assert_eq!(created.revoked_at, None);
        assert_eq!(store.get_by_id(TENANT, "g-1").await.unwrap(), Some(created));
        assert_eq!(store.get_by_id("other", "g-1").await.unwrap(), None);
        assert_eq!(store.get_by_id(TENANT, "missing").await.unwrap(), None);
    }

    // ── list: owner-or-grantee, filters, ordering, includeRevoked ────────────

    #[tokio::test]
    async fn list_returns_owner_or_grantee_grants_ordered_desc_then_id_asc() {
        let store = store().await;
        // principal "p" is grantee on g-a (newest), owner on g-b (oldest);
        // g-x is unrelated to p; g-c shares created_at with g-b ⇒ id ASC tie.
        store
            .create(&grant_args(
                "g-a",
                "owner",
                "p",
                "note",
                "n-1",
                "read",
                NOW + 2_000,
            ))
            .await
            .unwrap();
        store
            .create(&grant_args("g-c", "p", "other", "note", "n-2", "read", NOW))
            .await
            .unwrap();
        store
            .create(&grant_args("g-b", "p", "other", "note", "n-3", "read", NOW))
            .await
            .unwrap();
        store
            .create(&grant_args(
                "g-x",
                "stranger",
                "nobody",
                "note",
                "n-9",
                "read",
                NOW + 5_000,
            ))
            .await
            .unwrap();

        let ids: Vec<String> = store
            .list(&ListGrantsArgs {
                tenant_id: TENANT,
                principal_user_id: "p",
                record_type: None,
                record_id: None,
                include_revoked: false,
            })
            .await
            .unwrap()
            .into_iter()
            .map(|g| g.id)
            .collect();
        // created_at DESC ⇒ g-a (newest) first; g-b/g-c tie broken by id ASC.
        assert_eq!(ids, ["g-a", "g-b", "g-c"]);
    }

    #[tokio::test]
    async fn list_filters_by_record_type_and_record_id() {
        let store = store().await;
        store
            .create(&grant_args("g-1", "p", "x", "note", "n-1", "read", NOW))
            .await
            .unwrap();
        store
            .create(&grant_args("g-2", "p", "x", "task", "n-1", "read", NOW))
            .await
            .unwrap();
        store
            .create(&grant_args("g-3", "p", "x", "note", "n-2", "read", NOW))
            .await
            .unwrap();

        let only_note_n1: Vec<String> = store
            .list(&ListGrantsArgs {
                tenant_id: TENANT,
                principal_user_id: "p",
                record_type: Some("note"),
                record_id: Some("n-1"),
                include_revoked: false,
            })
            .await
            .unwrap()
            .into_iter()
            .map(|g| g.id)
            .collect();
        assert_eq!(only_note_n1, ["g-1"]);
    }

    #[tokio::test]
    async fn list_excludes_revoked_unless_include_revoked() {
        let store = store().await;
        store
            .create(&grant_args("g-1", "p", "x", "note", "n-1", "read", NOW))
            .await
            .unwrap();
        store
            .create(&grant_args(
                "g-2",
                "p",
                "x",
                "note",
                "n-2",
                "read",
                NOW + 1_000,
            ))
            .await
            .unwrap();
        store
            .revoke(TENANT, "g-1", &iso_from_epoch_ms(NOW + 2_000))
            .await
            .unwrap();

        let active: Vec<String> = store
            .list(&ListGrantsArgs {
                tenant_id: TENANT,
                principal_user_id: "p",
                record_type: None,
                record_id: None,
                include_revoked: false,
            })
            .await
            .unwrap()
            .into_iter()
            .map(|g| g.id)
            .collect();
        assert_eq!(active, ["g-2"]);

        let all: Vec<String> = store
            .list(&ListGrantsArgs {
                tenant_id: TENANT,
                principal_user_id: "p",
                record_type: None,
                record_id: None,
                include_revoked: true,
            })
            .await
            .unwrap()
            .into_iter()
            .map(|g| g.id)
            .collect();
        // include_revoked ⇒ both; g-2 newer sorts first.
        assert_eq!(all, ["g-2", "g-1"]);
    }

    // ── revoke: idempotent, preserves timestamp ──────────────────────────────

    #[tokio::test]
    async fn revoke_is_idempotent_and_preserves_original_timestamp() {
        let store = store().await;
        store
            .create(&grant_args("g-1", "p", "x", "note", "n-1", "read", NOW))
            .await
            .unwrap();

        let first = store
            .revoke(TENANT, "g-1", &iso_from_epoch_ms(NOW + 1_000))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.revoked_at, Some(iso_from_epoch_ms(NOW + 1_000)));

        // A second revoke at a later clock returns the unchanged row.
        let second = store
            .revoke(TENANT, "g-1", &iso_from_epoch_ms(NOW + 9_000))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(second.revoked_at, Some(iso_from_epoch_ms(NOW + 1_000)));

        // Unknown id ⇒ None.
        assert_eq!(
            store
                .revoke(TENANT, "ghost", &iso_from_epoch_ms(NOW))
                .await
                .unwrap(),
            None
        );
    }

    // ── hasActiveGrantFor ────────────────────────────────────────────────────

    #[tokio::test]
    async fn has_active_grant_for_respects_permission_and_revocation() {
        let store = store().await;
        store
            .create(&grant_args(
                "g-read", "owner", "grantee", "note", "n-1", "read", NOW,
            ))
            .await
            .unwrap();

        // read grant satisfies a read requirement, not a write requirement.
        assert!(
            store
                .has_active_grant_for(TENANT, "grantee", "note", "n-1", "read")
                .await
                .unwrap()
        );
        assert!(
            !store
                .has_active_grant_for(TENANT, "grantee", "note", "n-1", "write")
                .await
                .unwrap()
        );
        // A write grant satisfies both.
        store
            .create(&grant_args(
                "g-write", "owner", "grantee", "task", "t-1", "write", NOW,
            ))
            .await
            .unwrap();
        assert!(
            store
                .has_active_grant_for(TENANT, "grantee", "task", "t-1", "read")
                .await
                .unwrap()
        );
        assert!(
            store
                .has_active_grant_for(TENANT, "grantee", "task", "t-1", "write")
                .await
                .unwrap()
        );

        // Wrong grantee / wrong record / wrong tenant ⇒ false.
        assert!(
            !store
                .has_active_grant_for(TENANT, "stranger", "note", "n-1", "read")
                .await
                .unwrap()
        );
        assert!(
            !store
                .has_active_grant_for(TENANT, "grantee", "note", "n-2", "read")
                .await
                .unwrap()
        );
        assert!(
            !store
                .has_active_grant_for("other", "grantee", "note", "n-1", "read")
                .await
                .unwrap()
        );

        // Revoking removes it from the active check.
        store
            .revoke(TENANT, "g-read", &iso_from_epoch_ms(NOW + 1))
            .await
            .unwrap();
        assert!(
            !store
                .has_active_grant_for(TENANT, "grantee", "note", "n-1", "read")
                .await
                .unwrap()
        );
    }

    // ── hasActiveGrantForRecordId (cascade) ──────────────────────────────────

    #[tokio::test]
    async fn has_active_grant_for_record_id_matches_any_type_with_read() {
        let store = store().await;
        // A grant on (task, shared-id) with write should cascade-match the
        // record id with a read requirement (write satisfies read).
        store
            .create(&grant_args(
                "g-1",
                "owner",
                "grantee",
                "task",
                "shared-id",
                "write",
                NOW,
            ))
            .await
            .unwrap();
        assert!(
            store
                .has_active_grant_for_record_id(TENANT, "grantee", "shared-id")
                .await
                .unwrap()
        );

        // A read grant on a different record id does not match.
        assert!(
            !store
                .has_active_grant_for_record_id(TENANT, "grantee", "other-id")
                .await
                .unwrap()
        );
        // Wrong grantee / tenant ⇒ false.
        assert!(
            !store
                .has_active_grant_for_record_id(TENANT, "stranger", "shared-id")
                .await
                .unwrap()
        );
        assert!(
            !store
                .has_active_grant_for_record_id("other", "grantee", "shared-id")
                .await
                .unwrap()
        );

        // Revocation drops it.
        store
            .revoke(TENANT, "g-1", &iso_from_epoch_ms(NOW + 1))
            .await
            .unwrap();
        assert!(
            !store
                .has_active_grant_for_record_id(TENANT, "grantee", "shared-id")
                .await
                .unwrap()
        );
    }
}
