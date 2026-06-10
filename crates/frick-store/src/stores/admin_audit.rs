//! Hash-chained admin audit log (`apps/server/src/storage/admin-audit-store.ts`,
//! map 03 §9.8).
//!
//! Rows are appended by the admin route handlers AFTER authentication has
//! succeeded — never for unauthenticated requests (those are request-log
//! territory). The table is global (not tenant-scoped) because admin actions
//! span all tenants and the global admin scope itself; an operator
//! investigating an incident wants a single stream to walk.
//!
//! Migration 0012 added a hash chain over the rows: each row's `entry_hash`
//! commits to the previous row's hash and the canonical JSON of its own columns.
//! Tampering with any row (changing `action`, `target`, …, or deleting a row)
//! breaks the chain and is detectable via [`AdminAuditStore::verify_chain`].
//!
//! # Serialization of `record` (server-storage-1)
//!
//! The chain's read-previous + insert is a critical section: if two `record`
//! calls interleave at an `await`, both read the same tail and chain off the
//! same predecessor, forking the chain. A wrapping transaction alone does NOT
//! fix this on SQLite — the seam runs synchronously, two `record` calls still
//! interleave at the `await` between the SELECT and the INSERT, and the seam's
//! nested-transaction reuse means the second call doesn't get its own `BEGIN`.
//! The TS serializes `record` through an in-process promise-chain mutex
//! (`#recordTail`); we mirror it with a [`tokio::sync::Mutex`] held across the
//! whole `record` transaction so each call's SELECT observes the prior call's
//! INSERT. (The Postgres `LOCK TABLE … SHARE ROW EXCLUSIVE` adds the
//! cross-process guard the in-process mutex can't provide; it is a no-op seam
//! here until the Postgres arm lands.)
//!
//! # Determinism (map 03 §9, "Determinism rule")
//!
//! [`record`] takes `now_ms` for `occurred_at` (the TS reads `this.now()`);
//! `id` is the AUTOINCREMENT rowid from the driver. Hashing is deterministic
//! given the inputs, so the chain is reproducible under test.
//!
//! [`record`]: AdminAuditStore::record

use std::sync::Arc;

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;

use crate::driver::{SqlDriver, SqlRow};
use crate::error::StoreError;
use crate::stores::blob_bytes::iso_from_epoch_ms;

const DEFAULT_LIST_LIMIT: i64 = 100;
const MAX_LIST_LIMIT: i64 = 1000;

/// `AdminAuditOutcome` (admin-audit-store.ts:18). The outcome vocabulary —
/// `allow | deny | error`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdminAuditOutcome {
    Allow,
    Deny,
    Error,
}

impl AdminAuditOutcome {
    /// The wire/storage spelling (lower-case), matching the TS string union.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Deny => "deny",
            Self::Error => "error",
        }
    }

    /// Parse the stored string back to the enum. Unknown strings (which the
    /// schema/route layer forbids) map to [`AdminAuditOutcome::Error`] — the TS
    /// casts the raw string with `as AdminAuditOutcome` and never validates on
    /// read, so this only matters for hand-corrupted rows.
    #[must_use]
    pub fn from_str_lossy(value: &str) -> Self {
        match value {
            "allow" => Self::Allow,
            "deny" => Self::Deny,
            _ => Self::Error,
        }
    }
}

/// Input to [`AdminAuditStore::record`]
/// (`Omit<AdminAuditRow, "id"|"occurredAt"|"previousHash"|"entryHash">`,
/// admin-audit-store.ts:124-126).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdminAuditInput {
    /// Truncated SHA-256 of the admin token (hex, 12 chars). Never the raw
    /// token — the caller produces this.
    pub admin_token_fingerprint: String,
    /// Dotted action name, e.g. `tenants.create`, `tenants.archive`.
    pub action: String,
    /// Target identifier the action operated on (e.g. tenant id). `None` stores
    /// SQL NULL and hashes as literal `null`.
    pub target: Option<String>,
    pub outcome: AdminAuditOutcome,
    /// JSON-encoded extra metadata; callers redact secrets first. `None` stores
    /// SQL NULL and hashes as literal `null`.
    pub detail: Option<String>,
}

/// `AdminAuditRow` (admin-audit-store.ts:20-36): one stored entry. `target` /
/// `detail` / `previous_hash` / `entry_hash` are `None` when the column is NULL
/// (the TS omits each absent key).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdminAuditRow {
    pub id: i64,
    pub occurred_at: String,
    pub admin_token_fingerprint: String,
    pub action: String,
    pub target: Option<String>,
    pub outcome: AdminAuditOutcome,
    pub detail: Option<String>,
    /// Hash of the chronologically-previous row's `entry_hash`. Empty string
    /// for the genesis row (so it is present, not absent, after `record`).
    pub previous_hash: Option<String>,
    /// SHA-256 hex over `previous_hash || canonical_json(row)`.
    pub entry_hash: Option<String>,
}

/// `AdminAuditListOptions` (admin-audit-store.ts:50-57).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AdminAuditListOptions {
    /// Inclusive lower bound on `occurred_at` (ISO-8601).
    pub since: Option<String>,
    /// Exact-match filter on `action`.
    pub action: Option<String>,
    /// Max rows to return. Defaults to 100, capped at 1000.
    pub limit: Option<i64>,
}

/// `AdminAuditChainVerification` (admin-audit-store.ts:59-63): the result of
/// [`AdminAuditStore::verify_chain`]. `broken_at` carries the `id` of the first
/// row whose hash didn't match, and is `None` when the chain is intact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdminAuditChainVerification {
    pub valid: bool,
    pub broken_at: Option<i64>,
}

/// `AdminAuditStore` (`storage/admin-audit-store.ts`).
pub struct AdminAuditStore {
    sql: Arc<SqlDriver>,
    /// In-process serialization gate for [`record`](Self::record)
    /// (server-storage-1) — the Rust analogue of the TS `#recordTail` promise
    /// chain. Held across the whole record transaction so the read-previous +
    /// insert critical section never interleaves with another in-process
    /// `record`.
    record_lock: Mutex<()>,
}

impl AdminAuditStore {
    #[must_use]
    pub fn new(sql: Arc<SqlDriver>) -> Self {
        Self {
            sql,
            record_lock: Mutex::new(()),
        }
    }

    /// `record` (admin-audit-store.ts:124-206). Append a new audit row, chaining
    /// its `entry_hash` off the current tail. Serialized in-process (see
    /// [`record_lock`](Self::record_lock)) and wrapped in a transaction.
    ///
    /// The previous row is chosen by `ORDER BY id DESC LIMIT 1` (AUTOINCREMENT
    /// insertion order, NOT `occurred_at` — clock skew must not pick a wrong
    /// predecessor); genesis `previous_hash = ""`. The INSERT uses
    /// `RETURNING id` for the generated rowid. `now_ms` stamps `occurred_at`.
    ///
    /// The returned row mirrors the TS exactly: `previous_hash`/`entry_hash` are
    /// always `Some` (present), while `target`/`detail` are `Some` only when the
    /// input supplied them.
    pub async fn record(
        &self,
        input: &AdminAuditInput,
        now_ms: i64,
    ) -> Result<AdminAuditRow, StoreError> {
        // Serialize the read-previous + insert across in-process callers; held
        // for the duration of the transaction (mirrors the TS #recordTail
        // mutex). The guard is dropped when this scope ends.
        let _guard = self.record_lock.lock().await;

        let occurred_at = iso_from_epoch_ms(now_ms);
        let target = input.target.clone();
        let detail = input.detail.clone();

        let outcome = input.outcome;
        let fingerprint = input.admin_token_fingerprint.clone();
        let action = input.action.clone();

        // server-storage-1: the read-previous + insert MUST be atomic. The
        // wrapping transaction makes the pair durable-atomic; on Postgres a
        // `LOCK TABLE … SHARE ROW EXCLUSIVE` (reserved for FR-242) would add the
        // cross-process guard. The in-process mutex above serializes record()
        // callers within this process.
        let (previous_hash, entry_hash, id) = self
            .sql
            .transaction(move |tx| {
                let occurred_at = occurred_at.clone();
                let fingerprint = fingerprint.clone();
                let action = action.clone();
                let target = target.clone();
                let detail = detail.clone();
                Box::pin(async move {
                    // Look up the most-recent row's entry_hash to chain against.
                    // Order by `id DESC` (AUTOINCREMENT insertion order); empty
                    // string for the genesis row keeps the canonical input
                    // stable.
                    let previous_row = tx
                        .get(
                            "SELECT entry_hash FROM admin_audit_log ORDER BY id DESC LIMIT 1",
                            &[],
                        )
                        .await?;
                    let previous_hash = previous_row
                        .as_ref()
                        .and_then(|row| row.text("entry_hash"))
                        .unwrap_or("")
                        .to_owned();

                    let canonical = canonical_json(
                        &occurred_at,
                        &fingerprint,
                        &action,
                        target.as_deref(),
                        outcome.as_str(),
                        detail.as_deref(),
                    );
                    let entry_hash = compute_entry_hash(&previous_hash, &canonical);

                    // `INSERT … RETURNING id` returns a row, so it goes through
                    // the query path (`get`), not `run` (which `execute`s and
                    // errors on a result set). The job store uses the same
                    // dialect-portable pattern; on Postgres the RETURNING row is
                    // the only way to read the generated key.
                    let returned = tx
                        .get(
                            "INSERT INTO admin_audit_log
                                 (occurred_at, admin_token_fingerprint, action, target, outcome, detail, previous_hash, entry_hash)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                                 RETURNING id",
                            &[
                                occurred_at.as_str().into(),
                                fingerprint.as_str().into(),
                                action.as_str().into(),
                                target.clone().into(),
                                outcome.as_str().into(),
                                detail.clone().into(),
                                previous_hash.as_str().into(),
                                entry_hash.as_str().into(),
                            ],
                        )
                        .await?;
                    let id = returned
                        .and_then(|row| row.i64("id"))
                        .ok_or_else(|| StoreError::store("adminAudit.record: INSERT returned no id"))?;
                    Ok((previous_hash, entry_hash, id))
                })
            })
            .await?;

        Ok(AdminAuditRow {
            id,
            occurred_at: iso_from_epoch_ms(now_ms),
            admin_token_fingerprint: input.admin_token_fingerprint.clone(),
            action: input.action.clone(),
            target: input.target.clone(),
            outcome: input.outcome,
            detail: input.detail.clone(),
            previous_hash: Some(previous_hash),
            entry_hash: Some(entry_hash),
        })
    }

    /// `list` (admin-audit-store.ts:208-233): rows filtered by optional `since`
    /// (`occurred_at >= ?`) and exact `action`, newest first
    /// (`ORDER BY occurred_at DESC, id DESC`). `limit` defaults to 100, is
    /// floored, and is clamped to `[1, 1000]`.
    pub async fn list(
        &self,
        options: &AdminAuditListOptions,
    ) -> Result<Vec<AdminAuditRow>, StoreError> {
        let mut clauses: Vec<&str> = Vec::new();
        let mut params: Vec<crate::driver::SqlValue> = Vec::new();
        if let Some(since) = &options.since {
            clauses.push("occurred_at >= ?");
            params.push(since.as_str().into());
        }
        if let Some(action) = &options.action {
            clauses.push("action = ?");
            params.push(action.as_str().into());
        }
        let where_clause = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };
        let requested = options.limit.unwrap_or(DEFAULT_LIST_LIMIT);
        let limit = requested.clamp(1, MAX_LIST_LIMIT);
        params.push(limit.into());

        let sql = format!(
            "SELECT id, occurred_at, admin_token_fingerprint, action, target, outcome, detail,
                    previous_hash, entry_hash
               FROM admin_audit_log
               {where_clause}
               ORDER BY occurred_at DESC, id DESC
               LIMIT ?"
        );
        let rows = self.sql.all(&sql, &params).await?;
        Ok(rows.iter().map(to_row).collect())
    }

    /// `verifyChain` (admin-audit-store.ts:242-278). Re-derive each row's
    /// `entry_hash` in insertion order (`ORDER BY id ASC`) and compare against
    /// the stored value, constant-time. Rows with a NULL `entry_hash` (pre-0012)
    /// are the implicit genesis prefix and are skipped; the first hashed row
    /// chains from its own recorded `previous_hash` (or `""`), and every later
    /// row's stored `previous_hash` must equal the prior row's `entry_hash`.
    /// Returns `{ valid: true }` for an intact chain, else `{ valid: false,
    /// broken_at: <id> }` for the first mismatch.
    pub async fn verify_chain(&self) -> Result<AdminAuditChainVerification, StoreError> {
        let rows = self
            .sql
            .all(
                "SELECT id, occurred_at, admin_token_fingerprint, action, target, outcome, detail,
                        previous_hash, entry_hash
                   FROM admin_audit_log
                   ORDER BY id ASC",
                &[],
            )
            .await?;

        let mut previous_hash = String::new();
        let mut saw_hashed = false;
        for row in &rows {
            let Some(stored_entry_hash) = row.text("entry_hash") else {
                // Pre-chain row — leave `previous_hash` at "" so the first
                // hashed row chains from the genesis prefix.
                continue;
            };
            let row_previous = row.text("previous_hash").unwrap_or("");
            let expected_previous = if saw_hashed {
                previous_hash.as_str()
            } else {
                row_previous
            };
            if saw_hashed && !constant_time_equals(row_previous, &previous_hash) {
                return Ok(AdminAuditChainVerification {
                    valid: false,
                    broken_at: row.i64("id"),
                });
            }
            let canonical = canonical_json(
                row.text("occurred_at").unwrap_or(""),
                row.text("admin_token_fingerprint").unwrap_or(""),
                row.text("action").unwrap_or(""),
                row.text("target"),
                row.text("outcome").unwrap_or(""),
                row.text("detail"),
            );
            let derived = compute_entry_hash(expected_previous, &canonical);
            if !constant_time_equals(&derived, stored_entry_hash) {
                return Ok(AdminAuditChainVerification {
                    valid: false,
                    broken_at: row.i64("id"),
                });
            }
            stored_entry_hash.clone_into(&mut previous_hash);
            saw_hashed = true;
        }
        Ok(AdminAuditChainVerification {
            valid: true,
            broken_at: None,
        })
    }
}

/// `canonicalJson` (admin-audit-store.ts:72-88). FIXED key order
/// `{occurred_at, admin_token_fingerprint, action, target, outcome, detail}`
/// with `target`/`detail` as literal JSON `null` when absent. Built by hand so
/// the key ORDER is byte-identical to the TS `JSON.stringify` of the
/// fixed-shape object (a `serde_json::Map` would alphabetize). String values use
/// `serde_json` so the escaping matches `JSON.stringify` exactly.
fn canonical_json(
    occurred_at: &str,
    admin_token_fingerprint: &str,
    action: &str,
    target: Option<&str>,
    outcome: &str,
    detail: Option<&str>,
) -> String {
    fn json_str(value: &str) -> String {
        // serde_json string encoding == JSON.stringify string encoding for the
        // characters either escapes (control chars, `"`, `\`).
        serde_json::Value::String(value.to_owned()).to_string()
    }
    fn json_opt(value: Option<&str>) -> String {
        value.map_or_else(|| "null".to_owned(), json_str)
    }
    format!(
        "{{\"occurred_at\":{},\"admin_token_fingerprint\":{},\"action\":{},\"target\":{},\"outcome\":{},\"detail\":{}}}",
        json_str(occurred_at),
        json_str(admin_token_fingerprint),
        json_str(action),
        json_opt(target),
        json_str(outcome),
        json_opt(detail),
    )
}

/// `computeEntryHash` (admin-audit-store.ts:90-92):
/// `hex(sha256(utf8(previous_hash) || utf8(canonical)))` — two sequential
/// `update()` calls over a single SHA-256, matching the TS digest.
fn compute_entry_hash(previous_hash: &str, canonical: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(previous_hash.as_bytes());
    hasher.update(canonical.as_bytes());
    hex::encode(hasher.finalize())
}

/// `constantTimeEquals` (admin-audit-store.ts:95-101): length check then a
/// constant-time byte compare (`subtle::ConstantTimeEq`).
fn constant_time_equals(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

/// `toRow` (admin-audit-store.ts:281-293): `SELECT` row → [`AdminAuditRow`].
/// NULL `target`/`detail`/`previous_hash`/`entry_hash` become `None` (the TS
/// omits each absent key).
fn to_row(row: &SqlRow) -> AdminAuditRow {
    AdminAuditRow {
        id: row.i64("id").unwrap_or_default(),
        occurred_at: row.text("occurred_at").unwrap_or_default().to_owned(),
        admin_token_fingerprint: row
            .text("admin_token_fingerprint")
            .unwrap_or_default()
            .to_owned(),
        action: row.text("action").unwrap_or_default().to_owned(),
        target: row.text("target").map(str::to_owned),
        outcome: AdminAuditOutcome::from_str_lossy(row.text("outcome").unwrap_or("error")),
        detail: row.text("detail").map(str::to_owned),
        previous_hash: row.text("previous_hash").map(str::to_owned),
        entry_hash: row.text("entry_hash").map(str::to_owned),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The effective post-migration-0012 SQLite schema for `admin_audit_log`
    // (map 03 §5): 0005 created it, 0012 added the nullable chain columns.
    const SCHEMA: &str = "
        CREATE TABLE admin_audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          occurred_at TEXT NOT NULL,
          admin_token_fingerprint TEXT NOT NULL,
          action TEXT NOT NULL,
          target TEXT,
          outcome TEXT NOT NULL,
          detail TEXT,
          previous_hash TEXT,
          entry_hash TEXT
        );
        CREATE INDEX idx_admin_audit_occurred ON admin_audit_log (occurred_at DESC);
        CREATE INDEX idx_admin_audit_action ON admin_audit_log (action, occurred_at DESC);
        CREATE INDEX idx_admin_audit_chain ON admin_audit_log (id, entry_hash);";

    // A fixed clock: 2023-11-14T22:13:20.123Z.
    const NOW: i64 = 1_700_000_000_123;

    async fn store() -> (AdminAuditStore, Arc<SqlDriver>) {
        let sql = Arc::new(SqlDriver::open_sqlite(":memory:").unwrap());
        sql.exec(SCHEMA).await.unwrap();
        (AdminAuditStore::new(Arc::clone(&sql)), sql)
    }

    fn input(action: &str, target: &str, outcome: AdminAuditOutcome) -> AdminAuditInput {
        AdminAuditInput {
            admin_token_fingerprint: "abc123def456".to_owned(),
            action: action.to_owned(),
            target: Some(target.to_owned()),
            outcome,
            detail: None,
        }
    }

    // ── canonical-json / entry-hash reference vectors (computed from Node) ────

    #[test]
    fn canonical_json_has_fixed_key_order_and_literal_nulls() {
        assert_eq!(
            canonical_json(
                "2023-11-14T22:13:20.123Z",
                "abc123def456",
                "tenants.create",
                Some("t1"),
                "allow",
                None,
            ),
            r#"{"occurred_at":"2023-11-14T22:13:20.123Z","admin_token_fingerprint":"abc123def456","action":"tenants.create","target":"t1","outcome":"allow","detail":null}"#
        );
    }

    #[test]
    fn entry_hash_matches_node_genesis_and_chained_vectors() {
        // Genesis: previousHash = "".
        let canonical1 = canonical_json(
            "2023-11-14T22:13:20.123Z",
            "abc123def456",
            "tenants.create",
            Some("t1"),
            "allow",
            None,
        );
        let h1 = compute_entry_hash("", &canonical1);
        assert_eq!(
            h1,
            "3c537e4164ff6bba8d859b5b8a2c980f980977b33a3c0f517ed05ab7d9ef4cb2"
        );

        // Second row chains off h1.
        let canonical2 = canonical_json(
            "2023-11-14T22:13:21.123Z",
            "abc123def456",
            "tenants.archive",
            Some("t1"),
            "allow",
            None,
        );
        let h2 = compute_entry_hash(&h1, &canonical2);
        assert_eq!(
            h2,
            "379a6556e7f7ab6599ec910614625c3044a72b816bc6394684f55e45424d4dc2"
        );
    }

    // ── Port of storage-audit-fixes.test.ts (server-storage-1 describe block) ─

    /// "sequential record() still chains correctly".
    #[tokio::test]
    async fn sequential_record_chains_genesis_then_previous() {
        let (store, _sql) = store().await;
        let a = store
            .record(
                &input("tenants.create", "t1", AdminAuditOutcome::Allow),
                NOW,
            )
            .await
            .unwrap();
        let b = store
            .record(
                &input("tenants.archive", "t1", AdminAuditOutcome::Allow),
                NOW + 1_000,
            )
            .await
            .unwrap();
        assert_eq!(a.previous_hash.as_deref(), Some(""));
        assert_eq!(b.previous_hash, a.entry_hash);
        assert_eq!(
            store.verify_chain().await.unwrap(),
            AdminAuditChainVerification {
                valid: true,
                broken_at: None
            }
        );
    }

    /// "a burst of concurrent record() calls produces an intact chain". The
    /// in-process mutex serializes the read-previous + insert so the chain never
    /// forks; we drive 20 records (sequentially here — the seam is single
    /// connection — and assert the same invariants the TS burst checks).
    #[tokio::test]
    async fn many_records_produce_an_intact_chain_with_distinct_previous_hashes() {
        let (store, _sql) = store().await;
        for i in 0..20 {
            store
                .record(
                    &input(
                        "tenants.create",
                        &format!("tenant-{i}"),
                        AdminAuditOutcome::Allow,
                    ),
                    NOW + i64::from(i),
                )
                .await
                .unwrap();
        }

        assert_eq!(
            store.verify_chain().await.unwrap(),
            AdminAuditChainVerification {
                valid: true,
                broken_at: None
            }
        );

        let rows = store
            .list(&AdminAuditListOptions {
                limit: Some(1000),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(rows.len(), 20);
        // No two rows share a previous_hash (each chains off a distinct
        // predecessor — the genesis "" plus 19 distinct entry hashes).
        let mut prev: Vec<&str> = rows
            .iter()
            .map(|r| r.previous_hash.as_deref().unwrap_or(""))
            .collect();
        prev.sort_unstable();
        let distinct = prev.len();
        prev.dedup();
        assert_eq!(prev.len(), distinct, "previous_hashes must be unique");
    }

    // ── list: ordering, filters, limit ───────────────────────────────────────

    /// "returns audit-log rows in reverse-chronological order".
    #[tokio::test]
    async fn list_returns_reverse_chronological_order() {
        let (store, _sql) = store().await;
        store
            .record(
                &input("tenants.create", "tenant-order-a", AdminAuditOutcome::Allow),
                NOW,
            )
            .await
            .unwrap();
        store
            .record(
                &input("tenants.create", "tenant-order-b", AdminAuditOutcome::Allow),
                NOW + 1,
            )
            .await
            .unwrap();
        store
            .record(
                &input("tenants.create", "tenant-order-c", AdminAuditOutcome::Allow),
                NOW + 2,
            )
            .await
            .unwrap();

        let targets: Vec<Option<String>> = store
            .list(&AdminAuditListOptions {
                action: Some("tenants.create".to_owned()),
                ..Default::default()
            })
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.target)
            .collect();
        assert_eq!(
            targets,
            [
                Some("tenant-order-c".to_owned()),
                Some("tenant-order-b".to_owned()),
                Some("tenant-order-a".to_owned()),
            ]
        );
    }

    /// "filters by action exact-match".
    #[tokio::test]
    async fn list_filters_by_action_exact_match() {
        let (store, _sql) = store().await;
        store
            .record(&input("tenants.create", "a", AdminAuditOutcome::Allow), NOW)
            .await
            .unwrap();
        store
            .record(
                &input("tenants.create", "b", AdminAuditOutcome::Allow),
                NOW + 1,
            )
            .await
            .unwrap();
        store
            .record(
                &input("tenants.archive", "a", AdminAuditOutcome::Allow),
                NOW + 2,
            )
            .await
            .unwrap();

        let archives = store
            .list(&AdminAuditListOptions {
                action: Some("tenants.archive".to_owned()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(archives.len(), 1);
        assert_eq!(archives[0].action, "tenants.archive");

        let creates: Vec<String> = store
            .list(&AdminAuditListOptions {
                action: Some("tenants.create".to_owned()),
                ..Default::default()
            })
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.action)
            .collect();
        assert_eq!(creates, ["tenants.create", "tenants.create"]);
    }

    /// "filters by since=<isoLater>": `occurred_at >= ?` inclusive lower bound.
    #[tokio::test]
    async fn list_filters_by_since_inclusive_lower_bound() {
        let (store, _sql) = store().await;
        store
            .record(
                &input("tenants.create", "old", AdminAuditOutcome::Allow),
                NOW,
            )
            .await
            .unwrap();
        let cutoff = iso_from_epoch_ms(NOW + 10);
        store
            .record(
                &input("tenants.create", "new", AdminAuditOutcome::Allow),
                NOW + 20,
            )
            .await
            .unwrap();

        let targets: Vec<Option<String>> = store
            .list(&AdminAuditListOptions {
                since: Some(cutoff),
                ..Default::default()
            })
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.target)
            .collect();
        assert_eq!(targets, [Some("new".to_owned())]);
    }

    /// "limit caps results" — plus the default and the 1000 cap.
    #[tokio::test]
    async fn list_limit_caps_floors_and_defaults() {
        let (store, _sql) = store().await;
        for i in 0..3 {
            store
                .record(
                    &input(
                        "tenants.create",
                        &format!("t-{i}"),
                        AdminAuditOutcome::Allow,
                    ),
                    NOW + i64::from(i),
                )
                .await
                .unwrap();
        }
        let limited = store
            .list(&AdminAuditListOptions {
                limit: Some(2),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(limited.len(), 2);

        // limit <= 0 clamps to 1.
        let clamped = store
            .list(&AdminAuditListOptions {
                limit: Some(0),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(clamped.len(), 1);

        // Default (None) returns everything up to 100.
        let all = store.list(&AdminAuditListOptions::default()).await.unwrap();
        assert_eq!(all.len(), 3);
    }

    // ── target/detail round-trip (NULL ⇒ None; present ⇒ Some) ───────────────

    #[tokio::test]
    async fn target_and_detail_round_trip_present_and_absent() {
        let (store, _sql) = store().await;
        // Present target + detail.
        let with_detail = AdminAuditInput {
            admin_token_fingerprint: "abc123def456".to_owned(),
            action: "tenants.create".to_owned(),
            target: Some("t1".to_owned()),
            outcome: AdminAuditOutcome::Allow,
            detail: Some(r#"{"displayName":"Audit Create"}"#.to_owned()),
        };
        let recorded = store.record(&with_detail, NOW).await.unwrap();
        assert_eq!(recorded.target, Some("t1".to_owned()));
        assert_eq!(
            recorded.detail,
            Some(r#"{"displayName":"Audit Create"}"#.to_owned())
        );

        // Absent target + detail store NULL and hash as literal null.
        let bare = AdminAuditInput {
            admin_token_fingerprint: "abc123def456".to_owned(),
            action: "system.ping".to_owned(),
            target: None,
            outcome: AdminAuditOutcome::Error,
            detail: None,
        };
        let recorded2 = store.record(&bare, NOW + 1).await.unwrap();
        assert_eq!(recorded2.target, None);
        assert_eq!(recorded2.detail, None);
        assert_eq!(recorded2.outcome, AdminAuditOutcome::Error);

        // Reloaded via list, the NULLs remain absent.
        let reloaded = store
            .list(&AdminAuditListOptions {
                action: Some("system.ping".to_owned()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(reloaded[0].target, None);
        assert_eq!(reloaded[0].detail, None);

        // The chain still verifies across both rows.
        assert!(store.verify_chain().await.unwrap().valid);
    }

    // ── verifyChain detects tampering ────────────────────────────────────────

    #[tokio::test]
    async fn verify_chain_detects_a_tampered_row() {
        let (store, sql) = store().await;
        let a = store
            .record(
                &input("tenants.create", "t1", AdminAuditOutcome::Allow),
                NOW,
            )
            .await
            .unwrap();
        store
            .record(
                &input("tenants.archive", "t1", AdminAuditOutcome::Allow),
                NOW + 1,
            )
            .await
            .unwrap();
        assert!(store.verify_chain().await.unwrap().valid);

        // Tamper with the first row's action without recomputing its hash.
        sql.run(
            "UPDATE admin_audit_log SET action = ? WHERE id = ?",
            &["tenants.delete".into(), a.id.into()],
        )
        .await
        .unwrap();

        let verification = store.verify_chain().await.unwrap();
        assert!(!verification.valid);
        // The first row whose re-derived hash no longer matches is row `a`.
        assert_eq!(verification.broken_at, Some(a.id));
    }

    /// Pre-0012 rows (NULL entry_hash) are the implicit genesis prefix: skipped
    /// by verification, and the first hashed row chains from "".
    #[tokio::test]
    async fn verify_chain_skips_null_entry_hash_genesis_prefix() {
        let (store, sql) = store().await;
        // A pre-chain row with NULL hash columns (as migration 0012 leaves
        // historical rows).
        sql.run(
            "INSERT INTO admin_audit_log
                (occurred_at, admin_token_fingerprint, action, target, outcome, detail, previous_hash, entry_hash)
                VALUES (?, ?, ?, NULL, ?, NULL, NULL, NULL)",
            &[
                iso_from_epoch_ms(NOW).into(),
                "oldfingerpr".into(),
                "legacy.action".into(),
                "allow".into(),
            ],
        )
        .await
        .unwrap();

        // The next record() chains from the genesis prefix ("").
        let first_hashed = store
            .record(
                &input("tenants.create", "t1", AdminAuditOutcome::Allow),
                NOW + 1,
            )
            .await
            .unwrap();
        assert_eq!(first_hashed.previous_hash.as_deref(), Some(""));
        assert!(store.verify_chain().await.unwrap().valid);
    }

    #[test]
    fn outcome_round_trips_through_str() {
        for outcome in [
            AdminAuditOutcome::Allow,
            AdminAuditOutcome::Deny,
            AdminAuditOutcome::Error,
        ] {
            assert_eq!(AdminAuditOutcome::from_str_lossy(outcome.as_str()), outcome);
        }
    }
}
