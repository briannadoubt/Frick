/**
 * `frick tenants list` — list rows in the `tenants` ledger.
 * `frick tenants create <id> [--display-name <name>]` — insert a tenant row.
 */
import { TenantAlreadyExistsError } from "../../../server/src/storage/tenant-store.js";
import type { ParsedArgs } from "../argv.js";
import { CliFailureError, CliUsageError } from "../errors.js";
import { contextFlagsFrom, loadConfig, openStore } from "../context.js";
import { emit, type OutputOptions } from "../output.js";
import { requireString } from "../argv.js";

export async function tenantsCommand(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === "list") return tenantsList(parsed, out);
  if (sub === "create") return tenantsCreate(parsed, out);
  throw new CliUsageError(`Unknown tenants subcommand: ${sub ?? "<missing>"}`, {
    expected: ["list", "create"],
  });
}

function tenantsList(parsed: ParsedArgs, out: OutputOptions): number {
  const config = loadConfig(contextFlagsFrom(parsed.flags));
  const store = openStore(config);
  try {
    const includeArchived = parsed.flags["include-archived"] === true;
    const rows = store.tenants.list(includeArchived);
    emit({ tenants: rows }, out);
    return 0;
  } finally {
    store.close();
  }
}

function tenantsCreate(parsed: ParsedArgs, out: OutputOptions): number {
  const tenantId = parsed.positionals[1];
  if (!tenantId) {
    throw new CliUsageError("frick tenants create requires a tenant id positional argument");
  }
  const displayName = requireString(parsed.flags, "display-name");
  const config = loadConfig(contextFlagsFrom(parsed.flags));
  const store = openStore(config);
  try {
    const row = store.tenants.create(tenantId, displayName);
    emit({ ok: true, tenant: row }, out);
    return 0;
  } catch (error) {
    if (error instanceof TenantAlreadyExistsError) {
      throw new CliFailureError("tenants.exists", error.message, { tenantId });
    }
    throw error;
  } finally {
    store.close();
  }
}
