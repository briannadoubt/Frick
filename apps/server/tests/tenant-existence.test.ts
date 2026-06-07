import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";

const ADMIN_TOKEN = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("tenant existence check on auth", () => {
  it("dev-login with new tenantId succeeds and registers the tenant when implicitTenantCreation=true", async () => {
    app = await startServer({ implicitTenantCreation: true });
    const response = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-ada", tenantId: "tenant-new-implicit" }),
    });
    expect(response.status).toBe(200);
    const row = await app.store.tenants.get("tenant-new-implicit");
    expect(row?.tenantId).toBe("tenant-new-implicit");
  });

  it("dev-login with unknown tenantId rejects with 403 + unknownTenant when implicitTenantCreation=false", async () => {
    app = await startServer({ implicitTenantCreation: false });
    const response = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-ada", tenantId: "tenant-unknown" }),
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("auth.forbidden");
    expect(body.error.details.reason).toBe("unknownTenant");
  });

  it("admin can pre-create a tenant so dev-login succeeds even with implicitTenantCreation=false", async () => {
    app = await startServer({ implicitTenantCreation: false, adminToken: ADMIN_TOKEN });
    const create = await fetch(`${app.httpUrl}/_frick/admin/tenants`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant-pre" }),
    });
    expect(create.status).toBe(201);

    const login = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-ada", tenantId: "tenant-pre" }),
    });
    expect(login.status).toBe(200);
  });

  it("_default tenant always succeeds regardless of implicitTenantCreation", async () => {
    app = await startServer({ implicitTenantCreation: false });
    const response = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-ada" }),
    });
    expect(response.status).toBe(200);
  });
});

async function startServer(overrides: {
  implicitTenantCreation?: boolean;
  adminToken?: string;
}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    config: {
      ...(overrides.implicitTenantCreation !== undefined
        ? { implicitTenantCreation: overrides.implicitTenantCreation }
        : {}),
      ...(overrides.adminToken !== undefined ? { adminToken: overrides.adminToken } : {}),
    },
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
