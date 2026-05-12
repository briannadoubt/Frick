/**
 * VAPID-authenticated web push adapter tests. The fetch impl is stubbed
 * so we don't dial real push services; the adapter is exercised
 * end-to-end (parse subscription, sign JWT, POST, translate response).
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { foundationSchema } from "@frick/protocol";
import { runFrameworkMigrations } from "../src/storage/migrations.js";
import { TenantSettingsStore } from "../src/storage/tenant-settings-store.js";
import { saveWebPushCredentials } from "../src/push/credentials.js";
import { createFrickWebPushAdapter, signVapidJwt } from "../src/push/web-push-adapter.js";
import type {
  FrickNotificationContext,
  FrickNotificationIntent,
  PushDeviceRegistration,
} from "../src/push/types.js";

function freshKey(): string {
  return randomBytes(32).toString("base64");
}

function generateP256Pem(): string {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return privateKey;
}

function setupTenant(env: NodeJS.ProcessEnv): { tenantSettings: TenantSettingsStore } {
  const db = new DatabaseSync(":memory:");
  runFrameworkMigrations(db, { supportedSchemaRevision: foundationSchema.schemaRevision });
  const tenantSettings = new TenantSettingsStore(db);
  saveWebPushCredentials(
    tenantSettings,
    "tenant-1",
    {
      subject: "mailto:ops@example.com",
      publicKey: "fake-public-key",
      privateKey: generateP256Pem(),
    },
    env,
  );
  return { tenantSettings };
}

const intent: FrickNotificationIntent = {
  intent: "message.new",
  tenantId: "tenant-1",
  recipientUserIds: ["user-1"],
  body: { title: "Hi", body: "Hello" },
};

function makeCtx(tenantSettings: TenantSettingsStore): FrickNotificationContext {
  return {
    tenantId: "tenant-1",
    intent,
    store: { tenantSettings } as unknown as FrickNotificationContext["store"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({}) as any }) as any } as any,
  };
}

function registration(token: string): PushDeviceRegistration {
  return {
    registrationId: "reg-1",
    tenantId: "tenant-1",
    userId: "user-1",
    deviceId: "dev-1",
    platform: "webPush",
    token,
    environment: "production",
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
}

describe("web push adapter", () => {
  it("returns skipped when credentials are missing", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const db = new DatabaseSync(":memory:");
    runFrameworkMigrations(db, { supportedSchemaRevision: foundationSchema.schemaRevision });
    const tenantSettings = new TenantSettingsStore(db);
    const adapter = createFrickWebPushAdapter({
      env,
      fetch: (async () => new Response()) as typeof fetch,
    });
    const delivery = await adapter.send(intent, registration(JSON.stringify({ endpoint: "https://example.test/p/abc" })), makeCtx(tenantSettings));
    expect(delivery.status).toBe("skipped");
    expect(delivery.error?.code).toBe("push.credentials.missing");
  });

  it("delivers a 201 response as success", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const { tenantSettings } = setupTenant(env);
    let observedAuth = "";
    const fetchImpl: typeof fetch = async (url, init) => {
      observedAuth = String((init?.headers as Record<string, string>)?.authorization ?? "");
      expect(String(url)).toBe("https://push.example.test/p/abc");
      return new Response(null, { status: 201 });
    };
    const adapter = createFrickWebPushAdapter({ env, fetch: fetchImpl });
    const delivery = await adapter.send(
      intent,
      registration(JSON.stringify({ endpoint: "https://push.example.test/p/abc", keys: { p256dh: "p", auth: "a" } })),
      makeCtx(tenantSettings),
    );
    expect(delivery.status).toBe("delivered");
    expect(observedAuth).toMatch(/^vapid t=.+ k=fake-public-key$/);
  });

  it("translates 410 Gone to push.unregistered", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const { tenantSettings } = setupTenant(env);
    const adapter = createFrickWebPushAdapter({
      env,
      fetch: (async () => new Response(null, { status: 410 })) as typeof fetch,
    });
    const delivery = await adapter.send(
      intent,
      registration(JSON.stringify({ endpoint: "https://push.example.test/p/dead" })),
      makeCtx(tenantSettings),
    );
    expect(delivery.status).toBe("failed");
    expect(delivery.error?.code).toBe("push.unregistered");
  });

  it("rejects malformed subscription tokens with push.badDeviceToken", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const { tenantSettings } = setupTenant(env);
    const adapter = createFrickWebPushAdapter({
      env,
      fetch: (async () => new Response()) as typeof fetch,
    });
    const delivery = await adapter.send(intent, registration("not-json"), makeCtx(tenantSettings));
    expect(delivery.status).toBe("failed");
    expect(delivery.error?.code).toBe("push.badDeviceToken");
  });

  it("signs a VAPID JWT parseable as {typ, alg, aud, exp, sub} with a 64-byte signature", () => {
    const token = signVapidJwt(
      { subject: "mailto:ops@example.com", publicKey: "pub", privateKey: generateP256Pem() },
      "https://push.example.test",
      1_700_000_000,
    );
    const [h, p, s] = token.split(".");
    const header = JSON.parse(Buffer.from(h!, "base64").toString("utf8"));
    const payload = JSON.parse(Buffer.from(p!, "base64").toString("utf8"));
    expect(header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(payload).toEqual({ aud: "https://push.example.test", exp: 1_700_000_000, sub: "mailto:ops@example.com" });
    const sig = Buffer.from(s!.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    expect(sig.length).toBe(64);
  });
});
