import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { FrameKind, encodeFrame, productTestSchema } from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";

// Coverage for FR-34 "Admin session revocation API + live disconnect". The
// authenticated admin route POST /_frick/admin/sessions/revoke deletes session
// rows (by userId, optionally tenant-scoped, or by a single sessionToken) so
// future requests are rejected, AND live-disconnects any currently-connected
// WebSocket so a revoked client can't keep streaming on an already-open
// socket. The action is recorded on the admin-audit hash chain.

const ADMIN_TOKEN = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("POST /_frick/admin/sessions/revoke", () => {
  it("revokes every session for a user and rejects the token afterwards", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    // Session is live before revocation.
    expect(await app.store.readActiveSession(ada.sessionToken)).toBeDefined();

    const res = await revoke(app.httpUrl, { userId: "user-ada" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: 1, disconnected: 0 });

    // Row is gone — the token no longer resolves to an active session.
    expect(await app.store.readActiveSession(ada.sessionToken)).toBeUndefined();
  });

  it("live-disconnects a connected client when its user is revoked", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connectAndHello(app.url, ada.sessionToken);

    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));

    const res = await revoke(app.httpUrl, { userId: "user-ada" });
    const body = (await res.json()) as { revoked: number; disconnected: number };
    expect(body.revoked).toBe(1);
    expect(body.disconnected).toBe(1);

    // 1008 = policy violation; the gateway closes revoked sockets with it.
    expect(await closed).toBe(1008);
  });

  it("scopes revocation to one tenant, leaving the user's other-tenant session alive", async () => {
    app = await startServer();
    // dev-login derives a globally-unique handle from userId, so the same user
    // can't log in to two tenants through it. Mint the two same-user sessions
    // directly to exercise tenant-scoped revocation.
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await app.store.sessions.create({
      sessionToken: "token-a",
      tenantId: "tenant-a",
      userId: "user-ada",
      deviceId: "device-a",
      replicaId: "replica-a",
      expiresAt,
    });
    await app.store.sessions.create({
      sessionToken: "token-b",
      tenantId: "tenant-b",
      userId: "user-ada",
      deviceId: "device-b",
      replicaId: "replica-b",
      expiresAt,
    });

    const res = await revoke(app.httpUrl, { userId: "user-ada", tenantId: "tenant-a" });
    expect((await res.json()).revoked).toBe(1);

    expect(await app.store.readActiveSession("token-a")).toBeUndefined();
    expect(await app.store.readActiveSession("token-b")).toBeDefined();
  });

  it("revokes a single session by token", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });

    const res = await revoke(app.httpUrl, { sessionToken: ada.sessionToken });
    expect((await res.json())).toEqual({ revoked: 1, disconnected: 0 });
    expect(await app.store.readActiveSession(ada.sessionToken)).toBeUndefined();
  });

  it("400s when neither userId nor sessionToken is provided", async () => {
    app = await startServer();
    const res = await revoke(app.httpUrl, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("sync.protocolError");
  });

  it("rejects an unauthenticated revoke request", async () => {
    app = await startServer();
    const res = await fetch(`${app.httpUrl}/_frick/admin/sessions/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-ada" }),
    });
    expect(res.status).toBe(401);
  });

  it("records the revocation on the admin audit log", async () => {
    app = await startServer();
    await devLogin(app.httpUrl, { userId: "user-ada" });
    await revoke(app.httpUrl, { userId: "user-ada" });

    const auditRes = await fetch(`${app.httpUrl}/_frick/admin/audit-log?action=sessions.revoke`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const { entries } = (await auditRes.json()) as { entries: Array<{ action: string; outcome: string }> };
    expect(entries.some((e) => e.action === "sessions.revoke" && e.outcome === "allow")).toBe(true);
  });
});

async function startServer() {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    schema: productTestSchema,
    config: { adminToken: ADMIN_TOKEN },
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    url: `ws://127.0.0.1:${address.port}/_frick/sync`,
    httpUrl: `http://127.0.0.1:${address.port}`,
    store: server.store,
    close: server.close,
  };
}

async function devLogin(
  httpUrl: string,
  body: { userId: string; tenantId?: string },
): Promise<{ sessionToken: string; tenantId: string }> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { sessionToken: string; tenantId: string };
}

function revoke(
  httpUrl: string,
  body: { userId?: string; tenantId?: string; sessionToken?: string },
): Promise<Response> {
  return fetch(`${httpUrl}/_frick/admin/sessions/revoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function connectAndHello(url: string, sessionToken: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${sessionToken}` } });
  await new Promise<void>((resolve) => socket.once("open", resolve));
  socket.send(
    encodeFrame([
      FrameKind.Hello,
      {
        replicaId: "replica-test",
        deviceId: "device-test",
        schemaHash: productTestSchema.hash,
        knownCursors: {},
      },
    ]),
  );
  // Drain HelloAck + Schema so the connection is fully established.
  await new Promise<void>((resolve) => {
    let seen = 0;
    const onMessage = () => {
      seen += 1;
      if (seen >= 2) {
        socket.off("message", onMessage);
        resolve();
      }
    };
    socket.on("message", onMessage);
  });
  return socket;
}
