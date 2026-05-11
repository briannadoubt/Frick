/**
 * HTTP-level tests for the push device registration routes.
 *
 * Covers the registration lifecycle (create, idempotent re-register, revoke)
 * and the tenant isolation boundary — a principal in tenant A must not be
 * able to revoke a registration that belongs to tenant B even if they
 * happen to guess the registration id.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

const ADMIN_TOKEN = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";

afterEach(async () => {
  await app?.close();
  app = undefined;
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
    notifications: server.notifications,
    pushRegistry: server.pushRegistry,
    close: server.close,
  };
}

async function devLogin(httpUrl: string, userId: string, tenantId?: string) {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, ...(tenantId !== undefined ? { tenantId } : {}) }),
  });
  const body = (await response.json()) as { sessionToken: string; userId: string; tenantId: string };
  return body;
}

describe("POST /push/registrations", () => {
  it("creates a registration row scoped to the principal", async () => {
    app = await startServer();
    const session = await devLogin(app.httpUrl, "user-ada");
    const response = await fetch(`${app.httpUrl}/push/registrations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId: "device-1", platform: "test", token: "tok-1" }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      registration: { registrationId: string; userId: string; tenantId: string; platform: string };
    };
    expect(body.registration.userId).toBe(session.userId);
    expect(body.registration.tenantId).toBe(session.tenantId);
    expect(body.registration.platform).toBe("test");

    // Stored row reflects the same fields.
    const list = app.store.pushRegistrations.listByUser(session.tenantId, session.userId);
    expect(list).toHaveLength(1);
    expect(list[0]?.registrationId).toBe(body.registration.registrationId);
  });

  it("rejects unknown platforms with 400", async () => {
    app = await startServer();
    const session = await devLogin(app.httpUrl, "user-ada");
    const response = await fetch(`${app.httpUrl}/push/registrations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId: "device-1", platform: "smoke-signals", token: "tok-1" }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects missing fields with 400", async () => {
    app = await startServer();
    const session = await devLogin(app.httpUrl, "user-ada");
    const response = await fetch(`${app.httpUrl}/push/registrations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId: "device-1", platform: "test" }),
    });
    expect(response.status).toBe(400);
  });

  /**
   * Re-registration decision (documented):
   *
   * Re-registering the same `(tenantId, userId, deviceId, platform)` keeps
   * the existing `registrationId` and refreshes `token` / `lastSeenAt`. We
   * deliberately preserve the id so apps that cached it earlier (e.g.
   * stored alongside the device record) don't need to re-fetch — the row
   * they're holding stays valid.
   */
  it("is idempotent: re-registering the same tuple reuses the registration id", async () => {
    app = await startServer();
    const session = await devLogin(app.httpUrl, "user-ada");
    const first = await fetch(`${app.httpUrl}/push/registrations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId: "device-1", platform: "test", token: "tok-1" }),
    });
    const firstBody = (await first.json()) as { registration: { registrationId: string } };
    const second = await fetch(`${app.httpUrl}/push/registrations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId: "device-1", platform: "test", token: "tok-2" }),
    });
    const secondBody = (await second.json()) as {
      registration: { registrationId: string; token: string };
    };
    expect(secondBody.registration.registrationId).toBe(firstBody.registration.registrationId);
    expect(secondBody.registration.token).toBe("tok-2");
    const list = app.store.pushRegistrations.listByUser(session.tenantId, session.userId);
    expect(list).toHaveLength(1);
  });
});

describe("DELETE /push/registrations/:id", () => {
  it("revokes the registration and listByUser excludes it", async () => {
    app = await startServer();
    const session = await devLogin(app.httpUrl, "user-ada");
    const create = await fetch(`${app.httpUrl}/push/registrations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId: "device-1", platform: "test", token: "tok-1" }),
    });
    const { registration } = (await create.json()) as {
      registration: { registrationId: string };
    };

    const del = await fetch(
      `${app.httpUrl}/push/registrations/${registration.registrationId}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${session.sessionToken}` },
      },
    );
    expect(del.status).toBe(204);
    expect(app.store.pushRegistrations.listByUser(session.tenantId, session.userId)).toHaveLength(0);
    const stored = app.store.pushRegistrations.getById(registration.registrationId, session.tenantId);
    expect(stored?.revokedAt).toBeDefined();
  });

  it("returns 404 across tenants", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    // Provision tenant-b via admin.
    await fetch(`${app.httpUrl}/_frick/admin/tenants`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant-b" }),
    });
    const sessionA = await devLogin(app.httpUrl, "user-ada");
    const sessionB = await devLogin(app.httpUrl, "user-grace", "tenant-b");
    const create = await fetch(`${app.httpUrl}/push/registrations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionB.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId: "device-1", platform: "test", token: "tok-b" }),
    });
    const { registration } = (await create.json()) as {
      registration: { registrationId: string };
    };
    const del = await fetch(
      `${app.httpUrl}/push/registrations/${registration.registrationId}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${sessionA.sessionToken}` },
      },
    );
    expect(del.status).toBe(404);
    // Tenant-b's row is still active.
    const stored = app.store.pushRegistrations.getById(registration.registrationId, "tenant-b");
    expect(stored?.revokedAt).toBeUndefined();
  });

  it("returns 404 for an unknown registration id", async () => {
    app = await startServer();
    const session = await devLogin(app.httpUrl, "user-ada");
    const del = await fetch(`${app.httpUrl}/push/registrations/does-not-exist`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(del.status).toBe(404);
  });

  it("listByUser excludes revoked rows", async () => {
    app = await startServer();
    const session = await devLogin(app.httpUrl, "user-ada");
    const r1 = await fetch(`${app.httpUrl}/push/registrations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId: "device-1", platform: "test", token: "tok-1" }),
    });
    const r2 = await fetch(`${app.httpUrl}/push/registrations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId: "device-2", platform: "test", token: "tok-2" }),
    });
    const r1Body = (await r1.json()) as { registration: { registrationId: string } };
    const r2Body = (await r2.json()) as { registration: { registrationId: string } };
    await fetch(`${app.httpUrl}/push/registrations/${r1Body.registration.registrationId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    const list = app.store.pushRegistrations.listByUser(session.tenantId, session.userId);
    expect(list.map((r) => r.registrationId)).toEqual([r2Body.registration.registrationId]);
  });
});
