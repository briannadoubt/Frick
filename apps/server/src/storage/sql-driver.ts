/**
 * SqlDriver — the async storage seam (FR-118).
 *
 * Every store in `apps/server/src/storage/` uses this interface instead of
 * `DatabaseSync` directly. The SQLite implementation (`SqliteSqlDriver`) wraps
 * the synchronous `node:sqlite` API in trivially-async methods so the call
 * sites compile cleanly against `Promise<T>`.
 *
 * Future Postgres adapter (FR-119) will implement the same interface using
 * async pg client calls. Callers never import `DatabaseSync`; only store
 * constructors and the factory below do.
 *
 * PLACEHOLDER convention: use `?` positional parameters in all SQL strings.
 * The SQLite driver passes them through unchanged. The future Postgres driver
 * will rewrite `?` → `$n` before forwarding.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool as PgPool } from "pg";
import { FrickConfigError } from "../config.js";
import type { FrickDbDriver } from "../config.js";
import { initializeStorage } from "./schema.js";
import { PgSqlDriver } from "./pg-sql-driver.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface SqlDriver {
  /**
   * Backend dialect. Almost all store SQL is dialect-neutral (the seam rewrites
   * `?`→`$n` and stores write portable `ON CONFLICT … DO UPDATE` / `RETURNING`),
   * but a few JSON-extraction predicates genuinely differ between SQLite and
   * Postgres. Stores branch on this only where there is no portable spelling.
   */
  readonly dialect: "sqlite" | "postgres";

  /**
   * Return the first matching row, or `undefined` when no row matches.
   * Equivalent to `db.prepare(sql).get(...params)`.
   */
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;

  /**
   * Return all matching rows (empty array when nothing matches).
   * Equivalent to `db.prepare(sql).all(...params)`.
   */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * Execute a DML statement and return the number of affected rows plus the
   * rowid of the last inserted row.
   * Equivalent to `db.prepare(sql).run(...params)`.
   */
  run(
    sql: string,
    params?: unknown[],
  ): Promise<{ changes: number; lastInsertRowid: number | bigint }>;

  /**
   * Execute a multi-statement DDL / pragma string with no parameters.
   * Equivalent to `db.exec(sql)`.
   */
  exec(sql: string): Promise<void>;

  /**
   * Run `fn` inside a `BEGIN IMMEDIATE … COMMIT` block on SQLite. If `fn`
   * throws, the transaction is rolled back and the original error is
   * re-thrown (rollback errors are swallowed). Nested `transaction()` calls
   * on the same SQLite connection reuse the outer transaction rather than
   * nesting (SQLite does not support real nesting via `BEGIN`).
   *
   * The callback receives the same `SqlDriver` instance (the transaction is
   * implicit in SQLite, not connection-scoped). For a Postgres adapter the
   * callback would receive a tx-scoped driver bound to the same client.
   */
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;

  /**
   * Create or upgrade the framework schema for this backend. Idempotent.
   * SQLite runs the synchronous DDL bundle; Postgres runs the framework
   * migration runner. Called once during store initialization.
   */
  initializeSchema(schemaRevision: number): Promise<void>;

  /** Close the underlying connection (SQLite) or pool (Postgres). */
  close(): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Parameter normalization
// ---------------------------------------------------------------------------

/**
 * `node:sqlite` binds only `null | number | bigint | string | Uint8Array`. JS
 * `boolean` and `undefined` reach the stores naturally (booleans for flag
 * columns, `undefined` for optional values), so the seam normalizes them the
 * way SQL expects — `boolean → 0 | 1`, `undefined → NULL` — instead of forcing
 * every call site to convert. A future Postgres adapter applies the same
 * contract before forwarding to `pg`.
 */
function bindParams(params: unknown[]): SqliteBindValue[] {
  return params.map((value) => {
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value === undefined) return null;
    return value as SqliteBindValue;
  });
}

type SqliteBindValue = null | number | bigint | string | Uint8Array;

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

export class SqliteSqlDriver implements SqlDriver {
  readonly dialect = "sqlite" as const;
  readonly #db: DatabaseSync;
  #txDepth = 0;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Expose the underlying DatabaseSync for the out-of-scope subsystems. */
  get rawDb(): DatabaseSync {
    return this.#db;
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    const stmt = this.#db.prepare(sql);
    return stmt.get(...bindParams(params)) as T | undefined;
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.#db.prepare(sql);
    return stmt.all(...bindParams(params)) as unknown as T[];
  }

  async run(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
    const stmt = this.#db.prepare(sql);
    const result = stmt.run(...bindParams(params));
    return {
      changes: Number(result.changes ?? 0),
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  async exec(sql: string): Promise<void> {
    this.#db.exec(sql);
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    // Nested transaction() on SQLite: reuse the outer transaction rather than
    // issuing a second BEGIN (which SQLite would reject). This is correct for
    // all current callers because the inner work is always a sub-step of the
    // outer logical transaction.
    if (this.#txDepth > 0) {
      this.#txDepth += 1;
      try {
        const result = await fn(this);
        return result;
      } finally {
        this.#txDepth -= 1;
      }
    }

    this.#txDepth = 1;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn(this);
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Swallow rollback errors — surface the original cause.
      }
      throw error;
    } finally {
      this.#txDepth -= 1;
    }
  }

  async initializeSchema(schemaRevision: number): Promise<void> {
    initializeStorage(this.#db, schemaRevision);
  }

  close(): void {
    this.#db.close();
  }
}

/**
 * Narrow a {@link SqlDriver} to {@link SqliteSqlDriver} — the only driver that
 * exposes a synchronous `rawDb` handle. Use this before reaching for `rawDb`
 * (raw-SQLite subsystems, synchronous DDL) instead of an unchecked cast.
 */
export function isSqliteSqlDriver(driver: SqlDriver): driver is SqliteSqlDriver {
  return driver.dialect === "sqlite";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface SqlDriverConfig {
  dbDriver: FrickDbDriver;
  /** Postgres connection string. Required when `dbDriver === "postgres"`. */
  dbUrl?: string | undefined;
  /** SQLite file path or `:memory:`. Used when `dbDriver === "sqlite"`. */
  dbPath: string;
}

/**
 * Build the appropriate `SqlDriver` for the configured storage driver.
 *
 * - `sqlite`: creates and returns a `SqliteSqlDriver` wrapping a fresh
 *   `DatabaseSync` at `config.dbPath`.
 * - `postgres`: throws `FrickConfigError` — Postgres store driver is not yet
 *   implemented (FR-119).
 *
 * Previously, `store.ts` silently fell through to SQLite even when postgres was
 * configured. This factory restores fail-fast behaviour.
 */
export function createSqlDriver(config: SqlDriverConfig): SqlDriver {
  if (config.dbDriver === "postgres") {
    if (!config.dbUrl) {
      throw new FrickConfigError(
        "FRICK_DB_DRIVER=postgres requires FRICK_DATABASE_URL (the Postgres connection string).",
      );
    }
    // The pg Pool is created synchronously and connects lazily on first query,
    // so construction stays sync. The framework schema is created later via
    // SqlDriver.initializeSchema() (awaited in the server's listen()).
    const pool = new PgPool({ connectionString: config.dbUrl });
    return new PgSqlDriver(pool);
  }

  // Ensure the parent directory exists for file-based databases.
  if (config.dbPath !== ":memory:") {
    mkdirSync(dirname(config.dbPath), { recursive: true });
  }

  const db = new DatabaseSync(config.dbPath);
  return new SqliteSqlDriver(db);
}
