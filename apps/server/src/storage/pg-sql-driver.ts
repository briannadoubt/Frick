/**
 * Postgres implementation of the {@link SqlDriver} async storage seam (FR-119).
 *
 * Stores write SQLite-flavoured SQL with `?` positional placeholders against
 * the {@link SqlDriver} interface; this adapter rewrites `?` → `$1, $2, …` and
 * runs it on a `pg` pool/client. The store SQL that the core data plane uses
 * (object, stream, idempotency) is already dialect-neutral — `INSERT … ON
 * CONFLICT … DO UPDATE`, `RETURNING`, standard predicates — so the only
 * translation needed here is placeholder syntax, parameter normalization, and
 * result-shape mapping.
 *
 * Parameter + result conventions (kept identical to {@link SqliteSqlDriver} so
 * stores behave the same on both backends):
 *   - JS `boolean` → `0 | 1` and `undefined` → `NULL` (flag columns are
 *     `INTEGER`, never `BOOLEAN`, in the Frick schema).
 *   - `Uint8Array` → `Buffer` for `BYTEA` columns.
 *   - `BIGINT` columns (e.g. `expires_at`) parse back as JS numbers, matching
 *     SQLite's numeric affinity (Frick values stay well within `Number` range).
 */
import pg, { Pool, type PoolClient } from "pg";
import type { SqlDriver } from "./sql-driver.js";
import { runFrameworkMigrationsPostgres } from "./pg-migrations.js";
import { FRAMEWORK_MIGRATIONS_PG } from "./pg-framework-migrations.js";

// Parse Postgres BIGINT (OID 20) as a JS number instead of the default string,
// so `expires_at`, identity ids, etc. round-trip the same as under SQLite.
// Set once at module load; affects this process's `pg` result decoding.
pg.types.setTypeParser(20, (value) => (value === null ? null : Number(value)));

type SqliteBindValue = null | number | bigint | string | Buffer;

function bindParams(params: unknown[]): SqliteBindValue[] {
  return params.map((value) => {
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value === undefined) return null;
    if (value instanceof Uint8Array && !Buffer.isBuffer(value)) return Buffer.from(value);
    return value as SqliteBindValue;
  });
}

/**
 * Rewrite anonymous `?` placeholders to Postgres `$n` positionals, left to
 * right. `?` characters inside single-quoted string literals are left alone —
 * the Frick store SQL never embeds a literal `?`, but the guard keeps the
 * rewrite robust if one is ever added.
 */
export function rewritePlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === "'") {
      // Handle escaped '' inside a string literal.
      inString = !inString;
      out += ch;
      continue;
    }
    if (ch === "?" && !inString) {
      n += 1;
      out += `$${n}`;
      continue;
    }
    out += ch;
  }
  return out;
}

interface PgSqlDriverInit {
  /** When set, this driver is bound to a single transaction-scoped client. */
  readonly txClient?: PoolClient;
}

export class PgSqlDriver implements SqlDriver {
  readonly dialect = "postgres" as const;
  readonly #pool: Pool;
  readonly #txClient: PoolClient | undefined;
  #txDepth = 0;

  constructor(pool: Pool, init: PgSqlDriverInit = {}) {
    this.#pool = pool;
    this.#txClient = init.txClient;
  }

  /** The underlying connection pool — for shutdown and migration runners. */
  get pool(): Pool {
    return this.#pool;
  }

  #queryable(): Pool | PoolClient {
    return this.#txClient ?? this.#pool;
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    const result = await this.#queryable().query(rewritePlaceholders(sql), bindParams(params));
    return result.rows[0] as T | undefined;
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.#queryable().query(rewritePlaceholders(sql), bindParams(params));
    return result.rows as T[];
  }

  async run(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
    const result = await this.#queryable().query(rewritePlaceholders(sql), bindParams(params));
    // Postgres has no rowid; a caller that needs the generated key appends
    // `RETURNING id` and we surface it here. Otherwise 0, matching the
    // contract where `changes` is the meaningful field for non-RETURNING DML.
    const firstRow = result.rows[0] as { id?: number | bigint } | undefined;
    const lastInsertRowid = firstRow && firstRow.id !== undefined ? firstRow.id : 0;
    return {
      changes: result.rowCount ?? 0,
      lastInsertRowid,
    };
  }

  async exec(sql: string): Promise<void> {
    // Simple-query (no params) — runs multi-statement DDL/pragma-equivalent SQL.
    await this.#queryable().query(sql);
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    // Already inside a transaction (nested call on a tx-bound driver): reuse the
    // outer transaction rather than opening a second one, mirroring the SQLite
    // adapter. Real savepoints are a future refinement if a caller needs them.
    if (this.#txClient) {
      this.#txDepth += 1;
      try {
        return await fn(this);
      } finally {
        this.#txDepth -= 1;
      }
    }

    const client = await this.#pool.connect();
    const tx = new PgSqlDriver(this.#pool, { txClient: client });
    try {
      await client.query("BEGIN");
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Surface the original cause, not a rollback failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Close the pool. Call from server shutdown / test teardown. */
  async close(): Promise<void> {
    if (this.#txClient) return; // tx-scoped drivers don't own the pool
    await this.#pool.end();
  }
}

export interface CreatePgSqlDriverOptions {
  /** Postgres connection string, e.g. `postgres://user:pass@host:5432/db`. */
  databaseUrl: string;
  /** Schema revision the framework migration runner validates against. */
  supportedSchemaRevision: number;
  /**
   * Run the framework migrations on construction. Defaults to `true`. Set
   * `false` when a separate migration step already prepared the database.
   */
  migrate?: boolean;
}

/**
 * Connect to Postgres, optionally run the framework migrations, and return a
 * ready {@link PgSqlDriver}. The async counterpart to the synchronous SQLite
 * `createSqlDriver` path — Postgres setup (pool + DDL) is inherently async.
 */
export async function createPgSqlDriver(
  options: CreatePgSqlDriverOptions,
): Promise<PgSqlDriver> {
  const pool = new Pool({ connectionString: options.databaseUrl });
  if (options.migrate !== false) {
    await runFrameworkMigrationsPostgres(pool, {
      supportedSchemaRevision: options.supportedSchemaRevision,
      migrations: FRAMEWORK_MIGRATIONS_PG,
    });
  }
  return new PgSqlDriver(pool);
}
