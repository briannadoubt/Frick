/**
 * Postgres full-text search adapter conformance (FR-24).
 *
 * Proves the `createPgFtsSearchAdapter` (tsvector / GIN) implements the same
 * async `FrickSearchAdapter` seam as the SQLite FTS5 adapter. Requires a live
 * Postgres via `FRICK_DATABASE_URL`; skipped otherwise.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { foundationSchema } from "@fricken/protocol";
import { PgSqlDriver } from "../src/storage/pg-sql-driver.js";
import { runFrameworkMigrationsPostgres } from "../src/storage/pg-migrations.js";
import { FRAMEWORK_MIGRATIONS_PG } from "../src/storage/pg-framework-migrations.js";
import { createPgFtsSearchAdapter } from "../src/search/pg-fts.js";
import type { FrickSearchAdapter } from "../src/search/types.js";

const DATABASE_URL = process.env.FRICK_DATABASE_URL;
const skip = !DATABASE_URL;

let pool: Pool;
let testSchema: string;
let adapter: FrickSearchAdapter;

beforeEach(async () => {
  if (skip) return;
  testSchema = `frick_pgsearch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  pool = new Pool({ connectionString: DATABASE_URL });
  await pool.query(`CREATE SCHEMA "${testSchema}"`);
  pool.on("connect", (client) => {
    client.query(`SET search_path TO "${testSchema}"`).catch(() => {});
  });
  await pool.query(`SET search_path TO "${testSchema}"`);
  await runFrameworkMigrationsPostgres(pool, {
    supportedSchemaRevision: foundationSchema.schemaRevision,
    migrations: FRAMEWORK_MIGRATIONS_PG,
  });
  adapter = createPgFtsSearchAdapter(new PgSqlDriver(pool));
});

afterEach(async () => {
  if (skip) return;
  await pool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
  await pool.end();
});

describe.skipIf(skip)("createPgFtsSearchAdapter (requires FRICK_DATABASE_URL)", () => {
  it("indexes docs and matches full-text queries, tenant-scoped", async () => {
    await adapter.upsert("tenant-a", "notes", {
      docId: "n1",
      text: "the quick brown fox jumps",
      fields: { author: "ada" },
    });
    await adapter.upsert("tenant-a", "notes", {
      docId: "n2",
      text: "lazy dogs sleep all day",
      fields: { author: "bob" },
    });
    // Another tenant's doc must never leak into tenant-a results.
    await adapter.upsert("tenant-b", "notes", {
      docId: "n3",
      text: "the quick rabbit",
      fields: { author: "eve" },
    });

    const fox = await adapter.query("tenant-a", { index: "notes", q: "fox" });
    expect(fox.total).toBe(1);
    expect(fox.hits.map((h) => h.docId)).toEqual(["n1"]);
    expect(fox.hits[0]!.fields).toEqual({ author: "ada" });
    expect(fox.hits[0]!.score).toBeGreaterThan(0);

    // "quick" matches n1 in tenant-a but NOT n3 (tenant-b).
    const quick = await adapter.query("tenant-a", { index: "notes", q: "quick" });
    expect(quick.hits.map((h) => h.docId)).toEqual(["n1"]);

    // No match.
    expect((await adapter.query("tenant-a", { index: "notes", q: "elephant" })).total).toBe(0);
    // Empty query → no hits, no error.
    expect((await adapter.query("tenant-a", { index: "notes", q: "   " })).total).toBe(0);
  });

  it("applies exact-match field filters", async () => {
    await adapter.upsert("tenant-a", "notes", {
      docId: "n1",
      text: "shared keyword here",
      fields: { author: "ada" },
    });
    await adapter.upsert("tenant-a", "notes", {
      docId: "n2",
      text: "shared keyword too",
      fields: { author: "bob" },
    });

    const all = await adapter.query("tenant-a", { index: "notes", q: "keyword" });
    expect(all.hits.map((h) => h.docId).sort()).toEqual(["n1", "n2"]);

    const onlyAda = await adapter.query("tenant-a", {
      index: "notes",
      q: "keyword",
      filter: { author: "ada" },
    });
    expect(onlyAda.hits.map((h) => h.docId)).toEqual(["n1"]);
  });

  it("delete and rebuild reset the index", async () => {
    await adapter.upsert("tenant-a", "notes", { docId: "n1", text: "deletable content", fields: {} });
    expect((await adapter.query("tenant-a", { index: "notes", q: "deletable" })).total).toBe(1);

    await adapter.delete("tenant-a", "notes", "n1");
    expect((await adapter.query("tenant-a", { index: "notes", q: "deletable" })).total).toBe(0);

    // Seed then rebuild from an empty source — clears everything.
    await adapter.upsert("tenant-a", "notes", { docId: "n2", text: "stale content", fields: {} });
    adapter.registerIndex({ name: "notes", source: { kind: "object", type: "Note" }, project: () => null });
    await adapter.rebuild("tenant-a", "notes", (async function* () {})());
    expect((await adapter.query("tenant-a", { index: "notes", q: "stale" })).total).toBe(0);
  });
});
