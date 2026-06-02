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
import { FrickConfigError } from "../config.js";
import type { FrickDbDriver } from "../config.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface SqlDriver {
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
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

export class SqliteSqlDriver implements SqlDriver {
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
    return stmt.get(...(params as Parameters<typeof stmt.get>)) as T | undefined;
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.#db.prepare(sql);
    return stmt.all(...(params as Parameters<typeof stmt.all>)) as unknown as T[];
  }

  async run(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
    const stmt = this.#db.prepare(sql);
    const result = stmt.run(...(params as Parameters<typeof stmt.run>));
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
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface SqlDriverConfig {
  dbDriver: FrickDbDriver;
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
export function createSqlDriver(config: SqlDriverConfig): SqliteSqlDriver {
  if (config.dbDriver === "postgres") {
    throw new FrickConfigError(
      "postgres store driver not yet implemented (FR-119): use dbDriver='sqlite' until the Postgres adapter lands",
    );
  }

  // Ensure the parent directory exists for file-based databases.
  if (config.dbPath !== ":memory:") {
    mkdirSync(dirname(config.dbPath), { recursive: true });
  }

  const db = new DatabaseSync(config.dbPath);
  return new SqliteSqlDriver(db);
}
