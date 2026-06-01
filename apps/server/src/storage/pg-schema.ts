import type { Pool } from "pg";
import { runFrameworkMigrationsPostgres } from "./pg-migrations.js";

/**
 * Initialize the Postgres database for the Frick server.
 *
 * Mirrors `initializeStorage` from `schema.ts` but operates against a
 * `pg.Pool` instead of a SQLite `DatabaseSync` handle. There are no Postgres
 * equivalents to the SQLite WAL/synchronous pragmas; Postgres manages its own
 * WAL and durability settings at the server level. This function's sole
 * responsibility is delegating table creation to the Postgres migration runner.
 */
export async function initializeStoragePg(pool: Pool, supportedSchemaRevision: number): Promise<void> {
  await runFrameworkMigrationsPostgres(pool, { supportedSchemaRevision });
}
