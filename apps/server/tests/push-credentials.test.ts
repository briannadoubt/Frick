/**
 * Round-trip and error-shape tests for the per-tenant push credentials
 * module. The encryption is the only piece worth unit-testing here — the
 * adapter integration is exercised end-to-end in `push-apns.test.ts` and
 * `push-fcm.test.ts`.
 */
import { SqliteSqlDriver } from "../src/storage/sql-driver.js";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { TenantSettingsStore } from "../src/storage/tenant-settings-store.js";
import {
  decryptCredential,
  encryptCredential,
  loadApnsCredentials,
  saveApnsCredentials,
  saveFcmCredentials,
  loadFcmCredentials,
} from "../src/push/credentials.js";
import { runFrameworkMigrations } from "../src/storage/migrations.js";
import { foundationSchema } from "@fricken/protocol";

function freshKey(): string {
  return randomBytes(32).toString("base64");
}

function openStore(): TenantSettingsStore {
  const db = new DatabaseSync(":memory:");
  runFrameworkMigrations(db, { supportedSchemaRevision: foundationSchema.schemaRevision });
  return new TenantSettingsStore(new SqliteSqlDriver(db));
}

describe("push credentials", () => {
  it("round-trips a JSON value through encrypt/decrypt", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const wrapped = encryptCredential({ secret: "hi", n: 7 }, env);
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    const unwrapped = decryptCredential<{ secret: string; n: number }>(wrapped.ciphertext, env);
    expect(unwrapped.ok).toBe(true);
    if (!unwrapped.ok) return;
    expect(unwrapped.value).toEqual({ secret: "hi", n: 7 });
  });

  it("returns disabled error when FRICK_PUSH_CRED_KEY is unset", async () => {
    const result = encryptCredential({}, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("push.credentials.disabled");
  });

  it("rejects a wrong-size key", async () => {
    const env = { FRICK_PUSH_CRED_KEY: Buffer.from("too short").toString("base64") };
    const result = encryptCredential({}, env);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("push.credentials.disabled");
  });

  it("returns corrupt error when ciphertext is tampered", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const wrapped = encryptCredential({ ok: 1 }, env);
    if (!wrapped.ok) throw new Error("encrypt failed");
    // Flip a byte mid-envelope (avoid the IV prefix — flipping IV produces an
    // auth-tag mismatch with the same code).
    const buf = Buffer.from(wrapped.ciphertext, "base64");
    buf[buf.length - 5] ^= 0x01;
    const tampered = buf.toString("base64");
    const unwrapped = decryptCredential(tampered, env);
    expect(unwrapped.ok).toBe(false);
    if (unwrapped.ok) return;
    expect(unwrapped.error.code).toBe("push.credentials.corrupt");
  });

  it("returns missing error when no credential is stored", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const store = openStore();
    const result = await loadApnsCredentials(store, "tenant-1", env);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("push.credentials.missing");
  });

  it("save/load round-trips APNs credentials per tenant", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const store = openStore();
    const save = await saveApnsCredentials(
      store,
      "tenant-1",
      {
        keyId: "ABCD123456",
        teamId: "TEAM12345",
        bundleId: "com.example.app",
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
      },
      env,
    );
    expect(save.ok).toBe(true);
    const load = await loadApnsCredentials(store, "tenant-1", env);
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.value.keyId).toBe("ABCD123456");
    expect(load.value.bundleId).toBe("com.example.app");
  });

  it("save/load round-trips FCM credentials per tenant", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const store = openStore();
    const save = await saveFcmCredentials(
      store,
      "tenant-1",
      {
        projectId: "frick-test",
        clientEmail: "svc@frick-test.iam.gserviceaccount.com",
        privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
      },
      env,
    );
    expect(save.ok).toBe(true);
    const load = await loadFcmCredentials(store, "tenant-1", env);
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.value.projectId).toBe("frick-test");
  });
});
