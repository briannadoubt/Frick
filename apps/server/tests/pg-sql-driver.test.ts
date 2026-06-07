/**
 * Postgres SqlDriver adapter — core data plane conformance (FR-119).
 *
 * The `rewritePlaceholders` unit checks always run. The store-integration
 * suite requires a live Postgres reachable via `FRICK_DATABASE_URL` and is
 * skipped otherwise (mirrors pg-migrations.test.ts), so the default
 * SQLite-only CI stays green. It proves the object, stream, and idempotency
 * stores — written against the `SqlDriver` seam — run unmodified on the
 * Postgres adapter.
 *
 * To run locally:
 *   FRICK_DATABASE_URL=postgres://postgres:frick@localhost:5433/frick_test pnpm --filter @fricken/server exec vitest run tests/pg-sql-driver.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { productTestSchema } from "@fricken/protocol";
import { PgSqlDriver, rewritePlaceholders } from "../src/storage/pg-sql-driver.js";
import { ObjectStore } from "../src/storage/object-store.js";
import { StreamStore } from "../src/storage/stream-store.js";
import { runFrameworkMigrationsPostgres } from "../src/storage/pg-migrations.js";
import { FRAMEWORK_MIGRATIONS_PG } from "../src/storage/pg-framework-migrations.js";

describe("rewritePlaceholders", () => {
  it("rewrites anonymous ? to $n left to right", () => {
    expect(rewritePlaceholders("SELECT * FROM t WHERE a = ? AND b = ?")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
  });

  it("leaves ? inside single-quoted literals alone", () => {
    expect(rewritePlaceholders("SELECT '? literal' WHERE a = ?")).toBe(
      "SELECT '? literal' WHERE a = $1",
    );
  });

  it("handles no placeholders", () => {
    expect(rewritePlaceholders("SELECT 1")).toBe("SELECT 1");
  });
});

const DATABASE_URL = process.env.FRICK_DATABASE_URL;
const skip = !DATABASE_URL;

let pool: Pool;
let testSchema: string;
let driver: PgSqlDriver;

beforeEach(async () => {
  if (skip) return;
  testSchema = `frick_pgdrv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  pool = new Pool({ connectionString: DATABASE_URL });
  await pool.query(`CREATE SCHEMA "${testSchema}"`);
  pool.on("connect", (client) => {
    client.query(`SET search_path TO "${testSchema}"`).catch(() => {});
  });
  await pool.query(`SET search_path TO "${testSchema}"`);
  await runFrameworkMigrationsPostgres(pool, {
    supportedSchemaRevision: productTestSchema.schemaRevision,
    migrations: FRAMEWORK_MIGRATIONS_PG,
  });
  driver = new PgSqlDriver(pool);
});

afterEach(async () => {
  if (skip) return;
  await pool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
  await pool.end();
});

describe.skipIf(skip)("PgSqlDriver — core stores on Postgres (requires FRICK_DATABASE_URL)", () => {
  it("ObjectStore upsert/read/list/delete round-trips", async () => {
    const objects = new ObjectStore(driver, productTestSchema);
    const write = (id: string, title: string) =>
      objects.upsertWithPolicy({
        tenantId: "tenant-a",
        objectType: "Conversation",
        objectId: id,
        value: { kind: "group", title, createdBy: "user-ada" },
      });

    expect((await write("c1", "One")).created).toBe(true);
    await write("c2", "Two");

    expect((await objects.read("tenant-a", "Conversation", "c1"))?.title).toBe("One");
    const list = await objects.list("tenant-a", "Conversation");
    expect(list.map((o) => o.id).sort()).toEqual(["c1", "c2"]);

    // Tenant isolation: a different tenant sees nothing.
    expect(await objects.list("tenant-b", "Conversation")).toEqual([]);

    // Update increments the version and overwrites.
    const updated = await write("c1", "One-updated");
    expect(updated.created).toBe(false);
    expect(updated.nextVersion).toBe(2);
    expect((await objects.read("tenant-a", "Conversation", "c1"))?.title).toBe("One-updated");
    expect(await objects.readVersion("tenant-a", "Conversation", "c1")).toBe(2);

    expect(await objects.delete("tenant-a", "Conversation", "c1")).toBe(true);
    expect(await objects.delete("tenant-a", "Conversation", "c1")).toBe(false);
    expect(await objects.read("tenant-a", "Conversation", "c1")).toBeUndefined();
  });

  it("StreamStore append + read with idempotent replay", async () => {
    const streams = new StreamStore(driver, productTestSchema);
    const base = {
      tenantId: "tenant-a",
      replicaId: "replica-1",
      stream: "MessageStream" as const,
      streamId: "conversation-1",
      event: "MessageSent" as const,
    };

    const first = await streams.append({
      ...base,
      requestId: "req-1",
      payload: { messageId: "m1", senderId: "user-ada", body: "hi", createdAt: "2026-06-01T00:00:00.000Z" },
    });
    expect(first.created).toBe(true);
    expect(first.event.sequence).toBe(1);

    const second = await streams.append({
      ...base,
      requestId: "req-2",
      payload: { messageId: "m2", senderId: "user-ada", body: "yo", createdAt: "2026-06-01T00:00:01.000Z" },
    });
    expect(second.event.sequence).toBe(2);

    // Idempotent replay: same (replicaId, requestId) returns the original event, no new row.
    const replay = await streams.append({
      ...base,
      requestId: "req-1",
      payload: { messageId: "m1", senderId: "user-ada", body: "hi", createdAt: "2026-06-01T00:00:00.000Z" },
    });
    expect(replay.created).toBe(false);
    expect(replay.event.eventId).toBe(first.event.eventId);

    const page = await streams.read("tenant-a", "MessageStream", "conversation-1", 0, 10);
    expect(page.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it("transaction() commits on success and rolls back on throw", async () => {
    await driver.exec(`CREATE TABLE tx_probe (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);

    await driver.transaction(async (tx) => {
      await tx.run("INSERT INTO tx_probe (id, label) VALUES (?, ?)", [1, "kept"]);
    });
    expect((await driver.get<{ label: string }>("SELECT label FROM tx_probe WHERE id = ?", [1]))?.label).toBe(
      "kept",
    );

    await expect(
      driver.transaction(async (tx) => {
        await tx.run("INSERT INTO tx_probe (id, label) VALUES (?, ?)", [2, "rolled-back"]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await driver.get("SELECT label FROM tx_probe WHERE id = ?", [2])).toBeUndefined();
  });

  it("normalizes boolean and undefined params like the SQLite driver", async () => {
    await driver.exec(`CREATE TABLE flag_probe (id INTEGER PRIMARY KEY, flag INTEGER, note TEXT)`);
    await driver.run("INSERT INTO flag_probe (id, flag, note) VALUES (?, ?, ?)", [1, true, undefined]);
    await driver.run("INSERT INTO flag_probe (id, flag, note) VALUES (?, ?, ?)", [2, false, "x"]);
    const rows = await driver.all<{ id: number; flag: number; note: string | null }>(
      "SELECT id, flag, note FROM flag_probe ORDER BY id",
    );
    expect(rows).toEqual([
      { id: 1, flag: 1, note: null },
      { id: 2, flag: 0, note: "x" },
    ]);
  });
});
