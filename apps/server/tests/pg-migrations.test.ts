/**
 * Postgres migration runner tests (FR-22).
 *
 * These tests require a live Postgres instance reachable via
 * `FRICK_DATABASE_URL`. When the env var is absent, every test in this suite
 * is skipped so the standard CI (SQLite-only) suite continues to pass without
 * Postgres infrastructure.
 *
 * To run locally:
 *   FRICK_DATABASE_URL=postgres://user:pass@localhost:5432/frick_test pnpm test
 *
 * The suite creates a fresh schema inside a randomly-named Postgres schema
 * (not the `public` schema) so it can run safely alongside an existing
 * database and multiple parallel test workers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { foundationSchema } from "@frick/protocol";
import {
  runFrameworkMigrationsPostgres,
  listAppliedMigrationsPostgres,
} from "../src/storage/pg-migrations.js";
import {
  FRAMEWORK_MIGRATIONS_PG,
  FRAMEWORK_TABLES_PG,
} from "../src/storage/pg-framework-migrations.js";
import {
  computeMigrationChecksum,
  FrickMigrationChecksumError,
  FrickMigrationRevisionError,
  FrickMigrationError,
  type FrameworkMigration,
} from "../src/storage/migrations.js";

const DATABASE_URL = process.env.FRICK_DATABASE_URL;
const skip = !DATABASE_URL;

// Random schema name per test run so parallel workers don't collide.
let testSchema: string;
let pool: Pool;

async function listTablesInSchema(pool: Pool, schema: string): Promise<string[]> {
  const result = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
    [schema],
  );
  return result.rows.map((r) => r.tablename);
}

beforeEach(async () => {
  if (skip) return;
  testSchema = `frick_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  pool = new Pool({ connectionString: DATABASE_URL });
  await pool.query(`CREATE SCHEMA "${testSchema}"`);
  await pool.query(`SET search_path TO "${testSchema}"`);
  // Set search_path on every new connection in the pool.
  pool.on("connect", (client) => {
    client.query(`SET search_path TO "${testSchema}"`).catch(() => {});
  });
});

afterEach(async () => {
  if (skip) return;
  await pool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
  await pool.end();
});

describe.skipIf(skip)("Postgres migration runner (requires FRICK_DATABASE_URL)", () => {
  it("applies all framework migrations on a fresh database", async () => {
    const result = await runFrameworkMigrationsPostgres(pool, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
      migrations: FRAMEWORK_MIGRATIONS_PG,
    });

    expect(result.applied.map((r) => r.id)).toEqual(
      FRAMEWORK_MIGRATIONS_PG.map((m) => m.id),
    );
    expect(result.alreadyApplied).toHaveLength(0);

    // Every applied row should have a valid checksum and non-negative duration.
    for (const row of result.applied) {
      expect(row.checksum).toMatch(/^sha256-[0-9a-f]{64}$/);
      expect(row.durationMs).toBeGreaterThanOrEqual(0);
    }

    // Verify the ledger itself is present.
    const tables = await listTablesInSchema(pool, testSchema);
    expect(tables).toContain("frick_migrations");

    // Spot-check a handful of tables defined across the migrations.
    for (const table of [
      "objects",
      "stream_events",
      "auth_accounts",
      "tenants",
      "jobs",
      "search_indexes",
    ]) {
      expect(tables).toContain(table);
    }
  });

  it("is idempotent across repeated runs", async () => {
    const first = await runFrameworkMigrationsPostgres(pool, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
      migrations: FRAMEWORK_MIGRATIONS_PG,
    });
    const second = await runFrameworkMigrationsPostgres(pool, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
      migrations: FRAMEWORK_MIGRATIONS_PG,
    });

    expect(first.applied).toHaveLength(FRAMEWORK_MIGRATIONS_PG.length);
    expect(second.applied).toHaveLength(0);
    expect(second.alreadyApplied).toHaveLength(FRAMEWORK_MIGRATIONS_PG.length);

    const listed = await listAppliedMigrationsPostgres(pool);
    expect(listed).toHaveLength(FRAMEWORK_MIGRATIONS_PG.length);
  });

  it("reports alreadyApplied IDs correctly on second run", async () => {
    await runFrameworkMigrationsPostgres(pool, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
      migrations: FRAMEWORK_MIGRATIONS_PG,
    });
    const second = await runFrameworkMigrationsPostgres(pool, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
      migrations: FRAMEWORK_MIGRATIONS_PG,
    });

    expect(second.alreadyApplied.map((r) => r.id)).toEqual(
      FRAMEWORK_MIGRATIONS_PG.map((m) => m.id),
    );
  });

  it("refuses to boot when a recorded checksum has drifted", async () => {
    await runFrameworkMigrationsPostgres(pool, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
      migrations: FRAMEWORK_MIGRATIONS_PG,
    });

    // Tamper with the first migration's checksum.
    await pool.query(
      `UPDATE frick_migrations SET checksum = $1 WHERE id = $2`,
      ["sha256-deadbeef", FRAMEWORK_MIGRATIONS_PG[0]!.id],
    );

    await expect(
      runFrameworkMigrationsPostgres(pool, {
        supportedSchemaRevision: foundationSchema.schemaRevision,
        migrations: FRAMEWORK_MIGRATIONS_PG,
      }),
    ).rejects.toThrow(FrickMigrationChecksumError);

    try {
      await runFrameworkMigrationsPostgres(pool, {
        supportedSchemaRevision: foundationSchema.schemaRevision,
        migrations: FRAMEWORK_MIGRATIONS_PG,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(FrickMigrationChecksumError);
      const e = error as FrickMigrationChecksumError;
      expect(e.migrationId).toBe(FRAMEWORK_MIGRATIONS_PG[0]!.id);
      expect(e.recordedChecksum).toBe("sha256-deadbeef");
      expect(e.currentChecksum).toBe(computeMigrationChecksum(FRAMEWORK_MIGRATIONS_PG[0]!));
    }
  });

  it("refuses to boot when the database records a future schema revision", async () => {
    await runFrameworkMigrationsPostgres(pool, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
      migrations: FRAMEWORK_MIGRATIONS_PG,
    });

    await pool.query(
      `INSERT INTO frick_migrations (id, schema_revision, applied_at, checksum, duration_ms)
         VALUES ($1, $2, $3, $4, $5)`,
      ["9999_future_migration", 99, new Date().toISOString(), "sha256-future", 0],
    );

    await expect(
      runFrameworkMigrationsPostgres(pool, {
        supportedSchemaRevision: foundationSchema.schemaRevision,
        migrations: FRAMEWORK_MIGRATIONS_PG,
      }),
    ).rejects.toThrow(FrickMigrationRevisionError);
  });

  it("rolls back the ledger insert if the migration SQL fails", async () => {
    const broken: FrameworkMigration = {
      id: "0001_initial_foundation_tables",
      schemaRevision: 1,
      description: "broken",
      sql: "CREATE TABLE foo (id INTEGER); SELECT this_is_not_valid_sql_xyz;",
    };

    await expect(
      runFrameworkMigrationsPostgres(pool, {
        supportedSchemaRevision: 1,
        migrations: [broken],
      }),
    ).rejects.toThrow(FrickMigrationError);

    // The ledger was bootstrapped (frick_migrations exists) but no rows committed.
    const listed = await listAppliedMigrationsPostgres(pool);
    expect(listed).toHaveLength(0);
  });

  it("supports an explicit migrations override (extension point)", async () => {
    const extra: FrameworkMigration = {
      id: "9000_test_extra",
      schemaRevision: 1,
      description: "test extra table",
      sql: "CREATE TABLE test_extra_pg (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY);",
    };

    const result = await runFrameworkMigrationsPostgres(pool, {
      supportedSchemaRevision: 1,
      migrations: [...FRAMEWORK_MIGRATIONS_PG, extra],
    });

    expect(result.applied.map((r) => r.id)).toContain("9000_test_extra");
    const tables = await listTablesInSchema(pool, testSchema);
    expect(tables).toContain("test_extra_pg");
  });

  it("FRAMEWORK_TABLES_PG covers the same logical set as FRAMEWORK_MIGRATIONS_PG", () => {
    // Every table created across all migrations should appear in FRAMEWORK_TABLES_PG.
    // This is a static consistency check — no DB needed — so it runs regardless of skip.
    // (We're inside a skipIf block, so it still needs a DB. Extract to a separate suite
    // if you want it to run without PG.)
    expect(FRAMEWORK_TABLES_PG).toContain("frick_migrations");
    expect(FRAMEWORK_TABLES_PG).toContain("objects");
    expect(FRAMEWORK_TABLES_PG).toContain("search_indexes");
    expect(FRAMEWORK_TABLES_PG).toContain("grants");
  });

  it("each migration's checksum is a valid sha256- prefixed hex string", () => {
    for (const migration of FRAMEWORK_MIGRATIONS_PG) {
      const checksum = computeMigrationChecksum(migration);
      expect(checksum).toMatch(/^sha256-[0-9a-f]{64}$/);
    }
  });
});

// Static unit tests that don't need a Postgres connection.
describe("FRAMEWORK_MIGRATIONS_PG static checks", () => {
  it("migration count matches SQLite migration count", async () => {
    // Import the SQLite migrations to verify parity.
    const { FRAMEWORK_MIGRATIONS } = await import("../src/storage/migrations.js");
    expect(FRAMEWORK_MIGRATIONS_PG).toHaveLength(FRAMEWORK_MIGRATIONS.length);
  });

  it("migration IDs match SQLite migration IDs (same order)", async () => {
    const { FRAMEWORK_MIGRATIONS } = await import("../src/storage/migrations.js");
    expect(FRAMEWORK_MIGRATIONS_PG.map((m) => m.id)).toEqual(
      FRAMEWORK_MIGRATIONS.map((m) => m.id),
    );
  });

  it("migration schemaRevisions match SQLite schemaRevisions", async () => {
    const { FRAMEWORK_MIGRATIONS } = await import("../src/storage/migrations.js");
    expect(FRAMEWORK_MIGRATIONS_PG.map((m) => m.schemaRevision)).toEqual(
      FRAMEWORK_MIGRATIONS.map((m) => m.schemaRevision),
    );
  });

  it("each migration has a non-empty description", () => {
    for (const migration of FRAMEWORK_MIGRATIONS_PG) {
      expect(migration.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("each migration has non-empty SQL", () => {
    for (const migration of FRAMEWORK_MIGRATIONS_PG) {
      expect(migration.sql.trim().length).toBeGreaterThan(0);
    }
  });

  it("FRAMEWORK_TABLES_PG has no duplicates", () => {
    const unique = new Set(FRAMEWORK_TABLES_PG);
    expect(unique.size).toBe(FRAMEWORK_TABLES_PG.length);
  });
});
