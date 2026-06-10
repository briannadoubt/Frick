//! JobStore (`apps/server/src/storage/job-store.ts`; map 03 §8.7, map 05 §2).
//!
//! Background-job lifecycle over the shared `jobs` table:
//!
//! - `ready`          → eligible to claim once `available_at <= now`
//! - `running`        → claimed by a worker; in-flight
//! - `completed`      → handler returned success
//! - `dead_lettered`  → handler exhausted retries or returned non-retryable failure
//!
//! There is no separate `failed` terminal state — failures either re-arm to
//! `ready` (with exponential backoff) or short-circuit to `dead_lettered`.
//! [`JobStore::counts_by_status`] exposes a synthetic `failed` bucket sourced
//! from `last_error_*` for operator-facing summaries.
//!
//! Unlike the TS class (which calls `Date.now()` internally), every mutating
//! method takes a `now_ms` parameter — system time belongs at the facade
//! boundary, never inside store logic.

use frick_protocol::Value;

use crate::driver::{SqlDialect, SqlDriver, SqlRow, SqlValue};
use crate::error::StoreError;
use crate::packed::{decode_packed, encode_packed};

/// `DEFAULT_APP_ID` (`apps/server/src/app-id.ts:37`): the app partition used
/// by single-app servers.
pub const DEFAULT_APP_ID: &str = "_default";

/// Cap the exponential backoff at 5 minutes — matches the spec.
const BACKOFF_CAP_MS: i64 = 5 * 60 * 1000;
/// Base backoff: 60s, doubled per attempt.
const BACKOFF_BASE_MS: i64 = 60 * 1000;

/// TS `claim` default `limit` (`job-store.ts:203`).
pub const DEFAULT_CLAIM_LIMIT: i64 = 10;

/// `RECURRING_MIN_INTERVAL_MS` (`apps/server/src/jobs/recurring.ts:20`):
/// recurring specs with a smaller `intervalMs` are rejected at boot.
pub const RECURRING_MIN_INTERVAL_MS: i64 = 60_000;

/// Lifecycle states for a background job row. No `failed` state — see the
/// module docs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobStatus {
    Ready,
    Running,
    Completed,
    DeadLettered,
}

impl JobStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::DeadLettered => "dead_lettered",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "ready" => Some(Self::Ready),
            "running" => Some(Self::Running),
            "completed" => Some(Self::Completed),
            "dead_lettered" => Some(Self::DeadLettered),
            _ => None,
        }
    }
}

/// TS `JobRow` (`job-store.ts:21-41`). Nullable columns surface as `None`
/// (TS drops falsy values from the mapped object).
#[derive(Debug, Clone, PartialEq)]
pub struct JobRow {
    pub id: i64,
    pub tenant_id: String,
    /// App partition (FR-153); [`DEFAULT_APP_ID`] for single-app servers.
    pub app_id: String,
    pub job_type: String,
    pub payload: Value,
    pub status: JobStatus,
    pub attempt_count: i64,
    pub max_attempts: i64,
    pub available_at: String,
    pub created_at: String,
    pub claimed_at: Option<String>,
    pub claimed_by: Option<String>,
    pub completed_at: Option<String>,
    pub failed_at: Option<String>,
    pub dead_lettered_at: Option<String>,
    pub idempotency_key: Option<String>,
    pub last_error_code: Option<String>,
    pub last_error_message: Option<String>,
}

/// Legacy single-row shape preserved for [`JobStore::next`] (`job-store.ts:50-54`).
#[derive(Debug, Clone, PartialEq)]
pub struct StoredJob {
    pub id: i64,
    pub name: String,
    pub value: Value,
}

/// TS `EnqueueInput` (`job-store.ts:56-65`).
#[derive(Debug, Clone)]
pub struct EnqueueInput {
    pub tenant_id: String,
    /// App partition (FR-153). Defaults to [`DEFAULT_APP_ID`] when `None`.
    pub app_id: Option<String>,
    pub job_type: String,
    pub payload: Value,
    pub idempotency_key: Option<String>,
    pub available_at: Option<String>,
    pub max_attempts: Option<i64>,
}

/// TS `ListJobsFilter` (`job-store.ts:67-74`).
#[derive(Debug, Clone, Default)]
pub struct ListJobsFilter {
    pub tenant_id: Option<String>,
    /// Filter to a single app partition (FR-153). `None` spans all apps.
    pub app_id: Option<String>,
    pub status: Option<JobStatus>,
    pub job_type: Option<String>,
    pub limit: Option<i64>,
}

/// TS `JobCounts` (`job-store.ts:76-83`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct JobCounts {
    pub ready: i64,
    pub running: i64,
    pub completed: i64,
    pub dead_lettered: i64,
    /// Synthetic: rows in any state whose `last_error_*` columns are populated.
    pub failed: i64,
}

/// `jobBackoffMs` (`job-store.ts:116-120`): `min(60s * 2^(max(1,attempt)-1), 5m)`.
/// Attempt numbers below 1 collapse to the base delay.
#[must_use]
pub fn job_backoff_ms(attempt_count: i64) -> i64 {
    let safe = attempt_count.max(1);
    // The cap kicks in at attempt 4 (480s raw > 300s); clamping the exponent
    // keeps the shift in-range for absurd attempt counts (TS goes through f64
    // and `Math.min` with Infinity — same observable result).
    let exponent = (safe - 1).min(32);
    let raw = BACKOFF_BASE_MS.saturating_mul(1_i64 << exponent);
    raw.min(BACKOFF_CAP_MS)
}

/// `windowStart = Math.floor(now / intervalMs) * intervalMs`
/// (`recurring.ts:127`). Floor division mirrors `Math.floor` for negative
/// inputs too.
#[must_use]
pub fn recurring_window_start(now_ms: i64, interval_ms: i64) -> i64 {
    now_ms.div_euclid(interval_ms) * interval_ms
}

/// The recurring scheduler's per-window idempotency key
/// (`recurring.ts:128,140-145`): `recurring:<name>:` + (`<appId>:` only when
/// the target carries an appId) + `<tenantId>:<windowStart>`. Window dedupe
/// rides the jobs unique idempotency index, so multiple ticks per window and
/// restarts are no-ops.
#[must_use]
pub fn recurring_idempotency_key(
    name: &str,
    app_id: Option<&str>,
    tenant_id: &str,
    window_start_ms: i64,
) -> String {
    let app_segment = app_id
        .map(|app_id| format!("{app_id}:"))
        .unwrap_or_default();
    format!("recurring:{name}:{app_segment}{tenant_id}:{window_start_ms}")
}

/// Format epoch milliseconds as the JS `new Date(ms).toISOString()` shape
/// (`YYYY-MM-DDTHH:mm:ss.sssZ`) — lexicographic order equals chronological
/// order, which the `available_at <= ?` claim gate relies on. Supports years
/// 0000-9999 (JS switches to expanded years outside that range; stores never
/// produce such timestamps).
#[must_use]
pub fn epoch_ms_to_iso(epoch_ms: i64) -> String {
    let days = epoch_ms.div_euclid(86_400_000);
    let ms_of_day = epoch_ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let hour = ms_of_day / 3_600_000;
    let minute = (ms_of_day % 3_600_000) / 60_000;
    let second = (ms_of_day % 60_000) / 1_000;
    let milli = ms_of_day % 1_000;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z")
}

/// Days-since-epoch → (year, month, day), Howard Hinnant's `civil_from_days`.
const fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

/// The job store. Borrows the driver — the facade owns the [`SqlDriver`] and
/// hands out short-lived store views.
pub struct JobStore<'a> {
    sql: &'a SqlDriver,
}

impl<'a> JobStore<'a> {
    #[must_use]
    pub const fn new(sql: &'a SqlDriver) -> Self {
        Self { sql }
    }

    /// Insert a new job, or — when `idempotency_key` is set and a row already
    /// exists for `(app_id, tenant_id, job_type, idempotency_key)` — return
    /// the existing row unchanged. The idempotency dedupe applies across ALL
    /// states: re-enqueueing a completed job with the same key returns the
    /// completed row, NOT a fresh ready row. Callers that want to retry a
    /// completed job should pick a new idempotency key.
    pub async fn enqueue(&self, input: EnqueueInput, now_ms: i64) -> Result<JobRow, StoreError> {
        let app_id = input.app_id.as_deref().unwrap_or(DEFAULT_APP_ID);

        if let Some(key) = input.idempotency_key.as_deref() {
            let existing = self
                .find_by_idempotency_key(&input.tenant_id, &input.job_type, key, app_id)
                .await?;
            if let Some(existing) = existing {
                return Ok(existing);
            }
        }

        let now = epoch_ms_to_iso(now_ms);
        let available_at = input.available_at.clone().unwrap_or_else(|| now.clone());
        let max_attempts = input.max_attempts.unwrap_or(5);
        let packed = encode_packed(&input.payload)?;

        // TS uses `sql.run` and reads `lastInsertRowid`; here the `RETURNING
        // id` row is read directly (the dialect-portable path — PG callers
        // need the returned row anyway).
        let returned = self
            .sql
            .get(
                "INSERT INTO jobs (
            app_id, tenant_id, job_type, packed, status, created_at,
            available_at, max_attempts, attempt_count, idempotency_key
          ) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, 0, ?)
          RETURNING id",
                &[
                    SqlValue::from(app_id),
                    SqlValue::from(input.tenant_id.as_str()),
                    SqlValue::from(input.job_type.as_str()),
                    SqlValue::from(packed),
                    SqlValue::from(now.as_str()),
                    SqlValue::from(available_at.as_str()),
                    SqlValue::from(max_attempts),
                    SqlValue::from(input.idempotency_key.clone()),
                ],
            )
            .await?;
        let id = returned
            .and_then(|row| row.i64("id"))
            .ok_or_else(|| StoreError::store("jobs.enqueue: INSERT returned no id"))?;

        let row = self.get_by_id(id, None, None).await?;
        row.ok_or_else(|| StoreError::store(format!("jobs.enqueue: inserted row {id} not found")))
    }

    /// Atomically claim up to `limit` ready jobs whose `available_at <= now`.
    /// Uses `UPDATE ... WHERE id IN (SELECT ... LIMIT n) RETURNING *` so two
    /// workers polling concurrently each see a disjoint slice; the
    /// bookkeeping (status = 'running', claimed_at, claimed_by,
    /// attempt_count += 1) is applied in the same statement.
    /// `attempt_count` increments AT CLAIM time.
    pub async fn claim(
        &self,
        worker_id: &str,
        job_type: Option<&str>,
        limit: i64,
        app_id: Option<&str>,
        now_ms: i64,
    ) -> Result<Vec<JobRow>, StoreError> {
        let now = epoch_ms_to_iso(now_ms);
        let mut params = vec![
            SqlValue::from(now.as_str()),
            SqlValue::from(worker_id),
            SqlValue::from(now.as_str()),
        ];
        let mut type_clause = "";
        if let Some(job_type) = job_type {
            type_clause = "AND job_type = ?";
            params.push(SqlValue::from(job_type));
        }
        // Per-app dispatch (FR-153): when an app_id is supplied, a worker
        // claims ONLY that app's ready jobs. Omitting it (the single-app
        // default) claims across all apps.
        let mut app_clause = "";
        if let Some(app_id) = app_id {
            app_clause = "AND app_id = ?";
            params.push(SqlValue::from(app_id));
        }
        params.push(SqlValue::from(limit));

        // Multi-node safety (FR-28): Postgres needs `FOR UPDATE SKIP LOCKED`
        // so concurrent claimers take disjoint sets; SQLite serializes
        // writers, so it needs (and has) no row-lock clause.
        let lock_clause = if self.sql.dialect() == SqlDialect::Postgres {
            "FOR UPDATE SKIP LOCKED"
        } else {
            ""
        };
        let sql = format!(
            "UPDATE jobs SET
            status = 'running',
            claimed_at = ?,
            claimed_by = ?,
            attempt_count = attempt_count + 1
          WHERE id IN (
            SELECT id FROM jobs
            WHERE status = 'ready' AND available_at <= ? {type_clause} {app_clause}
            ORDER BY available_at ASC, id ASC
            LIMIT ?
            {lock_clause}
          )
          RETURNING *"
        );
        let rows = self.sql.all(&sql, &params).await?;
        rows.iter().map(map_row).collect()
    }

    /// Mark a job completed. Idempotent — re-completing an already-completed
    /// job is a no-op; re-completing a dead-lettered job is rejected (the
    /// `status != 'dead_lettered'` guard). When `result` is given, `packed`
    /// is OVERWRITTEN with the encoded result so operators can inspect it —
    /// terminal state means the input payload is no longer interesting.
    pub async fn complete(
        &self,
        job_id: i64,
        result: Option<&Value>,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        let now = epoch_ms_to_iso(now_ms);
        if let Some(result) = result {
            self.sql
                .run(
                    "UPDATE jobs SET status = 'completed', completed_at = ?, packed = ?
            WHERE id = ? AND status != 'dead_lettered'",
                    &[
                        SqlValue::from(now.as_str()),
                        SqlValue::from(encode_packed(result)?),
                        SqlValue::from(job_id),
                    ],
                )
                .await?;
            return Ok(());
        }
        self.sql
            .run(
                "UPDATE jobs SET status = 'completed', completed_at = ?
          WHERE id = ? AND status != 'dead_lettered'",
                &[SqlValue::from(now.as_str()), SqlValue::from(job_id)],
            )
            .await?;
        Ok(())
    }

    /// Mark a job failed. If `retryable` and the attempt budget isn't
    /// exhausted, the row is re-armed for a future claim with exponential
    /// backoff (`available_at = now + backoff(attempt_count)`, claimed_*
    /// cleared). Otherwise it transitions to `dead_lettered` (both
    /// `dead_lettered_at` and `failed_at` set; claimed_* NOT cleared).
    ///
    /// `attempt_count` was already incremented by [`Self::claim`], so the
    /// budget check compares the post-claim count against `max_attempts`.
    /// A missing row is a silent no-op.
    pub async fn fail(
        &self,
        job_id: i64,
        error_code: &str,
        error_message: &str,
        retryable: bool,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        let Some(row) = self.get_by_id(job_id, None, None).await? else {
            return Ok(());
        };
        let now = epoch_ms_to_iso(now_ms);
        if retryable && row.attempt_count < row.max_attempts {
            let next_available = epoch_ms_to_iso(now_ms + job_backoff_ms(row.attempt_count));
            self.sql
                .run(
                    "UPDATE jobs SET
              status = 'ready',
              available_at = ?,
              failed_at = ?,
              last_error_code = ?,
              last_error_message = ?,
              claimed_at = NULL,
              claimed_by = NULL
            WHERE id = ?",
                    &[
                        SqlValue::from(next_available.as_str()),
                        SqlValue::from(now.as_str()),
                        SqlValue::from(error_code),
                        SqlValue::from(error_message),
                        SqlValue::from(job_id),
                    ],
                )
                .await?;
            return Ok(());
        }
        self.sql
            .run(
                "UPDATE jobs SET
            status = 'dead_lettered',
            dead_lettered_at = ?,
            failed_at = ?,
            last_error_code = ?,
            last_error_message = ?
          WHERE id = ?",
                &[
                    SqlValue::from(now.as_str()),
                    SqlValue::from(now.as_str()),
                    SqlValue::from(error_code),
                    SqlValue::from(error_message),
                    SqlValue::from(job_id),
                ],
            )
            .await?;
        Ok(())
    }

    /// Admin introspection list: optional equality filters, newest first
    /// (`ORDER BY id DESC`), default limit 100.
    pub async fn list(&self, filter: &ListJobsFilter) -> Result<Vec<JobRow>, StoreError> {
        let mut where_clauses: Vec<&str> = Vec::new();
        let mut params: Vec<SqlValue> = Vec::new();
        if let Some(tenant_id) = filter.tenant_id.as_deref() {
            where_clauses.push("tenant_id = ?");
            params.push(SqlValue::from(tenant_id));
        }
        if let Some(app_id) = filter.app_id.as_deref() {
            where_clauses.push("app_id = ?");
            params.push(SqlValue::from(app_id));
        }
        if let Some(status) = filter.status {
            where_clauses.push("status = ?");
            params.push(SqlValue::from(status.as_str()));
        }
        if let Some(job_type) = filter.job_type.as_deref() {
            where_clauses.push("job_type = ?");
            params.push(SqlValue::from(job_type));
        }
        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };
        let limit = filter.limit.unwrap_or(100);
        params.push(SqlValue::from(limit));
        let sql = format!(
            "SELECT * FROM jobs {where_sql}
          ORDER BY id DESC
          LIMIT ?"
        );
        let rows = self.sql.all(&sql, &params).await?;
        rows.iter().map(map_row).collect()
    }

    /// Single-row lookup, optionally scoped to a tenant and/or app partition.
    pub async fn get_by_id(
        &self,
        job_id: i64,
        tenant_id: Option<&str>,
        app_id: Option<&str>,
    ) -> Result<Option<JobRow>, StoreError> {
        let mut params = vec![SqlValue::from(job_id)];
        let mut where_sql = String::from("id = ?");
        if let Some(tenant_id) = tenant_id {
            where_sql.push_str(" AND tenant_id = ?");
            params.push(SqlValue::from(tenant_id));
        }
        if let Some(app_id) = app_id {
            where_sql.push_str(" AND app_id = ?");
            params.push(SqlValue::from(app_id));
        }
        let sql = format!("SELECT * FROM jobs WHERE {where_sql} LIMIT 1");
        let row = self.sql.get(&sql, &params).await?;
        row.as_ref().map(map_row).transpose()
    }

    /// Snapshot of row counts by status, plus a synthetic `failed` bucket
    /// counting rows whose `last_error_code` is populated regardless of
    /// status. Surface used by `/_frick/inspect/jobs`.
    pub async fn counts_by_status(&self) -> Result<JobCounts, StoreError> {
        let mut counts = JobCounts::default();
        let rows = self
            .sql
            .all(
                "SELECT status, COUNT(*) AS count FROM jobs GROUP BY status",
                &[],
            )
            .await?;
        for row in rows {
            let count = row.i64("count").unwrap_or(0);
            match row.text("status").and_then(JobStatus::parse) {
                Some(JobStatus::Ready) => counts.ready = count,
                Some(JobStatus::Running) => counts.running = count,
                Some(JobStatus::Completed) => counts.completed = count,
                Some(JobStatus::DeadLettered) => counts.dead_lettered = count,
                None => {}
            }
        }
        let failed = self
            .sql
            .get(
                "SELECT COUNT(*) AS count FROM jobs WHERE last_error_code IS NOT NULL",
                &[],
            )
            .await?;
        counts.failed = failed.and_then(|row| row.i64("count")).unwrap_or(0);
        Ok(counts)
    }

    /// Legacy single-tenant pop (`store.nextJob(type)`): claim 1 with worker
    /// id `legacy:<tenantId>`, returning the thin `{id, name, value}` view.
    pub async fn next(
        &self,
        tenant_id: &str,
        job_type: &str,
        app_id: Option<&str>,
        now_ms: i64,
    ) -> Result<Option<StoredJob>, StoreError> {
        let app_id = app_id.unwrap_or(DEFAULT_APP_ID);
        let worker_id = format!("legacy:{tenant_id}");
        let claimed = self
            .claim(&worker_id, Some(job_type), 1, Some(app_id), now_ms)
            .await?;
        Ok(claimed.into_iter().next().map(|row| StoredJob {
            id: row.id,
            name: row.job_type,
            value: row.payload,
        }))
    }

    async fn find_by_idempotency_key(
        &self,
        tenant_id: &str,
        job_type: &str,
        idempotency_key: &str,
        app_id: &str,
    ) -> Result<Option<JobRow>, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT * FROM jobs
          WHERE app_id = ? AND tenant_id = ? AND job_type = ? AND idempotency_key = ?
          LIMIT 1",
                &[
                    SqlValue::from(app_id),
                    SqlValue::from(tenant_id),
                    SqlValue::from(job_type),
                    SqlValue::from(idempotency_key),
                ],
            )
            .await?;
        row.as_ref().map(map_row).transpose()
    }
}

/// TS `mapRow` (`job-store.ts:438-460`): numbers through `Number(...)`,
/// nullable columns become absent properties (TS truthiness — empty strings
/// also map to `None`), `app_id ?? DEFAULT_APP_ID`.
fn map_row(row: &SqlRow) -> Result<JobRow, StoreError> {
    let status_text = required_text(row, "status")?;
    let status = JobStatus::parse(&status_text).ok_or_else(|| {
        StoreError::store(format!("jobs.map_row: unknown status '{status_text}'"))
    })?;
    let packed = row
        .blob("packed")
        .ok_or_else(|| StoreError::store("jobs.map_row: missing column 'packed'"))?;
    Ok(JobRow {
        id: required_i64(row, "id")?,
        tenant_id: required_text(row, "tenant_id")?,
        app_id: optional_text(row, "app_id").unwrap_or_else(|| DEFAULT_APP_ID.to_string()),
        job_type: required_text(row, "job_type")?,
        payload: decode_packed(packed)?,
        status,
        attempt_count: required_i64(row, "attempt_count")?,
        max_attempts: required_i64(row, "max_attempts")?,
        available_at: required_text(row, "available_at")?,
        created_at: required_text(row, "created_at")?,
        claimed_at: optional_text(row, "claimed_at"),
        claimed_by: optional_text(row, "claimed_by"),
        completed_at: optional_text(row, "completed_at"),
        failed_at: optional_text(row, "failed_at"),
        dead_lettered_at: optional_text(row, "dead_lettered_at"),
        idempotency_key: optional_text(row, "idempotency_key"),
        last_error_code: optional_text(row, "last_error_code"),
        last_error_message: optional_text(row, "last_error_message"),
    })
}

fn required_text(row: &SqlRow, name: &str) -> Result<String, StoreError> {
    row.text(name)
        .map(ToString::to_string)
        .ok_or_else(|| StoreError::store(format!("jobs.map_row: missing column '{name}'")))
}

fn required_i64(row: &SqlRow, name: &str) -> Result<i64, StoreError> {
    row.i64(name)
        .ok_or_else(|| StoreError::store(format!("jobs.map_row: missing column '{name}'")))
}

/// TS truthiness: NULL and `""` both map to an absent property.
fn optional_text(row: &SqlRow, name: &str) -> Option<String> {
    row.text(name)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Effective post-migration `jobs` schema (map 03 §5; migrations 0001 +
    /// 0003 + 0006 + 0021 + 0022). The crate's migration runner is being
    /// written in a parallel task, so the tests pin the effective DDL here.
    const JOBS_TEST_SCHEMA: &str = "
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_type TEXT NOT NULL,
        packed BLOB NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT '_default',
        available_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
        max_attempts INTEGER NOT NULL DEFAULT 5,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        claimed_at TEXT,
        claimed_by TEXT,
        completed_at TEXT,
        failed_at TEXT,
        dead_lettered_at TEXT,
        idempotency_key TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        app_id TEXT NOT NULL DEFAULT '_default'
      );
      CREATE INDEX idx_jobs_tenant ON jobs (tenant_id, job_type, status, id);
      CREATE INDEX idx_jobs_status_available_at ON jobs (tenant_id, status, available_at);
      CREATE UNIQUE INDEX idx_jobs_idempotency_key
        ON jobs (app_id, tenant_id, job_type, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX idx_jobs_app_tenant ON jobs (app_id, tenant_id, job_type, status, id);
      CREATE INDEX idx_jobs_app_tenant_status_available_at
        ON jobs (app_id, tenant_id, status, available_at);
    ";

    const NOW_MS: i64 = 1_000_000_000_000; // 2001-09-09T01:46:40.000Z

    async fn jobs_driver() -> SqlDriver {
        let driver = SqlDriver::open_sqlite(":memory:").unwrap();
        driver.exec(JOBS_TEST_SCHEMA).await.unwrap();
        driver
    }

    fn payload(entries: &[(&str, Value)]) -> Value {
        Value::Map(
            entries
                .iter()
                .map(|(key, value)| ((*key).into(), value.clone()))
                .collect(),
        )
    }

    fn enqueue_input(tenant_id: &str, job_type: &str, value: Value) -> EnqueueInput {
        EnqueueInput {
            tenant_id: tenant_id.to_string(),
            app_id: None,
            job_type: job_type.to_string(),
            payload: value,
            idempotency_key: None,
            available_at: None,
            max_attempts: None,
        }
    }

    #[tokio::test]
    async fn round_trips_enqueue_claim_complete() {
        let driver = jobs_driver().await;
        let store = JobStore::new(&driver);
        let row = store
            .enqueue(
                enqueue_input("_default", "TestJob", payload(&[("hello", "world".into())])),
                NOW_MS,
            )
            .await
            .unwrap();
        assert_eq!(row.status, JobStatus::Ready);
        assert_eq!(row.attempt_count, 0);
        assert_eq!(row.max_attempts, 5, "default max_attempts");
        assert_eq!(row.app_id, DEFAULT_APP_ID);
        assert_eq!(row.created_at, "2001-09-09T01:46:40.000Z");
        assert_eq!(
            row.available_at, row.created_at,
            "available_at defaults to now"
        );

        let claimed = store
            .claim("worker-a", None, DEFAULT_CLAIM_LIMIT, None, NOW_MS)
            .await
            .unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].id, row.id);
        assert_eq!(claimed[0].status, JobStatus::Running);
        assert_eq!(claimed[0].claimed_by.as_deref(), Some("worker-a"));
        assert_eq!(
            claimed[0].attempt_count, 1,
            "attempt_count increments at claim"
        );

        let result = payload(&[("ok", true.into())]);
        store
            .complete(row.id, Some(&result), NOW_MS + 5)
            .await
            .unwrap();
        let done = store.get_by_id(row.id, None, None).await.unwrap().unwrap();
        assert_eq!(done.status, JobStatus::Completed);
        assert!(done.completed_at.is_some());
        assert_eq!(
            done.payload, result,
            "complete OVERWRITES packed with the result"
        );
    }

    #[tokio::test]
    async fn complete_without_result_preserves_payload_and_is_idempotent() {
        let driver = jobs_driver().await;
        let store = JobStore::new(&driver);
        let original = payload(&[("keep", "me".into())]);
        let row = store
            .enqueue(
                enqueue_input("_default", "TestJob", original.clone()),
                NOW_MS,
            )
            .await
            .unwrap();
        store
            .claim("worker-a", None, 10, None, NOW_MS)
            .await
            .unwrap();
        store.complete(row.id, None, NOW_MS + 1).await.unwrap();
        let done = store.get_by_id(row.id, None, None).await.unwrap().unwrap();
        assert_eq!(done.payload, original);

        // Re-completing keeps the row completed: the SQL guard only rejects
        // dead-lettered rows, so the UPDATE re-runs and refreshes
        // completed_at — exactly like the TS statement.
        store.complete(row.id, None, NOW_MS + 99_999).await.unwrap();
        let again = store.get_by_id(row.id, None, None).await.unwrap().unwrap();
        assert_eq!(again.status, JobStatus::Completed);
        assert_eq!(
            again.completed_at.as_deref(),
            Some(epoch_ms_to_iso(NOW_MS + 99_999).as_str())
        );
    }

    #[tokio::test]
    async fn complete_rejects_dead_lettered_rows() {
        let driver = jobs_driver().await;
        let store = JobStore::new(&driver);
        let row = store
            .enqueue(enqueue_input("_default", "TestJob", payload(&[])), NOW_MS)
            .await
            .unwrap();
        store
            .claim("worker-a", None, 10, None, NOW_MS)
            .await
            .unwrap();
        store
            .fail(row.id, "test.fatal", "no retry", false, NOW_MS)
            .await
            .unwrap();
        store.complete(row.id, None, NOW_MS + 1).await.unwrap();
        let after = store.get_by_id(row.id, None, None).await.unwrap().unwrap();
        assert_eq!(
            after.status,
            JobStatus::DeadLettered,
            "guard keeps dead-lettered terminal"
        );
    }

    #[tokio::test]
    async fn same_idempotency_key_returns_the_existing_row() {
        let driver = jobs_driver().await;
        let store = JobStore::new(&driver);
        let mut first_input =
            enqueue_input("_default", "PushNotification", payload(&[("x", 1.into())]));
        first_input.idempotency_key = Some("abc".to_string());
        let first = store.enqueue(first_input, NOW_MS).await.unwrap();

        let mut second_input =
            enqueue_input("_default", "PushNotification", payload(&[("x", 2.into())]));
        second_input.idempotency_key = Some("abc".to_string());
        let second = store.enqueue(second_input, NOW_MS + 1).await.unwrap();

        assert_eq!(second.id, first.id);
        // The payload from the first enqueue wins — second call returns existing row.
        assert_eq!(second.payload, payload(&[("x", 1.into())]));
    }

    #[tokio::test]
    async fn idempotency_dedupe_applies_across_completed_state() {
        let driver = jobs_driver().await;
        let store = JobStore::new(&driver);
        let mut input = enqueue_input("_default", "T", payload(&[]));
        input.idempotency_key = Some("done-once".to_string());
        let row = store.enqueue(input.clone(), NOW_MS).await.unwrap();
        store
            .claim("worker-a", None, 10, None, NOW_MS)
            .await
            .unwrap();
        store.complete(row.id, None, NOW_MS).await.unwrap();

        let again = store.enqueue(input, NOW_MS + 60_000).await.unwrap();
        assert_eq!(again.id, row.id);
        assert_eq!(
            again.status,
            JobStatus::Completed,
            "dedupe returns the terminal row as-is"
        );
    }

    #[tokio::test]
    async fn idempotency_keys_are_scoped_per_app() {
        let driver = jobs_driver().await;
        let store = JobStore::new(&driver);
        let mut a = enqueue_input("_default", "send", payload(&[]));
        a.app_id = Some("app-a".to_string());
        a.idempotency_key = Some("k-1".to_string());
        let mut b = enqueue_input("_default", "send", payload(&[]));
        b.app_id = Some("app-b".to_string());
        b.idempotency_key = Some("k-1".to_string());

        let row_a = store.enqueue(a, NOW_MS).await.unwrap();
        let row_b = store.enqueue(b, NOW_MS).await.unwrap();
        assert_ne!(
            row_a.id, row_b.id,
            "0022: same key in two apps never collides"
        );
        assert_eq!(row_a.app_id, "app-a");
        assert_eq!(row_b.app_id, "app-b");
    }

    #[tokio::test]
    async fn no_idempotency_key_means_no_dedupe() {
        let driver = jobs_driver().await;
        let store = JobStore::new(&driver);
        let first = store
            .enqueue(enqueue_input("_default", "T", payload(&[])), NOW_MS)
            .await
            .unwrap();
        let second = store
            .enqueue(enqueue_input("_default", "T", payload(&[])), NOW_MS)
            .await
            .unwrap();
        assert_ne!(first.id, second.id);
    }

    #[tokio::test]
    async fn claim_slices_are_disjoint() {
        let driver = jobs_driver().await;
        let store = JobStore::new(&driver);
        for i in 0..10 {
            store
                .enqueue(
                    enqueue_input("_default", "TestJob", payload(&[("i", i.into())])),
                    NOW_MS,
                )
                .await
                .unwrap();
        }
        let a = store
            .claim("worker-a", None, 6, None, NOW_MS)
            .await
            .unwrap();
        let b = store
            .claim("worker-b", None, 6, None, NOW_MS)
            .await
            .unwrap();
        let mut ids: Vec<i64> = a.iter().chain(b.iter()).map(|row| row.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), a.len() + b.len(), "no overlap");
        assert_eq!(a.len() + b.len(), 10);
    }

    #[tokio::test]
    async fn claim_respects_the_available_at_gate_and_ordering() {
        let driver = jobs_driver().await;
        let store = JobStore::new(&driver);
        let mut later = enqueue_input("_default", "T", payload(&[]));
        later.available_at = Some(epoch_ms_to_iso(NOW_MS + 60_000));
        let future_row = store.enqueue(later, NOW_MS).await.unwrap();
        let mut earlier = enqueue_input("_default", "T", payload(&[]));
        earlier.available_at = Some(epoch_ms_to_iso(NOW_MS - 60_000));
        let past_row = store.enqueue(earlier, NOW_MS).await.unwrap();

        // Only the past-due row is claimable now; subquery orders by
        // available_at ASC, id ASC.
        let claimed = store
            .claim("worker-a", None, 10, None, NOW_MS)
            .await
            .unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].id, past_row.id);

        // Once the clock reaches its available_at, the future row claims too.
        let claimed = store
            .claim("worker-a", None, 10, None, NOW_MS + 60_000)
            .await
            .unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].id, future_row.id);
    }

    #[tokio::test]
    async fn claim_filters_by_job_type_and_app() {
        let driver = jobs_driver().await;
        let store = JobStore::new(&driver);
        let mut for_a = enqueue_input("_default", "Echo", payload(&[("tag", "from-a".into())]));
        for_a.app_id = Some("app-a".to_string());
        let a_row = store.enqueue(for_a, NOW_MS).await.unwrap();
        let mut for_b = enqueue_input("_default", "Echo", payload(&[("tag", "from-b".into())]));
        for_b.app_id = Some("app-b".to_string());
        let b_row = store.enqueue(for_b, NOW_MS).await.unwrap();
        store
            .enqueue(enqueue_input("_default", "Other", payload(&[])), NOW_MS)
            .await
            .unwrap();

        // App filter: a worker claiming for app-a never sees app-b's jobs.
        let claimed = store
            .claim("worker-a", Some("Echo"), 10, Some("app-a"), NOW_MS)
            .await
            .unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].id, a_row.id);

        // Type filter: "Echo" leaves the "Other" job alone.
        let claimed = store
            .claim("worker-b", Some("Echo"), 10, None, NOW_MS)
            .await
            .unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].id, b_row.id);

        let ready = store
            .list(&ListJobsFilter {
                status: Some(JobStatus::Ready),
                ..ListJobsFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].job_type, "Other");
    }

    #[tokio::test]
    async fn retryable_failure_rearms_with_exponential_backoff() {
        let driver = jobs_driver().await;
        let store = JobStore::new(&driver);
        let mut input = enqueue_input("_default", "TestJob", payload(&[]));
        input.max_attempts = Some(3);
        let row = store.enqueue(input, NOW_MS).await.unwrap();
        let claimed = store
            .claim("worker-a", None, 10, None, NOW_MS)
            .await
            .unwrap();
        assert_eq!(claimed[0].attempt_count, 1);

        store
            .fail(claimed[0].id, "test.transient", "boom", true, NOW_MS)
            .await
            .unwrap();
        let after = store.get_by_id(row.id, None, None).await.unwrap().unwrap();
        assert_eq!(after.status, JobStatus::Ready);
        assert_eq!(after.last_error_code.as_deref(), Some("test.transient"));
        assert_eq!(after.last_error_message.as_deref(), Some("boom"));
        assert_eq!(after.attempt_count, 1, "fail never touches attempt_count");
        assert_eq!(after.claimed_at, None);
        assert_eq!(after.claimed_by, None);
        assert!(after.failed_at.is_some());
        // available_at = now + jobBackoffMs(1), deterministic with an injected clock.
        assert_eq!(
            after.available_at,
            epoch_ms_to_iso(NOW_MS + job_backoff_ms(1))
        );

        // Backed off: not claimable now, claimable once the backoff elapses.
        assert!(
            store
                .claim("worker-a", None, 10, None, NOW_MS)
                .await
                .unwrap()
                .is_empty()
        );
        let reclaimed = store
            .claim("worker-a", None, 10, None, NOW_MS + job_backoff_ms(1))
            .await
            .unwrap();
        assert_eq!(reclaimed.len(), 1);
        assert_eq!(reclaimed[0].attempt_count, 2);
    }

    #[tokio::test]
    async fn non_retryable_failure_dead_letters_immediately() {
        let driver = jobs_driver().await;
        let store = JobStore::new(&driver);
        let mut input = enqueue_input("_default", "TestJob", payload(&[]));
        input.max_attempts = Some(10);
        let row = store.enqueue(input, NOW_MS).await.unwrap();
        store
            .claim("worker-a", None, 10, None, NOW_MS)
            .await
            .unwrap();
        store
            .fail(row.id, "test.fatal", "no retry", false, NOW_MS)
            .await
            .unwrap();
        let after = store.get_by_id(row.id, None, None).await.unwrap().unwrap();
        assert_eq!(after.status, JobStatus::DeadLettered);
        assert!(after.dead_lettered_at.is_some());
        assert!(after.failed_at.is_some());
        assert_eq!(after.last_error_code.as_deref(), Some("test.fatal"));
        assert!(
            after.claimed_by.is_some(),
            "dead-letter path does NOT clear claimed_*"
        );
    }

    #[tokio::test]
    async fn dead_letters_when_max_attempts_is_reached() {
        let driver = jobs_driver().await;
        let store = JobStore::new(&driver);
        let mut input = enqueue_input("_default", "TestJob", payload(&[]));
        input.max_attempts = Some(1);
        let row = store.enqueue(input, NOW_MS).await.unwrap();
        let claimed = store
            .claim("worker-a", Some("TestJob"), 1, None, NOW_MS)
            .await
            .unwrap();
        assert_eq!(claimed[0].attempt_count, 1);
        store
            .fail(claimed[0].id, "test.retry", "exhausted", true, NOW_MS)
            .await
            .unwrap();
        let after = store.get_by_id(row.id, None, None).await.unwrap().unwrap();
        assert_eq!(
            after.status,
            JobStatus::DeadLettered,
            "retryable but budget exhausted"
        );
    }

    #[tokio::test]
    async fn fail_on_a_missing_row_is_a_silent_no_op() {
        let driver = jobs_driver().await;
        let store = JobStore::new(&driver);
        store
            .fail(12_345, "test", "missing", true, NOW_MS)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn list_and_get_by_id_respect_tenant_and_app_scopes() {
        let driver = jobs_driver().await;
        let store = JobStore::new(&driver);
        store
            .enqueue(enqueue_input("tenant-a", "T", payload(&[])), NOW_MS)
            .await
            .unwrap();
        store
            .enqueue(enqueue_input("tenant-b", "T", payload(&[])), NOW_MS)
            .await
            .unwrap();

        let tenant_a = ListJobsFilter {
            tenant_id: Some("tenant-a".to_string()),
            ..ListJobsFilter::default()
        };
        let tenant_b = ListJobsFilter {
            tenant_id: Some("tenant-b".to_string()),
            ..ListJobsFilter::default()
        };
        assert_eq!(store.list(&tenant_a).await.unwrap().len(), 1);
        assert_eq!(store.list(&tenant_b).await.unwrap().len(), 1);
        let a_row = store.list(&tenant_a).await.unwrap().remove(0);
        assert_eq!(a_row.tenant_id, "tenant-a");

        // getById with a tenant filter only finds within that tenant.
        assert!(
            store
                .get_by_id(a_row.id, Some("tenant-b"), None)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store
                .get_by_id(a_row.id, Some("tenant-a"), None)
                .await
                .unwrap()
                .unwrap()
                .id,
            a_row.id
        );
        // ... same for the app filter.
        assert!(
            store
                .get_by_id(a_row.id, None, Some("app-x"))
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store
                .get_by_id(a_row.id, None, Some(DEFAULT_APP_ID))
                .await
                .unwrap()
                .unwrap()
                .id,
            a_row.id
        );
    }

    #[tokio::test]
    async fn list_orders_newest_first_and_applies_the_limit() {
        let driver = jobs_driver().await;
        let store = JobStore::new(&driver);
        for i in 0..5 {
            store
                .enqueue(
                    enqueue_input("_default", "T", payload(&[("i", i.into())])),
                    NOW_MS,
                )
                .await
                .unwrap();
        }
        let rows = store
            .list(&ListJobsFilter {
                limit: Some(3),
                ..ListJobsFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(rows.len(), 3);
        let ids: Vec<i64> = rows.iter().map(|row| row.id).collect();
        assert_eq!(ids, vec![5, 4, 3], "ORDER BY id DESC");
    }

    #[tokio::test]
    async fn counts_by_status_exposes_a_per_state_snapshot() {
        let driver = jobs_driver().await;
        let store = JobStore::new(&driver);
        store
            .enqueue(enqueue_input("_default", "T", payload(&[])), NOW_MS)
            .await
            .unwrap();
        store
            .enqueue(enqueue_input("_default", "T", payload(&[])), NOW_MS)
            .await
            .unwrap();
        store
            .enqueue(enqueue_input("_default", "T", payload(&[])), NOW_MS)
            .await
            .unwrap();
        let claimed = store
            .claim("worker-a", Some("T"), 2, None, NOW_MS)
            .await
            .unwrap();
        store.complete(claimed[0].id, None, NOW_MS).await.unwrap();
        store
            .fail(claimed[1].id, "test.fatal", "x", false, NOW_MS)
            .await
            .unwrap();

        let counts = store.counts_by_status().await.unwrap();
        assert_eq!(counts.completed, 1);
        assert_eq!(counts.dead_lettered, 1);
        assert_eq!(counts.ready, 1);
        assert_eq!(counts.running, 0);
        assert!(counts.failed >= 1, "synthetic bucket from last_error_code");
    }

    #[tokio::test]
    async fn legacy_next_claims_one_job_with_the_legacy_worker_id() {
        let driver = jobs_driver().await;
        let store = JobStore::new(&driver);
        let value = payload(&[("hello", "world".into())]);
        let row = store
            .enqueue(enqueue_input("_default", "TestJob", value.clone()), NOW_MS)
            .await
            .unwrap();

        let job = store
            .next("_default", "TestJob", None, NOW_MS)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(job.id, row.id);
        assert_eq!(job.name, "TestJob");
        assert_eq!(job.value, value);

        let claimed = store.get_by_id(row.id, None, None).await.unwrap().unwrap();
        assert_eq!(claimed.status, JobStatus::Running);
        assert_eq!(claimed.claimed_by.as_deref(), Some("legacy:_default"));

        assert!(
            store
                .next("_default", "TestJob", None, NOW_MS)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn backoff_doubles_per_attempt_and_caps_at_five_minutes() {
        assert_eq!(job_backoff_ms(1), 60_000);
        assert_eq!(job_backoff_ms(2), 120_000);
        assert_eq!(job_backoff_ms(3), 240_000);
        // Cap kicks in around attempt 4 (480_000 > 300_000).
        assert_eq!(job_backoff_ms(4), 300_000);
        assert_eq!(job_backoff_ms(10), 300_000);
        // Attempts below 1 collapse to the base delay.
        assert_eq!(job_backoff_ms(0), 60_000);
        assert_eq!(job_backoff_ms(-7), 60_000);
        // No overflow for absurd attempt counts.
        assert_eq!(job_backoff_ms(i64::MAX), 300_000);
    }

    #[test]
    fn recurring_window_keys_match_the_ts_shape() {
        let interval_ms = 300_000;
        let window = recurring_window_start(NOW_MS, interval_ms);
        assert_eq!(window, 999_999_900_000);
        assert_eq!(
            recurring_idempotency_key("test", None, "_default", window),
            "recurring:test:_default:999999900000"
        );
        // The app segment appears ONLY when the target carries an appId (FR-153).
        assert_eq!(
            recurring_idempotency_key("poll", Some("app-a"), "tenant-1", window),
            "recurring:poll:app-a:tenant-1:999999900000"
        );
        // Ticks within the same window share a key; the next window differs.
        assert_eq!(recurring_window_start(NOW_MS + 1_000, interval_ms), window);
        assert_eq!(
            recurring_window_start(window + interval_ms, interval_ms),
            window + interval_ms
        );
    }

    #[tokio::test]
    async fn recurring_window_keys_dedupe_through_enqueue() {
        let driver = jobs_driver().await;
        let store = JobStore::new(&driver);
        let interval_ms = 60_000;
        let window = recurring_window_start(NOW_MS, interval_ms);
        let mut input = enqueue_input("_default", "my.job", payload(&[]));
        input.idempotency_key = Some(recurring_idempotency_key("test", None, "_default", window));
        input.available_at = Some(epoch_ms_to_iso(window));

        let first = store.enqueue(input.clone(), NOW_MS).await.unwrap();
        // A second tick in the same window is a no-op (same key → same row).
        let second = store.enqueue(input.clone(), NOW_MS + 1_000).await.unwrap();
        assert_eq!(second.id, first.id);

        // The next window mints a fresh key → a fresh row.
        let next_window = window + interval_ms;
        input.idempotency_key = Some(recurring_idempotency_key(
            "test",
            None,
            "_default",
            next_window,
        ));
        input.available_at = Some(epoch_ms_to_iso(next_window));
        let third = store.enqueue(input, next_window).await.unwrap();
        assert_ne!(third.id, first.id);
        assert_eq!(third.available_at, epoch_ms_to_iso(next_window));
    }

    #[test]
    fn epoch_ms_to_iso_matches_js_to_iso_string() {
        assert_eq!(epoch_ms_to_iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(epoch_ms_to_iso(NOW_MS), "2001-09-09T01:46:40.000Z");
        assert_eq!(
            epoch_ms_to_iso(1_700_000_000_123),
            "2023-11-14T22:13:20.123Z"
        );
        // Leap day.
        assert_eq!(
            epoch_ms_to_iso(1_582_934_400_000),
            "2020-02-29T00:00:00.000Z"
        );
    }
}
