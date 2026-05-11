import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { foundationSchema } from "@frick/protocol";
import {
  FRAMEWORK_TABLES,
  listAppliedMigrations,
  runFrameworkMigrations,
} from "../src/storage/migrations.js";
import { FrickResetRefusedError, resetFrickDatabase } from "../src/storage/reset.js";

function listTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe("resetFrickDatabase", () => {
  it("drops all framework tables when confirmed in development", () => {
    const db = new DatabaseSync(":memory:");
    runFrameworkMigrations(db, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
    });

    // Seed something so we can prove the rows go away.
    db.prepare(
      `INSERT INTO objects (object_type, object_id, version, packed, updated_at)
        VALUES (?, ?, ?, ?, ?)`,
    ).run("User", "user-test", 0, Buffer.from([0x80]), new Date().toISOString());

    resetFrickDatabase({ db, env: "development", confirmDevReset: true });

    const remaining = listTables(db);
    for (const table of FRAMEWORK_TABLES) {
      expect(remaining).not.toContain(table);
    }

    // After reset, the runner re-applies the initial migration cleanly.
    const result = runFrameworkMigrations(db, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
    });
    expect(result.applied).toHaveLength(10);
    expect(listAppliedMigrations(db)).toHaveLength(10);
    db.close();
  });

  it("refuses without the confirmDevReset flag", () => {
    const db = new DatabaseSync(":memory:");
    runFrameworkMigrations(db, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
    });

    expect(() =>
      resetFrickDatabase({ db, env: "development", confirmDevReset: false }),
    ).toThrow(FrickResetRefusedError);

    try {
      resetFrickDatabase({ db, env: "development", confirmDevReset: false });
    } catch (error) {
      expect(error).toBeInstanceOf(FrickResetRefusedError);
      expect((error as FrickResetRefusedError).reason).toBe("missing_confirmation");
    }

    // Tables still exist.
    expect(listTables(db)).toContain("objects");
    db.close();
  });

  it("refuses outside development env even when confirmed", () => {
    const db = new DatabaseSync(":memory:");
    runFrameworkMigrations(db, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
    });

    for (const env of ["production", "staging", undefined]) {
      expect(() =>
        resetFrickDatabase({ db, env, confirmDevReset: true }),
      ).toThrow(FrickResetRefusedError);
    }

    try {
      resetFrickDatabase({ db, env: "production", confirmDevReset: true });
    } catch (error) {
      expect((error as FrickResetRefusedError).reason).toBe("production_env");
    }

    expect(listTables(db)).toContain("objects");
    db.close();
  });
});
