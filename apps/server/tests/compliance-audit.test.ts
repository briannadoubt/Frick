import { DatabaseSync } from "node:sqlite";
import { foundationSchema } from "@frick/protocol";
import { describe, expect, it } from "vitest";
import { AdminAuditStore } from "../src/storage/admin-audit-store.js";
import { runFrameworkMigrations } from "../src/storage/migrations.js";

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
