/**
 * APNs adapter integration test using a local HTTP/2 server. We can't dial
 * `api.push.apple.com` from CI (and we wouldn't want to even if we could),
 * so the test spins up a `node:http2` plaintext server and points the
 * adapter at it via `options.connect`. The mock server inspects the
 * incoming `authorization` and `apns-topic` headers, then replies with
 * either 200 (deliver path) or 410 (unregistered path).
 *
 * We also assert that the ES256 JWT is well-formed (parseable header, kid
 * matches, iss matches, signature is IEEE-P1363 64 bytes wide).
 */
import {
  connect as h2Connect,
  createServer as createH2Server,
  type Http2Server,
} from "node:http2";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { foundationSchema } from "@frick/protocol";
import { runFrameworkMigrations } from "../src/storage/migrations.js";
import { TenantSettingsStore } from "../src/storage/tenant-settings-store.js";
import { saveApnsCredentials } from "../src/push/credentials.js";
import { createFrickApnsAdapter, signApnsJwt } from "../src/push/apns-adapter.js";
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

const intent: FrickNotificationIntent = {
  intent: "message.new",
  tenantId: "tenant-1",
  recipientUserIds: ["user-1"],
  body: { title: "Hello", body: "World" },
  threadId: "convo-abc",
};

function registration(token: string): PushDeviceRegistration {
  return {
    registrationId: "reg-1",
    tenantId: "tenant-1",
    userId: "user-1",
    deviceId: "dev-1",
    platform: "apns",
    token,
    environment: "production",
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
}

function setupTenant(env: NodeJS.ProcessEnv): { tenantSettings: TenantSettingsStore } {
  const pem = generateP256Pem();
  const db = new DatabaseSync(":memory:");
  runFrameworkMigrations(db, { supportedSchemaRevision: foundationSchema.schemaRevision });
  const tenantSettings = new TenantSettingsStore(db);
  saveApnsCredentials(
    tenantSettings,
    "tenant-1",
    {
      keyId: "ABCD123456",
      teamId: "TEAM12345",
      bundleId: "com.example.app",
      privateKeyPem: pem,
    },
    env,
  );
  return { tenantSettings };
}

function makeCtx(tenantSettings: TenantSettingsStore): FrickNotificationContext {
  return {
    tenantId: "tenant-1",
    intent,
    store: { tenantSettings } as unknown as FrickNotificationContext["store"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({}) as any }) as any } as any,
  };
}

interface MockServer {
  server: Http2Server;
  port: number;
  /** Map of device-token → response builder. */
  routes: Map<string, (headers: Record<string, string | string[] | undefined>) => { status: number; body?: string; reason?: string }>;
  observedHeaders: Array<Record<string, string | string[] | undefined>>;
}

async function startMockApns(): Promise<MockServer> {
  const server = createH2Server();
  const mock: MockServer = {
    server,
    port: 0,
    routes: new Map(),
    observedHeaders: [],
  };
  server.on("stream", (stream, headers) => {
    mock.observedHeaders.push(headers);
    const path = String(headers[":path"] ?? "");
    const token = path.replace("/3/device/", "");
    const handler = mock.routes.get(token);
    const result = handler ? handler(headers) : { status: 200 };
    const body = result.body ?? (result.reason ? JSON.stringify({ reason: result.reason }) : "");
    stream.respond({ ":status": result.status, "apns-id": `apns-${token}` });
    stream.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server address");
  mock.port = address.port;
  return mock;
}

let mock: MockServer;
beforeAll(async () => {
  mock = await startMockApns();
});
afterAll(async () => {
  await new Promise<void>((resolve) => mock.server.close(() => resolve()));
});

function adapterFor(env: NodeJS.ProcessEnv) {
  return createFrickApnsAdapter({
    env,
    endpoint: `http://127.0.0.1:${mock.port}`,
    connect: (endpoint) => h2Connect(endpoint),
  });
}

describe("APNs adapter", () => {
  it("returns skipped delivery when credentials are missing", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const db = new DatabaseSync(":memory:");
    runFrameworkMigrations(db, { supportedSchemaRevision: foundationSchema.schemaRevision });
    const tenantSettings = new TenantSettingsStore(db);
    const adapter = adapterFor(env);
    try {
      const delivery = await adapter.send(intent, registration("notoken"), makeCtx(tenantSettings));
      expect(delivery.status).toBe("skipped");
      expect(delivery.error?.code).toBe("push.credentials.missing");
    } finally {
      await adapter.close();
    }
  });

  it("delivers a 200 response with apns-id receipt", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const { tenantSettings } = setupTenant(env);
    mock.routes.set("device-ok", () => ({ status: 200 }));
    const adapter = adapterFor(env);
    try {
      const delivery = await adapter.send(intent, registration("device-ok"), makeCtx(tenantSettings));
      expect(delivery.status).toBe("delivered");
      expect(delivery.receiptId).toBe("apns-device-ok");
      const headers = mock.observedHeaders.at(-1);
      expect(headers?.["apns-topic"]).toBe("com.example.app");
      expect(String(headers?.authorization)).toMatch(/^bearer /);
    } finally {
      await adapter.close();
    }
  });

  it("maps 410 Unregistered to push.unregistered", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const { tenantSettings } = setupTenant(env);
    mock.routes.set("device-dead", () => ({ status: 410, reason: "Unregistered" }));
    const adapter = adapterFor(env);
    try {
      const delivery = await adapter.send(intent, registration("device-dead"), makeCtx(tenantSettings));
      expect(delivery.status).toBe("failed");
      expect(delivery.error?.code).toBe("push.unregistered");
    } finally {
      await adapter.close();
    }
  });

  it("maps 400 BadDeviceToken to push.badDeviceToken", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const { tenantSettings } = setupTenant(env);
    mock.routes.set("device-bad", () => ({ status: 400, reason: "BadDeviceToken" }));
    const adapter = adapterFor(env);
    try {
      const delivery = await adapter.send(intent, registration("device-bad"), makeCtx(tenantSettings));
      expect(delivery.status).toBe("failed");
      expect(delivery.error?.code).toBe("push.badDeviceToken");
    } finally {
      await adapter.close();
    }
  });

  it("signs a parseable ES256 JWT with the credential's keyId and teamId", () => {
    const pem = generateP256Pem();
    const token = signApnsJwt(
      {
        keyId: "ABCD123456",
        teamId: "TEAM12345",
        bundleId: "com.example.app",
        privateKeyPem: pem,
      },
      1_700_000_000,
    );
    const [headerB64, payloadB64, signatureB64] = token.split(".");
    expect(headerB64).toBeDefined();
    expect(payloadB64).toBeDefined();
    expect(signatureB64).toBeDefined();
    const header = JSON.parse(Buffer.from(headerB64!, "base64").toString("utf8"));
    expect(header).toEqual({ alg: "ES256", kid: "ABCD123456", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64").toString("utf8"));
    expect(payload).toEqual({ iss: "TEAM12345", iat: 1_700_000_000 });
    // IEEE-P1363 ECDSA signature for P-256 is 64 bytes.
    const sig = Buffer.from(signatureB64!.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    expect(sig.length).toBe(64);
  });
});
