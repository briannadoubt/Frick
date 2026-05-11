import { afterEach, describe, expect, it } from "vitest";
import { isFrickErrorEnvelope } from "@frick/protocol";
import { createFrickServer } from "../src/server.js";
import { FrickConfigError, loadFrickConfig } from "../src/config.js";

const ADMIN_TOKEN = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("/_frick/admin/tenants routes", () => {
  it("returns 401 envelope when unauthenticated", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    const response = await fetch(`${app.httpUrl}/_frick/admin/tenants`);
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(isFrickErrorEnvelope(body.error)).toBe(true);
    expect(body.error.code).toBe("auth.unauthenticated");
  });

  it("returns 403 envelope for a tenant-scoped principal", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const response = await fetch(`${app.httpUrl}/_frick/admin/tenants`, {
      headers: { authorization: `Bearer ${login.sessionToken}` },
    });
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("auth.forbidden");
  });

  it("lists tenants including _default when called with admin bearer", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    const response = await fetch(`${app.httpUrl}/_frick/admin/tenants`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tenants: Array<{ tenantId: string }> };
    expect(body.tenants.map((row) => row.tenantId)).toContain("_default");
  });

  it("POST creates a tenant then GET lists it", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    const create = await fetch(`${app.httpUrl}/_frick/admin/tenants`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant-alpha", displayName: "Alpha" }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { tenantId: string; displayName?: string };
    expect(created.tenantId).toBe("tenant-alpha");
    expect(created.displayName).toBe("Alpha");

    const list = await fetch(`${app.httpUrl}/_frick/admin/tenants`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const body = (await list.json()) as { tenants: Array<{ tenantId: string }> };
    expect(body.tenants.map((row) => row.tenantId)).toContain("tenant-alpha");
  });

  it("POST returns 409 envelope on duplicate id", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    const headers = { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };
    await fetch(`${app.httpUrl}/_frick/admin/tenants`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tenantId: "tenant-dup" }),
    });
    const dup = await fetch(`${app.httpUrl}/_frick/admin/tenants`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tenantId: "tenant-dup" }),
    });
    expect(dup.status).toBe(409);
    const body = await dup.json();
    expect(isFrickErrorEnvelope(body.error)).toBe(true);
    expect(body.error.details.reason).toBe("tenantExists");
  });

  it("POST archive soft-deletes and includeArchived gates visibility", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    const headers = { authorization: `Bearer ${ADMIN_TOKEN}` };
    await fetch(`${app.httpUrl}/_frick/admin/tenants`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant-archive" }),
    });
    const archive = await fetch(
      `${app.httpUrl}/_frick/admin/tenants/tenant-archive/archive`,
      { method: "POST", headers },
    );
    expect(archive.status).toBe(200);
    const archivedRow = (await archive.json()) as { tenantId: string; archivedAt?: string };
    expect(archivedRow.archivedAt).toBeTypeOf("string");

    const withoutArchived = await fetch(`${app.httpUrl}/_frick/admin/tenants`, { headers });
    const withoutBody = (await withoutArchived.json()) as { tenants: Array<{ tenantId: string }> };
    expect(withoutBody.tenants.map((row) => row.tenantId)).not.toContain("tenant-archive");

    const withArchived = await fetch(
      `${app.httpUrl}/_frick/admin/tenants?includeArchived=true`,
      { headers },
    );
    const withBody = (await withArchived.json()) as { tenants: Array<{ tenantId: string }> };
    expect(withBody.tenants.map((row) => row.tenantId)).toContain("tenant-archive");
  });

  it("returns 404 when admin token is unset", async () => {
    app = await startServer({});
    const response = await fetch(`${app.httpUrl}/_frick/admin/tenants`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(response.status).toBe(404);
  });

  it("rejects production startup with FrickConfigError when adminToken is too short", () => {
    expect(() =>
      loadFrickConfig(
        { adminToken: "short", dbPath: "/tmp/x.sqlite" },
        { env: { FRICK_ENV: "production" }, warn: () => {} },
      ),
    ).toThrow(FrickConfigError);
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

async function devLogin(
  httpUrl: string,
  body: { userId: string; tenantId?: string },
): Promise<{ sessionToken: string }> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { sessionToken: string };
}
