import { afterEach, describe, expect, it } from "vitest";
import { isFrickErrorEnvelope } from "@frick/protocol";
import { createFrickServer } from "../src/server.js";

const ADMIN_TOKEN = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("/_frick/admin/accounts POST", () => {
  it("admin creates an account in _default and the user can subsequently log in", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    const create = await fetch(`${app.httpUrl}/_frick/admin/accounts`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        handle: "newuser",
        displayName: "New User",
        password: "supersecret",
      }),
    });
    expect(create.status).toBe(201);
    const body = (await create.json()) as {
      account: { userId: string; handle: string; tenantId: string; displayName: string; createdAt: string };
    };
    expect(body.account.handle).toBe("newuser");
    expect(body.account.tenantId).toBe("_default");
    expect(body.account.userId).toBe("user-newuser");
    expect(typeof body.account.createdAt).toBe("string");

    const login = await fetch(`${app.httpUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "newuser", password: "supersecret" }),
    });
    expect(login.status).toBe(200);
    const loginBody = (await login.json()) as { sessionToken: string };
    expect(typeof loginBody.sessionToken).toBe("string");
  });

  it("admin creates an account in tenant-x; dev-login in tenant-x succeeds with no auto-create needed", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    // Register tenant-x first
    await fetch(`${app.httpUrl}/_frick/admin/tenants`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant-x" }),
    });

    const create = await fetch(`${app.httpUrl}/_frick/admin/accounts`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        tenantId: "tenant-x",
        handle: "alpha",
        displayName: "Alpha User",
        password: "supersecret",
      }),
    });
    expect(create.status).toBe(201);
    const body = (await create.json()) as {
      account: { userId: string; tenantId: string };
    };
    expect(body.account.tenantId).toBe("tenant-x");
    const userId = body.account.userId;

    const devLogin = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, tenantId: "tenant-x" }),
    });
    expect(devLogin.status).toBe(200);
  });

  it("duplicate handle in same tenant returns 409 with storage.conflict envelope", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    const headers = { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };
    const body = JSON.stringify({
      handle: "dupuser",
      displayName: "Dup User",
      password: "supersecret",
    });
    const first = await fetch(`${app.httpUrl}/_frick/admin/accounts`, {
      method: "POST",
      headers,
      body,
    });
    expect(first.status).toBe(201);

    const second = await fetch(`${app.httpUrl}/_frick/admin/accounts`, {
      method: "POST",
      headers,
      body,
    });
    expect(second.status).toBe(409);
    const envelope = await second.json();
    expect(isFrickErrorEnvelope(envelope.error)).toBe(true);
    expect(envelope.error.code).toBe("storage.conflict");
  });

  it("same handle in different tenants both succeed", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    const headers = { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };
    await fetch(`${app.httpUrl}/_frick/admin/tenants`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tenantId: "tenant-a" }),
    });
    await fetch(`${app.httpUrl}/_frick/admin/tenants`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tenantId: "tenant-b" }),
    });

    const a = await fetch(`${app.httpUrl}/_frick/admin/accounts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        tenantId: "tenant-a",
        handle: "shared",
        displayName: "Shared A",
        password: "supersecret",
      }),
    });
    expect(a.status).toBe(201);

    const b = await fetch(`${app.httpUrl}/_frick/admin/accounts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        tenantId: "tenant-b",
        handle: "shared",
        displayName: "Shared B",
        password: "supersecret",
      }),
    });
    expect(b.status).toBe(201);
  });

  it("non-admin bearer returns 403", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    const login = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-ada" }),
    });
    const { sessionToken } = (await login.json()) as { sessionToken: string };

    const response = await fetch(`${app.httpUrl}/_frick/admin/accounts`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        handle: "anyone",
        displayName: "Any One",
        password: "supersecret",
      }),
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("auth.forbidden");
  });

  it("missing admin bearer returns 401", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    const response = await fetch(`${app.httpUrl}/_frick/admin/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: "anyone",
        displayName: "Any One",
        password: "supersecret",
      }),
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("auth.unauthenticated");
  });

  it("returns 404 when admin token is unset", async () => {
    app = await startServer({});
    const response = await fetch(`${app.httpUrl}/_frick/admin/accounts`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        handle: "anyone",
        displayName: "Any One",
        password: "supersecret",
      }),
    });
    expect(response.status).toBe(404);
  });

  it("malformed body (missing handle) returns 400 with envelope", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    const response = await fetch(`${app.httpUrl}/_frick/admin/accounts`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "No Handle",
        password: "supersecret",
      }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(isFrickErrorEnvelope(body.error)).toBe(true);
    expect(body.error.code).toBe("sync.protocolError");
  });
});

async function startServer(overrides: { adminToken?: string } = {}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    config: { ...(overrides.adminToken !== undefined ? { adminToken: overrides.adminToken } : {}) },
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    store: server.store,
    close: server.close,
  };
}
