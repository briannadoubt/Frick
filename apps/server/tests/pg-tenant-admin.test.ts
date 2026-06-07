/**
 * Postgres SqlDriver adapter — tenant/admin/runtime stores conformance (FR-121).
 *
 * Proves the tenant, tenant-settings, admin-audit, and push-registration
 * stores run on the Postgres adapter. Requires a live Postgres via
 * `FRICK_DATABASE_URL`; skipped otherwise.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { foundationSchema } from "@fricken/protocol";
import { PgSqlDriver } from "../src/storage/pg-sql-driver.js";
import { runFrameworkMigrationsPostgres } from "../src/storage/pg-migrations.js";
import { FRAMEWORK_MIGRATIONS_PG } from "../src/storage/pg-framework-migrations.js";
import { TenantStore } from "../src/storage/tenant-store.js";
import { TenantSettingsStore } from "../src/storage/tenant-settings-store.js";
import { AdminAuditStore } from "../src/storage/admin-audit-store.js";
import { PushRegistrationStore } from "../src/storage/push-registration-store.js";

const DATABASE_URL = process.env.FRICK_DATABASE_URL;
const skip = !DATABASE_URL;

let pool: Pool;
let testSchema: string;
let driver: PgSqlDriver;

beforeEach(async () => {
  if (skip) return;
  testSchema = `frick_pgtadmin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
  driver = new PgSqlDriver(pool);
});

afterEach(async () => {
  if (skip) return;
  await pool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
  await pool.end();
});

describe.skipIf(skip)("PgSqlDriver — tenant/admin stores on Postgres (requires FRICK_DATABASE_URL)", () => {
  it("TenantStore create / ensure (idempotent) / get / list / archive", async () => {
    const tenants = new TenantStore(driver);
    const row = await tenants.create("tenant-a", "Tenant A");
    expect(row.tenantId).toBe("tenant-a");

    // ensure() is idempotent — the ON CONFLICT DO NOTHING path must not throw
    // or duplicate when the tenant already exists.
    await tenants.ensure("tenant-a");
    await tenants.ensure("tenant-b");

    expect((await tenants.get("tenant-a"))?.displayName).toBe("Tenant A");
    const ids = (await tenants.list()).map((t) => t.tenantId);
    expect(ids).toContain("tenant-a");
    expect(ids).toContain("tenant-b");

    await tenants.archive("tenant-b");
    expect((await tenants.list()).map((t) => t.tenantId)).not.toContain("tenant-b");
    expect((await tenants.list(true)).map((t) => t.tenantId)).toContain("tenant-b");
  });

  it("TenantSettingsStore set / get / list / delete", async () => {
    const settings = new TenantSettingsStore(driver);
    await settings.set("tenant-a", "retentionMs", 60000);
    await settings.set("tenant-a", "feature", { enabled: true });

    expect(await settings.get("tenant-a", "retentionMs")).toBe(60000);
    expect(await settings.get("tenant-a", "feature")).toEqual({ enabled: true });
    expect(await settings.list("tenant-a")).toEqual({ retentionMs: 60000, feature: { enabled: true } });

    // Upsert overwrites (ON CONFLICT DO UPDATE).
    await settings.set("tenant-a", "retentionMs", 120000);
    expect(await settings.get("tenant-a", "retentionMs")).toBe(120000);

    await settings.delete("tenant-a", "retentionMs");
    expect(await settings.get("tenant-a", "retentionMs")).toBeUndefined();
  });

  it("AdminAuditStore record returns the generated id and chains hashes", async () => {
    const audit = new AdminAuditStore(driver);
    const first = await audit.record({
      adminTokenFingerprint: "abc123",
      action: "tenants.create",
      target: "tenant-a",
      outcome: "allow",
    });
    // RETURNING id must surface a real generated id (not 0) on Postgres.
    expect(first.id).toBeGreaterThan(0);
    expect(first.previousHash).toBe("");
    expect(first.entryHash).toMatch(/^[0-9a-f]{64}$/);

    const second = await audit.record({
      adminTokenFingerprint: "abc123",
      action: "tenants.create",
      target: "tenant-b",
      outcome: "allow",
    });
    expect(second.id).toBeGreaterThan(first.id);
    // The chain links the second entry to the first.
    expect(second.previousHash).toBe(first.entryHash);

    const entries = await audit.list({});
    expect(entries.map((e) => e.target)).toEqual(["tenant-b", "tenant-a"]);
    expect((await audit.verifyChain()).valid).toBe(true);
  });

  it("PushRegistrationStore register / listByUser / revoke", async () => {
    const push = new PushRegistrationStore(driver);
    const reg = await push.register({
      tenantId: "tenant-a",
      userId: "user-ada",
      deviceId: "device-1",
      platform: "apns",
      token: "device-token-1",
      environment: "production",
    });
    expect(reg.registrationId).toMatch(/^push-/);

    expect((await push.listByUser("tenant-a", "user-ada")).map((r) => r.token)).toEqual([
      "device-token-1",
    ]);

    // Re-registering the same device updates in place (no duplicate row).
    await push.register({
      tenantId: "tenant-a",
      userId: "user-ada",
      deviceId: "device-1",
      platform: "apns",
      token: "device-token-2",
      environment: "production",
    });
    expect((await push.listByUser("tenant-a", "user-ada")).map((r) => r.token)).toEqual([
      "device-token-2",
    ]);

    expect(await push.revoke(reg.registrationId, "tenant-a")).toBe(true);
    expect(await push.listByUser("tenant-a", "user-ada")).toEqual([]);
  });
});
