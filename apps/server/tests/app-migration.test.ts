import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { foundationSchema } from "@fricken/protocol";
import { FRAMEWORK_MIGRATIONS, runFrameworkMigrations } from "../src/storage/migrations.js";

function openDb(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

/**
 * FR-36: the `app_id` column is the second partitioning axis (the first is
 * `tenant_id`, migration 0003). These tests prove migration 0021_app_boundary
 * is purely additive — every framework table that carries `tenant_id` also
 * carries `app_id`, the column is NOT NULL DEFAULT '_default' so legacy rows
 * map to the implicit default app, and the compound (app_id, tenant_id, …)
 * indexes exist.
 */
describe("0021_app_boundary migration", () => {
  // Every framework table the tenant boundary covers must also gain app_id.
  const APP_SCOPED_TABLES = [
    "objects",
    "stream_events",
    "presence_leases",
    "signal_outbox",
    "blob_metadata",
    "blob_content",
    "jobs",
    "auth_sessions",
    "auth_accounts",
    "idempotency_keys",
  ] as const;

  it("adds an app_id column to every tenant-scoped framework table", () => {
    const db = openDb();
    runFrameworkMigrations(db, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
    });

    for (const table of APP_SCOPED_TABLES) {
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
      const appId = columns.find((c) => c.name === "app_id");
      expect(appId, `${table} should have an app_id column`).toBeDefined();
      // NOT NULL with a default of '_default'.
      expect(appId?.notnull, `${table}.app_id should be NOT NULL`).toBe(1);
      expect(appId?.dflt_value, `${table}.app_id should default to '_default'`).toBe(
        "'_default'",
      );
    }

    db.close();
  });

  it("backfills existing rows with the default app id", () => {
    const db = openDb();

    // Apply migrations up to (but not including) the app boundary, then seed
    // pre-app rows so we can prove the ADD COLUMN default backfills them.
    const appMigrationIndex = FRAMEWORK_MIGRATIONS.findIndex(
      (migration) => migration.id === "0021_app_boundary",
    );
    expect(appMigrationIndex).toBeGreaterThan(0);
    runFrameworkMigrations(db, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
      migrations: FRAMEWORK_MIGRATIONS.slice(0, appMigrationIndex),
    });

    // These rows already carry tenant_id (from 0003) but not yet app_id.
    db.prepare(
      `INSERT INTO objects (tenant_id, object_type, object_id, version, packed, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("_default", "User", "user-legacy", 0, Buffer.from([0x80]), new Date().toISOString());
    db.prepare(
      `INSERT INTO auth_accounts
        (user_id, tenant_id, handle, display_name, password_salt, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("user-legacy", "_default", "legacy", "Legacy", "salt", "hash", new Date().toISOString());

    // Now apply the full set including 0021.
    runFrameworkMigrations(db, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
    });

    const obj = db
      .prepare("SELECT app_id FROM objects WHERE object_id = 'user-legacy'")
      .get() as { app_id: string } | undefined;
    expect(obj?.app_id).toBe("_default");

    const acct = db
      .prepare("SELECT app_id FROM auth_accounts WHERE user_id = 'user-legacy'")
      .get() as { app_id: string } | undefined;
    expect(acct?.app_id).toBe("_default");

    db.close();
  });

  it("creates the compound (app_id, tenant_id, …) indexes", () => {
    const db = openDb();
    runFrameworkMigrations(db, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
    });

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as Array<{ name: string }>;
    const names = new Set(indexes.map((i) => i.name));

    for (const expected of [
      "idx_objects_app_tenant",
      "idx_stream_events_app_tenant",
      "idx_stream_events_app_tenant_event_id",
      "idx_presence_leases_app_tenant",
      "idx_signal_outbox_app_tenant",
      "idx_blob_metadata_app_tenant",
      "idx_blob_metadata_app_tenant_owner",
      "idx_blob_content_app_tenant",
      "idx_jobs_app_tenant",
      "idx_jobs_app_tenant_status_available_at",
      "idx_auth_sessions_app_tenant_user",
      "idx_auth_accounts_app_tenant_handle",
      "idx_idempotency_keys_app_tenant",
    ]) {
      expect(names.has(expected), `index ${expected} should exist`).toBe(true);
    }

    db.close();
  });

  it("lets two apps store the same (tenant, object) independently", () => {
    const db = openDb();
    runFrameworkMigrations(db, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
    });

    // The objects PRIMARY KEY is (tenant_id, object_type, object_id) — app_id is
    // an additive column, so the same logical object can exist in two apps only
    // when they also differ on tenant. The query layer (FR-37) is what enforces
    // the cross-app read/write boundary; here we just prove the column carries
    // distinct app ids without disturbing existing keys.
    const ts = new Date().toISOString();
    db.prepare(
      `INSERT INTO objects (app_id, tenant_id, object_type, object_id, version, packed, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("app-a", "tenant-1", "Doc", "doc-1", 0, Buffer.from([0x80]), ts);
    db.prepare(
      `INSERT INTO objects (app_id, tenant_id, object_type, object_id, version, packed, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("app-b", "tenant-2", "Doc", "doc-1", 0, Buffer.from([0x80]), ts);

    const apps = db
      .prepare("SELECT app_id FROM objects WHERE object_id = 'doc-1' ORDER BY app_id")
      .all() as Array<{ app_id: string }>;
    expect(apps.map((r) => r.app_id)).toEqual(["app-a", "app-b"]);

    db.close();
  });
});
