//! Durable event feed for the DevTools developer console (FR-274, map 03 §9.x;
//! `apps/server/src/devtools/event-store.ts`).
//!
//! The store sits behind [`FrickStore::devtools_events`] and is intentionally
//! additive: it does NOT replace the unstructured request logger or the
//! counters in the metrics module. Each framework emission point that wants to
//! surface itself in the console writes a row here in addition to its existing
//! log/metric calls. The console (`/_frick/inspect/devtools/*`) and the
//! structured diagnostics snapshot (`recentErrors`) read it back.
//!
//! Retention follows the same "age sweep, then cap sweep" idiom as the
//! idempotency-keys prune in [`FrickStore::prune`] — the `devtools_events`
//! table must never grow unbounded (a busy server emits one row per HTTP
//! request). The defaults (1 hour / 10,000 rows) keep a 100 req/s server's
//! recent history queryable without dominating the database.
//!
//! # Determinism (map 03 §9, "Determinism rule")
//!
//! [`record`](DevToolsEventStore::record) and [`prune`](DevToolsEventStore::prune)
//! and [`summary`](DevToolsEventStore::summary) take `now_ms` (the TS reads
//! `this.now()`); `id` is the AUTOINCREMENT / IDENTITY rowid the driver
//! returns. Nothing here reads the clock directly, so the feed is reproducible
//! under test — the facade threads the clock seam exactly like the sibling
//! stores.
//!
//! [`FrickStore::devtools_events`]: crate::facade::FrickStore::devtools_events
//! [`FrickStore::prune`]: crate::facade::FrickStore::prune

use std::sync::Arc;

use serde_json::{Map, Value};

use crate::driver::{SqlDriver, SqlRow, SqlValue};
use crate::error::StoreError;
use crate::stores::blob_bytes::iso_from_epoch_ms;

/// Default retention window: keep one hour of events
/// (`DEFAULT_DEVTOOLS_EVENTS_RETENTION_MS`).
pub const DEFAULT_DEVTOOLS_EVENTS_RETENTION_MS: i64 = 60 * 60 * 1000;
/// Default hard cap on total rows (`DEFAULT_DEVTOOLS_EVENTS_MAX_ROWS`).
pub const DEFAULT_DEVTOOLS_EVENTS_MAX_ROWS: i64 = 10_000;
/// Default prune cadence: 60 seconds
/// (`DEFAULT_DEVTOOLS_EVENTS_PRUNE_INTERVAL_MS`).
pub const DEFAULT_DEVTOOLS_EVENTS_PRUNE_INTERVAL_MS: i64 = 60 * 1000;
/// Default `limit` for [`DevToolsEventStore::list`] when callers omit it.
const DEFAULT_LIST_LIMIT: i64 = 200;
/// Hard cap on a single list call — prevents pathological queries from the
/// inspect route.
const MAX_LIST_LIMIT: i64 = 1000;
/// Default `summary` rolling window when the route omits one (60 s).
pub const DEFAULT_SUMMARY_WINDOW_MS: i64 = 60 * 1000;

/// Input to [`DevToolsEventStore::record`]
/// (`DevToolsEventInput`, event-store.ts:20-26).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DevToolsEventInput {
    /// Event kind — a dotted label, e.g. `http.request`, `job.failed`.
    pub kind: String,
    /// Tenant the event belongs to; `None` stores SQL NULL (global / not
    /// tenant-scoped).
    pub tenant_id: Option<String>,
    /// JSON-encoded `fields` bag. `None` stores `"{}"`. Callers serialize
    /// (and redact) before handing it here; an unserializable bag never breaks
    /// the originating request.
    pub fields_json: Option<String>,
    /// Override the recorded timestamp (ISO-8601). `None` ⇒ `iso(now_ms)`.
    pub occurred_at: Option<String>,
}

/// `DevToolsEventRow` (event-store.ts:28-34): one stored event. `fields` is the
/// JSON-decoded `fields` column (an empty object when the column is NULL/blank
/// or fails to parse, matching the TS swallow-on-corrupt behavior).
#[derive(Debug, Clone, PartialEq)]
pub struct DevToolsEventRow {
    pub id: i64,
    pub occurred_at: String,
    pub kind: String,
    /// `None` when the column is NULL (the TS keeps `null`).
    pub tenant_id: Option<String>,
    /// Decoded `fields` object; an empty map when absent or unparsable.
    pub fields: Map<String, Value>,
}

/// `DevToolsEventListFilter` (event-store.ts:36-41): optional exact-match
/// filters + a `since_id` lower bound + a `limit`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DevToolsEventListFilter {
    pub kind: Option<String>,
    pub tenant_id: Option<String>,
    pub since_id: Option<i64>,
    pub limit: Option<i64>,
}

/// `DevToolsEventsPruneResult` (event-store.ts:43-46): rows dropped by each
/// sweep.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DevToolsEventsPruneResult {
    pub pruned_by_age: u64,
    pub pruned_by_cap: u64,
}

/// One-kind aggregate count surfaced by [`DevToolsEventStore::summary`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevToolsKindCount {
    pub kind: String,
    pub count: i64,
}

/// `summary(windowMs)` result (event-store.ts:160-178): the window echoed back,
/// the total count, and the per-kind breakdown (descending by count).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevToolsEventsSummary {
    pub window_ms: i64,
    pub total: i64,
    /// Per-kind counts, most-frequent first (`ORDER BY count DESC`).
    pub by_kind: Vec<DevToolsKindCount>,
}

/// `DevToolsEventStore` (`devtools/event-store.ts`). Append + list/summary +
/// two-phase prune over the migrated `devtools_events` table.
pub struct DevToolsEventStore {
    sql: Arc<SqlDriver>,
    retention_ms: i64,
    max_rows: i64,
}

impl DevToolsEventStore {
    /// Construct with the configured retention/cap knobs (event-store.ts
    /// constructor). The facade resolves the defaults before calling.
    #[must_use]
    pub fn new(sql: Arc<SqlDriver>, retention_ms: i64, max_rows: i64) -> Self {
        Self {
            sql,
            retention_ms,
            max_rows,
        }
    }

    /// `record` (event-store.ts:84-106). Append a single event. Never errors on
    /// the SQL write — the worst case is a dropped row, which is preferable to
    /// taking down the originating handler (the TS swallows). `now_ms` stamps
    /// `occurred_at` when the input omits it.
    pub async fn record(&self, input: &DevToolsEventInput, now_ms: i64) {
        let occurred_at = input
            .occurred_at
            .clone()
            .unwrap_or_else(|| iso_from_epoch_ms(now_ms));
        let fields_json = input
            .fields_json
            .clone()
            .unwrap_or_else(|| "{}".to_string());
        let tenant: SqlValue = input.tenant_id.clone().into();
        let result = self
            .sql
            .run(
                "INSERT INTO devtools_events (occurred_at, kind, tenant_id, fields)
                     VALUES (?, ?, ?, ?)",
                &[
                    occurred_at.into(),
                    input.kind.as_str().into(),
                    tenant,
                    fields_json.into(),
                ],
            )
            .await;
        if let Err(error) = result {
            // Best-effort — recording must never break the originating path.
            tracing::warn!(
                target: "frick.devtools.record_failed",
                kind = input.kind.as_str(),
                error = %error,
                "devtools event record failed",
            );
        }
    }

    /// `list` (event-store.ts:108-140): rows filtered by optional exact `kind`,
    /// exact `tenant_id`, and a `since_id` (`id > ?`) lower bound, newest first
    /// (`ORDER BY id DESC`). `limit` defaults to 200, is floored, and is
    /// clamped to `[1, 1000]`.
    pub async fn list(
        &self,
        filter: &DevToolsEventListFilter,
    ) -> Result<Vec<DevToolsEventRow>, StoreError> {
        let mut clauses: Vec<&str> = Vec::new();
        let mut params: Vec<SqlValue> = Vec::new();
        if let Some(kind) = &filter.kind {
            clauses.push("kind = ?");
            params.push(kind.as_str().into());
        }
        if let Some(tenant_id) = &filter.tenant_id {
            clauses.push("tenant_id = ?");
            params.push(tenant_id.as_str().into());
        }
        if let Some(since_id) = filter.since_id {
            clauses.push("id > ?");
            params.push(since_id.into());
        }
        let where_clause = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };
        let limit = clamp_limit(filter.limit);
        params.push(limit.into());

        let sql = format!(
            "SELECT id, occurred_at, kind, tenant_id, fields
               FROM devtools_events
               {where_clause}
               ORDER BY id DESC
               LIMIT ?"
        );
        let rows = self.sql.all(&sql, &params).await?;
        Ok(rows.iter().map(decode_row).collect())
    }

    /// `getById` (event-store.ts:142-158): a single row by `id`, or `None`.
    pub async fn get_by_id(&self, id: i64) -> Result<Option<DevToolsEventRow>, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT id, occurred_at, kind, tenant_id, fields
                   FROM devtools_events WHERE id = ?",
                &[id.into()],
            )
            .await?;
        Ok(row.as_ref().map(decode_row))
    }

    /// `summary(windowMs)` (event-store.ts:160-178): aggregate counts by `kind`
    /// over the most-recent `window_ms`, ordered by count descending. `now_ms`
    /// derives the cutoff (`iso(now - max(0, window))`).
    pub async fn summary(
        &self,
        window_ms: i64,
        now_ms: i64,
    ) -> Result<DevToolsEventsSummary, StoreError> {
        let cutoff_iso = iso_from_epoch_ms(now_ms - window_ms.max(0));
        let rows = self
            .sql
            .all(
                "SELECT kind, COUNT(*) AS count
                   FROM devtools_events
                   WHERE occurred_at >= ?
                   GROUP BY kind
                   ORDER BY count DESC",
                &[cutoff_iso.into()],
            )
            .await?;
        let mut total = 0_i64;
        let mut by_kind = Vec::with_capacity(rows.len());
        for row in &rows {
            let kind = row.text("kind").unwrap_or_default().to_owned();
            let count = row.i64("count").unwrap_or_default();
            total += count;
            by_kind.push(DevToolsKindCount { kind, count });
        }
        Ok(DevToolsEventsSummary {
            window_ms,
            total,
            by_kind,
        })
    }

    /// `prune` (event-store.ts:180-220): two sequential sweeps — drop rows older
    /// than the retention window, then, if the table still exceeds the cap, drop
    /// the oldest rows until it fits. Deliberately NOT wrapped in a transaction
    /// (a rolling GC needs no cross-statement atomicity; the worst case is the
    /// cap count being off by a concurrently-inserted row, which the next sweep
    /// corrects). `now_ms` derives the age cutoff.
    pub async fn prune(&self, now_ms: i64) -> Result<DevToolsEventsPruneResult, StoreError> {
        let cutoff_iso = iso_from_epoch_ms(now_ms - self.retention_ms);
        let age = self
            .sql
            .run(
                "DELETE FROM devtools_events WHERE occurred_at < ?",
                &[cutoff_iso.into()],
            )
            .await?;
        let pruned_by_age = age.changes;

        let mut pruned_by_cap = 0_u64;
        let remaining = self.row_count().await?;
        let overflow = remaining.saturating_sub(self.max_rows.max(0).unsigned_abs());
        if overflow > 0 {
            #[allow(clippy::cast_possible_wrap)]
            let cap = self
                .sql
                .run(
                    "DELETE FROM devtools_events
                       WHERE id IN (
                         SELECT id FROM devtools_events
                           ORDER BY id ASC
                           LIMIT ?
                       )",
                    &[(overflow as i64).into()],
                )
                .await?;
            pruned_by_cap = cap.changes;
        }
        Ok(DevToolsEventsPruneResult {
            pruned_by_age,
            pruned_by_cap,
        })
    }

    /// `rowCount` (event-store.ts:222-227): total rows in the table.
    pub async fn row_count(&self) -> Result<u64, StoreError> {
        let row = self
            .sql
            .get("SELECT COUNT(*) AS count FROM devtools_events", &[])
            .await?;
        Ok(row
            .and_then(|row| row.i64("count"))
            .unwrap_or(0)
            .max(0)
            .unsigned_abs())
    }
}

/// `clampLimit` (event-store.ts:240-245): default 200, floor, clamp to
/// `[1, 1000]`. A `None`/`<= 0` limit falls back to the default.
fn clamp_limit(limit: Option<i64>) -> i64 {
    match limit {
        Some(value) if value > 0 => value.min(MAX_LIST_LIMIT),
        _ => DEFAULT_LIST_LIMIT,
    }
}

/// `decodeRow` (event-store.ts:229-238): a `SELECT` row → [`DevToolsEventRow`].
/// The `fields` JSON is decoded to a map; a NULL/blank/non-object/unparsable
/// value yields an empty map (the TS swallows the parse error). NULL
/// `tenant_id` becomes `None`.
fn decode_row(row: &SqlRow) -> DevToolsEventRow {
    let fields = row
        .text("fields")
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();
    DevToolsEventRow {
        id: row.i64("id").unwrap_or_default(),
        occurred_at: row.text("occurred_at").unwrap_or_default().to_owned(),
        kind: row.text("kind").unwrap_or_default().to_owned(),
        tenant_id: row.text("tenant_id").map(str::to_owned),
        fields,
    }
}

#[cfg(test)]
mod tests {
    //! Port of `apps/server/tests/devtools-events.test.ts`.

    use super::*;

    // The effective post-migration-0011 SQLite schema for `devtools_events`
    // (conformance fixture `0011_devtools_event_log`).
    const SCHEMA: &str = "
        CREATE TABLE devtools_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          occurred_at TEXT NOT NULL,
          kind TEXT NOT NULL,
          tenant_id TEXT,
          fields TEXT NOT NULL
        );
        CREATE INDEX idx_devtools_events_kind_at ON devtools_events (kind, occurred_at DESC);
        CREATE INDEX idx_devtools_events_tenant_at ON devtools_events (tenant_id, occurred_at DESC);";

    // A fixed clock: 2023-11-14T22:13:20.123Z.
    const NOW: i64 = 1_700_000_000_123;

    async fn store(retention_ms: i64, max_rows: i64) -> (DevToolsEventStore, Arc<SqlDriver>) {
        let sql = Arc::new(SqlDriver::open_sqlite(":memory:").unwrap());
        sql.exec(SCHEMA).await.unwrap();
        (
            DevToolsEventStore::new(Arc::clone(&sql), retention_ms, max_rows),
            sql,
        )
    }

    fn input(kind: &str, tenant: Option<&str>, fields_json: Option<&str>) -> DevToolsEventInput {
        DevToolsEventInput {
            kind: kind.to_owned(),
            tenant_id: tenant.map(str::to_owned),
            fields_json: fields_json.map(str::to_owned),
            occurred_at: None,
        }
    }

    #[tokio::test]
    async fn record_then_list_returns_newest_first_with_decoded_fields() {
        let (store, _sql) = store(DEFAULT_DEVTOOLS_EVENTS_RETENTION_MS, 10_000).await;
        store
            .record(&input("http.request", None, Some(r#"{"status":200}"#)), NOW)
            .await;
        store
            .record(
                &input("job.failed", Some("t1"), Some(r#"{"errorCode":"boom"}"#)),
                NOW + 1,
            )
            .await;

        let rows = store
            .list(&DevToolsEventListFilter::default())
            .await
            .unwrap();
        assert_eq!(rows.len(), 2);
        // Newest first (id DESC): the job.failed row is last-inserted.
        assert_eq!(rows[0].kind, "job.failed");
        assert_eq!(rows[0].tenant_id.as_deref(), Some("t1"));
        assert_eq!(rows[0].fields.get("errorCode"), Some(&Value::from("boom")));
        assert_eq!(rows[1].kind, "http.request");
        assert_eq!(rows[1].tenant_id, None);
        assert_eq!(rows[1].fields.get("status"), Some(&Value::from(200)));
    }

    #[tokio::test]
    async fn list_filters_by_kind_tenant_and_since_id() {
        let (store, _sql) = store(DEFAULT_DEVTOOLS_EVENTS_RETENTION_MS, 10_000).await;
        store
            .record(&input("http.request", Some("t1"), None), NOW)
            .await;
        store
            .record(&input("http.request", Some("t2"), None), NOW + 1)
            .await;
        store
            .record(&input("job.failed", Some("t1"), None), NOW + 2)
            .await;

        // kind filter.
        let http = store
            .list(&DevToolsEventListFilter {
                kind: Some("http.request".to_owned()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(http.len(), 2);
        assert!(http.iter().all(|r| r.kind == "http.request"));

        // tenant filter.
        let t1 = store
            .list(&DevToolsEventListFilter {
                tenant_id: Some("t1".to_owned()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(t1.len(), 2);
        assert!(t1.iter().all(|r| r.tenant_id.as_deref() == Some("t1")));

        // since_id: strictly greater than the first row's id.
        let first_id = http.iter().map(|r| r.id).min().unwrap();
        let after = store
            .list(&DevToolsEventListFilter {
                since_id: Some(first_id),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(after.iter().all(|r| r.id > first_id));
    }

    #[tokio::test]
    async fn list_limit_defaults_floors_and_caps() {
        let (store, _sql) = store(DEFAULT_DEVTOOLS_EVENTS_RETENTION_MS, 10_000).await;
        for i in 0..5 {
            store
                .record(&input("http.request", None, None), NOW + i64::from(i))
                .await;
        }
        let limited = store
            .list(&DevToolsEventListFilter {
                limit: Some(2),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(limited.len(), 2);

        // limit <= 0 falls back to the default (200), so all 5 come back.
        let defaulted = store
            .list(&DevToolsEventListFilter {
                limit: Some(0),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(defaulted.len(), 5);
    }

    #[tokio::test]
    async fn get_by_id_round_trips_and_misses_are_none() {
        let (store, _sql) = store(DEFAULT_DEVTOOLS_EVENTS_RETENTION_MS, 10_000).await;
        store
            .record(&input("http.request", None, Some(r#"{"path":"/x"}"#)), NOW)
            .await;
        let rows = store
            .list(&DevToolsEventListFilter::default())
            .await
            .unwrap();
        let id = rows[0].id;
        let fetched = store.get_by_id(id).await.unwrap().unwrap();
        assert_eq!(fetched.id, id);
        assert_eq!(fetched.fields.get("path"), Some(&Value::from("/x")));
        assert_eq!(store.get_by_id(999_999).await.unwrap(), None);
    }

    #[tokio::test]
    async fn corrupt_or_null_fields_decode_to_empty_object() {
        let (store, sql) = store(DEFAULT_DEVTOOLS_EVENTS_RETENTION_MS, 10_000).await;
        // Insert a row whose fields column is non-object JSON and another that
        // is unparsable — both decode to an empty map.
        sql.run(
            "INSERT INTO devtools_events (occurred_at, kind, tenant_id, fields) VALUES (?, ?, NULL, ?)",
            &[iso_from_epoch_ms(NOW).into(), "weird.array".into(), "[1,2,3]".into()],
        )
        .await
        .unwrap();
        sql.run(
            "INSERT INTO devtools_events (occurred_at, kind, tenant_id, fields) VALUES (?, ?, NULL, ?)",
            &[iso_from_epoch_ms(NOW + 1).into(), "weird.bad".into(), "{not json".into()],
        )
        .await
        .unwrap();
        let rows = store
            .list(&DevToolsEventListFilter::default())
            .await
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.fields.is_empty()));
    }

    #[tokio::test]
    async fn summary_aggregates_by_kind_within_window() {
        let (store, _sql) = store(DEFAULT_DEVTOOLS_EVENTS_RETENTION_MS, 10_000).await;
        store.record(&input("http.request", None, None), NOW).await;
        store
            .record(&input("http.request", None, None), NOW + 1)
            .await;
        store
            .record(&input("job.failed", None, None), NOW + 2)
            .await;
        // An old row outside the window must not be counted.
        store
            .record(&input("http.request", None, None), NOW - 10 * 60 * 1000)
            .await;

        let summary = store.summary(60 * 1000, NOW + 3).await.unwrap();
        assert_eq!(summary.window_ms, 60 * 1000);
        assert_eq!(summary.total, 3);
        // Ordered by count desc: http.request (2) before job.failed (1).
        assert_eq!(summary.by_kind[0].kind, "http.request");
        assert_eq!(summary.by_kind[0].count, 2);
        assert_eq!(summary.by_kind[1].kind, "job.failed");
        assert_eq!(summary.by_kind[1].count, 1);
    }

    #[tokio::test]
    async fn prune_drops_by_age_then_by_cap() {
        // Retention 1s, cap 2 rows.
        let (store, _sql) = store(1_000, 2).await;
        // Two rows older than the 1s window.
        store.record(&input("a", None, None), NOW - 5_000).await;
        store.record(&input("b", None, None), NOW - 5_000).await;
        // Three fresh rows.
        store.record(&input("c", None, None), NOW).await;
        store.record(&input("d", None, None), NOW + 1).await;
        store.record(&input("e", None, None), NOW + 2).await;
        assert_eq!(store.row_count().await.unwrap(), 5);

        let result = store.prune(NOW + 3).await.unwrap();
        // Age sweep removes the two stale rows.
        assert_eq!(result.pruned_by_age, 2);
        // Cap sweep brings the remaining 3 down to the cap of 2 (drops 1).
        assert_eq!(result.pruned_by_cap, 1);
        assert_eq!(store.row_count().await.unwrap(), 2);
        // The two survivors are the newest (d, e).
        let rows = store
            .list(&DevToolsEventListFilter::default())
            .await
            .unwrap();
        let kinds: Vec<&str> = rows.iter().map(|r| r.kind.as_str()).collect();
        assert_eq!(kinds, ["e", "d"]);
    }

    #[tokio::test]
    async fn explicit_occurred_at_overrides_now() {
        let (store, _sql) = store(DEFAULT_DEVTOOLS_EVENTS_RETENTION_MS, 10_000).await;
        store
            .record(
                &DevToolsEventInput {
                    kind: "http.request".to_owned(),
                    tenant_id: None,
                    fields_json: None,
                    occurred_at: Some("2020-01-01T00:00:00.000Z".to_owned()),
                },
                NOW,
            )
            .await;
        let rows = store
            .list(&DevToolsEventListFilter::default())
            .await
            .unwrap();
        assert_eq!(rows[0].occurred_at, "2020-01-01T00:00:00.000Z");
    }
}
