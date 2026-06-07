import type { Principal } from "../authz.js";
import type { FrickStore } from "../store.js";
import type { StoredAccount } from "../storage/account-store.js";

const DEFAULT_ACCOUNT_LIMIT = 50;
const MAX_ACCOUNT_LIMIT = 200;

export interface DashboardAccounts {
  readonly schemaHash: string;
  readonly tenantId: string;
  readonly scope: "tenant" | "admin";
  readonly limit: number;
  readonly count: number;
  readonly truncated: boolean;
  readonly accounts: readonly StoredAccount[];
}

export interface BuildDashboardAccountsInput {
  readonly store: FrickStore;
  readonly principal: Principal;
  readonly tenantId?: string;
  readonly limit?: number;
}

export async function buildDashboardAccounts(input: BuildDashboardAccountsInput): Promise<DashboardAccounts> {
  const scope = input.principal.scope === "admin" ? "admin" : "tenant";
  const tenantId = scope === "admin"
    ? input.tenantId || input.principal.tenantId
    : input.principal.tenantId;
  const limit = normalizeDashboardAccountLimit(input.limit);
  const rows = await input.store.accounts.list(tenantId, limit + 1);
  const accounts = rows.slice(0, limit);

  return {
    schemaHash: input.store.schema.hash,
    tenantId,
    scope,
    limit,
    count: accounts.length,
    truncated: rows.length > accounts.length,
    accounts,
  };
}

export function normalizeDashboardAccountLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_ACCOUNT_LIMIT;
  }
  return Math.min(MAX_ACCOUNT_LIMIT, Math.floor(value));
}
