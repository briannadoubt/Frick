/**
 * NDJSON restore reader. Counterpart of {@link dumpFrickDatabase}. Reads
 * the header, validates schema-identity and migration parity, then inserts
 * every subsequent `{ type, row }` line into the matching table.
 *
 * Restore is row-shaped (raw column values) rather than API-shaped — this
 * matches the dump format and makes restore lossless across changes to the
 * higher-level `FrickStore` surface.
 */

import type { SqlDriver } from "../storage/sql-driver.js";
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
  "search_indexes",
  "idempotency_keys",
  "tenant_settings",
  "jobs",
  "push_device_registrations",
  "platform_events",
  "analytics_aggregate_buckets",
  "analytics_recent_events",
];

const EVENT_CHILD_TABLES: readonly string[] = ["platform_event_deliveries"];

const INFRA_TABLES: readonly string[] = [
  "tenants",
  "admin_audit_log",
  "frick_migrations",
];

const ALL_TABLES: readonly string[] = [
  ...TENANT_SCOPED_TABLES,
  ...EVENT_CHILD_TABLES,
  ...INFRA_TABLES,
];
const TRUNCATE_ALL_TABLES: readonly string[] = [
  ...EVENT_CHILD_TABLES,
  ...TENANT_SCOPED_TABLES,
  ...INFRA_TABLES,
];
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
  const sql = options.target.sqlDriver;
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
    (await options.target.listAppliedMigrations()).map((row) => row.id),
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
    await truncateScope(sql, tenantScope);
  } else {
    await assertScopeEmpty(sql, tenantScope);
  }

  // Insert rows inside one transaction so a malformed row can be skipped
  // without aborting the rest. Rows arrive in dump order (parents before
  // children), so FK constraints (enforced on Postgres) are satisfied without
  // disabling them.
  let lineNumber = 1;
  await sql.transaction(async (tx) => {
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
      if (tenantScope !== "all" && parsed.type === "platform_event_deliveries") {
        await assertPlatformEventDeliveryMatchesScope(tx, parsed.row, tenantScope, lineNumber);
      }
      // Wrap each insert in a SAVEPOINT so a single bad row can be skipped
      // without poisoning the surrounding transaction. (On Postgres a failed
      // statement aborts the whole transaction until rolled back; SQLite is
      // more forgiving, but SAVEPOINT is correct and supported on both.)
      await tx.exec("SAVEPOINT frick_restore_row");
      try {
        await insertRow(tx, parsed.type, parsed.row, columnCache);
        await tx.exec("RELEASE SAVEPOINT frick_restore_row");
        rowCountsByType[parsed.type] = (rowCountsByType[parsed.type] ?? 0) + 1;
      } catch (error) {
        await tx.exec("ROLLBACK TO SAVEPOINT frick_restore_row");
        await tx.exec("RELEASE SAVEPOINT frick_restore_row");
        skipped.push({
          type: parsed.type,
          reason: error instanceof Error ? error.message : String(error),
          line: lineNumber,
        });
      }
    }
  });

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

async function assertPlatformEventDeliveryMatchesScope(
  sql: SqlDriver,
  row: Record<string, unknown>,
  tenantScope: string,
  lineNumber: number,
): Promise<void> {
  const eventId = row.event_id;
  const event =
    typeof eventId === "string"
      ? await sql.get<{ tenant_id: string | null }>(
        "SELECT tenant_id FROM platform_events WHERE event_id = ?",
        [eventId],
      )
      : undefined;
  if (event?.tenant_id === tenantScope) return;
  throw new FrickRestoreRefusedError(
    "tenantScopeMismatch",
    `Refusing to restore platform_event_deliveries row for event ${String(eventId)} into tenant-scoped dump ${tenantScope}`,
    {
      table: "platform_event_deliveries",
      eventId,
      expectedTenantId: tenantScope,
      line: lineNumber,
    },
  );
}

async function insertRow(
  tx: SqlDriver,
  table: string,
  row: Record<string, unknown>,
  columnCache: Map<string, Set<string>>,
): Promise<void> {
  const allowedColumns = await getTableColumns(tx, table, columnCache);
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
  const sqlText = `INSERT INTO ${quoteIdentifier(table)} (${columnList}) VALUES (${placeholders})`;
  await tx.run(sqlText, params);
}

async function getTableColumns(
  sql: SqlDriver,
  table: string,
  columnCache: Map<string, Set<string>>,
): Promise<Set<string>> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  // SQLite introspects columns via PRAGMA; Postgres via information_schema.
  const rows =
    sql.dialect === "postgres"
      ? await sql.all<{ name: string }>(
        "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?",
        [table],
      )
      : await sql.all<{ name: string }>(`PRAGMA table_info(${quoteIdentifier(table)})`);
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

async function truncateScope(sql: SqlDriver, tenantScope: string): Promise<void> {
  // Children are deleted before parents (TRUNCATE_ALL_TABLES) and FK cascades
  // cover blob_content/derivatives, so no FK disable is needed on either
  // backend. (SQLite enforces FKs off by default; Postgres enforces them, but
  // the delete order + cascades keep it consistent.)
  await sql.transaction(async (tx) => {
    if (tenantScope === "all") {
      for (const t of TRUNCATE_ALL_TABLES) {
        if (await tableExists(tx, t)) await tx.exec(`DELETE FROM ${t}`);
      }
    } else {
      await deletePlatformEventDeliveriesForTenant(tx, tenantScope);
      for (const t of TENANT_SCOPED_TABLES) {
        if (await tableExists(tx, t)) {
          await tx.run(`DELETE FROM ${t} WHERE tenant_id = ?`, [tenantScope]);
        }
      }
      if (await tableExists(tx, "tenants")) {
        await tx.run("DELETE FROM tenants WHERE tenant_id = ?", [tenantScope]);
      }
    }
  });
}

async function assertScopeEmpty(sql: SqlDriver, tenantScope: string): Promise<void> {
  if (tenantScope === "all") {
    for (const t of [...TENANT_SCOPED_TABLES, ...EVENT_CHILD_TABLES]) {
      if (!(await tableExists(sql, t))) continue;
      const row = await sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`);
      if (Number(row?.n ?? 0) > 0) {
        throw new FrickRestoreRefusedError(
          "targetNotEmpty",
          `Target database is not empty (table ${t} has rows); pass overwrite: true to replace`,
          { table: t },
        );
      }
    }
    return;
  }
  await assertPlatformEventDeliveriesEmptyForTenant(sql, tenantScope);
  for (const t of TENANT_SCOPED_TABLES) {
    if (!(await tableExists(sql, t))) continue;
    const row = await sql.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${t} WHERE tenant_id = ?`,
      [tenantScope],
    );
    if (Number(row?.n ?? 0) > 0) {
      throw new FrickRestoreRefusedError(
        "targetNotEmpty",
        `Target database already has data for tenant ${tenantScope} (table ${t}); pass overwrite: true to replace`,
        { table: t, tenantId: tenantScope },
      );
    }
  }
}

async function deletePlatformEventDeliveriesForTenant(
  sql: SqlDriver,
  tenantScope: string,
): Promise<void> {
  if (!(await tableExists(sql, "platform_event_deliveries")) || !(await tableExists(sql, "platform_events"))) {
    return;
  }
  await sql.run(
    `DELETE FROM platform_event_deliveries
        WHERE event_id IN (
          SELECT event_id FROM platform_events WHERE tenant_id = ?
        )`,
    [tenantScope],
  );
}

async function assertPlatformEventDeliveriesEmptyForTenant(
  sql: SqlDriver,
  tenantScope: string,
): Promise<void> {
  if (!(await tableExists(sql, "platform_event_deliveries")) || !(await tableExists(sql, "platform_events"))) {
    return;
  }
  const row = await sql.get<{ n: number }>(
    `SELECT COUNT(*) AS n
        FROM platform_event_deliveries d
        JOIN platform_events e ON e.event_id = d.event_id
        WHERE e.tenant_id = ?`,
    [tenantScope],
  );
  if (Number(row?.n ?? 0) > 0) {
    throw new FrickRestoreRefusedError(
      "targetNotEmpty",
      `Target database already has data for tenant ${tenantScope} (table platform_event_deliveries); pass overwrite: true to replace`,
      { table: "platform_event_deliveries", tenantId: tenantScope },
    );
  }
}

async function tableExists(sql: SqlDriver, name: string): Promise<boolean> {
  const query =
    sql.dialect === "postgres"
      ? "SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?"
      : "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?";
  const row = await sql.get<{ ok?: number }>(query, [name]);
  return Number(row?.ok ?? 0) === 1;
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
