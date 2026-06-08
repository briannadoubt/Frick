import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";
import { FrickStore } from "../src/store.js";
import {
  assertServicePrincipalScope,
  servicePrincipalHasScope,
  AuthorizationError,
  type Principal,
} from "../src/authz.js";

/// FR-46: service principals (machine identities). These tests drive the full
/// lifecycle: issue an API key, authenticate with it, enforce scoped authz
/// (allow/deny), confirm an admin-audit event is emitted on access, revoke the
/// key, and confirm the key no longer authenticates.

const ADMIN_TOKEN = "test-admin-token-service-principal-0987654321";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("service principals — store lifecycle (FR-46)", () => {
  it("issues a key, returns it once, and never stores the plaintext", async () => {
    const store = new FrickStore({ path: ":memory:" });
    const issued = await store.servicePrincipals.issue({
      tenantId: "_default",
      name: "ci-deploy-bot",
      scopes: ["object.read", "stream.append"],
    });

    expect(issued.apiKey).toContain(".");
    expect(issued.keyId.startsWith("sk_")).toBe(true);
    expect(issued.apiKey.startsWith(issued.keyId)).toBe(true);
    expect(issued.scopes).toEqual(["object.read", "stream.append"]);

    // The plaintext key (and secret) must not be persisted in any column.
    const row = store.db
      .prepare("SELECT * FROM service_principals WHERE id = ?")
      .get(issued.id) as Record<string, unknown>;
    expect(row.key_hash).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(issued.apiKey.split(".")[1]);
    expect(row.key_hash).not.toBe(issued.apiKey);
  });

  it("authenticates a valid key into a tenant-scoped service principal record", async () => {
    const store = new FrickStore({ path: ":memory:" });
    const issued = await store.servicePrincipals.issue({
      tenantId: "tenant-a",
      name: "bot",
      scopes: ["object.read"],
    });

    const record = await store.servicePrincipals.authenticate(issued.apiKey);
    expect(record).toBeDefined();
    expect(record?.id).toBe(issued.id);
    expect(record?.tenantId).toBe("tenant-a");
    expect(record?.scopes).toEqual(["object.read"]);
  });

  it("rejects an unknown or tampered key", async () => {
    const store = new FrickStore({ path: ":memory:" });
    const issued = await store.servicePrincipals.issue({
      tenantId: "_default",
      name: "bot",
      scopes: [],
    });
    expect(await store.servicePrincipals.authenticate("sk_nope.invalid")).toBeUndefined();
    expect(await store.servicePrincipals.authenticate(`${issued.keyId}.wrongsecret`)).toBeUndefined();
    expect(await store.servicePrincipals.authenticate("not-a-key")).toBeUndefined();
  });

  it("enforces scoped authz: holds granted scope, denies missing scope", () => {
    const principal: Principal = {
      userId: "sp_x",
      deviceId: "service",
      replicaId: "service",
      tenantId: "_default",
      scope: "service",
      serviceScopes: ["object.read"],
    };
    expect(servicePrincipalHasScope(principal, "object.read")).toBe(true);
    expect(servicePrincipalHasScope(principal, "object.write")).toBe(false);
    expect(() => assertServicePrincipalScope(principal, "object.read")).not.toThrow();
    expect(() => assertServicePrincipalScope(principal, "object.write")).toThrow(
      AuthorizationError,
    );
  });

  it("treats the wildcard scope as granting everything, and never gates non-service principals", () => {
    const wildcard: Principal = {
      userId: "sp_y",
      deviceId: "service",
      replicaId: "service",
      tenantId: "_default",
      scope: "service",
      serviceScopes: ["*"],
    };
    expect(servicePrincipalHasScope(wildcard, "anything.at.all")).toBe(true);

    const user: Principal = {
      userId: "user-1",
      deviceId: "d",
      replicaId: "r",
      tenantId: "_default",
    };
    // A normal user principal is gated by the usual authz flow, not by service
    // scopes — so the scope helper is a no-op pass for it.
    expect(servicePrincipalHasScope(user, "object.write")).toBe(true);
  });

  it("revokes a key so it no longer authenticates (idempotent)", async () => {
    const store = new FrickStore({ path: ":memory:" });
    const issued = await store.servicePrincipals.issue({
      tenantId: "tenant-r",
      name: "bot",
      scopes: ["object.read"],
    });
    expect(await store.servicePrincipals.authenticate(issued.apiKey)).toBeDefined();

    expect(await store.servicePrincipals.revoke("tenant-r", issued.id)).toBe(true);
    expect(await store.servicePrincipals.authenticate(issued.apiKey)).toBeUndefined();
    // Second revoke is a no-op.
    expect(await store.servicePrincipals.revoke("tenant-r", issued.id)).toBe(false);
  });

  it("scopes list/revoke per tenant — one tenant cannot revoke another's principal", async () => {
    const store = new FrickStore({ path: ":memory:" });
    const a = await store.servicePrincipals.issue({ tenantId: "ta", name: "a", scopes: [] });
    await store.servicePrincipals.issue({ tenantId: "tb", name: "b", scopes: [] });

    const listA = await store.servicePrincipals.list("ta");
    expect(listA.map((r) => r.id)).toEqual([a.id]);

    // Wrong-tenant revoke does nothing; the key still authenticates.
    expect(await store.servicePrincipals.revoke("tb", a.id)).toBe(false);
    expect(await store.servicePrincipals.authenticate(a.apiKey)).toBeDefined();
  });
});

describe("service principals — request authentication + audit (FR-46)", () => {
  it("resolves an API key over HTTP and emits an admin-audit event", async () => {
    app = await startServer();
    const issued = await app.store.servicePrincipals.issue({
      tenantId: "_default",
      name: "ci-bot",
      scopes: ["object.read"],
    });

    // Hit a protected endpoint with the service key as the bearer.
    const res = await fetch(`${app.httpUrl}/account/export`, {
      headers: { authorization: `Bearer ${issued.apiKey}` },
    });
    // The request authenticated (no 401). Whatever the route returns, the
    // principal was resolved — which is what we assert via the audit log.
    expect(res.status).not.toBe(401);

    const audit = await app.store.adminAudit.list({ action: "servicePrincipal.authenticate" });
    const row = audit.find((r) => r.target === issued.id);
    expect(row).toBeDefined();
    expect(row?.outcome).toBe("allow");
    // The raw key must never appear in the audit row.
    expect(JSON.stringify(row)).not.toContain(issued.apiKey.split(".")[1]);
    expect(row?.detail && JSON.parse(row.detail)).toMatchObject({
      tenantId: "_default",
      scopes: ["object.read"],
    });
  });

  it("denies a revoked key over HTTP with a 401 and audits the denial", async () => {
    app = await startServer();
    const issued = await app.store.servicePrincipals.issue({
      tenantId: "_default",
      name: "ci-bot",
      scopes: ["object.read"],
    });
    await app.store.servicePrincipals.revoke("_default", issued.id);

    const res = await fetch(`${app.httpUrl}/account/export`, {
      headers: { authorization: `Bearer ${issued.apiKey}` },
    });
    expect(res.status).toBe(401);

    const audit = await app.store.adminAudit.list({ action: "servicePrincipal.authenticate" });
    const deny = audit.find((r) => r.outcome === "deny");
    expect(deny).toBeDefined();
  });
});

async function startServer() {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    config: { adminToken: ADMIN_TOKEN },
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
