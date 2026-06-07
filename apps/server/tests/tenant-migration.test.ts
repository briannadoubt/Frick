import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { foundationSchema } from "@fricken/protocol";
import { FRAMEWORK_MIGRATIONS, runFrameworkMigrations } from "../src/storage/migrations.js";

function openDb(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

describe("0003_tenant_boundary migration", () => {
  it("backfills existing rows with the default tenant id", async () => {
    const db = openDb();

    // Apply migrations through 0002 only. Later migrations depend on the
    // tenant_id columns added by 0003, so this fixture must stop before it.
    const tenantMigrationIndex = FRAMEWORK_MIGRATIONS.findIndex(
      (migration) => migration.id === "0003_tenant_boundary",
    );
    expect(tenantMigrationIndex).toBeGreaterThan(0);
    runFrameworkMigrations(db, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
      migrations: FRAMEWORK_MIGRATIONS.slice(0, tenantMigrationIndex),
    });

    // Seed pre-tenant rows.
    db.prepare(
      `INSERT INTO objects (object_type, object_id, version, packed, updated_at)
        VALUES (?, ?, ?, ?, ?)`,
    ).run("User", "user-legacy", 0, Buffer.from([0x80]), new Date().toISOString());
    db.prepare(
      `INSERT INTO auth_accounts
        (user_id, handle, display_name, password_salt, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("user-legacy", "legacy", "Legacy", "salt", "hash", new Date().toISOString());

    // Now apply the full set including 0003.
    runFrameworkMigrations(db, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
    });

    const obj = db
      .prepare("SELECT tenant_id FROM objects WHERE object_id = 'user-legacy'")
      .get() as { tenant_id: string } | undefined;
    expect(obj?.tenant_id).toBe("_default");

    const acct = db
      .prepare("SELECT tenant_id FROM auth_accounts WHERE user_id = 'user-legacy'")
      .get() as { tenant_id: string } | undefined;
    expect(acct?.tenant_id).toBe("_default");

    db.close();
  });

  it("enforces handle uniqueness per tenant, not globally", async () => {
    const db = openDb();
    runFrameworkMigrations(db, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
    });

    // Same handle in two tenants: both succeed.
    db.prepare(
      `INSERT INTO auth_accounts
        (user_id, tenant_id, handle, display_name, password_salt, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("user-tenant-a-dorothy", "tenant-a", "dorothy", "Dorothy", "s", "h", new Date().toISOString());

    db.prepare(
      `INSERT INTO auth_accounts
        (user_id, tenant_id, handle, display_name, password_salt, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("user-tenant-b-dorothy", "tenant-b", "dorothy", "Dorothy", "s", "h", new Date().toISOString());

    // Same handle in the same tenant collides.
    expect(() =>
      db
        .prepare(
          `INSERT INTO auth_accounts
            (user_id, tenant_id, handle, display_name, password_salt, password_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "user-tenant-a-dorothy-dupe",
          "tenant-a",
          "DOROTHY",
          "Dupe",
          "s",
          "h",
          new Date().toISOString(),
        ),
    ).toThrow(/UNIQUE/i);

    db.close();
  });

  it("scopes idempotency_keys primary key to tenant", async () => {
    const db = openDb();
    runFrameworkMigrations(db, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
    });

    // Two tenants insert the same (replica_id, request_id) — must coexist.
    db.prepare(
      `INSERT INTO idempotency_keys
        (tenant_id, replica_id, request_id, result_event_id, created_at)
        VALUES (?, ?, ?, ?, ?)`,
    ).run("tenant-a", "replica-x", "request-1", "event-a", new Date().toISOString());
    db.prepare(
      `INSERT INTO idempotency_keys
        (tenant_id, replica_id, request_id, result_event_id, created_at)
        VALUES (?, ?, ?, ?, ?)`,
    ).run("tenant-b", "replica-x", "request-1", "event-b", new Date().toISOString());

    const rows = db
      .prepare(
        "SELECT result_event_id FROM idempotency_keys WHERE replica_id = 'replica-x' AND request_id = 'request-1' ORDER BY tenant_id",
      )
      .all() as Array<{ result_event_id: string }>;
    expect(rows.map((r) => r.result_event_id)).toEqual(["event-a", "event-b"]);

    db.close();
  });
});
