import type { PlainObject } from "@frick/protocol";
import type { Principal } from "../authz.js";
import type { FrickStore } from "../store.js";

const DEFAULT_OBJECT_LIMIT = 50;
const MAX_OBJECT_LIMIT = 200;

export interface DashboardObjectData {
  readonly schemaHash: string;
  readonly type: string;
  readonly tenantId: string;
  readonly scope: "tenant" | "admin";
  readonly limit: number;
  readonly count: number;
  readonly total: number;
  readonly truncated: boolean;
  readonly rows: readonly PlainObject[];
}

export interface BuildDashboardObjectDataInput {
  readonly store: FrickStore;
  readonly principal: Principal;
  readonly type: string;
  readonly tenantId?: string;
  readonly limit?: number;
}

export function buildDashboardObjectData(
  input: BuildDashboardObjectDataInput,
): DashboardObjectData | undefined {
  if (!input.store.schema.objects.some((object) => object.name === input.type)) {
    return undefined;
  }

  const scope = input.principal.scope === "admin" ? "admin" : "tenant";
  const tenantId = scope === "admin"
    ? input.tenantId || input.principal.tenantId
    : input.principal.tenantId;
  const limit = normalizeDashboardObjectLimit(input.limit);
  const visibleRows = scope === "admin"
    ? input.store.listObjects(tenantId, input.type)
    : input.store.listObjectsForUser(tenantId, input.type, input.principal.userId);
  const rows = visibleRows.slice(0, limit);

  return {
    schemaHash: input.store.schema.hash,
    type: input.type,
    tenantId,
    scope,
    limit,
    count: rows.length,
    total: visibleRows.length,
    truncated: visibleRows.length > rows.length,
    rows,
  };
}

export function normalizeDashboardObjectLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_OBJECT_LIMIT;
  }
  return Math.min(MAX_OBJECT_LIMIT, Math.floor(value));
}
