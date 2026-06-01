import type { Pool, PoolClient } from "pg";
import {
  computeMigrationChecksum,
  FrickMigrationChecksumError,
  FrickMigrationError,
  FrickMigrationRevisionError,
  type AppliedMigrationRow,
  type FrameworkMigration,
  type MigrationRunResult,
  type MigrationRunnerOptions,
} from "./migrations.js";
import { FRAMEWORK_MIGRATIONS_PG } from "./pg-framework-migrations.js";

/**
 * Postgres-compatible framework migration runner.
 *
 * Mirrors the semantics of the SQLite `runFrameworkMigrations` function but
 * operates against a `pg.Pool` instead of a `node:sqlite` `DatabaseSync`
 * handle. The same `FrameworkMigration` definitions, ledger schema, and
 * checksum algorithm are reused — the only difference is the SQL dialect and
 * the async client API.
 *
 * Behavior (same as the SQLite runner):
 *   1. Ensure `frick_migrations` exists.
 *   2. Load applied rows.
 *   3. Verify checksum for every already-applied migration.
 *      Mismatch → `FrickMigrationChecksumError`.
 *   4. Verify `max(applied.schemaRevision) <= supportedSchemaRevision`.
 *      Otherwise → `FrickMigrationRevisionError`.
 *   5. Apply any in-code migrations not yet applied, each inside a
 *      transaction that wraps both the SQL and the ledger insert.
 *
 * The Postgres `frick_migrations` table has the same shape as its SQLite
 * sibling (same column names, same column types modulo dialect). A single
 * cluster can therefore have both a SQLite dev instance and a Postgres
 * production instance and the ledger rows are semantically identical.
 */
export async function runFrameworkMigrationsPostgres(
  pool: Pool,
  options: MigrationRunnerOptions,
): Promise<MigrationRunResult> {
  const migrations = options.migrations ?? FRAMEWORK_MIGRATIONS_PG;
  const now = options.now ?? (() => new Date());

  const client = await pool.connect();
  try {
    await ensureMigrationsTablePg(client);

    const appliedRows = await loadAppliedMigrationsPg(client);
    const appliedById = new Map(appliedRows.map((row) => [row.id, row] as const));

    for (const migration of migrations) {
      const recorded = appliedById.get(migration.id);
      if (!recorded) continue;
      const currentChecksum = computeMigrationChecksum(migration);
      if (recorded.checksum !== currentChecksum) {
        throw new FrickMigrationChecksumError(migration.id, recorded.checksum, currentChecksum);
      }
    }

    const maxAppliedRevision = appliedRows.reduce(
      (max, row) => Math.max(max, row.schemaRevision),
      0,
    );
    if (maxAppliedRevision > options.supportedSchemaRevision) {
      throw new FrickMigrationRevisionError(maxAppliedRevision, options.supportedSchemaRevision);
    }

    const alreadyApplied: AppliedMigrationRow[] = [];
    const newlyApplied: AppliedMigrationRow[] = [];

    for (const migration of migrations) {
      const recorded = appliedById.get(migration.id);
      if (recorded) {
        alreadyApplied.push(recorded);
        continue;
      }
      if (migration.schemaRevision > options.supportedSchemaRevision) {
        throw new FrickMigrationRevisionError(
          migration.schemaRevision,
          options.supportedSchemaRevision,
        );
      }
      const applied = await applyMigrationPg(client, migration, now);
      newlyApplied.push(applied);
    }

    return { applied: newlyApplied, alreadyApplied };
  } finally {
    client.release();
  }
}

/**
 * Bootstrap the `frick_migrations` ledger table in Postgres. Uses
 * `CREATE TABLE IF NOT EXISTS` so it is safe to call on every server boot.
 * The schema mirrors the SQLite ledger exactly (same column names, compatible
 * types) so tooling that reads both can treat them uniformly.
 */
async function ensureMigrationsTablePg(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS frick_migrations (
      id TEXT PRIMARY KEY,
      schema_revision INTEGER NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL,
      checksum TEXT NOT NULL,
      duration_ms INTEGER NOT NULL
    )
  `);
}

async function loadAppliedMigrationsPg(client: PoolClient): Promise<AppliedMigrationRow[]> {
  const result = await client.query<{
    id: string;
    schema_revision: number;
    applied_at: Date;
    checksum: string;
    duration_ms: number;
  }>(
    `SELECT id, schema_revision, applied_at, checksum, duration_ms
       FROM frick_migrations
       ORDER BY schema_revision ASC, id ASC`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    schemaRevision: row.schema_revision,
    appliedAt: row.applied_at instanceof Date ? row.applied_at.toISOString() : String(row.applied_at),
    checksum: row.checksum,
    durationMs: row.duration_ms,
  }));
}

async function applyMigrationPg(
  client: PoolClient,
  migration: FrameworkMigration,
  now: () => Date,
): Promise<AppliedMigrationRow> {
  const checksum = computeMigrationChecksum(migration);
  const start = process.hrtime.bigint();
  const appliedAt = now().toISOString();

  await client.query("BEGIN");
  try {
    // Execute the migration SQL (may contain multiple statements).
    await client.query(migration.sql);

    const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
    await client.query(
      `INSERT INTO frick_migrations (id, schema_revision, applied_at, checksum, duration_ms)
         VALUES ($1, $2, $3, $4, $5)`,
      [migration.id, migration.schemaRevision, appliedAt, checksum, durationMs],
    );
    await client.query("COMMIT");
    return {
      id: migration.id,
      schemaRevision: migration.schemaRevision,
      appliedAt,
      checksum,
      durationMs,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Swallow rollback error — surface the original cause.
    }
    throw new FrickMigrationError(
      `Failed to apply migration ${migration.id} (${migration.description}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Read the applied migration ledger from Postgres. Exposed for tests and
 * operations tooling. Mirrors `listAppliedMigrations` from migrations.ts.
 */
export async function listAppliedMigrationsPostgres(pool: Pool): Promise<AppliedMigrationRow[]> {
  const client = await pool.connect();
  try {
    await ensureMigrationsTablePg(client);
    return await loadAppliedMigrationsPg(client);
  } finally {
    client.release();
  }
}

// Re-export the checksum helper so callers don't need to import from two files.
export { computeMigrationChecksum };
