/**
 * NDJSON dump generator for the framework database.
 *
 * The dump format is one JSON object per line (no trailing newline yielded
 * by the generator — the caller decides how to frame lines). The first
 * line is a `header` row carrying schema-identity metadata and the list of
 * applied migrations; every subsequent line is `{ type, row }` where `type`
 * is the SQL table name and `row` is the raw column shape with
 * `Uint8Array` / `Buffer` values base64-encoded under a sibling
 * `*_base64` key.
 *
 * The format is intentionally column-shaped, not API-shaped. That keeps
 * dump and restore lossless across migrations that change the public
 * `FrickStore` surface — we round-trip the bytes that SQLite actually
 * stored. A side benefit: dump.ts does not depend on the higher-level
 * typed stores beyond the `FrickStore` facade for the schema fingerprint
 * and the migration ledger.
 */

import type { DatabaseSync } from "node:sqlite";
import type { FrickStore } from "../store.js";

export interface FrickDumpOptions {
  /** When omitted or set to "all", dump every tenant + framework infra. */
  tenantId?: string;
  /** Override default: only included for whole-database dumps unless forced. */
  includeAdminAudit?: boolean;
  /** Same default rule as {@link includeAdminAudit}. */
  includeMigrations?: boolean;
}

export interface FrickDumpHeader {
  frickFormat: 1;
  createdAt: string;
  schemaId: string;
  schemaVersion: string;
  schemaRevision: number;
  schemaHash: string;
  appliedMigrations: string[];
  tenantId: string;
}

/**
 * Tables in the framework. Per-tenant dumps filter rows where `tenant_id =
 * <chosen>`. Infra tables (admin_audit_log, frick_migrations, schema_versions)
 * have no tenant_id; they're included only on whole-database dumps.
 */
interface TableSpec {
  name: string;
  /** True if the table has a `tenant_id` column. */
  tenantScoped: boolean;
  /** True if dump should include this table only for whole-DB dumps. */
  infraOnly?: boolean;
  /** Deterministic ORDER BY clause. */
  orderBy: string;
}

const TABLE_ORDER: readonly TableSpec[] = [
  { name: "tenants", tenantScoped: false, infraOnly: true, orderBy: "tenant_id ASC" },
  { name: "auth_accounts", tenantScoped: true, orderBy: "tenant_id ASC, user_id ASC" },
  { name: "auth_sessions", tenantScoped: true, orderBy: "tenant_id ASC, session_token ASC" },
  { name: "objects", tenantScoped: true, orderBy: "tenant_id ASC, object_type ASC, object_id ASC" },
  {
    name: "stream_events",
    tenantScoped: true,
    orderBy: "tenant_id ASC, stream_type ASC, stream_id ASC, sequence ASC",
  },
  {
    name: "presence_leases",
    tenantScoped: true,
    orderBy: "tenant_id ASC, presence_type ASC, presence_key ASC",
  },
  { name: "signal_outbox", tenantScoped: true, orderBy: "id ASC" },
  { name: "blob_metadata", tenantScoped: true, orderBy: "tenant_id ASC, blob_id ASC" },
  { name: "blob_content", tenantScoped: true, orderBy: "tenant_id ASC, blob_id ASC" },
  {
    name: "conversation_inbox",
    tenantScoped: true,
    orderBy: "tenant_id ASC, conversation_id ASC, user_id ASC",
  },
  { name: "idempotency_keys", tenantScoped: true, orderBy: "tenant_id ASC, replica_id ASC, request_id ASC" },
  { name: "jobs", tenantScoped: true, orderBy: "id ASC" },
  {
    name: "push_device_registrations",
    tenantScoped: true,
    orderBy: "tenant_id ASC, registration_id ASC",
  },
  { name: "admin_audit_log", tenantScoped: false, infraOnly: true, orderBy: "id ASC" },
  { name: "frick_migrations", tenantScoped: false, infraOnly: true, orderBy: "id ASC" },
];

export async function* dumpFrickDatabase(
  store: FrickStore,
  options: FrickDumpOptions = {},
): AsyncIterable<string> {
  const tenantScope = options.tenantId ?? "all";
  const wholeDb = tenantScope === "all";
  const includeAdmin = options.includeAdminAudit ?? wholeDb;
  const includeMigrations = options.includeMigrations ?? wholeDb;
  const db = store.rawDatabase();

  const header: FrickDumpHeader = {
    frickFormat: 1,
    createdAt: new Date().toISOString(),
    schemaId: store.schema.schemaId,
    schemaVersion: store.schema.schemaVersion,
    schemaRevision: store.schema.schemaRevision,
    schemaHash: store.schema.hash,
    appliedMigrations: store.listAppliedMigrations().map((row) => row.id),
    tenantId: tenantScope,
  };
  yield JSON.stringify({ type: "header", row: header });

  for (const table of TABLE_ORDER) {
    if (table.name === "admin_audit_log" && !includeAdmin) continue;
    if (table.name === "frick_migrations" && !includeMigrations) continue;
    if (table.infraOnly && !wholeDb && table.name === "tenants") {
      // Per-tenant dump: still include the tenant ledger row for the chosen
      // tenant so a restore into a fresh DB can register it.
    } else if (table.infraOnly && !wholeDb) {
      continue;
    }

    if (!tableExists(db, table.name)) continue;

    const sql = buildSelect(table, wholeDb, tenantScope);
    const rows = table.tenantScoped && !wholeDb
      ? (db.prepare(sql).all(tenantScope) as Array<Record<string, unknown>>)
      : table.name === "tenants" && !wholeDb
        ? (db.prepare(sql).all(tenantScope) as Array<Record<string, unknown>>)
        : (db.prepare(sql).all() as Array<Record<string, unknown>>);

    for (const row of rows) {
      yield JSON.stringify({ type: table.name, row: encodeRow(row) });
    }
  }
}

function buildSelect(table: TableSpec, wholeDb: boolean, tenantId: string): string {
  if (table.name === "tenants" && !wholeDb) {
    return `SELECT * FROM tenants WHERE tenant_id = ? ORDER BY ${table.orderBy}`;
  }
  if (table.tenantScoped && !wholeDb) {
    return `SELECT * FROM ${table.name} WHERE tenant_id = ? ORDER BY ${table.orderBy}`;
  }
  return `SELECT * FROM ${table.name} ORDER BY ${table.orderBy}`;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { ok?: number } | undefined;
  return row?.ok === 1;
}

/**
 * Convert a SQLite row to a JSON-safe object. Buffers/Uint8Arrays land as
 * a sibling `<column>_base64` key; the original column key is dropped to
 * keep the JSON unambiguous. Restore reverses the rewrite.
 */
function encodeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Uint8Array) {
      out[`${key}_base64`] = Buffer.from(value).toString("base64");
    } else if (Buffer.isBuffer(value)) {
      out[`${key}_base64`] = value.toString("base64");
    } else if (typeof value === "bigint") {
      // node:sqlite returns INTEGER PRIMARY KEY rowids as bigint when they
      // overflow safe-integer range. Stringify so JSON round-trips.
      out[key] = Number(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
