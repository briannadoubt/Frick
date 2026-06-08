import { afterEach, describe, expect, it } from "vitest";
import { productTestSchema } from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";

// Coverage for FR-39 "Tenant admin API: move account between tenants". The
// authenticated admin route POST /_frick/admin/accounts/move reassigns an
// account's tenant: the account identity row moves to the target tenant, every
// session bound to the OLD tenant is revoked so the user re-authenticates into
// the new one, the target tenant must already exist, and the action is recorded
// on the admin-audit hash chain. Per-tenant DATA (object/stream stores) does
// NOT move — that boundary is documented, not migrated here.

const ADMIN_TOKEN = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("POST /_frick/admin/accounts/move", () => {
  it("moves an account to the new tenant and revokes old-tenant sessions", async () => {
    app = await startServer();
    await createTenant("tenant-old");
    await createTenant("tenant-new");
    await createAccount("tenant-old", "ada");

    const userId = "u-ada";
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await app.store.sessions.create({
      sessionToken: "tok-ada",
      tenantId: "tenant-old",
      userId,
      deviceId: "device-a",
      replicaId: "replica-a",
      expiresAt,
    });
    expect(await app.store.readActiveSession("tok-ada")).toBeDefined();

    const res = await move({ userId, fromTenantId: "tenant-old", toTenantId: "tenant-new" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      moved: boolean;
      toTenantId: string;
      revoked: number;
    };
    expect(body.moved).toBe(true);
    expect(body.toTenantId).toBe("tenant-new");
    expect(body.revoked).toBe(1);

    // Account now lives in the new tenant, gone from the old one.
    expect(await app.store.accounts.readByIdentity("tenant-new", userId)).toBeDefined();
    expect(await app.store.accounts.readByIdentity("tenant-old", userId)).toBeUndefined();

    // Old-tenant session was invalidated.
    expect(await app.store.readActiveSession("tok-ada")).toBeUndefined();
  });

  it("records the move on the admin audit log", async () => {
    app = await startServer();
    await createTenant("tenant-old");
    await createTenant("tenant-new");
    await createAccount("tenant-old", "ada");

    await move({ userId: "u-ada", fromTenantId: "tenant-old", toTenantId: "tenant-new" });

    const auditRes = await fetch(`${app.httpUrl}/_frick/admin/audit-log?action=accounts.move`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const { entries } = (await auditRes.json()) as {
      entries: Array<{ action: string; outcome: string }>;
    };
    expect(entries.some((e) => e.action === "accounts.move" && e.outcome === "allow")).toBe(true);
  });

  it("404s for an unknown account", async () => {
    app = await startServer();
    await createTenant("tenant-old");
    await createTenant("tenant-new");

    const res = await move({
      userId: "u-nobody",
      fromTenantId: "tenant-old",
      toTenantId: "tenant-new",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; error: { details: { reason: string } } };
    expect(body.code).toBe("sync.protocolError");
    expect(body.error.details.reason).toBe("accountNotFound");
  });

  it("403s when the target tenant does not exist", async () => {
    app = await startServer();
    await createTenant("tenant-old");
    await createAccount("tenant-old", "ada");

    const res = await move({
      userId: "u-ada",
      fromTenantId: "tenant-old",
      toTenantId: "tenant-ghost",
    });
    // ensureTenantAllowed throws UnknownTenantError -> auth.forbidden (403).
    expect(res.status).toBe(403);
    // Account stays put.
    expect(await app.store.accounts.readByIdentity("tenant-old", "u-ada")).toBeDefined();
  });

  it("409s when the target tenant already has that handle", async () => {
    app = await startServer();
    await createTenant("tenant-old");
    await createTenant("tenant-new");
    await createAccount("tenant-old", "ada");
    // A different account in the target tenant already owns the same handle.
    await app.store.accounts.create({
      tenantId: "tenant-new",
      userId: "u-other",
      handle: "ada",
      displayName: "Other Ada",
      password: "correct horse battery staple",
    });

    const res = await move({
      userId: "u-ada",
      fromTenantId: "tenant-old",
      toTenantId: "tenant-new",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("storage.conflict");
    // Source account untouched.
    expect(await app.store.accounts.readByIdentity("tenant-old", "u-ada")).toBeDefined();
  });

  it("rejects an unauthenticated move request", async () => {
    app = await startServer();
    const res = await fetch(`${app.httpUrl}/_frick/admin/accounts/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "u-ada", fromTenantId: "tenant-old", toTenantId: "tenant-new" }),
    });
    expect(res.status).toBe(401);
  });
});

async function startServer() {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    schema: productTestSchema,
    // Disable implicit tenant creation so the "target tenant must exist" guard
    // is exercised (otherwise an unknown tenant would be auto-registered).
    config: { adminToken: ADMIN_TOKEN, implicitTenantCreation: false },
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

function createTenant(tenantId: string): Promise<Response> {
  return fetch(`${app!.httpUrl}/_frick/admin/tenants`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ tenantId }),
  });
}

function createAccount(tenantId: string, handle: string): Promise<Response> {
  return fetch(`${app!.httpUrl}/_frick/admin/accounts`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      tenantId,
      userId: `u-${handle}`,
      handle,
      displayName: handle,
      password: "correct horse battery staple",
    }),
  });
}

function move(body: {
  userId: string;
  fromTenantId: string;
  toTenantId: string;
}): Promise<Response> {
  return fetch(`${app!.httpUrl}/_frick/admin/accounts/move`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
