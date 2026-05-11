import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { foundationSchema } from "@frick/protocol";
import {
  FRAMEWORK_MIGRATIONS,
  listAppliedMigrations,
  runFrameworkMigrations,
  type FrameworkMigration,
} from "../src/storage/migrations.js";
import { FrickStore } from "../src/store.js";

const FOUNDATION_TABLES = [
  "schema_versions",
  "objects",
  "stream_events",
  "idempotency_keys",
  "presence_leases",
  "signal_outbox",
  "blob_metadata",
  "blob_content",
  "conversation_inbox",
  "jobs",
  "auth_sessions",
  "auth_accounts",
];

function openDb(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function listTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe("framework migration runner", () => {
  it("applies the initial migration on a fresh database", () => {
    const db = openDb();

    const result = runFrameworkMigrations(db, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
    });

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.id).toBe("0001_initial_foundation_tables");
    expect(result.applied[0]?.schemaRevision).toBe(1);
    expect(result.applied[0]?.checksum).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(result.applied[0]?.durationMs).toBeGreaterThanOrEqual(0);

    const applied = listAppliedMigrations(db);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.id).toBe("0001_initial_foundation_tables");

    const tables = listTables(db);
    for (const table of FOUNDATION_TABLES) {
      expect(tables).toContain(table);
    }
    expect(tables).toContain("frick_migrations");

    db.close();
  });

  it("is idempotent across repeated runs", () => {
    const db = openDb();

    const first = runFrameworkMigrations(db, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
    });
    const second = runFrameworkMigrations(db, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
    });

    expect(first.applied).toHaveLength(1);
    expect(second.applied).toHaveLength(0);
    expect(second.alreadyApplied).toHaveLength(1);
    expect(listAppliedMigrations(db)).toHaveLength(1);

    db.close();
  });

  it("the FrickStore constructor wires the runner so server boot creates tables", () => {
    const store = new FrickStore({ path: ":memory:", seed: false });
    // FrickStore exposes #db privately; reach in via store operations to prove
    // tables exist. listObjects on a known type should return an empty array
    // rather than throwing — that confirms the table is present.
    expect(store.listObjects("Conversation")).toEqual([]);
    store.close();
  });

  it("rolls back the ledger insert if the migration SQL fails", () => {
    const db = openDb();
    const broken: FrameworkMigration = {
      id: "0001_initial_foundation_tables",
      schemaRevision: 1,
      description: "broken",
      sql: "CREATE TABLE foo (id INTEGER); SELECT this_is_not_valid_sql;",
    };

    expect(() =>
      runFrameworkMigrations(db, {
        supportedSchemaRevision: 1,
        migrations: [broken],
      }),
    ).toThrow();

    // The migrations ledger exists (bootstrap CREATE) but holds no rows.
    expect(listAppliedMigrations(db)).toHaveLength(0);
    db.close();
  });

  it("supports an explicit migrations override (extension point for app registries)", () => {
    const db = openDb();
    const extra: FrameworkMigration = {
      id: "9000_test_extra",
      schemaRevision: 1,
      description: "test extra",
      sql: "CREATE TABLE test_extra (id INTEGER PRIMARY KEY);",
    };

    const result = runFrameworkMigrations(db, {
      supportedSchemaRevision: 1,
      migrations: [...FRAMEWORK_MIGRATIONS, extra],
    });

    expect(result.applied.map((row) => row.id)).toEqual([
      "0001_initial_foundation_tables",
      "9000_test_extra",
    ]);
    expect(listTables(db)).toContain("test_extra");
    db.close();
  });
});
