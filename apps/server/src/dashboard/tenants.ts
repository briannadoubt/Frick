import type { Principal } from "../authz.js";
import type { FrickStore } from "../store.js";
import type { TenantRow } from "../storage/tenant-store.js";

const DEFAULT_TENANT_LIMIT = 50;
const MAX_TENANT_LIMIT = 200;

export interface DashboardTenants {
  readonly schemaHash: string;
  readonly scope: "tenant" | "admin";
  readonly includeArchived: boolean;
  readonly limit: number;
  readonly count: number;
  readonly truncated: boolean;
  readonly tenants: readonly TenantRow[];
}

export interface BuildDashboardTenantsInput {
  readonly store: FrickStore;
  readonly principal: Principal;
  readonly includeArchived?: boolean;
  readonly limit?: number;
}

export function buildDashboardTenants(input: BuildDashboardTenantsInput): DashboardTenants {
  const scope = input.principal.scope === "admin" ? "admin" : "tenant";
  const includeArchived = input.includeArchived === true;
  const limit = normalizeDashboardTenantLimit(input.limit);
  const rows = scope === "admin"
    ? input.store.tenants.list(includeArchived)
    : ownTenantRows(input.store, input.principal, includeArchived);
  const tenants = rows.slice(0, limit);

  return {
    schemaHash: input.store.schema.hash,
    scope,
    includeArchived,
    limit,
    count: tenants.length,
    truncated: rows.length > tenants.length,
    tenants,
  };
}

export function normalizeDashboardTenantLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TENANT_LIMIT;
  }
  return Math.min(MAX_TENANT_LIMIT, Math.floor(value));
}

function ownTenantRows(
  store: FrickStore,
  principal: Principal,
  includeArchived: boolean,
): TenantRow[] {
  const row = store.tenants.get(principal.tenantId);
  if (!row) return [];
  if (row.archivedAt && !includeArchived) return [];
  return [row];
}
