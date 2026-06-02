import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  FrameKind,
  decodeFrame,
  encodeFrame,
  productTestSchema,
  type FrickFrame,
} from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";
import { FrickStore } from "../src/store.js";

const ADMIN_TOKEN = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("tenant_settings store basics", () => {
  it("set/get/delete/list round-trip with structured values", () => {
    const store = new FrickStore({ path: ":memory:", seed: false });
    try {
      store.tenantSettings.set("tenant-a", "limits", { maxBlobBytes: 1024 });
      store.tenantSettings.set("tenant-a", "retentionMs", 60_000);
      store.tenantSettings.set("tenant-b", "limits", { maxBlobBytes: 9999 });

      expect(store.tenantSettings.get("tenant-a", "limits")).toEqual({
        maxBlobBytes: 1024,
      });
      expect(store.tenantSettings.get("tenant-a", "retentionMs")).toBe(60_000);
      expect(store.tenantSettings.get("tenant-b", "limits")).toEqual({
        maxBlobBytes: 9999,
      });
      // Missing key
      expect(store.tenantSettings.get("tenant-a", "nope")).toBeUndefined();

      const listA = store.tenantSettings.list("tenant-a");
      expect(listA).toEqual({ limits: { maxBlobBytes: 1024 }, retentionMs: 60_000 });

      store.tenantSettings.delete("tenant-a", "limits");
      expect(store.tenantSettings.get("tenant-a", "limits")).toBeUndefined();
      expect(store.tenantSettings.list("tenant-a")).toEqual({ retentionMs: 60_000 });
    } finally {
      store.close();
    }
  });
});

describe("per-tenant retention in FrickStore.prune", () => {
  it("uses per-tenant retentionMs override and respects global default for other tenants", async () => {
    const store = new FrickStore({
      path: ":memory:",
      seed: true,
      schema: productTestSchema,
      idempotencyKeyRetentionMs: 24 * 60 * 60 * 1000, // 24h global
      idempotencyKeyPruneIntervalMs: 0,
    });
    try {
      // tenant-fast: prune anything older than 0ms — i.e. immediately.
      store.tenantSettings.set("tenant-fast", "retentionMs", 0);

      // Need users in each tenant so signup-free appends can proceed via
      // raw streams API. Use lower-level appendEvent which doesn't require
      // membership checks.
      store.appendEvent({
        tenantId: "tenant-fast",
        requestId: "req-fast",
        replicaId: "replica-1",
        stream: "MessageStream",
        streamId: "conversation-general",
        event: "MessageSent",
        payload: {
          messageId: "msg-fast",
          senderId: "user-ada",
          body: "fast",
          createdAt: "2026-05-10T00:00:00.000Z",
        },
      });
      store.appendEvent({
        tenantId: "_default",
        requestId: "req-default",
        replicaId: "replica-1",
        stream: "MessageStream",
        streamId: "conversation-general",
        event: "MessageSent",
        payload: {
          messageId: "msg-default",
          senderId: "user-ada",
          body: "default",
          createdAt: "2026-05-10T00:00:00.000Z",
        },
      });

      expect(store.idempotencyKeyRowCount()).toBe(2);

      // Wait so created_at is strictly less than now.
      await new Promise((resolve) => setTimeout(resolve, 5));

      const result = store.prune();
      // The tenant-fast row should be gone; the _default row should still be
      // present (24h global hasn't elapsed).
      expect(result.prunedByAge).toBeGreaterThanOrEqual(1);
      expect(store.idempotencyKeyRowCount()).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("admin /_frick/admin/tenants/:tenantId/settings", () => {
  it("GET returns settings; PUT persists; non-admin gets 403; missing token 401", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    const adminHeaders = {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "content-type": "application/json",
    };

    // PUT a setting (number) — body is a raw JSON value, not an envelope.
    const put = await fetch(
      `${app.httpUrl}/_frick/admin/tenants/_default/settings/retentionMs`,
      { method: "PUT", headers: adminHeaders, body: "60000" },
    );
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { tenantId: string; key: string; value: unknown };
    expect(putBody).toMatchObject({ tenantId: "_default", key: "retentionMs", value: 60000 });

    // GET reflects the new value.
    const get = await fetch(`${app.httpUrl}/_frick/admin/tenants/_default/settings`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as { settings: Record<string, unknown> };
    expect(getBody.settings).toMatchObject({ retentionMs: 60000 });

    // Non-admin session is 403.
    const devLogin = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-ada" }),
    });
    const { sessionToken } = (await devLogin.json()) as { sessionToken: string };
    const denied = await fetch(
      `${app.httpUrl}/_frick/admin/tenants/_default/settings`,
      { headers: { authorization: `Bearer ${sessionToken}` } },
    );
    expect(denied.status).toBe(403);

    // Missing bearer is 401.
    const noAuth = await fetch(
      `${app.httpUrl}/_frick/admin/tenants/_default/settings`,
    );
    expect(noAuth.status).toBe(401);
  });

  it("settings persist across reconnects (admin sets, new client sees the lower cap)", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    // Set per-tenant maxBlobBytes lower than global.
    await fetch(
      `${app.httpUrl}/_frick/admin/tenants/_default/settings/limits`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ maxBlobBytes: 8 }),
      },
    );

    // Reconnect via a brand new dev-login + upload — the resolved limit must
    // be the per-tenant 8 bytes, not the global 25MB default.
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const response = await fetch(
      `${app.httpUrl}/blobs/blob-persist/content?ownerId=user-ada`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          authorization: `Bearer ${login.sessionToken}`,
        },
        body: Buffer.from("this body is way too large for 8 bytes"),
      },
    );
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error.code).toBe("blob.tooLarge");
  });

  it("PUT fails closed before persisting when audit recording fails", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    (app.store.adminAudit as unknown as { record: () => never }).record = () => {
      throw new Error("audit unavailable");
    };

    const response = await fetch(
      `${app.httpUrl}/_frick/admin/tenants/_default/settings/retentionMs`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        body: "60000",
      },
    );

    expect(response.status).toBe(500);
    expect(app.store.tenantSettings.get("_default", "retentionMs")).toBeUndefined();
  });
});

describe("per-tenant maxBlobBytes (HTTP)", () => {
  it("rejects an upload over the tenant cap but accepts the same payload in default tenant", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    // Register tenant-tight and lower its maxBlobBytes to 8.
    await fetch(`${app.httpUrl}/_frick/admin/tenants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tenantId: "tenant-tight" }),
    });
    await fetch(
      `${app.httpUrl}/_frick/admin/tenants/tenant-tight/settings/limits`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ maxBlobBytes: 8 }),
      },
    );

    // Tight tenant: 413.
    const tight = await devLogin(app.httpUrl, {
      userId: "user-tight",
      tenantId: "tenant-tight",
    });
    const oversize = Buffer.from("definitely more than 8 bytes");
    const denied = await fetch(
      `${app.httpUrl}/blobs/blob-tight/content?ownerId=user-tight`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          authorization: `Bearer ${tight.sessionToken}`,
        },
        body: oversize,
      },
    );
    expect(denied.status).toBe(413);
    const errBody = await denied.json();
    expect(errBody.error).toMatchObject({
      code: "blob.tooLarge",
      details: expect.objectContaining({ limit: "maxBlobBytes", configuredMax: 8 }),
    });

    // Default tenant: accepted (global default is 25MB).
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    const ok = await fetch(
      `${app.httpUrl}/blobs/blob-default/content?ownerId=user-ada`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          authorization: `Bearer ${ada.sessionToken}`,
        },
        body: oversize,
      },
    );
    expect(ok.status).toBe(201);
  });
});

describe("per-tenant maxSubscriptionsPerConnection (WS)", () => {
  it("nacks the second subscription when cap is set to 1 for the tenant", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    await fetch(
      `${app.httpUrl}/_frick/admin/tenants/_default/settings/limits`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ maxSubscriptionsPerConnection: 1 }),
      },
    );

    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connect(app.url, login.sessionToken);
    const frames: FrickFrame[] = [];
    socket.on("message", (data) => frames.push(decodeFrame(data as Buffer)));

    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: login.replicaId,
          deviceId: login.deviceId,
          schemaHash: productTestSchema.hash,
          knownCursors: {},
        },
      ]),
    );
    await waitForFrameCount(frames, 2);

    socket.send(
      encodeFrame([
        FrameKind.Subscribe,
        {
          subscriptionId: "sub-1",
          kind: "stream",
          name: "MessageStream",
          key: "conversation-general",
          cursor: 0,
        },
      ]),
    );
    await waitForFrameCount(frames, 3);

    socket.send(
      encodeFrame([
        FrameKind.Subscribe,
        { subscriptionId: "sub-2", kind: "object", name: "Conversation" },
      ]),
    );
    await waitForFrameCount(frames, 4);

    const nack = frames[3]!;
    expect(nack[0]).toBe(FrameKind.Nack);
    expect(nack[1]).toMatchObject({
      requestId: "sub-2",
      error: expect.objectContaining({
        code: "rateLimit.exceeded",
        details: expect.objectContaining({
          limit: "maxSubscriptionsPerConnection",
          configuredMax: 1,
        }),
      }),
    });
    socket.close();
  });
});

async function startServer(overrides: { adminToken?: string } = {}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    schema: productTestSchema,
    config: {
      ...(overrides.adminToken !== undefined ? { adminToken: overrides.adminToken } : {}),
      implicitTenantCreation: true,
    },
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    url: `ws://127.0.0.1:${address.port}/_frick/sync`,
    store: server.store,
    close: server.close,
  };
}

async function connect(url: string, sessionToken?: string): Promise<WebSocket> {
  const socket = new WebSocket(
    url,
    sessionToken ? { headers: { authorization: `Bearer ${sessionToken}` } } : undefined,
  );
  await new Promise<void>((resolve) => socket.once("open", resolve));
  return socket;
}

async function waitForFrameCount(
  frames: FrickFrame[],
  target: number,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (frames.length < target) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${target} frames (got ${frames.length})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function devLogin(
  httpUrl: string,
  body: {
    userId: string;
    deviceId?: string;
    replicaId?: string;
    platform?: string;
    tenantId?: string;
  },
): Promise<{
  schemaHash: string;
  sessionToken: string;
  userId: string;
  deviceId: string;
  replicaId: string;
  expiresAt: string;
}> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    schemaHash: string;
    sessionToken: string;
    userId: string;
    deviceId: string;
    replicaId: string;
    expiresAt: string;
  };
}
