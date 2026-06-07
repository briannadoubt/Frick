import { decode, encode } from "@msgpack/msgpack";
import type { PlainObject } from "@fricken/protocol";
import type { SqlDriver } from "./sql-driver.js";

/**
 * Lifecycle states for a background job row.
 *
 *   ready          → eligible to claim once `available_at <= now`
 *   running        → claimed by a worker; in-flight
 *   completed      → handler returned success
 *   dead_lettered  → handler exhausted retries or returned non-retryable failure
 *
 * Note: there is no separate `failed` terminal state in the schema — failures
 * either re-enqueue to `ready` (with backoff) or short-circuit to
 * `dead_lettered`. The `countsByStatus()` snapshot exposes a synthetic
 * `failed` bucket sourced from `last_error_*` for operator-facing summaries.
 */
export type JobStatus = "ready" | "running" | "completed" | "dead_lettered";

export interface JobRow {
  id: number;
  tenantId: string;
  jobType: string;
  payload: PlainObject;
  status: JobStatus;
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  createdAt: string;
  claimedAt?: string;
  claimedBy?: string;
  completedAt?: string;
  failedAt?: string;
  deadLetteredAt?: string;
  idempotencyKey?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

/**
 * Legacy single-row shape preserved for the {@link JobStore.next} helper. The
 * pre-lifecycle API returned a thin `{id, name, value}` view; existing
 * callers (and the test in `store.test.ts`) still depend on it. New code
 * should use the structured {@link JobRow} surface returned by `claim` /
 * `getById` / `list`.
 */
export interface StoredJob {
  id: number;
  name: string;
  value: PlainObject;
}

export interface EnqueueInput {
  tenantId: string;
  jobType: string;
  payload: unknown;
  idempotencyKey?: string;
  availableAt?: string;
  maxAttempts?: number;
}

export interface ListJobsFilter {
  tenantId?: string;
  status?: JobStatus;
  jobType?: string;
  limit?: number;
}

export interface JobCounts {
  ready: number;
  running: number;
  completed: number;
  dead_lettered: number;
  /** Synthetic: rows in any state whose `last_error_*` columns are populated. */
  failed: number;
}

/** Cap the exponential backoff at 5 minutes — matches the spec. */
const BACKOFF_CAP_MS = 5 * 60 * 1000;
/** Base backoff: 60s, doubled per attempt. */
const BACKOFF_BASE_MS = 60 * 1000;

interface RawJobRow {
  id: number;
  tenant_id: string;
  job_type: string;
  packed: Uint8Array;
  status: string;
  attempt_count: number;
  max_attempts: number;
  available_at: string;
  created_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
  completed_at: string | null;
  failed_at: string | null;
  dead_lettered_at: string | null;
  idempotency_key: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
}

/**
 * Compute the per-attempt backoff: `min(60s * 2^(attempt-1), 5m)`. Attempt
 * numbers below 1 collapse to the base delay. Exported for the worker tests
 * that want to assert backoff timing without re-deriving the formula.
 */
export function jobBackoffMs(attemptCount: number): number {
  const safe = Math.max(1, attemptCount);
  const raw = BACKOFF_BASE_MS * 2 ** (safe - 1);
  return Math.min(raw, BACKOFF_CAP_MS);
}

export class JobStore {
  constructor(private readonly sql: SqlDriver) {}

  /**
   * Insert a new job, or — when `idempotencyKey` is set and a row already
   * exists for `(tenant_id, job_type, idempotency_key)` — return the existing
   * row unchanged. The idempotency dedupe applies across all terminal states:
   * re-enqueueing a completed job with the same key returns the completed
   * row, NOT a fresh ready row. Callers that want to retry a completed job
   * should pick a new idempotency key.
   */
  async enqueue(input: EnqueueInput): Promise<JobRow>;
  /** @deprecated Legacy 3-arg form retained for the round-1 single-tenant facade. */
  async enqueue(tenantId: string, jobType: string, value: PlainObject): Promise<JobRow>;
  async enqueue(
    a: EnqueueInput | string,
    b?: string,
    c?: PlainObject,
  ): Promise<JobRow> {
    const input: EnqueueInput =
      typeof a === "string"
        ? { tenantId: a, jobType: b as string, payload: c as PlainObject }
        : a;

    if (input.idempotencyKey !== undefined) {
      const existing = await this.findByIdempotencyKey(
        input.tenantId,
        input.jobType,
        input.idempotencyKey,
      );
      if (existing) return existing;
    }

    const now = new Date().toISOString();
    const availableAt = input.availableAt ?? now;
    const maxAttempts = input.maxAttempts ?? 5;
    const packed = Buffer.from(encode(input.payload));

    const result = await this.sql.run(
      `INSERT INTO jobs (
            tenant_id, job_type, packed, status, created_at,
            available_at, max_attempts, attempt_count, idempotency_key
          ) VALUES (?, ?, ?, 'ready', ?, ?, ?, 0, ?)
          RETURNING id`,
      [
        input.tenantId,
        input.jobType,
        packed,
        now,
        availableAt,
        maxAttempts,
        input.idempotencyKey ?? null,
      ],
    );

    const id = Number(result.lastInsertRowid);
    const row = await this.getById(id);
    if (!row) {
      throw new Error(`jobs.enqueue: inserted row ${id} not found`);
    }
    return row;
  }

  /**
   * Atomically claim up to `limit` ready jobs whose `available_at <= now`.
   * Uses `UPDATE ... WHERE id IN (SELECT ... LIMIT n)` so two workers polling
   * concurrently each see a disjoint slice — SQLite serializes writes through
   * a single writer lock, so the SELECT inside the UPDATE is consistent with
   * the WHERE filter.
   *
   * The bookkeeping (status = 'running', claimed_at, claimed_by,
   * attempt_count += 1) is applied in the same statement; callers don't see
   * a window where a row is selected but not yet marked running.
   */
  async claim(workerId: string, jobType?: string, limit: number = 10): Promise<JobRow[]> {
    const now = new Date().toISOString();
    const params: Array<string | number> = [now, workerId, now];
    let typeClause = "";
    if (jobType !== undefined) {
      typeClause = "AND job_type = ?";
      params.push(jobType);
    }
    params.push(limit);

    // Multi-node safety (FR-28): on Postgres, two nodes running this claim
    // concurrently could otherwise select the same 'ready' rows in the
    // subquery and both flip them to 'running' (the outer `id IN (…)` re-check
    // does not re-test status). `FOR UPDATE SKIP LOCKED` makes each claimer
    // lock-and-take a disjoint set, skipping rows a peer already holds — the
    // canonical Postgres queue pattern. SQLite serializes writers on one
    // connection, so it needs (and has) no row-lock clause.
    const lockClause = this.sql.dialect === "postgres" ? "FOR UPDATE SKIP LOCKED" : "";
    // SQLite's `UPDATE ... RETURNING` lands in node:sqlite via .all().
    const rows = await this.sql.all<RawJobRow>(
      `UPDATE jobs SET
            status = 'running',
            claimed_at = ?,
            claimed_by = ?,
            attempt_count = attempt_count + 1
          WHERE id IN (
            SELECT id FROM jobs
            WHERE status = 'ready' AND available_at <= ? ${typeClause}
            ORDER BY available_at ASC, id ASC
            LIMIT ?
            ${lockClause}
          )
          RETURNING *`,
      params,
    );

    return rows.map((row) => mapRow(row));
  }

  /**
   * Mark a job completed. Idempotent — re-completing an already-completed job
   * is a no-op. Re-completing a dead-lettered job is rejected (caller error).
   */
  async complete(jobId: number, result?: unknown): Promise<void> {
    const now = new Date().toISOString();
    if (result !== undefined) {
      // Stash the result in `packed` so operators can inspect it. We
      // intentionally overwrite the payload rather than adding another
      // column — terminal state means the input is no longer interesting.
      await this.sql.run(
        `UPDATE jobs SET status = 'completed', completed_at = ?, packed = ?
            WHERE id = ? AND status != 'dead_lettered'`,
        [now, Buffer.from(encode(result as PlainObject)), jobId],
      );
      return;
    }
    await this.sql.run(
      `UPDATE jobs SET status = 'completed', completed_at = ?
          WHERE id = ? AND status != 'dead_lettered'`,
      [now, jobId],
    );
  }

  /**
   * Mark a job failed. If `retryable` and the attempt budget isn't exhausted,
   * the row is re-armed for a future claim with exponential backoff. Otherwise
   * it transitions to `dead_lettered` and stays there.
   *
   * `attempt_count` was already incremented by `claim`, so the budget check
   * compares the current `attempt_count` (post-claim) against `max_attempts`.
   */
  async fail(
    jobId: number,
    errorCode: string,
    errorMessage: string,
    retryable: boolean,
  ): Promise<void> {
    const row = await this.getById(jobId);
    if (!row) return;
    const now = new Date().toISOString();
    if (retryable && row.attemptCount < row.maxAttempts) {
      const nextAvailable = new Date(Date.now() + jobBackoffMs(row.attemptCount)).toISOString();
      await this.sql.run(
        `UPDATE jobs SET
              status = 'ready',
              available_at = ?,
              failed_at = ?,
              last_error_code = ?,
              last_error_message = ?,
              claimed_at = NULL,
              claimed_by = NULL
            WHERE id = ?`,
        [nextAvailable, now, errorCode, errorMessage, jobId],
      );
      return;
    }
    await this.sql.run(
      `UPDATE jobs SET
            status = 'dead_lettered',
            dead_lettered_at = ?,
            failed_at = ?,
            last_error_code = ?,
            last_error_message = ?
          WHERE id = ?`,
      [now, now, errorCode, errorMessage, jobId],
    );
  }

  async list(filter: ListJobsFilter = {}): Promise<JobRow[]> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.tenantId !== undefined) {
      where.push("tenant_id = ?");
      params.push(filter.tenantId);
    }
    if (filter.status !== undefined) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.jobType !== undefined) {
      where.push("job_type = ?");
      params.push(filter.jobType);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = filter.limit ?? 100;
    params.push(limit);
    const rows = await this.sql.all<RawJobRow>(
      `SELECT * FROM jobs ${whereSql}
          ORDER BY id DESC
          LIMIT ?`,
      params,
    );
    return rows.map((row) => mapRow(row));
  }

  async getById(jobId: number, tenantId?: string): Promise<JobRow | undefined> {
    const params: Array<string | number> = [jobId];
    let where = "id = ?";
    if (tenantId !== undefined) {
      where += " AND tenant_id = ?";
      params.push(tenantId);
    }
    const row = await this.sql.get<RawJobRow>(
      `SELECT * FROM jobs WHERE ${where} LIMIT 1`,
      params,
    );
    return row ? mapRow(row) : undefined;
  }

  /**
   * Snapshot of row counts by status, plus a synthetic `failed` bucket that
   * counts rows whose `last_error_code` is populated (regardless of status —
   * a dead-lettered or ready-after-retry row both qualify). Surface used by
   * `/_frick/inspect/jobs`.
   */
  async countsByStatus(): Promise<JobCounts> {
    const counts: JobCounts = {
      ready: 0,
      running: 0,
      completed: 0,
      dead_lettered: 0,
      failed: 0,
    };
    const rows = await this.sql.all<{ status: string; count: number }>(
      `SELECT status, COUNT(*) AS count FROM jobs GROUP BY status`,
    );
    for (const row of rows) {
      if (
        row.status === "ready" ||
        row.status === "running" ||
        row.status === "completed" ||
        row.status === "dead_lettered"
      ) {
        counts[row.status] = Number(row.count);
      }
    }
    const failed = await this.sql.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM jobs WHERE last_error_code IS NOT NULL`,
    );
    counts.failed = Number(failed!.count);
    return counts;
  }

  /**
   * Legacy single-tenant pop used by `store.nextJob(type)` and the
   * `store.test.ts` smoke test. Equivalent to a claim with no `claimedBy`
   * recorded — preserved so old call sites compile while the worker uses the
   * new lifecycle.
   */
  async next(tenantId: string, type: string): Promise<StoredJob | undefined> {
    const claimed = await this.claim(`legacy:${tenantId}`, type, 1);
    const row = claimed[0];
    if (!row) return undefined;
    return { id: row.id, name: row.jobType, value: row.payload };
  }

  private async findByIdempotencyKey(
    tenantId: string,
    jobType: string,
    idempotencyKey: string,
  ): Promise<JobRow | undefined> {
    const row = await this.sql.get<RawJobRow>(
      `SELECT * FROM jobs
          WHERE tenant_id = ? AND job_type = ? AND idempotency_key = ?
          LIMIT 1`,
      [tenantId, jobType, idempotencyKey],
    );
    return row ? mapRow(row) : undefined;
  }
}

function mapRow(row: RawJobRow): JobRow {
  const result: JobRow = {
    id: Number(row.id),
    tenantId: row.tenant_id,
    jobType: row.job_type,
    payload: decode(row.packed) as PlainObject,
    status: row.status as JobStatus,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    availableAt: row.available_at,
    createdAt: row.created_at,
  };
  if (row.claimed_at) result.claimedAt = row.claimed_at;
  if (row.claimed_by) result.claimedBy = row.claimed_by;
  if (row.completed_at) result.completedAt = row.completed_at;
  if (row.failed_at) result.failedAt = row.failed_at;
  if (row.dead_lettered_at) result.deadLetteredAt = row.dead_lettered_at;
  if (row.idempotency_key) result.idempotencyKey = row.idempotency_key;
  if (row.last_error_code) result.lastErrorCode = row.last_error_code;
  if (row.last_error_message) result.lastErrorMessage = row.last_error_message;
  return result;
}
