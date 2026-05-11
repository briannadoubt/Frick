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

import type { DatabaseSync } from "node:sqlite";

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
  readonly #db: DatabaseSync;
  readonly #retentionMs: number;
  readonly #maxRows: number;
  readonly #now: () => Date;

  constructor(db: DatabaseSync, options: DevToolsEventStoreOptions) {
    this.#db = db;
    this.#retentionMs = options.retentionMs;
    this.#maxRows = options.maxRows;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Record a single event. Never throws on serialization failure — the worst
   * case is that a single weird field bag silently drops the row, which is
   * preferable to taking down the originating handler.
   */
  record(input: DevToolsEventInput): void {
    const occurredAt = input.occurredAt ?? this.#now().toISOString();
    let fieldsJson: string;
    try {
      fieldsJson = JSON.stringify(input.fields ?? {});
    } catch {
      fieldsJson = "{}";
    }
    try {
      this.#db
        .prepare(
          `INSERT INTO devtools_events (occurred_at, kind, tenant_id, fields)
            VALUES (?, ?, ?, ?)`,
        )
        .run(occurredAt, input.kind, input.tenantId ?? null, fieldsJson);
    } catch {
      // Swallow — recording must never break the originating request path.
    }
  }

  list(filter: DevToolsEventListFilter = {}): DevToolsEventRow[] {
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
    const rows = this.#db
      .prepare(
        `SELECT id, occurred_at, kind, tenant_id, fields
          FROM devtools_events
          ${where}
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(...params) as Array<{
        id: number;
        occurred_at: string;
        kind: string;
        tenant_id: string | null;
        fields: string;
      }>;
    return rows.map((row) => decodeRow(row));
  }

  getById(id: number): DevToolsEventRow | undefined {
    const row = this.#db
      .prepare(
        `SELECT id, occurred_at, kind, tenant_id, fields
          FROM devtools_events WHERE id = ?`,
      )
      .get(id) as
      | { id: number; occurred_at: string; kind: string; tenant_id: string | null; fields: string }
      | undefined;
    return row ? decodeRow(row) : undefined;
  }

  /**
   * Aggregate counts by `kind` over a recent time window. Used by the
   * inspection `/summary` endpoint as a single-shot "what's happening now"
   * view that doesn't require fetching every row.
   */
  summary(windowMs: number): { windowMs: number; total: number; byKind: Record<string, number> } {
    const cutoffIso = new Date(this.#now().getTime() - Math.max(0, windowMs)).toISOString();
    const rows = this.#db
      .prepare(
        `SELECT kind, COUNT(*) AS count
          FROM devtools_events
          WHERE occurred_at >= ?
          GROUP BY kind
          ORDER BY count DESC`,
      )
      .all(cutoffIso) as Array<{ kind: string; count: number }>;
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
  prune(): DevToolsEventsPruneResult {
    const cutoffIso = new Date(this.#now().getTime() - this.#retentionMs).toISOString();
    let prunedByAge = 0;
    let prunedByCap = 0;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const ageResult = this.#db
        .prepare("DELETE FROM devtools_events WHERE occurred_at < ?")
        .run(cutoffIso);
      prunedByAge = Number(ageResult.changes ?? 0);

      const remaining = this.#db
        .prepare("SELECT COUNT(*) AS count FROM devtools_events")
        .get() as { count: number };
      const overflow = Number(remaining.count) - this.#maxRows;
      if (overflow > 0) {
        const capResult = this.#db
          .prepare(
            `DELETE FROM devtools_events
              WHERE id IN (
                SELECT id FROM devtools_events
                  ORDER BY id ASC
                  LIMIT ?
              )`,
          )
          .run(overflow);
        prunedByCap = Number(capResult.changes ?? 0);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Swallow — surface the original cause.
      }
      throw error;
    }
    return { prunedByAge, prunedByCap };
  }

  rowCount(): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS count FROM devtools_events")
      .get() as { count: number } | undefined;
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
