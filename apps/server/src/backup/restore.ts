/**
 * NDJSON restore reader. Counterpart of {@link dumpFrickDatabase}. Reads
 * the header, validates schema-identity and migration parity, then inserts
 * every subsequent `{ type, row }` line into the matching table.
 *
 * Restore is row-shaped (raw column values) rather than API-shaped — this
 * matches the dump format and makes restore lossless across changes to the
 * higher-level `FrickStore` surface.
 */

import type { DatabaseSync } from "node:sqlite";
import type { FrickStore } from "../store.js";
import type { FrickDumpHeader } from "./dump.js";

export interface FrickRestoreOptions {
  target: FrickStore;
  source: AsyncIterable<string>;
  confirm: "yes";
  overwrite?: boolean;
  forceSchemaDrift?: boolean;
}

export interface FrickRestoreReport {
  rowCountsByType: Record<string, number>;
  skipped: Array<{ type: string; reason: string; line?: number }>;
  schemaCompatibility: { sourceHash: string; targetHash: string; matched: boolean };
  startedAt: string;
  finishedAt: string;
}

export class FrickRestoreRefusedError extends Error {
  constructor(
    readonly reason:
      | "missingConfirmation"
      | "missingHeader"
      | "schemaHashMismatch"
      | "missingMigrations"
      | "targetNotEmpty"
      | "tenantScopeMismatch",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FrickRestoreRefusedError";
  }
}

const TENANT_SCOPED_TABLES: readonly string[] = [
  "auth_accounts",
  "auth_sessions",
  "objects",
  "stream_events",
  "presence_leases",
  "signal_outbox",
  "blob_metadata",
  "blob_content",
  "blob_derivatives",
  "conversation_inbox",
  "search_indexes",
  "idempotency_keys",
  "tenant_settings",
  "jobs",
  "push_device_registrations",
];

const INFRA_TABLES: readonly string[] = [
  "tenants",
  "admin_audit_log",
  "frick_migrations",
];

const ALL_TABLES: readonly string[] = [...TENANT_SCOPED_TABLES, ...INFRA_TABLES];
const TENANT_ID_CONSTRAINED_TABLES = new Set([...TENANT_SCOPED_TABLES, "tenants"]);

export async function restoreFrickDatabase(
  options: FrickRestoreOptions,
): Promise<FrickRestoreReport> {
  if (options.confirm !== "yes") {
    throw new FrickRestoreRefusedError(
      "missingConfirmation",
      "Refusing to restore: `confirm` must be the string \"yes\"",
    );
  }

  const startedAt = new Date().toISOString();
  const db = options.target.rawDatabase();
  const skipped: FrickRestoreReport["skipped"] = [];
  const rowCountsByType: Record<string, number> = {};
  const columnCache = new Map<string, Set<string>>();

  const reader = lineReader(options.source);
  const headerLine = await reader.next();
  if (headerLine.done) {
    throw new FrickRestoreRefusedError("missingHeader", "Dump is empty: no header");
  }
  const parsedHeader = JSON.parse(headerLine.value) as { type: string; row: FrickDumpHeader };
  if (parsedHeader.type !== "header") {
    throw new FrickRestoreRefusedError(
      "missingHeader",
      `First line must be a header, got type=${parsedHeader.type}`,
    );
  }
  const header = parsedHeader.row;
  const targetHash = options.target.schema.hash;
  const matched = header.schemaHash === targetHash;
  if (!matched && options.forceSchemaDrift !== true) {
    throw new FrickRestoreRefusedError(
      "schemaHashMismatch",
      `Schema hash mismatch: source=${header.schemaHash} target=${targetHash}`,
      { sourceHash: header.schemaHash, targetHash },
    );
  }

  const appliedIds = new Set(
    options.target.listAppliedMigrations().map((row) => row.id),
  );
  const missingMigrations = header.appliedMigrations.filter((id) => !appliedIds.has(id));
  if (missingMigrations.length > 0) {
    throw new FrickRestoreRefusedError(
      "missingMigrations",
      `Target database is missing migrations applied to the source: ${missingMigrations.join(", ")}`,
      { missingMigrations },
    );
  }

  const tenantScope = header.tenantId;

  if (options.overwrite) {
    truncateScope(db, tenantScope);
  } else {
    assertScopeEmpty(db, tenantScope);
  }

  // Insert rows one at a time inside a transaction so a malformed row can be
  // skipped without aborting the rest.
  db.exec("BEGIN IMMEDIATE");
  let lineNumber = 1;
  try {
    for await (const raw of reader) {
      lineNumber += 1;
      if (raw.length === 0) continue;
      let parsed: { type: string; row: Record<string, unknown> };
      try {
        parsed = JSON.parse(raw) as { type: string; row: Record<string, unknown> };
      } catch (error) {
        skipped.push({
          type: "<unparseable>",
          reason: `JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
          line: lineNumber,
        });
        continue;
      }
      if (!ALL_TABLES.includes(parsed.type)) {
        skipped.push({ type: parsed.type, reason: "unknownTableType", line: lineNumber });
        continue;
      }
      if (tenantScope !== "all" && TENANT_ID_CONSTRAINED_TABLES.has(parsed.type)) {
        assertRowTenantMatchesScope(parsed.type, parsed.row, tenantScope, lineNumber);
      }
      try {
        insertRow(db, parsed.type, parsed.row, columnCache);
        rowCountsByType[parsed.type] = (rowCountsByType[parsed.type] ?? 0) + 1;
      } catch (error) {
        skipped.push({
          type: parsed.type,
          reason: error instanceof Error ? error.message : String(error),
          line: lineNumber,
        });
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Swallow — surface the original error.
    }
    throw error;
  }

  return {
    rowCountsByType,
    skipped,
    schemaCompatibility: { sourceHash: header.schemaHash, targetHash, matched },
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

function assertRowTenantMatchesScope(
  table: string,
  row: Record<string, unknown>,
  tenantScope: string,
  lineNumber: number,
): void {
  if (row.tenant_id === tenantScope) return;
  throw new FrickRestoreRefusedError(
    "tenantScopeMismatch",
    `Refusing to restore ${table} row for tenant ${String(row.tenant_id)} into tenant-scoped dump ${tenantScope}`,
    { table, tenantId: row.tenant_id, expectedTenantId: tenantScope, line: lineNumber },
  );
}

function insertRow(
  db: DatabaseSync,
  table: string,
  row: Record<string, unknown>,
  columnCache: Map<string, Set<string>>,
): void {
  const allowedColumns = getTableColumns(db, table, columnCache);
  const columns: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(row)) {
    const column = key.endsWith("_base64") ? key.slice(0, -"_base64".length) : key;
    if (!allowedColumns.has(column)) {
      throw new Error(`invalidColumn: ${table}.${column}`);
    }
    if (columns.includes(column)) {
      throw new Error(`duplicateColumn: ${table}.${column}`);
    }
    if (key.endsWith("_base64")) {
      columns.push(column);
      params.push(Buffer.from(String(value), "base64"));
    } else {
      columns.push(column);
      params.push(value as never);
    }
  }
  if (columns.length === 0) {
    throw new Error(`emptyRow: ${table}`);
  }
  const placeholders = columns.map(() => "?").join(", ");
  const columnList = columns.map(quoteIdentifier).join(", ");
  const sql = `INSERT INTO ${quoteIdentifier(table)} (${columnList}) VALUES (${placeholders})`;
  db.prepare(sql).run(...(params as Array<string | number | bigint | Buffer | null>));
}

function getTableColumns(
  db: DatabaseSync,
  table: string,
  columnCache: Map<string, Set<string>>,
): Set<string> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const rows = db
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all() as Array<{ name: string }>;
  if (rows.length === 0) {
    throw new Error(`missingTable: ${table}`);
  }
  const columns = new Set(rows.map((row) => row.name));
  columnCache.set(table, columns);
  return columns;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function truncateScope(db: DatabaseSync, tenantScope: string): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    if (tenantScope === "all") {
      for (const t of ALL_TABLES) {
        if (tableExists(db, t)) db.exec(`DELETE FROM ${t}`);
      }
    } else {
      for (const t of TENANT_SCOPED_TABLES) {
        if (tableExists(db, t)) {
          db.prepare(`DELETE FROM ${t} WHERE tenant_id = ?`).run(tenantScope);
        }
      }
      if (tableExists(db, "tenants")) {
        db.prepare("DELETE FROM tenants WHERE tenant_id = ?").run(tenantScope);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function assertScopeEmpty(db: DatabaseSync, tenantScope: string): void {
  if (tenantScope === "all") {
    for (const t of TENANT_SCOPED_TABLES) {
      if (!tableExists(db, t)) continue;
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
      if (Number(row.n) > 0) {
        throw new FrickRestoreRefusedError(
          "targetNotEmpty",
          `Target database is not empty (table ${t} has rows); pass overwrite: true to replace`,
          { table: t },
        );
      }
    }
    return;
  }
  for (const t of TENANT_SCOPED_TABLES) {
    if (!tableExists(db, t)) continue;
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE tenant_id = ?`)
      .get(tenantScope) as { n: number };
    if (Number(row.n) > 0) {
      throw new FrickRestoreRefusedError(
        "targetNotEmpty",
        `Target database already has data for tenant ${tenantScope} (table ${t}); pass overwrite: true to replace`,
        { table: t, tenantId: tenantScope },
      );
    }
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { ok?: number } | undefined;
  return row?.ok === 1;
}

/**
 * Yields one logical NDJSON line per iteration. The input may be an
 * `AsyncIterable<string>` whose chunks don't align with line boundaries
 * (e.g. raw `Readable` chunks); we buffer and split on `\n`.
 */
async function* lineReader(source: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of source) {
    buffer += chunk;
    let newlineIdx = buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (line.length > 0) yield line;
      newlineIdx = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) {
    yield buffer;
  }
}
