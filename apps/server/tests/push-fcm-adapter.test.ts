/**
 * Unit tests for the FCM adapter. We don't dial real Google endpoints — a
 * pair of `fetch` stubs simulates the OAuth2 token exchange and the
 * `messages:send` POST. The goal is to cover:
 *
 *   - credentials missing → skipped delivery
 *   - successful delivery → `delivered` with `receiptId` from `message.name`
 *   - UNREGISTERED / INVALID_ARGUMENT → revocation-eligible error codes
 *   - access-token cache (one token exchange across multiple sends within
 *     the same expiry window)
 */
import { SqliteSqlDriver } from "../src/storage/sql-driver.js";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { foundationSchema } from "@fricken/protocol";
import { runFrameworkMigrations } from "../src/storage/migrations.js";
import { TenantSettingsStore } from "../src/storage/tenant-settings-store.js";
import { saveFcmCredentials } from "../src/push/credentials.js";
import { createFrickFcmAdapter } from "../src/push/fcm-adapter.js";
import type {
  FrickNotificationContext,
  FrickNotificationIntent,
  PushDeviceRegistration,
} from "../src/push/types.js";

function freshKey(): string {
  return randomBytes(32).toString("base64");
}

async function setupTenant(env: NodeJS.ProcessEnv): Promise<{
  tenantSettings: TenantSettingsStore;
  privateKeyPem: string;
}> {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const db = new DatabaseSync(":memory:");
  runFrameworkMigrations(db, { supportedSchemaRevision: foundationSchema.schemaRevision });
  const tenantSettings = new TenantSettingsStore(new SqliteSqlDriver(db));
  await saveFcmCredentials(
    tenantSettings,
    "tenant-1",
    {
      projectId: "frick-test",
      clientEmail: "svc@frick-test.iam.gserviceaccount.com",
      privateKey,
    },
    env,
  );
  return { tenantSettings, privateKeyPem: privateKey };
}

const intent: FrickNotificationIntent = {
  intent: "message.new",
  tenantId: "tenant-1",
  recipientUserIds: ["user-1"],
  body: { title: "Hello", body: "World", data: { conversationId: "abc" } },
  threadId: "abc",
};

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

function makeCtx(tenantSettings: TenantSettingsStore): FrickNotificationContext {
  return {
    tenantId: "tenant-1",
    intent,
    store: { tenantSettings } as unknown as FrickNotificationContext["store"],
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({}) as any }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

describe("FCM adapter", () => {
  it("returns skipped delivery when credentials are missing", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const db = new DatabaseSync(":memory:");
    runFrameworkMigrations(db, { supportedSchemaRevision: foundationSchema.schemaRevision });
    const tenantSettings = new TenantSettingsStore(new SqliteSqlDriver(db));
    const adapter = createFrickFcmAdapter({ env, fetch: (async () => new Response()) as typeof fetch });
    const delivery = await adapter.send(intent, registration, makeCtx(tenantSettings));
    expect(delivery.status).toBe("skipped");
    expect(delivery.error?.code).toBe("push.credentials.missing");
  });

  it("delivers and returns the message name as receiptId", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const { tenantSettings } = await setupTenant(env);
    let tokenCalls = 0;
    let sendCalls = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/token")) {
        tokenCalls += 1;
        return new Response(
          JSON.stringify({ access_token: "ya29.fake", expires_in: 3600, token_type: "Bearer" }),
          { status: 200 },
        );
      }
      sendCalls += 1;
      expect(init?.headers).toMatchObject({ authorization: "Bearer ya29.fake" });
      expect(u).toContain("/v1/projects/frick-test/messages:send");
      const body = JSON.parse(String(init?.body)) as { message: Record<string, unknown> };
      expect(body.message).toMatchObject({ token: "fcm-token-xyz" });
      return new Response(JSON.stringify({ name: "projects/frick-test/messages/0:1234" }), {
        status: 200,
      });
    };
    const adapter = createFrickFcmAdapter({
      env,
      tokenUri: "https://example.test/token",
      fetch: fetchImpl,
    });
    const first = await adapter.send(intent, registration, makeCtx(tenantSettings));
    expect(first.status).toBe("delivered");
    expect(first.receiptId).toBe("projects/frick-test/messages/0:1234");
    // Token should be cached across the next send.
    const second = await adapter.send(intent, registration, makeCtx(tenantSettings));
    expect(second.status).toBe("delivered");
    expect(tokenCalls).toBe(1);
    expect(sendCalls).toBe(2);
  });

  it("maps UNREGISTERED to push.unregistered", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const { tenantSettings } = await setupTenant(env);
    const fetchImpl: typeof fetch = async (url) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/token")) {
        return new Response(JSON.stringify({ access_token: "ya29.fake", expires_in: 3600 }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          error: {
            status: "NOT_FOUND",
            message: "Requested entity was not found.",
            details: [{ errorCode: "UNREGISTERED" }],
          },
        }),
        { status: 404 },
      );
    };
    const adapter = createFrickFcmAdapter({
      env,
      tokenUri: "https://example.test/token",
      fetch: fetchImpl,
    });
    const delivery = await adapter.send(intent, registration, makeCtx(tenantSettings));
    expect(delivery.status).toBe("failed");
    expect(delivery.error?.code).toBe("push.unregistered");
  });

  it("surfaces token-exchange failure as push.tokenExchangeFailed", async () => {
    const env = { FRICK_PUSH_CRED_KEY: freshKey() };
    const { tenantSettings } = await setupTenant(env);
    const fetchImpl: typeof fetch = async () =>
      new Response("invalid_grant", { status: 400 });
    const adapter = createFrickFcmAdapter({
      env,
      tokenUri: "https://example.test/token",
      fetch: fetchImpl,
    });
    const delivery = await adapter.send(intent, registration, makeCtx(tenantSettings));
    expect(delivery.status).toBe("failed");
    expect(delivery.error?.code).toBe("push.tokenExchangeFailed");
  });
});
