/**
 * VAPID-authenticated web push adapter tests. The fetch impl is stubbed
 * so we don't dial real push services; the adapter is exercised
 * end-to-end (parse subscription, sign JWT, POST, translate response).
 */
import { SqliteSqlDriver } from "../src/storage/sql-driver.js";
import { createECDH, generateKeyPairSync, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { foundationSchema } from "@fricken/protocol";
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

function generateP256Ecdh(): ReturnType<typeof createECDH> {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return ecdh;
}

function generateP256Pem(): string {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return privateKey;
}

async function setupTenant(env: NodeJS.ProcessEnv): Promise<{ tenantSettings: TenantSettingsStore }> {
  const db = new DatabaseSync(":memory:");
  runFrameworkMigrations(db, { supportedSchemaRevision: foundationSchema.schemaRevision });
  const tenantSettings = new TenantSettingsStore(new SqliteSqlDriver(db));
  await saveWebPushCredentials(
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

const publicResolver = async (): Promise<readonly { address: string }[]> => [{ address: "8.8.8.8" }];

describe("web push adapter", () => {
  it("returns skipped when credentials are missing", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const db = new DatabaseSync(":memory:");
    runFrameworkMigrations(db, { supportedSchemaRevision: foundationSchema.schemaRevision });
    const tenantSettings = new TenantSettingsStore(new SqliteSqlDriver(db));
    const adapter = createFrickWebPushAdapter({
      env,
      fetch: (async () => new Response()) as typeof fetch,
    });
    const delivery = await adapter.send(intent, registration(JSON.stringify({ endpoint: "https://example.test/p/abc" })), makeCtx(tenantSettings));
    expect(delivery.status).toBe("skipped");
    expect(delivery.error?.code).toBe("push.credentials.missing");
  });

  it("delivers a 201 response as success, sending an empty body when the subscription has no keys", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const { tenantSettings } = await setupTenant(env);
    let observedAuth = "";
    let observedBody: BodyInit | null | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      observedAuth = String((init?.headers as Record<string, string>)?.authorization ?? "");
      observedBody = init?.body;
      expect(String(url)).toBe("https://push.example.test/p/abc");
      expect((init?.headers as Record<string, string>)?.["content-length"]).toBe("0");
      return new Response(null, { status: 201 });
    };
    const adapter = createFrickWebPushAdapter({ env, fetch: fetchImpl, resolveHostname: publicResolver });
    const delivery = await adapter.send(
      {
        ...intent,
        body: { title: "Sensitive title", body: "Secret body", data: { secret: "do-not-send" } },
        deepLink: "/conversations/secret",
      },
      // No subscription keys → backward-compatible empty-body wake-up path.
      registration(JSON.stringify({ endpoint: "https://push.example.test/p/abc" })),
      makeCtx(tenantSettings),
    );
    expect(delivery.status).toBe("delivered");
    expect(observedAuth).toMatch(/^vapid t=.+ k=fake-public-key$/);
    expect(observedBody).toBe("");
  });

  it("encrypts the payload (aes128gcm) when the subscription carries p256dh + auth", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const { tenantSettings } = await setupTenant(env);
    const subscriberEcdh = generateP256Ecdh();
    let observedHeaders: Record<string, string> = {};
    let observedBody: BodyInit | null | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      observedHeaders = (init?.headers as Record<string, string>) ?? {};
      observedBody = init?.body;
      return new Response(null, { status: 201 });
    };
    const adapter = createFrickWebPushAdapter({ env, fetch: fetchImpl, resolveHostname: publicResolver });
    const delivery = await adapter.send(
      { ...intent, body: { title: "Hi", body: "Secret body" } },
      registration(
        JSON.stringify({
          endpoint: "https://push.example.test/p/abc",
          keys: {
            p256dh: subscriberEcdh.getPublicKey().toString("base64url"),
            auth: Buffer.alloc(16, 7).toString("base64url"),
          },
        }),
      ),
      makeCtx(tenantSettings),
    );
    expect(delivery.status).toBe("delivered");
    expect(observedHeaders["content-encoding"]).toBe("aes128gcm");
    expect(Buffer.isBuffer(observedBody)).toBe(true);
    const body = observedBody as Buffer;
    expect(observedHeaders["content-length"]).toBe(String(body.length));
    // RFC 8188 header: salt(16) || rs(4) || idlen(1) || keyid (65-byte point).
    expect(body.subarray(0, 16).length).toBe(16);
    expect(body[20]).toBe(65);
    expect(body[21]).toBe(0x04);
  });

  it("translates 410 Gone to push.unregistered", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const { tenantSettings } = await setupTenant(env);
    const adapter = createFrickWebPushAdapter({
      env,
      fetch: (async () => new Response(null, { status: 410 })) as typeof fetch,
      resolveHostname: publicResolver,
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
    const { tenantSettings } = await setupTenant(env);
    const adapter = createFrickWebPushAdapter({
      env,
      fetch: (async () => new Response()) as typeof fetch,
    });
    const delivery = await adapter.send(intent, registration("not-json"), makeCtx(tenantSettings));
    expect(delivery.status).toBe("failed");
    expect(delivery.error?.code).toBe("push.badDeviceToken");
  });

  it("rejects non-https subscription endpoints before fetch", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const { tenantSettings } = await setupTenant(env);
    let fetchCalled = false;
    const adapter = createFrickWebPushAdapter({
      env,
      fetch: (async () => {
        fetchCalled = true;
        return new Response();
      }) as typeof fetch,
    });
    const delivery = await adapter.send(
      intent,
      registration(JSON.stringify({ endpoint: "http://push.example.test/p/abc" })),
      makeCtx(tenantSettings),
    );
    expect(delivery.status).toBe("failed");
    expect(delivery.error?.code).toBe("push.badDeviceToken");
    expect(fetchCalled).toBe(false);
  });

  it("rejects loopback and private subscription endpoints before fetch", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const { tenantSettings } = await setupTenant(env);
    let fetchCalled = false;
    const adapter = createFrickWebPushAdapter({
      env,
      fetch: (async () => {
        fetchCalled = true;
        return new Response();
      }) as typeof fetch,
    });
    for (const endpoint of [
      "https://localhost/p/abc",
      "https://127.0.0.1/p/abc",
      "https://10.1.2.3/p/abc",
      "https://172.16.0.1/p/abc",
      "https://192.168.1.1/p/abc",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/p/abc",
      "https://[fd00::1]/p/abc",
    ]) {
      const delivery = await adapter.send(
        intent,
        registration(JSON.stringify({ endpoint })),
        makeCtx(tenantSettings),
      );
      expect(delivery.status).toBe("failed");
      expect(delivery.error?.code).toBe("push.badDeviceToken");
    }
    expect(fetchCalled).toBe(false);
  });

  it("rejects hostnames that resolve to private addresses before fetch", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const { tenantSettings } = await setupTenant(env);
    let fetchCalled = false;
    const adapter = createFrickWebPushAdapter({
      env,
      fetch: (async () => {
        fetchCalled = true;
        return new Response();
      }) as typeof fetch,
      resolveHostname: async () => [{ address: "10.0.0.2" }],
    });
    const delivery = await adapter.send(
      intent,
      registration(JSON.stringify({ endpoint: "https://push.example.test/p/abc" })),
      makeCtx(tenantSettings),
    );

    expect(delivery.status).toBe("failed");
    expect(delivery.error?.code).toBe("push.badDeviceToken");
    expect(fetchCalled).toBe(false);
  });

  it("signs a VAPID JWT parseable as {typ, alg, aud, exp, sub} with a 64-byte signature", async () => {
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
