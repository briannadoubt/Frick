/**
 * FR-28: multi-node job workers must not double-execute. The job claim uses
 * `FOR UPDATE SKIP LOCKED` on Postgres so concurrent claimers (simulating
 * separate nodes hitting the shared database) take disjoint job sets.
 *
 * Requires a live Postgres via FRICK_DATABASE_URL; skipped otherwise. Without
 * the SKIP LOCKED clause this test fails — the same job id comes back from two
 * concurrent claims.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { foundationSchema } from "@fricken/protocol";
import { PgSqlDriver } from "../src/storage/pg-sql-driver.js";
import { runFrameworkMigrationsPostgres } from "../src/storage/pg-migrations.js";
import { FRAMEWORK_MIGRATIONS_PG } from "../src/storage/pg-framework-migrations.js";
import { JobStore } from "../src/storage/job-store.js";

const DATABASE_URL = process.env.FRICK_DATABASE_URL;
const skip = !DATABASE_URL;
const describeOrSkip = skip ? describe.skip : describe;

// Push the test schema onto every pooled connection at startup (libpq option),
// so concurrent claims never race a not-yet-applied `SET search_path`.
function urlWithSearchPath(base: string, schema: string): string {
  const u = new URL(base);
  u.searchParams.set("options", `-c search_path=${schema}`);
  return u.toString();
}

let adminPool: Pool;
let workPool: Pool;
let testSchema: string;
let jobs: JobStore;

beforeEach(async () => {
  if (skip) return;
  testSchema = `frick_pgjob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  adminPool = new Pool({ connectionString: DATABASE_URL });
  await adminPool.query(`CREATE SCHEMA "${testSchema}"`);
  workPool = new Pool({ connectionString: urlWithSearchPath(DATABASE_URL!, testSchema) });
  await runFrameworkMigrationsPostgres(workPool, {
    supportedSchemaRevision: foundationSchema.schemaRevision,
    migrations: FRAMEWORK_MIGRATIONS_PG,
  });
  jobs = new JobStore(new PgSqlDriver(workPool));
});

afterEach(async () => {
  if (skip) return;
  await workPool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
  await adminPool.end();
});

describeOrSkip("Postgres job claim (FR-28 multi-node)", () => {
  it("never hands the same job to two concurrent claimers", async () => {
    const JOB_COUNT = 60;
    for (let i = 0; i < JOB_COUNT; i++) {
      await jobs.enqueue({ tenantId: "_default", jobType: "work", payload: { i } });
    }

    // Eight concurrent "nodes", each looping claim() until the queue drains.
    const claimedIds: number[] = [];
    const workers = Array.from({ length: 8 }, (_unused, w) =>
      (async () => {
        for (;;) {
          const rows = await jobs.claim(`worker-${w}`, "work", 7);
          if (rows.length === 0) break;
          for (const row of rows) claimedIds.push(row.id);
        }
      })(),
    );
    await Promise.all(workers);

    // Every job claimed exactly once: no duplicates, full coverage.
    expect(claimedIds.length).toBe(JOB_COUNT);
    expect(new Set(claimedIds).size).toBe(JOB_COUNT);
  });
});
