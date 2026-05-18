import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Principal } from "../authz.js";
import type { PlatformEventEnvelope } from "../platform-events/types.js";

export const DEFAULT_ANALYTICS_SUMMARY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_ANALYTICS_SUMMARY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const MIN_ANALYTICS_SUMMARY_WINDOW_MS = 60 * 1000;
export const ANALYTICS_AGGREGATE_BUCKET_MS = 60 * 60 * 1000;

export interface AnalyticsSummary {
  readonly family: "analytics.user_event";
  readonly generatedAt: string;
  readonly since: string;
  readonly windowMs: number;
  readonly scope:
    | { readonly kind: "admin" }
    | { readonly kind: "tenant"; readonly tenantId: string };
  readonly totals: {
    readonly events: number;
    readonly uniqueUsers: number;
    readonly uniqueTenants: number;
  };
  readonly topEvents: readonly AnalyticsSummaryCount[];
  readonly topRoutes: readonly AnalyticsRouteCount[];
  readonly recentEvents: readonly AnalyticsRecentEvent[];
}

export interface AnalyticsSummaryCount {
  readonly name: string;
  readonly count: number;
}

export interface AnalyticsRouteCount {
  readonly path: string;
  readonly count: number;
}

export interface AnalyticsRecentEvent {
  readonly eventId: string;
  readonly name: string;
  readonly tenantId: string | null;
  readonly accountId: string | null;
  readonly subjectId: string | null;
  readonly traceId: string | null;
  readonly occurredAt: string;
  readonly acceptedAt: string;
  readonly properties: Record<string, unknown>;
  readonly context: Record<string, unknown>;
}

export interface BuildAnalyticsSummaryInput {
  readonly store: AnalyticsEventStore;
  readonly principal: Principal;
  readonly windowMs?: number;
  readonly now?: Date;
  readonly limit?: number;
}

export interface RecordAnalyticsEventResult {
  readonly recorded: boolean;
  readonly duplicate: boolean;
  readonly skipped: boolean;
}

interface TotalsRow {
  events: number | bigint | null;
  unique_users: number | bigint | null;
  unique_tenants: number | bigint | null;
}

interface CountRow {
  name: string;
  count: number | bigint;
}

interface RouteCountRow {
  path: string;
  count: number | bigint;
}

interface RecentEventRow {
  event_id: string;
  name: string;
  tenant_id: string | null;
  account_id: string | null;
  subject_id: string | null;
  trace_id: string | null;
  occurred_at: string;
  accepted_at: string;
  properties: string;
  context: string;
}

export class AnalyticsEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalyticsEventValidationError";
  }
}

const ANALYTICS_FAMILY = "analytics.user_event";
const DEFAULT_RESULT_LIMIT = 10;

export class AnalyticsEventStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  constructor(db: DatabaseSync, options: { now?: () => Date } = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
  }

  recordPlatformEvent(event: PlatformEventEnvelope): RecordAnalyticsEventResult {
    if (event.family !== ANALYTICS_FAMILY) {
      return { recorded: false, duplicate: false, skipped: true };
    }

    const occurredAtMs = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurredAtMs)) {
      throw new AnalyticsEventValidationError("analytics event occurredAt is not parseable");
    }

    const payload = plainObject(event.payload);
    const properties = plainObject(payload.properties);
    const context = plainObject(payload.context);
    const processedAt = this.#now().toISOString();
    const tenantKey = event.tenantId ?? "";
    const routePath = analyticsRoutePath(properties, context);

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.#db
        .prepare(
          `INSERT OR IGNORE INTO analytics_recent_events (
              event_id, occurred_at, accepted_at, processed_at,
              tenant_id, account_id, subject_id, trace_id, name, properties, context
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.occurredAt,
          event.acceptedAt,
          processedAt,
          event.tenantId,
          event.accountId,
          event.subjectId,
          event.traceId,
          event.name,
          JSON.stringify(properties),
          JSON.stringify(context),
        );

      if (Number(inserted.changes ?? 0) === 0) {
        this.#db.exec("COMMIT");
        return { recorded: false, duplicate: true, skipped: false };
      }

      const bucketStart = bucketStartIso(occurredAtMs, ANALYTICS_AGGREGATE_BUCKET_MS);
      this.#incrementBucket(bucketStart, tenantKey, "event", event.name);
      if (routePath) {
        this.#incrementBucket(bucketStart, tenantKey, "route", routePath);
      }
      if (event.subjectId) {
        this.#incrementBucket(bucketStart, tenantKey, "subject", event.subjectId);
      }
      this.#db.exec("COMMIT");
      return { recorded: true, duplicate: false, skipped: false };
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      throw error;
    }
  }

  summary(input: Omit<BuildAnalyticsSummaryInput, "store">): AnalyticsSummary {
    const windowMs = normalizeAnalyticsSummaryWindowMs(input.windowMs);
    const now = input.now ?? new Date();
    const generatedAt = now.toISOString();
    const since = new Date(now.getTime() - windowMs).toISOString();
    const limit = clampLimit(input.limit ?? DEFAULT_RESULT_LIMIT);
    const scope = analyticsScope(input.principal);
    const where = analyticsWhere(scope);
    const params = analyticsParams(scope, since);

    const totals = this.#db
      .prepare(
        `SELECT
            COUNT(*) AS events,
            COUNT(DISTINCT subject_id) AS unique_users,
            COUNT(DISTINCT tenant_id) AS unique_tenants
          FROM analytics_recent_events
          WHERE ${where}`,
      )
      .get(...params) as TotalsRow | undefined;

    const topEvents = this.#db
      .prepare(
        `SELECT name, COUNT(*) AS count
          FROM analytics_recent_events
          WHERE ${where}
          GROUP BY name
          ORDER BY count DESC, name ASC
          LIMIT ?`,
      )
      .all(...params, limit) as unknown as CountRow[];

    const topRoutes = this.#db
      .prepare(
        `SELECT path, COUNT(*) AS count
          FROM (
            SELECT
              CASE
                WHEN json_type(properties, '$.path') = 'text'
                  THEN json_extract(properties, '$.path')
                WHEN json_type(context, '$.path') = 'text'
                  THEN json_extract(context, '$.path')
              END AS path
            FROM analytics_recent_events
            WHERE ${where}
              AND name = 'screen.viewed'
          )
          WHERE path IS NOT NULL
          GROUP BY path
          ORDER BY count DESC, path ASC
          LIMIT ?`,
      )
      .all(...params, limit) as unknown as RouteCountRow[];

    const recentEvents = this.#db
      .prepare(
        `SELECT
            event_id, name, tenant_id, account_id, subject_id, trace_id,
            occurred_at, accepted_at, properties, context
          FROM analytics_recent_events
          WHERE ${where}
          ORDER BY occurred_at DESC, event_id DESC
          LIMIT ?`,
      )
      .all(...params, limit) as unknown as RecentEventRow[];

    return {
      family: ANALYTICS_FAMILY,
      generatedAt,
      since,
      windowMs,
      scope,
      totals: {
        events: numberFromSql(totals?.events),
        uniqueUsers: numberFromSql(totals?.unique_users),
        uniqueTenants: numberFromSql(totals?.unique_tenants),
      },
      topEvents: topEvents.map((row) => ({
        name: row.name,
        count: numberFromSql(row.count),
      })),
      topRoutes: topRoutes.map((row) => ({
        path: row.path,
        count: numberFromSql(row.count),
      })),
      recentEvents: recentEvents.map(recentEventFromRow),
    };
  }

  #incrementBucket(
    bucketStart: string,
    tenantId: string,
    metricKind: "event" | "route" | "subject",
    metricKey: string,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO analytics_aggregate_buckets (
            bucket_start, bucket_ms, tenant_id, metric_kind, metric_key, count
          ) VALUES (?, ?, ?, ?, ?, 1)
          ON CONFLICT(bucket_start, bucket_ms, tenant_id, metric_kind, metric_key)
          DO UPDATE SET count = count + 1`,
      )
      .run(bucketStart, ANALYTICS_AGGREGATE_BUCKET_MS, tenantId, metricKind, metricKey);
  }
}

export function normalizeAnalyticsSummaryWindowMs(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_ANALYTICS_SUMMARY_WINDOW_MS;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_ANALYTICS_SUMMARY_WINDOW_MS;
  }
  return Math.min(
    MAX_ANALYTICS_SUMMARY_WINDOW_MS,
    Math.max(MIN_ANALYTICS_SUMMARY_WINDOW_MS, Math.floor(parsed)),
  );
}

export function buildAnalyticsSummary(input: BuildAnalyticsSummaryInput): AnalyticsSummary {
  return input.store.summary(input);
}

function analyticsScope(principal: Principal): AnalyticsSummary["scope"] {
  if (principal.scope === "admin") {
    return { kind: "admin" };
  }
  return { kind: "tenant", tenantId: principal.tenantId };
}

function analyticsWhere(scope: AnalyticsSummary["scope"]): string {
  const tenantClause = scope.kind === "tenant" ? " AND tenant_id = ?" : "";
  return `occurred_at >= ?${tenantClause}`;
}

function analyticsParams(scope: AnalyticsSummary["scope"], since: string): readonly SQLInputValue[] {
  if (scope.kind === "tenant") {
    return [since, scope.tenantId];
  }
  return [since];
}

function recentEventFromRow(row: RecentEventRow): AnalyticsRecentEvent {
  return {
    eventId: row.event_id,
    name: row.name,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    subjectId: row.subject_id,
    traceId: row.trace_id,
    occurredAt: row.occurred_at,
    acceptedAt: row.accepted_at,
    properties: parseJsonObject(row.properties),
    context: parseJsonObject(row.context),
  };
}

function analyticsRoutePath(
  properties: Record<string, unknown>,
  context: Record<string, unknown>,
): string | undefined {
  if (typeof properties.path === "string" && properties.path.length > 0) {
    return properties.path;
  }
  if (typeof context.path === "string" && context.path.length > 0) {
    return context.path;
  }
  return undefined;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    return plainObject(JSON.parse(value));
  } catch {
    return {};
  }
}

function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function numberFromSql(value: number | bigint | null | undefined): number {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return value ?? 0;
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RESULT_LIMIT;
  return Math.min(100, Math.max(1, Math.floor(value)));
}

function bucketStartIso(occurredAtMs: number, bucketMs: number): string {
  return new Date(Math.floor(occurredAtMs / bucketMs) * bucketMs).toISOString();
}
