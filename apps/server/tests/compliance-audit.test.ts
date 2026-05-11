import { DatabaseSync } from "node:sqlite";
import { foundationSchema } from "@frick/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";
import { AdminAuditStore } from "../src/storage/admin-audit-store.js";
import { runFrameworkMigrations } from "../src/storage/migrations.js";

const ADMIN_TOKEN = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";
let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runFrameworkMigrations(db, { supportedSchemaRevision: foundationSchema.schemaRevision });
  return db;
}

const FINGERPRINT = "abc123def456";

describe("admin audit chain", () => {
  it("populates previous_hash + entry_hash on every record", () => {
    const db = openDb();
    const store = new AdminAuditStore(db);

    const first = store.record({
      adminTokenFingerprint: FINGERPRINT,
      action: "tenants.create",
      target: "t1",
      outcome: "allow",
    });
    expect(first.previousHash).toBe("");
    expect(first.entryHash).toMatch(/^[0-9a-f]{64}$/);

    const second = store.record({
      adminTokenFingerprint: FINGERPRINT,
      action: "tenants.archive",
      target: "t1",
      outcome: "allow",
    });
    expect(second.previousHash).toBe(first.entryHash);
    expect(second.entryHash).not.toBe(first.entryHash);

    db.close();
  });

  it("verifyChain returns valid after a sequence of inserts", () => {
    const db = openDb();
    const store = new AdminAuditStore(db);
    for (let i = 0; i < 5; i += 1) {
      store.record({
        adminTokenFingerprint: FINGERPRINT,
        action: "tenants.create",
        target: `t-${i}`,
        outcome: "allow",
        detail: JSON.stringify({ i }),
      });
    }
    expect(store.verifyChain()).toEqual({ valid: true });
    db.close();
  });

  it("verifyChain detects tampering with action field", () => {
    const db = openDb();
    const store = new AdminAuditStore(db);
    store.record({
      adminTokenFingerprint: FINGERPRINT,
      action: "tenants.create",
      target: "t-a",
      outcome: "allow",
    });
    const second = store.record({
      adminTokenFingerprint: FINGERPRINT,
      action: "tenants.archive",
      target: "t-a",
      outcome: "allow",
    });
    store.record({
      adminTokenFingerprint: FINGERPRINT,
      action: "tenants.create",
      target: "t-b",
      outcome: "allow",
    });

    // Tamper: rewrite action on the second row.
    db.prepare("UPDATE admin_audit_log SET action = ? WHERE id = ?").run(
      "tenants.create",
      second.id,
    );

    const result = store.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(second.id);
    db.close();
  });

  it("compliance manifest endpoint describes the available evidence", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/admin/compliance/manifest`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, Record<string, unknown>>;
    expect(body.audit?.hashChained).toBe(true);
    expect(body.audit?.table).toBe("admin_audit_log");
    expect(body.dataSubject?.exportEndpoint).toBe("/_frick/admin/data-subject");
    expect(body.dataSubject?.eraseEndpoint).toBe("/_frick/admin/data-subject/erase");
    expect(typeof body.retention?.idempotencyKeysDefaultMs).toBe("number");
  });

  it("audit verify endpoint returns 200 valid on intact chain, 409 broken on tamper", async () => {
    app = await startServer();
    // Trigger a couple admin actions to populate the chain.
    await fetch(`${app.httpUrl}/_frick/admin/tenants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tenantId: "tenant-verify-1" }),
    });

    let response = await fetch(`${app.httpUrl}/_frick/admin/compliance/audit/verify`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ valid: true });

    // Tamper.
    app.store.db
      .prepare("UPDATE admin_audit_log SET action = 'tampered' WHERE id = 1")
      .run();

    response = await fetch(`${app.httpUrl}/_frick/admin/compliance/audit/verify`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { valid: boolean; brokenAt?: number };
    expect(body.valid).toBe(false);
    expect(body.brokenAt).toBe(1);
  });

  it("verifyChain detects tampering with entry_hash itself", () => {
    const db = openDb();
    const store = new AdminAuditStore(db);
    const first = store.record({
      adminTokenFingerprint: FINGERPRINT,
      action: "tenants.create",
      target: "t-a",
      outcome: "allow",
    });
    db.prepare("UPDATE admin_audit_log SET entry_hash = ? WHERE id = ?").run(
      "0".repeat(64),
      first.id,
    );
    const result = store.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(first.id);
    db.close();
  });
});

async function startServer() {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    config: { adminToken: ADMIN_TOKEN },
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    store: server.store,
    close: server.close,
  };
}
