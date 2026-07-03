//! NDJSON backup (dump) and restore for the framework database (FR-262).
//!
//! Ported from `apps/server/src/backup/dump.ts` + `restore.ts` (map 03 §14).
//! The format is **column-shaped, not API-shaped**: each line round-trips the
//! raw column values SQLite/Postgres actually stored, so dump and restore stay
//! lossless across migrations that change the higher-level [`FrickStore`]
//! surface. Blob columns are base64-encoded under a sibling `<column>_base64`
//! key; the original column key is dropped so the JSON is unambiguous.
//!
//! ## Wire format
//!
//! One JSON object per line (no trailing newline appended per yield — the
//! caller frames lines). The first line is the header:
//!
//! ```text
//! {"type":"header","row":{"frickFormat":1,"createdAt":"…","schemaId":"…",
//!   "schemaVersion":"…","schemaRevision":1,"schemaHash":"…",
//!   "appliedMigrations":["0001_…",…],"tenantId":"all"}}
//! ```
//!
//! then `{"type":"<table>","row":{…}}` per row, tables in the fixed
//! [`TABLE_ORDER`] with a deterministic `ORDER BY` per table.
//!
//! ## Determinism
//!
//! This module reads neither the clock nor the RNG — `created_at` is injected
//! by the caller as `now_ms` (the route/facade layer is the time boundary), and
//! there is no randomness. The same database dumped at the same `now_ms`
//! produces byte-identical NDJSON.

use std::collections::{BTreeMap, HashSet};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde_json::{Map as JsonMap, Value as Json, json};

use crate::driver::{SqlDriver, SqlExec, SqlValue};
use crate::error::StoreError;
use crate::facade::FrickStore;
use crate::stores::blob_bytes::iso_from_epoch_ms;

/// The current dump format version, emitted as `frickFormat` in the header.
pub const FRICK_DUMP_FORMAT: i64 = 1;

/// One framework table, with the metadata the dump/restore routing needs.
struct TableSpec {
    /// SQL table name (also the dump line's `type`).
    name: &'static str,
    /// True when the table has a `tenant_id` column (per-tenant dumps filter
    /// `tenant_id = ?`).
    tenant_scoped: bool,
    /// True when the table is infra (no `tenant_id`): included only on whole-DB
    /// dumps. `tenants` is special — see [`build_select`].
    infra_only: bool,
    /// Deterministic `ORDER BY` clause (column list, no `ORDER BY` keyword).
    order_by: &'static str,
}

/// Tables in the framework, in the fixed dump order (parents before children so
/// FK constraints — enforced on Postgres — are satisfied without disabling
/// them). Mirrors `TABLE_ORDER` in `dump.ts`.
///
/// ⚠️ NOT dumped (map 03 §14.1): `schema_versions`, `devtools_events`,
/// `auth_password_reset_tokens`, `invitations`, `grants`,
/// `auth_refresh_tokens`, `service_principals`, `auth_saml_seen_assertions`.
///
/// `auth_registration_locks` (migration 0025) and `sealed_sender_access`
/// (migration 0026) ARE dumped and tenant-erased (AURA-437) — they carry a
/// `tenant_id` and hold durable security state (the reglock PIN verifier and
/// the sealed-sender token hash) that must survive a backup/restore and must
/// not survive a tenant erasure. They post-date the TS mirror.
const TABLE_ORDER: &[TableSpec] = &[
    TableSpec {
        name: "tenants",
        tenant_scoped: false,
        infra_only: true,
        order_by: "tenant_id ASC",
    },
    TableSpec {
        name: "auth_accounts",
        tenant_scoped: true,
        infra_only: false,
        order_by: "tenant_id ASC, user_id ASC",
    },
    TableSpec {
        name: "auth_sessions",
        tenant_scoped: true,
        infra_only: false,
        order_by: "tenant_id ASC, session_token_digest ASC",
    },
    TableSpec {
        name: "objects",
        tenant_scoped: true,
        infra_only: false,
        order_by: "tenant_id ASC, object_type ASC, object_id ASC",
    },
    TableSpec {
        name: "stream_events",
        tenant_scoped: true,
        infra_only: false,
        order_by: "tenant_id ASC, stream_type ASC, stream_id ASC, sequence ASC",
    },
    TableSpec {
        name: "presence_leases",
        tenant_scoped: true,
        infra_only: false,
        order_by: "tenant_id ASC, presence_type ASC, presence_key ASC",
    },
    TableSpec {
        name: "signal_outbox",
        tenant_scoped: true,
        infra_only: false,
        order_by: "id ASC",
    },
    TableSpec {
        name: "blob_metadata",
        tenant_scoped: true,
        infra_only: false,
        order_by: "tenant_id ASC, blob_id ASC",
    },
    TableSpec {
        name: "blob_content",
        tenant_scoped: true,
        infra_only: false,
        order_by: "tenant_id ASC, blob_id ASC",
    },
    TableSpec {
        name: "blob_derivatives",
        tenant_scoped: true,
        infra_only: false,
        order_by: "tenant_id ASC, parent_blob_id ASC, derivative_id ASC",
    },
    TableSpec {
        name: "search_indexes",
        tenant_scoped: true,
        infra_only: false,
        order_by: "tenant_id ASC, index_name ASC, doc_id ASC",
    },
    TableSpec {
        name: "idempotency_keys",
        tenant_scoped: true,
        infra_only: false,
        order_by: "tenant_id ASC, replica_id ASC, request_id ASC",
    },
    TableSpec {
        name: "tenant_settings",
        tenant_scoped: true,
        infra_only: false,
        order_by: "tenant_id ASC, setting_key ASC",
    },
    TableSpec {
        name: "jobs",
        tenant_scoped: true,
        infra_only: false,
        order_by: "id ASC",
    },
    TableSpec {
        name: "push_device_registrations",
        tenant_scoped: true,
        infra_only: false,
        order_by: "tenant_id ASC, registration_id ASC",
    },
    TableSpec {
        name: "platform_events",
        tenant_scoped: true,
        infra_only: false,
        order_by: "tenant_id ASC, id ASC",
    },
    TableSpec {
        name: "platform_event_deliveries",
        tenant_scoped: false,
        infra_only: false,
        order_by: "consumer ASC, event_id ASC",
    },
    TableSpec {
        name: "analytics_aggregate_buckets",
        tenant_scoped: true,
        infra_only: false,
        order_by: "tenant_id ASC, bucket_start ASC, metric_kind ASC, metric_key ASC",
    },
    TableSpec {
        name: "analytics_recent_events",
        tenant_scoped: true,
        infra_only: false,
        order_by: "tenant_id ASC, occurred_at ASC, event_id ASC",
    },
    TableSpec {
        name: "auth_registration_locks",
        tenant_scoped: true,
        infra_only: false,
        order_by: "tenant_id ASC, user_id ASC",
    },
    TableSpec {
        name: "sealed_sender_access",
        tenant_scoped: true,
        infra_only: false,
        order_by: "tenant_id ASC, user_id ASC",
    },
    TableSpec {
        name: "admin_audit_log",
        tenant_scoped: false,
        infra_only: true,
        order_by: "id ASC",
    },
    TableSpec {
        name: "frick_migrations",
        tenant_scoped: false,
        infra_only: true,
        order_by: "id ASC",
    },
];

/// Tables that carry a `tenant_id` and are subject to per-tenant scope checks on
/// restore (mirrors `TENANT_SCOPED_TABLES` in `restore.ts`).
const TENANT_SCOPED_TABLES: &[&str] = &[
    "auth_accounts",
    "auth_sessions",
    "objects",
    "stream_events",
    "presence_leases",
    "signal_outbox",
    "blob_metadata",
    "blob_content",
    "blob_derivatives",
    "search_indexes",
    "idempotency_keys",
    "tenant_settings",
    "jobs",
    "push_device_registrations",
    "platform_events",
    "analytics_aggregate_buckets",
    "analytics_recent_events",
    "auth_registration_locks",
    "sealed_sender_access",
];

/// Child table keyed off `platform_events` (scope checked via the parent
/// event's tenant).
const EVENT_CHILD_TABLES: &[&str] = &["platform_event_deliveries"];

/// Infra tables (no `tenant_id` of their own; `tenants` is scope-constrained).
const INFRA_TABLES: &[&str] = &["tenants", "admin_audit_log", "frick_migrations"];

/// Restore order for `overwrite` truncation: children before parents so FK
/// cascades (Postgres) stay consistent without disabling enforcement. Mirrors
/// `TRUNCATE_ALL_TABLES`.
fn truncate_all_tables() -> Vec<&'static str> {
    EVENT_CHILD_TABLES
        .iter()
        .chain(TENANT_SCOPED_TABLES)
        .chain(INFRA_TABLES)
        .copied()
        .collect()
}

/// All accepted table `type`s on restore (`ALL_TABLES`); any other `type` is
/// recorded as `unknownTableType` and skipped.
fn all_tables() -> Vec<&'static str> {
    TENANT_SCOPED_TABLES
        .iter()
        .chain(EVENT_CHILD_TABLES)
        .chain(INFRA_TABLES)
        .copied()
        .collect()
}

/// `tenants` plus the tenant-scoped tables — the set whose rows must carry the
/// dump's `tenant_id` on a per-tenant restore.
fn tenant_id_constrained(table: &str) -> bool {
    table == "tenants" || TENANT_SCOPED_TABLES.contains(&table)
}

// ---------------------------------------------------------------------------
// Dump
// ---------------------------------------------------------------------------

/// Options controlling [`FrickStore::dump_database_with`]. Defaults mirror
/// `FrickDumpOptions`: `tenant_id = None` ⇒ whole DB, and `include_admin_audit`
/// / `include_migrations` default to "whole-DB only" when left `None`.
#[derive(Debug, Default, Clone)]
pub struct DumpOptions {
    /// `None` or `Some("all")` ⇒ dump every tenant + framework infra; any other
    /// value scopes the dump to that tenant id.
    pub tenant_id: Option<String>,
    /// Override the default (admin audit included only on whole-DB dumps).
    pub include_admin_audit: Option<bool>,
    /// Override the default (the migration ledger included only on whole-DB
    /// dumps).
    pub include_migrations: Option<bool>,
}

impl DumpOptions {
    /// A whole-database dump (every tenant + infra).
    #[must_use]
    pub fn whole_database() -> Self {
        Self::default()
    }

    /// A dump scoped to a single tenant id.
    #[must_use]
    pub fn for_tenant(tenant_id: impl Into<String>) -> Self {
        Self {
            tenant_id: Some(tenant_id.into()),
            ..Self::default()
        }
    }
}

impl FrickStore {
    /// Dump the framework database to NDJSON lines (FR-262). Returns one
    /// `String` per line: a header followed by `{type, row}` rows in
    /// [`TABLE_ORDER`]. No trailing newline is appended to any line.
    ///
    /// `tenant_id`: `None` or `Some("all")` dumps the whole database; any other
    /// value scopes to that tenant. `now_ms` is the injected wall clock for the
    /// header's `createdAt` (the store never reads the clock itself).
    ///
    /// # Errors
    /// Propagates [`StoreError`] from the underlying driver (a failed query, a
    /// poisoned connection mutex, …).
    pub async fn dump_database(
        &self,
        tenant_id: Option<&str>,
        now_ms: i64,
    ) -> Result<Vec<String>, StoreError> {
        let options = DumpOptions {
            tenant_id: tenant_id.map(ToOwned::to_owned),
            ..DumpOptions::default()
        };
        self.dump_database_with(&options, now_ms).await
    }

    /// [`dump_database`](Self::dump_database) with explicit
    /// admin-audit / migration-ledger overrides.
    ///
    /// # Errors
    /// Propagates [`StoreError`] from the underlying driver.
    pub async fn dump_database_with(
        &self,
        options: &DumpOptions,
        now_ms: i64,
    ) -> Result<Vec<String>, StoreError> {
        let scope = options.tenant_id.as_deref().unwrap_or("all");
        let whole_db = scope == "all";
        let include_admin = options.include_admin_audit.unwrap_or(whole_db);
        let include_migrations = options.include_migrations.unwrap_or(whole_db);
        let driver = self.sql_driver();
        let schema = self.schema();

        let applied: Vec<String> = self
            .list_applied_migrations()
            .await?
            .into_iter()
            .map(|row| row.id)
            .collect();

        let mut lines = Vec::new();

        let header = json!({
            "type": "header",
            "row": {
                "frickFormat": FRICK_DUMP_FORMAT,
                "createdAt": iso_from_epoch_ms(now_ms),
                "schemaId": schema.schema_id,
                "schemaVersion": schema.schema_version,
                "schemaRevision": schema.schema_revision,
                "schemaHash": schema.hash,
                "appliedMigrations": applied,
                "tenantId": scope,
            },
        });
        lines.push(header.to_string());

        for table in TABLE_ORDER {
            if table.name == "admin_audit_log" && !include_admin {
                continue;
            }
            if table.name == "frick_migrations" && !include_migrations {
                continue;
            }
            // Infra tables are whole-DB-only, except `tenants`: a per-tenant
            // dump still emits the chosen tenant's ledger row so restore into a
            // fresh DB can register it.
            if table.infra_only && !whole_db && table.name != "tenants" {
                continue;
            }
            if !table_exists(driver, table.name).await? {
                continue;
            }

            let (sql, params) = build_select(table, whole_db, scope);
            let rows = driver.all(&sql, &params).await?;
            for row in &rows {
                let encoded = encode_row(row);
                lines.push(json!({ "type": table.name, "row": encoded }).to_string());
            }
        }

        Ok(lines)
    }
}

/// Build the `SELECT` for a table given the dump scope (mirrors `buildSelect`).
fn build_select(table: &TableSpec, whole_db: bool, tenant_id: &str) -> (String, Vec<SqlValue>) {
    if table.name == "tenants" && !whole_db {
        return (
            format!(
                "SELECT * FROM tenants WHERE tenant_id = ? ORDER BY {}",
                table.order_by
            ),
            vec![SqlValue::from(tenant_id)],
        );
    }
    if table.name == "platform_event_deliveries" && !whole_db {
        return (
            "SELECT d.* FROM platform_event_deliveries d \
             JOIN platform_events e ON e.event_id = d.event_id \
             WHERE e.tenant_id = ? ORDER BY d.consumer ASC, e.id ASC"
                .to_owned(),
            vec![SqlValue::from(tenant_id)],
        );
    }
    if table.tenant_scoped && !whole_db {
        return (
            format!(
                "SELECT * FROM {} WHERE tenant_id = ? ORDER BY {}",
                table.name, table.order_by
            ),
            vec![SqlValue::from(tenant_id)],
        );
    }
    (
        format!("SELECT * FROM {} ORDER BY {}", table.name, table.order_by),
        Vec::new(),
    )
}

/// Convert one result row to a JSON object. Blob columns land under a sibling
/// `<column>_base64` key (standard base64); the original column key is dropped.
/// Integers/reals become JSON numbers, text becomes a string, NULL becomes JSON
/// null. Mirrors `encodeRow`.
fn encode_row(row: &crate::driver::SqlRow) -> Json {
    let mut out = JsonMap::new();
    for (column, value) in row.iter() {
        match value {
            SqlValue::Blob(bytes) => {
                out.insert(
                    format!("{column}_base64"),
                    Json::String(BASE64_STANDARD.encode(bytes)),
                );
            }
            SqlValue::Null => {
                out.insert(column.clone(), Json::Null);
            }
            SqlValue::Integer(n) => {
                out.insert(column.clone(), json!(n));
            }
            SqlValue::Real(f) => {
                out.insert(column.clone(), json!(f));
            }
            SqlValue::Text(text) => {
                out.insert(column.clone(), Json::String(text.clone()));
            }
        }
    }
    Json::Object(out)
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/// Options for [`FrickStore::restore_database`] (mirrors `FrickRestoreOptions`
/// minus the `target`/`source`, which are the receiver/argument).
#[derive(Debug, Clone, Copy, Default)]
pub struct RestoreOptions {
    /// Must be `true`, else the restore refuses with
    /// [`RestoreRefusal::MissingConfirmation`]. (The CLI maps `--confirm yes`
    /// to this flag.)
    pub confirm: bool,
    /// Truncate the target scope before inserting (else a non-empty target
    /// refuses with [`RestoreRefusal::TargetNotEmpty`]).
    pub overwrite: bool,
    /// Restore even when the dump's `schemaHash` differs from the target's
    /// (else refuses with [`RestoreRefusal::SchemaHashMismatch`]).
    pub force_schema_drift: bool,
}

/// The structured reason a restore refused before inserting any rows
/// (`FrickRestoreRefusedError.reason`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestoreRefusal {
    /// `confirm` was not `true`.
    MissingConfirmation,
    /// The dump was empty or its first line was not a `header`.
    MissingHeader,
    /// The dump's `schemaHash` differs from the target's (and
    /// `force_schema_drift` was not set).
    SchemaHashMismatch {
        source_hash: String,
        target_hash: String,
    },
    /// The target is missing one or more migration ids that the source had
    /// applied.
    MissingMigrations { missing: Vec<String> },
    /// The target scope already has rows (and `overwrite` was not set).
    TargetNotEmpty { table: String },
    /// A row's tenant does not match a tenant-scoped dump's `tenant_id`.
    TenantScopeMismatch {
        table: String,
        tenant_id: Option<String>,
        expected_tenant_id: String,
        line: usize,
    },
}

impl RestoreRefusal {
    /// The CLI-facing reason slug (`cli.restore.<reason>`), matching the TS
    /// `FrickRestoreRefusedError.reason` string union.
    #[must_use]
    pub fn reason(&self) -> &'static str {
        match self {
            Self::MissingConfirmation => "missingConfirmation",
            Self::MissingHeader => "missingHeader",
            Self::SchemaHashMismatch { .. } => "schemaHashMismatch",
            Self::MissingMigrations { .. } => "missingMigrations",
            Self::TargetNotEmpty { .. } => "targetNotEmpty",
            Self::TenantScopeMismatch { .. } => "tenantScopeMismatch",
        }
    }

    /// A human-readable message mirroring the TS error strings.
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::MissingConfirmation => "Refusing to restore: `confirm` must be true".to_owned(),
            Self::MissingHeader => "Dump is empty or missing a header line".to_owned(),
            Self::SchemaHashMismatch {
                source_hash,
                target_hash,
            } => format!("Schema hash mismatch: source={source_hash} target={target_hash}"),
            Self::MissingMigrations { missing } => format!(
                "Target database is missing migrations applied to the source: {}",
                missing.join(", ")
            ),
            Self::TargetNotEmpty { table } => format!(
                "Target database is not empty (table {table} has rows); pass overwrite to replace"
            ),
            Self::TenantScopeMismatch {
                table,
                tenant_id,
                expected_tenant_id,
                ..
            } => format!(
                "Refusing to restore {table} row for tenant {} into tenant-scoped dump {expected_tenant_id}",
                tenant_id.as_deref().unwrap_or("<none>")
            ),
        }
    }
}

/// The outcome of a [`FrickStore::restore_database`] that proceeded past the
/// refusal gate (mirrors `FrickRestoreReport`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreReport {
    /// How many rows were inserted, keyed by table/`type`.
    pub row_counts_by_type: BTreeMap<String, u64>,
    /// Rows skipped (bad JSON, unknown type, failed insert), with the reason.
    pub skipped: Vec<SkippedRow>,
    /// Source vs target schema-hash comparison.
    pub schema_compatibility: SchemaCompatibility,
    /// ISO timestamp captured at the start (`started_ms`).
    pub started_at: String,
    /// ISO timestamp captured at the end (`finished_ms`).
    pub finished_at: String,
}

/// One skipped row in a [`RestoreReport`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedRow {
    pub r#type: String,
    pub reason: String,
    pub line: Option<usize>,
}

/// The source/target schema-hash comparison recorded in a [`RestoreReport`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaCompatibility {
    pub source_hash: String,
    pub target_hash: String,
    pub matched: bool,
}

impl FrickStore {
    /// Restore the framework database from NDJSON `lines` (FR-262). Validates
    /// the header (schema-hash drift + migration parity), then inserts every
    /// subsequent `{type, row}` row.
    ///
    /// `lines` is any iterator of already-split NDJSON lines (one logical line
    /// per item; empty items are ignored). `started_ms` / `finished_ms` are the
    /// injected wall-clock bounds for the report timestamps — the store never
    /// reads the clock.
    ///
    /// # Errors
    /// Returns `Err(`[`StoreError`]`)` when a refusal fires (mapped via
    /// [`StoreError::Store`] carrying the [`RestoreRefusal`] message) or when the
    /// driver fails. Use
    /// [`restore_database_checked`](Self::restore_database_checked) when the
    /// caller needs the structured reason (the CLI maps it to
    /// `cli.restore.<reason>`).
    pub async fn restore_database<I, S>(
        &self,
        lines: I,
        opts: RestoreOptions,
        started_ms: i64,
        finished_ms: i64,
    ) -> Result<RestoreReport, StoreError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.restore_database_checked(lines, opts, started_ms, finished_ms)
            .await
            .map_err(|err| match err {
                RestoreError::Refused(refusal) => StoreError::store(refusal.message()),
                RestoreError::Store(store) => store,
            })
    }

    /// Like [`restore_database`](Self::restore_database) but surfaces a
    /// structured [`RestoreRefusal`] so the integrator can route it to the right
    /// `cli.restore.<reason>` exit code.
    ///
    /// # Errors
    /// Returns [`RestoreError::Refused`] for a pre-insert refusal and
    /// [`RestoreError::Store`] for a driver failure.
    pub async fn restore_database_checked<I, S>(
        &self,
        lines: I,
        opts: RestoreOptions,
        started_ms: i64,
        finished_ms: i64,
    ) -> Result<RestoreReport, RestoreError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        if !opts.confirm {
            return Err(RestoreRefusal::MissingConfirmation.into());
        }

        let started_at = iso_from_epoch_ms(started_ms);

        // Own the lines so the closure can keep them across awaits.
        let mut iter = lines
            .into_iter()
            .map(|line| line.as_ref().to_owned())
            .filter(|line| !line.is_empty());

        let header_line = iter
            .next()
            .ok_or_else(|| RestoreError::from(RestoreRefusal::MissingHeader))?;
        let header = parse_header(&header_line)?;

        let target_hash = self.schema().hash.clone();
        let matched = header.schema_hash == target_hash;
        if !matched && !opts.force_schema_drift {
            return Err(RestoreRefusal::SchemaHashMismatch {
                source_hash: header.schema_hash,
                target_hash,
            }
            .into());
        }

        let applied: HashSet<String> = self
            .list_applied_migrations()
            .await
            .map_err(RestoreError::Store)?
            .into_iter()
            .map(|row| row.id)
            .collect();
        let missing: Vec<String> = header
            .applied_migrations
            .iter()
            .filter(|id| !applied.contains(*id))
            .cloned()
            .collect();
        if !missing.is_empty() {
            return Err(RestoreRefusal::MissingMigrations { missing }.into());
        }

        let scope = header.tenant_id.clone();
        let driver = self.sql_driver();

        if opts.overwrite {
            truncate_scope(driver, &scope)
                .await
                .map_err(RestoreError::Store)?;
        } else {
            assert_scope_empty(driver, &scope).await?;
        }

        // Remaining lines are the rows; collect so the (non-clonable) iterator
        // can be moved into the transaction closure.
        let rows: Vec<String> = iter.collect();
        let accepted = all_tables();

        // A hard refusal (tenant-scope mismatch) must roll back the whole
        // restore: we surface it from the transaction as a sentinel
        // [`StoreError`] (forcing rollback) and stash the structured refusal in
        // this `Arc` so the caller gets the typed reason back. `driver.transaction`'s
        // error channel is `StoreError`, so this is how a non-`StoreError`
        // refusal escapes the closure.
        let refusal_slot: std::sync::Arc<std::sync::Mutex<Option<RestoreRefusal>>> =
            std::sync::Arc::new(std::sync::Mutex::new(None));

        // One transaction; each row wrapped in a SAVEPOINT so a single bad row
        // is skipped without poisoning the rest.
        let outcome: Result<RestoreOutcome, StoreError> = driver
            .transaction(|tx| {
                let scope = scope.clone();
                let accepted = accepted.clone();
                let rows = rows.clone();
                let refusal_slot = std::sync::Arc::clone(&refusal_slot);
                Box::pin(async move {
                    restore_rows_in_tx(tx, &rows, &scope, &accepted, &refusal_slot).await
                })
            })
            .await;

        let RestoreOutcome { skipped, counts } = match outcome {
            Ok(outcome) => outcome,
            Err(store) => {
                // If a hard refusal was stashed, the transaction rolled back for
                // that reason; return the typed refusal instead of the sentinel.
                let stashed = refusal_slot.lock().ok().and_then(|mut slot| slot.take());
                if let Some(refusal) = stashed {
                    return Err(RestoreError::Refused(refusal));
                }
                return Err(RestoreError::Store(store));
            }
        };

        Ok(RestoreReport {
            row_counts_by_type: counts,
            skipped,
            schema_compatibility: SchemaCompatibility {
                source_hash: header.schema_hash,
                target_hash,
                matched,
            },
            started_at,
            finished_at: iso_from_epoch_ms(finished_ms),
        })
    }
}

/// Insert every data row inside the open restore transaction. Each row is
/// wrapped in a `SAVEPOINT` so a single bad row is skipped (recorded in
/// `skipped`) without poisoning the rest. A hard tenant-scope refusal returns
/// the sentinel [`StoreError`] (rolling the whole transaction back) after
/// stashing the typed reason in `refusal_slot`. The header was line 1, so data
/// rows are numbered from 2.
async fn restore_rows_in_tx(
    tx: &SqlExec<'_>,
    rows: &[String],
    scope: &str,
    accepted: &[&str],
    refusal_slot: &std::sync::Mutex<Option<RestoreRefusal>>,
) -> Result<RestoreOutcome, StoreError> {
    let mut skipped: Vec<SkippedRow> = Vec::new();
    let mut counts: BTreeMap<String, u64> = BTreeMap::new();
    let mut column_cache: BTreeMap<String, HashSet<String>> = BTreeMap::new();
    let mut line_number = 1_usize;
    for raw in rows {
        line_number += 1;
        let Ok(parsed) = parse_row_line(raw) else {
            skipped.push(SkippedRow {
                r#type: "<unparseable>".to_owned(),
                reason: "JSON parse error".to_owned(),
                line: Some(line_number),
            });
            continue;
        };
        if !accepted.contains(&parsed.r#type.as_str()) {
            skipped.push(SkippedRow {
                r#type: parsed.r#type,
                reason: "unknownTableType".to_owned(),
                line: Some(line_number),
            });
            continue;
        }
        if scope != "all"
            && tenant_id_constrained(&parsed.r#type)
            && let Err(refusal) = assert_row_tenant(&parsed, scope, line_number)
        {
            return Err(stash_refusal(refusal_slot, refusal));
        }
        if scope != "all" && parsed.r#type == "platform_event_deliveries" {
            match assert_delivery_scope(tx, &parsed, scope, line_number).await {
                Ok(()) => {}
                Err(RestoreError::Refused(refusal)) => {
                    return Err(stash_refusal(refusal_slot, refusal));
                }
                Err(RestoreError::Store(store)) => return Err(store),
            }
        }

        tx.exec("SAVEPOINT frick_restore_row").await?;
        match insert_row(tx, &parsed, &mut column_cache).await {
            Ok(()) => {
                tx.exec("RELEASE SAVEPOINT frick_restore_row").await?;
                *counts.entry(parsed.r#type).or_insert(0) += 1;
            }
            Err(reason) => {
                tx.exec("ROLLBACK TO SAVEPOINT frick_restore_row").await?;
                tx.exec("RELEASE SAVEPOINT frick_restore_row").await?;
                skipped.push(SkippedRow {
                    r#type: parsed.r#type,
                    reason,
                    line: Some(line_number),
                });
            }
        }
    }
    Ok(RestoreOutcome { skipped, counts })
}

/// Either a structured refusal or an underlying store error.
#[derive(Debug)]
pub enum RestoreError {
    /// The restore refused before inserting any rows.
    Refused(RestoreRefusal),
    /// A driver / store failure.
    Store(StoreError),
}

impl From<RestoreRefusal> for RestoreError {
    fn from(refusal: RestoreRefusal) -> Self {
        Self::Refused(refusal)
    }
}

/// Stash a hard refusal in the slot and return the sentinel [`StoreError`] that
/// forces the transaction to roll back. The caller recovers the typed refusal
/// from the slot after the transaction returns.
fn stash_refusal(
    slot: &std::sync::Mutex<Option<RestoreRefusal>>,
    refusal: RestoreRefusal,
) -> StoreError {
    let message = refusal.message();
    if let Ok(mut guard) = slot.lock() {
        *guard = Some(refusal);
    }
    StoreError::store(message)
}

struct RestoreOutcome {
    skipped: Vec<SkippedRow>,
    counts: BTreeMap<String, u64>,
}

/// The parsed dump header (`FrickDumpHeader`).
struct DumpHeader {
    schema_hash: String,
    applied_migrations: Vec<String>,
    tenant_id: String,
}

fn parse_header(line: &str) -> Result<DumpHeader, RestoreError> {
    let value: Json = serde_json::from_str(line)
        .map_err(|_| RestoreError::from(RestoreRefusal::MissingHeader))?;
    if value.get("type").and_then(Json::as_str) != Some("header") {
        return Err(RestoreRefusal::MissingHeader.into());
    }
    let row = value
        .get("row")
        .ok_or_else(|| RestoreError::from(RestoreRefusal::MissingHeader))?;
    let schema_hash = row
        .get("schemaHash")
        .and_then(Json::as_str)
        .unwrap_or_default()
        .to_owned();
    let tenant_id = row
        .get("tenantId")
        .and_then(Json::as_str)
        .unwrap_or("all")
        .to_owned();
    let applied_migrations = row
        .get("appliedMigrations")
        .and_then(Json::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(ToOwned::to_owned))
                .collect()
        })
        .unwrap_or_default();
    Ok(DumpHeader {
        schema_hash,
        applied_migrations,
        tenant_id,
    })
}

/// A parsed `{type, row}` data line.
struct ParsedRow {
    r#type: String,
    row: JsonMap<String, Json>,
}

fn parse_row_line(line: &str) -> Result<ParsedRow, ()> {
    let value: Json = serde_json::from_str(line).map_err(|_| ())?;
    let r#type = value
        .get("type")
        .and_then(Json::as_str)
        .ok_or(())?
        .to_owned();
    let row = value
        .get("row")
        .and_then(Json::as_object)
        .ok_or(())?
        .clone();
    Ok(ParsedRow { r#type, row })
}

fn assert_row_tenant(parsed: &ParsedRow, scope: &str, line: usize) -> Result<(), RestoreRefusal> {
    let tenant_id = parsed.row.get("tenant_id").and_then(Json::as_str);
    if tenant_id == Some(scope) {
        return Ok(());
    }
    Err(RestoreRefusal::TenantScopeMismatch {
        table: parsed.r#type.clone(),
        tenant_id: tenant_id.map(ToOwned::to_owned),
        expected_tenant_id: scope.to_owned(),
        line,
    })
}

async fn assert_delivery_scope(
    tx: &SqlExec<'_>,
    parsed: &ParsedRow,
    scope: &str,
    line: usize,
) -> Result<(), RestoreError> {
    let event_id = parsed.row.get("event_id").and_then(Json::as_str);
    let matched = if let Some(event_id) = event_id {
        let row = tx
            .get(
                "SELECT tenant_id FROM platform_events WHERE event_id = ?",
                &[SqlValue::from(event_id)],
            )
            .await
            .map_err(RestoreError::Store)?;
        row.and_then(|r| r.text("tenant_id").map(ToOwned::to_owned)) == Some(scope.to_owned())
    } else {
        false
    };
    if matched {
        return Ok(());
    }
    Err(RestoreRefusal::TenantScopeMismatch {
        table: "platform_event_deliveries".to_owned(),
        tenant_id: event_id.map(ToOwned::to_owned),
        expected_tenant_id: scope.to_owned(),
        line,
    }
    .into())
}

/// Insert one decoded row. Columns are whitelisted against live table
/// introspection; `*_base64` keys are decoded to blobs; identifiers are
/// double-quote-escaped. Returns `Err(reason)` for a row-level failure (the
/// caller records it as a `skipped` row) — mirrors `insertRow`.
async fn insert_row(
    tx: &SqlExec<'_>,
    parsed: &ParsedRow,
    column_cache: &mut BTreeMap<String, HashSet<String>>,
) -> Result<(), String> {
    let table = &parsed.r#type;
    let allowed = get_table_columns(tx, table, column_cache).await?;

    let mut columns: Vec<String> = Vec::new();
    let mut params: Vec<SqlValue> = Vec::new();
    for (key, value) in &parsed.row {
        let is_base64 = key.ends_with("_base64");
        let column = if is_base64 {
            key[..key.len() - "_base64".len()].to_owned()
        } else {
            key.clone()
        };
        if !allowed.contains(&column) {
            return Err(format!("invalidColumn: {table}.{column}"));
        }
        if columns.contains(&column) {
            return Err(format!("duplicateColumn: {table}.{column}"));
        }
        if is_base64 {
            let text = value.as_str().unwrap_or_default();
            let bytes = BASE64_STANDARD
                .decode(text)
                .map_err(|err| format!("invalidBase64: {table}.{column}: {err}"))?;
            columns.push(column);
            params.push(SqlValue::Blob(bytes));
        } else {
            columns.push(column);
            params.push(json_to_sql(value));
        }
    }
    if columns.is_empty() {
        return Err(format!("emptyRow: {table}"));
    }

    let placeholders = vec!["?"; columns.len()].join(", ");
    let column_list = columns
        .iter()
        .map(|c| quote_identifier(c))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "INSERT INTO {} ({column_list}) VALUES ({placeholders})",
        quote_identifier(table)
    );
    tx.run(&sql, &params).await.map_err(|err| err.to_string())?;
    Ok(())
}

/// Map a JSON scalar back to a [`SqlValue`]. Integers stay integers, other
/// numbers become reals, strings become text, null becomes NULL, booleans bind
/// 1/0. Objects/arrays (which a column-shaped dump never emits) are stored as
/// their JSON text so a non-conforming line still round-trips losslessly rather
/// than vanishing.
fn json_to_sql(value: &Json) -> SqlValue {
    match value {
        Json::Null => SqlValue::Null,
        Json::Bool(b) => SqlValue::from_bool(*b),
        Json::Number(n) => n.as_i64().map_or_else(
            || SqlValue::Real(n.as_f64().unwrap_or(0.0)),
            SqlValue::Integer,
        ),
        Json::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

async fn get_table_columns(
    tx: &SqlExec<'_>,
    table: &str,
    cache: &mut BTreeMap<String, HashSet<String>>,
) -> Result<HashSet<String>, String> {
    if let Some(cached) = cache.get(table) {
        return Ok(cached.clone());
    }
    let rows = tx
        .all(
            &format!("PRAGMA table_info({})", quote_identifier(table)),
            &[],
        )
        .await
        .map_err(|err| err.to_string())?;
    if rows.is_empty() {
        return Err(format!("missingTable: {table}"));
    }
    let columns: HashSet<String> = rows
        .iter()
        .filter_map(|row| row.text("name").map(ToOwned::to_owned))
        .collect();
    cache.insert(table.to_owned(), columns.clone());
    Ok(columns)
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

async fn truncate_scope(driver: &SqlDriver, scope: &str) -> Result<(), StoreError> {
    driver
        .transaction(|tx| {
            let scope = scope.to_owned();
            Box::pin(async move {
                if scope == "all" {
                    for table in truncate_all_tables() {
                        if table_exists_exec(tx, table).await? {
                            tx.exec(&format!("DELETE FROM {table}")).await?;
                        }
                    }
                } else {
                    delete_deliveries_for_tenant(tx, &scope).await?;
                    for table in TENANT_SCOPED_TABLES {
                        if table_exists_exec(tx, table).await? {
                            tx.run(
                                &format!("DELETE FROM {table} WHERE tenant_id = ?"),
                                &[SqlValue::from(scope.as_str())],
                            )
                            .await?;
                        }
                    }
                    if table_exists_exec(tx, "tenants").await? {
                        tx.run(
                            "DELETE FROM tenants WHERE tenant_id = ?",
                            &[SqlValue::from(scope.as_str())],
                        )
                        .await?;
                    }
                }
                Ok(())
            })
        })
        .await
}

async fn delete_deliveries_for_tenant(tx: &SqlExec<'_>, scope: &str) -> Result<(), StoreError> {
    if !table_exists_exec(tx, "platform_event_deliveries").await?
        || !table_exists_exec(tx, "platform_events").await?
    {
        return Ok(());
    }
    tx.run(
        "DELETE FROM platform_event_deliveries WHERE event_id IN \
         (SELECT event_id FROM platform_events WHERE tenant_id = ?)",
        &[SqlValue::from(scope)],
    )
    .await?;
    Ok(())
}

async fn assert_scope_empty(driver: &SqlDriver, scope: &str) -> Result<(), RestoreError> {
    if scope == "all" {
        for table in TENANT_SCOPED_TABLES.iter().chain(EVENT_CHILD_TABLES) {
            if !table_exists(driver, table)
                .await
                .map_err(RestoreError::Store)?
            {
                continue;
            }
            let n = count(driver, &format!("SELECT COUNT(*) AS n FROM {table}"), &[]).await?;
            if n > 0 {
                return Err(RestoreRefusal::TargetNotEmpty {
                    table: (*table).to_owned(),
                }
                .into());
            }
        }
        return Ok(());
    }

    // Per-tenant: check deliveries via the JOIN, then each tenant-scoped table.
    if table_exists(driver, "platform_event_deliveries")
        .await
        .map_err(RestoreError::Store)?
        && table_exists(driver, "platform_events")
            .await
            .map_err(RestoreError::Store)?
    {
        let n = count(
            driver,
            "SELECT COUNT(*) AS n FROM platform_event_deliveries d \
             JOIN platform_events e ON e.event_id = d.event_id WHERE e.tenant_id = ?",
            &[SqlValue::from(scope)],
        )
        .await?;
        if n > 0 {
            return Err(RestoreRefusal::TargetNotEmpty {
                table: "platform_event_deliveries".to_owned(),
            }
            .into());
        }
    }
    for table in TENANT_SCOPED_TABLES {
        if !table_exists(driver, table)
            .await
            .map_err(RestoreError::Store)?
        {
            continue;
        }
        let n = count(
            driver,
            &format!("SELECT COUNT(*) AS n FROM {table} WHERE tenant_id = ?"),
            &[SqlValue::from(scope)],
        )
        .await?;
        if n > 0 {
            return Err(RestoreRefusal::TargetNotEmpty {
                table: (*table).to_owned(),
            }
            .into());
        }
    }
    Ok(())
}

async fn count(driver: &SqlDriver, sql: &str, params: &[SqlValue]) -> Result<i64, RestoreError> {
    let row = driver.get(sql, params).await.map_err(RestoreError::Store)?;
    Ok(row.and_then(|r| r.i64("n")).unwrap_or(0))
}

/// `sqlite_master` probe for a table's existence (SQLite dialect; the Postgres
/// arm uses `information_schema`, but FR-262 ships the SQLite path first — the
/// driver normalizes `?` either way).
async fn table_exists(driver: &SqlDriver, name: &str) -> Result<bool, StoreError> {
    let row = driver
        .get(
            "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
            &[SqlValue::from(name)],
        )
        .await?;
    Ok(row.and_then(|r| r.i64("ok")).unwrap_or(0) == 1)
}

async fn table_exists_exec(tx: &SqlExec<'_>, name: &str) -> Result<bool, StoreError> {
    let row = tx
        .get(
            "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
            &[SqlValue::from(name)],
        )
        .await?;
    Ok(row.and_then(|r| r.i64("ok")).unwrap_or(0) == 1)
}

#[cfg(test)]
mod tests;
