import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Principal } from "../authz.js";

export const DEFAULT_ANALYTICS_SUMMARY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_ANALYTICS_SUMMARY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const MIN_ANALYTICS_SUMMARY_WINDOW_MS = 60 * 1000;

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
  readonly db: DatabaseSync;
  readonly principal: Principal;
  readonly windowMs?: number;
  readonly now?: Date;
  readonly limit?: number;
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
  payload: string;
}

const ANALYTICS_FAMILY = "analytics.user_event";
const DEFAULT_RESULT_LIMIT = 10;

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
  const windowMs = normalizeAnalyticsSummaryWindowMs(input.windowMs);
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const since = new Date(now.getTime() - windowMs).toISOString();
  const limit = clampLimit(input.limit ?? DEFAULT_RESULT_LIMIT);
  const scope = analyticsScope(input.principal);
  const where = analyticsWhere(scope);
  const params = analyticsParams(scope, since);

  const totals = input.db
    .prepare(
      `SELECT
          COUNT(*) AS events,
          COUNT(DISTINCT subject_id) AS unique_users,
          COUNT(DISTINCT tenant_id) AS unique_tenants
        FROM platform_events
        WHERE ${where}`,
    )
    .get(...params) as TotalsRow | undefined;

  const topEvents = input.db
    .prepare(
      `SELECT name, COUNT(*) AS count
        FROM platform_events
        WHERE ${where}
        GROUP BY name
        ORDER BY count DESC, name ASC
        LIMIT ?`,
    )
    .all(...params, limit) as unknown as CountRow[];

  const topRoutes = input.db
    .prepare(
      `SELECT path, COUNT(*) AS count
        FROM (
          SELECT
            CASE
              WHEN json_type(payload, '$.properties.path') = 'text'
                THEN json_extract(payload, '$.properties.path')
              WHEN json_type(payload, '$.context.path') = 'text'
                THEN json_extract(payload, '$.context.path')
            END AS path
          FROM platform_events
          WHERE ${where}
            AND name = 'screen.viewed'
        )
        WHERE path IS NOT NULL
        GROUP BY path
        ORDER BY count DESC, path ASC
        LIMIT ?`,
    )
    .all(...params, limit) as unknown as RouteCountRow[];

  const recentEvents = input.db
    .prepare(
      `SELECT
          event_id, name, tenant_id, account_id, subject_id, trace_id,
          occurred_at, accepted_at, payload
        FROM platform_events
        WHERE ${where}
        ORDER BY occurred_at DESC, id DESC
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

function analyticsScope(principal: Principal): AnalyticsSummary["scope"] {
  if (principal.scope === "admin") {
    return { kind: "admin" };
  }
  return { kind: "tenant", tenantId: principal.tenantId };
}

function analyticsWhere(scope: AnalyticsSummary["scope"]): string {
  const tenantClause = scope.kind === "tenant" ? " AND tenant_id = ?" : "";
  return `family = ? AND occurred_at >= ?${tenantClause}`;
}

function analyticsParams(scope: AnalyticsSummary["scope"], since: string): readonly SQLInputValue[] {
  if (scope.kind === "tenant") {
    return [ANALYTICS_FAMILY, since, scope.tenantId];
  }
  return [ANALYTICS_FAMILY, since];
}

function recentEventFromRow(row: RecentEventRow): AnalyticsRecentEvent {
  const payload = parseJsonObject(row.payload);
  return {
    eventId: row.event_id,
    name: row.name,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    subjectId: row.subject_id,
    traceId: row.trace_id,
    occurredAt: row.occurred_at,
    acceptedAt: row.accepted_at,
    properties: plainObject(payload.properties),
    context: plainObject(payload.context),
  };
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
