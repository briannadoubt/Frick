/**
 * Durable event feed for the DevTools developer console.
 *
 * The store sits behind `FrickStore.devtoolsEvents` and is intentionally
 * additive: it does NOT replace the unstructured request logger or the
 * counters in the metrics module. Each framework emission point that wants to
 * surface itself in the console writes a row here in addition to its existing
 * log/metric calls.
 *
 * Retention follows the same "age sweep, then cap sweep" idiom as the
 * idempotency-keys prune in {@link FrickStore.prune}. We never want the
 * `devtools_events` table to grow unbounded — a busy server emits one row per
 * HTTP request, so left unchecked the table would dominate the database.
 * The defaults (1 hour / 10,000 rows) are tuned so a 100 req/s server still
 * fits comfortably while keeping recent history queryable.
 */

import type { SqlDriver } from "../storage/sql-driver.js";

export interface DevToolsEventInput {
  readonly kind: string;
  readonly tenantId?: string | undefined;
  readonly fields?: Record<string, unknown> | undefined;
  /** Override the recorded timestamp. Defaults to `new Date().toISOString()`. */
  readonly occurredAt?: string;
}

export interface DevToolsEventRow {
  readonly id: number;
  readonly occurredAt: string;
  readonly kind: string;
  readonly tenantId: string | null;
  readonly fields: Record<string, unknown>;
}

export interface DevToolsEventListFilter {
  readonly kind?: string;
  readonly tenantId?: string;
  readonly sinceId?: number;
  readonly limit?: number;
}

export interface DevToolsEventsPruneResult {
  readonly prunedByAge: number;
  readonly prunedByCap: number;
}

export interface DevToolsEventStoreOptions {
  /** Retention window in milliseconds. Older rows are dropped on every prune. */
  readonly retentionMs: number;
  /** Hard upper bound on total rows, applied after the age sweep. */
  readonly maxRows: number;
  /** Override the clock for deterministic tests. */
  readonly now?: () => Date;
}

/** Default: keep one hour of events. */
export const DEFAULT_DEVTOOLS_EVENTS_RETENTION_MS = 60 * 60 * 1000;
/** Default: cap the table at 10,000 rows. */
export const DEFAULT_DEVTOOLS_EVENTS_MAX_ROWS = 10_000;
/** Default prune interval: 60 seconds. */
export const DEFAULT_DEVTOOLS_EVENTS_PRUNE_INTERVAL_MS = 60 * 1000;
/** Default `limit` for `list(...)` when callers omit it. */
const DEFAULT_LIST_LIMIT = 200;
/** Hard cap on a single list call — prevents pathological queries from the inspect route. */
const MAX_LIST_LIMIT = 1000;

export class DevToolsEventStore {
  readonly #sql: SqlDriver;
  readonly #retentionMs: number;
  readonly #maxRows: number;
  readonly #now: () => Date;

  constructor(sql: SqlDriver, options: DevToolsEventStoreOptions) {
    this.#sql = sql;
    this.#retentionMs = options.retentionMs;
    this.#maxRows = options.maxRows;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Record a single event. Never throws on serialization failure — the worst
   * case is that a single weird field bag silently drops the row, which is
   * preferable to taking down the originating handler.
   */
  async record(input: DevToolsEventInput): Promise<void> {
    const occurredAt = input.occurredAt ?? this.#now().toISOString();
    let fieldsJson: string;
    try {
      fieldsJson = JSON.stringify(input.fields ?? {});
    } catch {
      fieldsJson = "{}";
    }
    try {
      await this.#sql.run(
        `INSERT INTO devtools_events (occurred_at, kind, tenant_id, fields)
            VALUES (?, ?, ?, ?)`,
        [occurredAt, input.kind, input.tenantId ?? null, fieldsJson],
      );
    } catch {
      // Swallow — recording must never break the originating request path.
    }
  }

  async list(filter: DevToolsEventListFilter = {}): Promise<DevToolsEventRow[]> {
    const clauses: string[] = [];
    const params: Array<string | number | null> = [];
    if (filter.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.tenantId !== undefined) {
      clauses.push("tenant_id = ?");
      params.push(filter.tenantId);
    }
    if (filter.sinceId !== undefined) {
      clauses.push("id > ?");
      params.push(filter.sinceId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = clampLimit(filter.limit);
    params.push(limit);
    const rows = await this.#sql.all<{
      id: number;
      occurred_at: string;
      kind: string;
      tenant_id: string | null;
      fields: string;
    }>(
      `SELECT id, occurred_at, kind, tenant_id, fields
          FROM devtools_events
          ${where}
          ORDER BY id DESC
          LIMIT ?`,
      params,
    );
    return rows.map((row) => decodeRow(row));
  }

  async getById(id: number): Promise<DevToolsEventRow | undefined> {
    const row = await this.#sql.get<{
      id: number;
      occurred_at: string;
      kind: string;
      tenant_id: string | null;
      fields: string;
    }>(
      `SELECT id, occurred_at, kind, tenant_id, fields
          FROM devtools_events WHERE id = ?`,
      [id],
    );
    return row ? decodeRow(row) : undefined;
  }

  /**
   * Aggregate counts by `kind` over a recent time window. Used by the
   * inspection `/summary` endpoint as a single-shot "what's happening now"
   * view that doesn't require fetching every row.
   */
  async summary(
    windowMs: number,
  ): Promise<{ windowMs: number; total: number; byKind: Record<string, number> }> {
    const cutoffIso = new Date(this.#now().getTime() - Math.max(0, windowMs)).toISOString();
    const rows = await this.#sql.all<{ kind: string; count: number }>(
      `SELECT kind, COUNT(*) AS count
          FROM devtools_events
          WHERE occurred_at >= ?
          GROUP BY kind
          ORDER BY count DESC`,
      [cutoffIso],
    );
    let total = 0;
    const byKind: Record<string, number> = {};
    for (const row of rows) {
      byKind[row.kind] = Number(row.count);
      total += Number(row.count);
    }
    return { windowMs, total, byKind };
  }

  /**
   * Two-phase prune: drop rows older than the retention window, then if the
   * table still exceeds the cap, drop the oldest rows until it fits.
   */
  async prune(): Promise<DevToolsEventsPruneResult> {
    const cutoffIso = new Date(this.#now().getTime() - this.#retentionMs).toISOString();
    // Two sequential sweeps WITHOUT a wrapping transaction. The seam's
    // transaction() holds a `BEGIN IMMEDIATE` across awaits on the shared
    // SQLite connection, which would collide with other connection users.
    // A rolling-window GC sweep needs no cross-statement atomicity: the worst
    // case is the cap count being off by a concurrently-inserted row, which
    // the next sweep corrects.
    const ageResult = await this.#sql.run("DELETE FROM devtools_events WHERE occurred_at < ?", [
      cutoffIso,
    ]);
    const prunedByAge = Number(ageResult.changes ?? 0);

    let prunedByCap = 0;
    const remaining = await this.#sql.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM devtools_events",
    );
    const overflow = Number(remaining?.count ?? 0) - this.#maxRows;
    if (overflow > 0) {
      const capResult = await this.#sql.run(
        `DELETE FROM devtools_events
              WHERE id IN (
                SELECT id FROM devtools_events
                  ORDER BY id ASC
                  LIMIT ?
              )`,
        [overflow],
      );
      prunedByCap = Number(capResult.changes ?? 0);
    }
    return { prunedByAge, prunedByCap };
  }

  async rowCount(): Promise<number> {
    const row = await this.#sql.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM devtools_events",
    );
    return Number(row?.count ?? 0);
  }
}

function decodeRow(row: {
  id: number;
  occurred_at: string;
  kind: string;
  tenant_id: string | null;
  fields: string;
}): DevToolsEventRow {
  let fields: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.fields);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      fields = parsed as Record<string, unknown>;
    }
  } catch {
    fields = {};
  }
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    kind: row.kind,
    tenantId: row.tenant_id,
    fields,
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  const numeric = Number(limit);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.floor(numeric));
}
