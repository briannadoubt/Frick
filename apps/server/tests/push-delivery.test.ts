/**
 * End-to-end delivery tests for the push framework. Drives the admin
 * `/_frick/admin/push/deliver` route, runs the worker (via inline router
 * deliver()), and asserts on what the test adapter recorded.
 *
 * We exercise the router synchronously rather than waiting on the polling
 * worker because the worker is disabled in test env by default; calling
 * `router.deliver(...)` directly gives deterministic assertions.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";
import { createFrickTestPushAdapter } from "../src/push/test-adapter.js";
import { isPushPlatform } from "../src/storage/push-registration-store.js";
import type { FrickPushAdapter, FrickPushDelivery } from "../src/push/types.js";

const ADMIN_TOKEN = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function startServer(overrides: { adapters?: FrickPushAdapter[] } = {}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    config: { adminToken: ADMIN_TOKEN },
    ...(overrides.adapters !== undefined ? { push: { adapters: overrides.adapters } } : {}),
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    store: server.store,
    notifications: server.notifications,
    pushRegistry: server.pushRegistry,
    close: server.close,
  };
}

async function devLogin(httpUrl: string, userId: string) {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  return (await response.json()) as { sessionToken: string; userId: string; tenantId: string };
}

async function registerDevice(
  httpUrl: string,
  sessionToken: string,
  deviceId: string,
  platform: string,
  token: string,
) {
  const response = await fetch(`${httpUrl}/push/registrations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId, platform, token }),
  });
  if (!response.ok) {
    throw new Error(`register failed ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as { registration: { registrationId: string } };
  return body.registration.registrationId;
}

describe("push delivery via admin route + router", () => {
  it("enqueueing an intent and running the handler delivers to the test adapter", async () => {
    app = await startServer();
    const session = await devLogin(app.httpUrl, "user-ada");
    await registerDevice(app.httpUrl, session.sessionToken, "device-1", "test", "tok-1");

    // Admin enqueue.
    const enq = await fetch(`${app.httpUrl}/_frick/admin/push/deliver`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        tenantId: session.tenantId,
        intent: "message.new",
        recipientUserIds: [session.userId],
        body: { title: "hi", body: "hello" },
      }),
    });
    expect(enq.status).toBe(201);
    const enqBody = (await enq.json()) as { jobId: number; jobType: string; status: string };
    expect(enqBody.jobType).toBe("push.deliver");

    // Run the router inline against the same intent so we can assert on
    // delivery outcomes without polling the worker (the worker is disabled
    // by default in test runs).
    const deliveries = await app.notifications.deliver({
      intent: "message.new",
      tenantId: session.tenantId,
      recipientUserIds: [session.userId],
      body: { title: "hi", body: "hello" },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("delivered");
    expect(deliveries[0]?.receiptId).toBeDefined();
  });

  it("fans out to all of a user's active devices", async () => {
    app = await startServer();
    const session = await devLogin(app.httpUrl, "user-ada");
    await registerDevice(app.httpUrl, session.sessionToken, "device-1", "test", "tok-1");
    await registerDevice(app.httpUrl, session.sessionToken, "device-2", "test", "tok-2");

    const deliveries = await app.notifications.deliver({
      intent: "message.new",
      tenantId: session.tenantId,
      recipientUserIds: [session.userId],
      body: {},
    });
    expect(deliveries).toHaveLength(2);
    expect(new Set(deliveries.map((d) => d.status))).toEqual(new Set(["delivered"]));
  });

  it("skips revoked registrations", async () => {
    app = await startServer();
    const session = await devLogin(app.httpUrl, "user-ada");
    const reg1 = await registerDevice(
      app.httpUrl,
      session.sessionToken,
      "device-1",
      "test",
      "tok-1",
    );
    await registerDevice(app.httpUrl, session.sessionToken, "device-2", "test", "tok-2");
    // Revoke the first one.
    await fetch(`${app.httpUrl}/push/registrations/${reg1}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    const deliveries = await app.notifications.deliver({
      intent: "message.new",
      tenantId: session.tenantId,
      recipientUserIds: [session.userId],
      body: {},
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.registration.deviceId).toBe("device-2");
  });

  it("registrations whose platform has no adapter are skipped with an error code", async () => {
    app = await startServer();
    const session = await devLogin(app.httpUrl, "user-ada");
    // Register a device for the "test" platform, then remove the test
    // adapter so resolveAdapter returns undefined.
    await registerDevice(app.httpUrl, session.sessionToken, "device-1", "test", "tok-1");
    // Forcibly drop the test adapter by working directly against the
    // registry. We avoid an unregister method on the public surface — the
    // only path that should remove an adapter is process restart.
    expect(isPushPlatform("test")).toBe(true);
    // Build a fresh server with NO test adapter override but pre-register a
    // bogus platform (which would dedupe the test default) — easier path:
    // register a real adapter under a different platform and a row pointing
    // to an unknown platform.
    await app.close();
    app = await startServer({ adapters: [] });
    const s2 = await devLogin(app.httpUrl, "user-ada");
    // Insert a registration directly with a platform that has no adapter.
    // We bypass the HTTP route because it validates the platform value.
    app.store.pushRegistrations.register({
      tenantId: s2.tenantId,
      userId: s2.userId,
      deviceId: "device-x",
      platform: "apns",
      token: "tok-apns",
      environment: "production",
    });
    const deliveries = await app.notifications.deliver({
      intent: "message.new",
      tenantId: s2.tenantId,
      recipientUserIds: [s2.userId],
      body: {},
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("skipped");
    expect(deliveries[0]?.error?.code).toBe("push.unknownAdapter");
  });

  it("revokes the registration when the adapter returns a revocation error code", async () => {
    const revokingAdapter: FrickPushAdapter = {
      platform: "test",
      async send(_intent, registration): Promise<FrickPushDelivery> {
        return {
          registration,
          attemptedAt: new Date().toISOString(),
          status: "failed",
          error: { code: "push.badDeviceToken", message: "stale token" },
        };
      },
    };
    app = await startServer({ adapters: [revokingAdapter] });
    const session = await devLogin(app.httpUrl, "user-ada");
    const regId = await registerDevice(
      app.httpUrl,
      session.sessionToken,
      "device-1",
      "test",
      "tok-1",
    );
    const deliveries = await app.notifications.deliver({
      intent: "message.new",
      tenantId: session.tenantId,
      recipientUserIds: [session.userId],
      body: {},
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("failed");
    expect(deliveries[0]?.error?.code).toBe("push.badDeviceToken");
    const stored = app.store.pushRegistrations.getById(regId, session.tenantId);
    expect(stored?.revokedAt).toBeDefined();
  });

  it("default test adapter records deliveries it sees", async () => {
    // Build a custom test adapter we control directly so we can read
    // `delivered`. The default adapter inside the framework is also
    // observable but the per-test instance is easier to reason about.
    const adapter = createFrickTestPushAdapter();
    app = await startServer({ adapters: [adapter] });
    const session = await devLogin(app.httpUrl, "user-ada");
    await registerDevice(app.httpUrl, session.sessionToken, "device-1", "test", "tok-1");
    await app.notifications.deliver({
      intent: "message.new",
      tenantId: session.tenantId,
      recipientUserIds: [session.userId],
      body: { title: "hi" },
    });
    expect(adapter.delivered).toHaveLength(1);
    expect(adapter.delivered[0]?.status).toBe("delivered");
    adapter.reset();
    expect(adapter.delivered).toHaveLength(0);
  });
});
