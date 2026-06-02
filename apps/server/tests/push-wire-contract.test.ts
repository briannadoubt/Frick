/**
 * Wire-shape contract between the server's push adapters and the
 * native `FrickPushPayload.from(...)` decoders.
 *
 * The Swift and Kotlin SDKs each have unit tests that decode a
 * representative APNs / FCM payload, but those tests use their own
 * hand-written fixtures — so a drift on either side would silently
 * pass both green. This test pins down the exact JSON the server
 * emits for one canonical intent and asserts the key/path shape the
 * client decoders read from. Any future change to either side will
 * flag here.
 *
 * Drives the real adapter (no mock encoder) via a `fetch` stub /
 * local HTTP/2 server, captures what would have gone over the wire,
 * and inspects it.
 */
import {
  connect as h2Connect,
  createServer as createH2Server,
  type Http2Server,
} from "node:http2";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { foundationSchema } from "@fricken/protocol";
import { runFrameworkMigrations } from "../src/storage/migrations.js";
import { TenantSettingsStore } from "../src/storage/tenant-settings-store.js";
import { saveApnsCredentials, saveFcmCredentials } from "../src/push/credentials.js";
import { createFrickApnsAdapter } from "../src/push/apns-adapter.js";
import { createFrickFcmAdapter } from "../src/push/fcm-adapter.js";
import type {
  FrickNotificationContext,
  FrickNotificationIntent,
  PushDeviceRegistration,
} from "../src/push/types.js";

const intent: FrickNotificationIntent = {
  intent: "message.new",
  tenantId: "tenant-1",
  recipientUserIds: ["user-1"],
  body: {
    title: "New message",
    body: "Hello from Ada",
    data: { conversationId: "convo-abc", messageId: "msg-7" },
  },
  threadId: "convo-abc",
  deepLink: "frick://conversation/convo-abc",
};

function freshKey(): string {
  return randomBytes(32).toString("base64");
}

function makeCtx(tenantSettings: TenantSettingsStore): FrickNotificationContext {
  return {
    tenantId: "tenant-1",
    intent,
    store: { tenantSettings } as unknown as FrickNotificationContext["store"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: { info() {}, warn() {}, error() {}, debug() {}, child: () => ({ info() {}, warn() {}, error() {}, debug() {}, child: () => ({}) as any }) as any } as any,
  };
}

describe("FCM wire contract — matches Kotlin FrickPushPayload.from(notification, data)", () => {
  it("delivers `notification.title` + `notification.body` and a string-valued `data` map with `intent` / `threadId` / `deepLink`", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const db = new DatabaseSync(":memory:");
    runFrameworkMigrations(db, { supportedSchemaRevision: foundationSchema.schemaRevision });
    const tenantSettings = new TenantSettingsStore(db);
    saveFcmCredentials(
      tenantSettings,
      "tenant-1",
      { projectId: "frick-test", clientEmail: "svc@frick-test.iam.gserviceaccount.com", privateKey },
      env,
    );

    let sentMessage: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/token")) {
        return new Response(
          JSON.stringify({ access_token: "ya29.fake", expires_in: 3600, token_type: "Bearer" }),
          { status: 200 },
        );
      }
      const parsed = JSON.parse(String(init?.body)) as { message: Record<string, unknown> };
      sentMessage = parsed.message;
      return new Response(JSON.stringify({ name: "projects/frick-test/messages/0:1" }), { status: 200 });
    };
    const adapter = createFrickFcmAdapter({ env, tokenUri: "https://example.test/token", fetch: fetchImpl });
    const registration: PushDeviceRegistration = {
      registrationId: "reg-1",
      tenantId: "tenant-1",
      userId: "user-1",
      deviceId: "dev-1",
      platform: "fcm",
      token: "fcm-token-xyz",
      environment: "production",
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };

    const delivery = await adapter.send(intent, registration, makeCtx(tenantSettings));
    expect(delivery.status).toBe("delivered");
    expect(sentMessage).toBeDefined();

    const message = sentMessage as Record<string, unknown>;
    // Top-level shape Kotlin's FirebaseMessagingService callbacks consume.
    expect(message.token).toBe("fcm-token-xyz");
    expect(message.notification).toEqual({ title: "New message", body: "Hello from Ada" });

    // `data` must be all-string per FCM v1 — Kotlin reads it as Map<String, String>.
    const data = message.data as Record<string, unknown>;
    expect(Object.values(data).every((v) => typeof v === "string")).toBe(true);
    expect(data.intent).toBe("message.new");
    expect(data.threadId).toBe("convo-abc");
    expect(data.deepLink).toBe("frick://conversation/convo-abc");
    // Custom `body.data` entries are flattened into `data` alongside reserved keys.
    expect(data.conversationId).toBe("convo-abc");
    expect(data.messageId).toBe("msg-7");
  });
});

describe("APNs wire contract — matches Swift FrickPushPayload.from(userInfo:)", () => {
  // Spin up a local HTTP/2 server in front of the adapter so we can
  // intercept the request body, then dial it directly with a manual
  // http2 client to grab the JSON the adapter sent.
  let server: Http2Server;
  let port: number;
  let captured: { authorization?: string; apnsTopic?: string; body?: string } = {};

  beforeAll(async () => {
    server = createH2Server();
    server.on("stream", (stream, headers) => {
      captured = {
        authorization: headers.authorization as string | undefined,
        apnsTopic: headers["apns-topic"] as string | undefined,
        body: undefined,
      };
      let body = "";
      stream.on("data", (chunk) => (body += chunk.toString("utf8")));
      stream.on("end", () => {
        captured.body = body;
        stream.respond({ ":status": 200 });
        stream.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    port = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("delivers `aps.alert.title/body`, `aps.thread-id`, `intent`, `deepLink`, and flattens custom data", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const { privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const db = new DatabaseSync(":memory:");
    runFrameworkMigrations(db, { supportedSchemaRevision: foundationSchema.schemaRevision });
    const tenantSettings = new TenantSettingsStore(db);
    saveApnsCredentials(
      tenantSettings,
      "tenant-1",
      { teamId: "TEAM12345", keyId: "KEY12345A", privateKeyPem: privateKey, bundleId: "dev.frick.demo" },
      env,
    );

    const adapter = createFrickApnsAdapter({
      env,
      endpoint: `http://127.0.0.1:${port}`,
      connect: (endpoint) => h2Connect(endpoint),
    });

    const registration: PushDeviceRegistration = {
      registrationId: "reg-1",
      tenantId: "tenant-1",
      userId: "user-1",
      deviceId: "dev-1",
      platform: "apns",
      token: "apns-device-token",
      environment: "production",
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };

    const delivery = await adapter.send(intent, registration, makeCtx(tenantSettings));
    expect(delivery.status).toBe("delivered");

    const userInfo = JSON.parse(captured.body ?? "{}") as Record<string, unknown>;
    // Swift reads `userInfo["aps"]["alert"]["title"|"body"]` and
    // `userInfo["aps"]["thread-id"]` for the thread.
    expect(userInfo.aps).toMatchObject({
      alert: { title: "New message", body: "Hello from Ada" },
      "thread-id": "convo-abc",
    });
    // Swift reads `userInfo["intent"]` and `userInfo["deepLink"]` at top-level.
    expect(userInfo.intent).toBe("message.new");
    expect(userInfo.deepLink).toBe("frick://conversation/convo-abc");
    // Custom body.data is hoisted to top level (non-aps keys reach the app).
    expect(userInfo.conversationId).toBe("convo-abc");
    expect(userInfo.messageId).toBe("msg-7");
  });
});
