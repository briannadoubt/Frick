import { afterEach, describe, expect, it } from "vitest";
import { foundationSchema, type FrickSchema } from "@frick/protocol";
import { createFrickServer } from "../src/server.js";
import { createFrickProjectModule } from "../src/platform/project.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("platform project runtime", () => {
  it("uses the project schema as the root app schema", async () => {
    const schema: FrickSchema = {
      ...foundationSchema,
      name: "crm",
      schemaId: "crm",
      schemaVersion: "0.1.0",
      hash: "crm-hash",
    };
    const project = createFrickProjectModule({
      manifest: { id: "crm", name: "crm", displayName: "CRM" },
      schema,
    });

    app = await startServer({ project });

    const schemaResponse = await fetch(`${app.httpUrl}/schema`);
    expect(schemaResponse.status).toBe(200);
    const schemaBody = await schemaResponse.json();
    expect(schemaBody.schemaId).toBe("crm");

    const inspectResponse = await fetch(`${app.httpUrl}/_frick/inspect/apps`, {
      headers: await inspectHeaders(app.httpUrl),
    });
    expect(inspectResponse.status).toBe(200);
    const inspectBody = await inspectResponse.json();
    expect(inspectBody.apps).toEqual([
      {
        id: "crm",
        basePath: "",
        schemaId: "crm",
        schemaRevision: foundationSchema.schemaRevision,
      },
    ]);
  });

  it("lets explicit schema override project schema for backwards compatibility", async () => {
    const projectSchema: FrickSchema = {
      ...foundationSchema,
      name: "project-schema",
      schemaId: "project-schema",
      hash: "project-schema-hash",
    };
    const explicitSchema: FrickSchema = {
      ...foundationSchema,
      name: "explicit-schema",
      schemaId: "explicit-schema",
      hash: "explicit-schema-hash",
    };

    app = await startServer({
      project: createFrickProjectModule({
        manifest: { id: "crm", name: "crm" },
        schema: projectSchema,
      }),
      schema: explicitSchema,
    });

    const response = await fetch(`${app.httpUrl}/schema`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.schemaId).toBe("explicit-schema");

    const metadataResponse = await fetch(`${app.httpUrl}/_frick/dashboard/api/metadata`, {
      headers: await inspectHeaders(app.httpUrl),
    });
    expect(metadataResponse.status).toBe(200);
    const metadata = await metadataResponse.json();
    expect(metadata.project.schemaId).toBe("explicit-schema");
  });

  it("does not use project schema as the shared runtime schema when apps are explicit", async () => {
    const projectSchema: FrickSchema = {
      ...foundationSchema,
      name: "project-schema",
      schemaId: "project-schema",
      hash: "project-schema-hash",
    };
    const appSchema: FrickSchema = {
      ...foundationSchema,
      name: "explicit-app",
      schemaId: "explicit-app",
      hash: "explicit-app-hash",
    };

    app = await startServer({
      project: createFrickProjectModule({
        manifest: { id: "crm", name: "crm" },
        schema: projectSchema,
      }),
      apps: [{ id: "explicit-app", basePath: "", schema: appSchema }],
    });

    const schemaResponse = await fetch(`${app.httpUrl}/schema`);
    expect(schemaResponse.status).toBe(200);
    expect((await schemaResponse.json()).schemaId).toBe("explicit-app");

    const readyResponse = await fetch(`${app.httpUrl}/ready`);
    expect(readyResponse.status).toBe(200);
    expect((await readyResponse.json()).schemaId).toBe(foundationSchema.schemaId);
  });
});

describe("mounted dashboard", () => {
  it("serves dashboard HTML without embedding sensitive data", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/dashboard`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Fricken Dashboard");
    expect(html).toContain('href="dashboard.css"');
    expect(html).toContain('src="dashboard.js"');
    expect(html).not.toContain("sessionToken");
    expect(html).not.toContain("adminToken");
  });

  it("requires authentication for dashboard metadata", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/dashboard/api/metadata`);

    expect(response.status).toBe(401);
  });

  it("requires authentication for dashboard object data", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/dashboard/api/data/objects/User`);

    expect(response.status).toBe(401);
  });

  it("requires authentication for dashboard accounts", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/dashboard/api/accounts`);

    expect(response.status).toBe(401);
  });

  it("requires authentication for dashboard tenants", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/dashboard/api/tenants`);

    expect(response.status).toBe(401);
  });

  it("serves dashboard metadata API when authenticated", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/dashboard/api/metadata`, {
      headers: await inspectHeaders(app.httpUrl),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.project.schemaId).toBe("frick-foundation");
    expect(body.resources).toContainEqual({
      kind: "object",
      name: "User",
      fieldCount: 2,
      indexCount: 1,
    });
    expect(body.platformEvents).toMatchObject({
      adapter: "sqlite",
      ok: true,
      retained: expect.any(Number),
    });

    const scriptResponse = await fetch(`${app.httpUrl}/_frick/dashboard/dashboard.js`);
    expect(scriptResponse.status).toBe(200);
    const script = await scriptResponse.text();
    expect(script).toContain("/_frick/dashboard/api/metadata");
    expect(script).toContain("/_frick/dashboard/api/analytics/summary");
    expect(script).toContain("/_frick/inspect/analytics/summary");
    expect(script).toContain("platform-events/health");
    expect(script).toContain("/_frick/dashboard/api/data/objects/");
    expect(script).toContain("/_frick/dashboard/api/accounts");
    expect(script).toContain("/_frick/dashboard/api/tenants");
  });

  it("serves schema object rows through the mounted dashboard data API", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/dashboard/api/data/objects/User?limit=1`, {
      headers: await inspectHeaders(app.httpUrl),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      schemaHash: foundationSchema.hash,
      type: "User",
      tenantId: "_default",
      scope: "tenant",
      count: 1,
      limit: 1,
      truncated: true,
    });
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      id: "user-ada",
      displayName: "Ada Lovelace",
    });
  });

  it("applies user visibility when dashboard object data is tenant scoped", async () => {
    app = await startServer();
    app.store.upsertObject("_default", "MessageDraft", "user-ada:conversation-general", {
      userId: "user-ada",
      conversationId: "conversation-general",
      body: "ada draft",
      updatedAt: 1_700_000_000_000,
    });
    app.store.upsertObject("_default", "MessageDraft", "user-grace:conversation-general", {
      userId: "user-grace",
      conversationId: "conversation-general",
      body: "grace draft",
      updatedAt: 1_700_000_000_001,
    });

    const response = await fetch(`${app.httpUrl}/_frick/dashboard/api/data/objects/MessageDraft`, {
      headers: await inspectHeaders(app.httpUrl),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rows.map((row: { userId?: string }) => row.userId)).toEqual(["user-ada"]);
  });

  it("lets admin bearer inspect a requested tenant's dashboard object data", async () => {
    const adminToken = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";
    app = await startServer({
      config: { adminToken },
    });
    app.store.upsertObject("tenant-x", "User", "user-tenant-x", {
      displayName: "Tenant X",
      avatarBlobId: undefined,
    });

    const response = await fetch(
      `${app.httpUrl}/_frick/dashboard/api/data/objects/User?tenantId=tenant-x`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      type: "User",
      tenantId: "tenant-x",
      scope: "admin",
      count: 1,
      total: 1,
    });
    expect(body.rows).toEqual([
      {
        id: "user-tenant-x",
        displayName: "Tenant X",
        avatarBlobId: null,
      },
    ]);
  });

  it("serves tenant-scoped accounts through the mounted dashboard accounts API", async () => {
    app = await startServer();
    app.store.createAccountUser({
      tenantId: "_default",
      userId: "user-dashboard-one",
      handle: "dashboard-one",
      displayName: "Dashboard One",
      password: "supersecret",
    });
    app.store.createAccountUser({
      tenantId: "tenant-x",
      userId: "user-tenant-x",
      handle: "tenant-x",
      displayName: "Tenant X",
      password: "supersecret",
    });
    const login = await fetch(`${app.httpUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "dashboard-one", password: "supersecret" }),
    });
    expect(login.status).toBe(200);
    const { sessionToken } = (await login.json()) as { sessionToken: string };

    const response = await fetch(
      `${app.httpUrl}/_frick/dashboard/api/accounts?tenantId=tenant-x`,
      { headers: { authorization: `Bearer ${sessionToken}` } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      schemaHash: foundationSchema.hash,
      tenantId: "_default",
      scope: "tenant",
      count: 1,
      limit: 50,
      truncated: false,
    });
    expect(body.accounts).toEqual([
      expect.objectContaining({
        tenantId: "_default",
        userId: "user-dashboard-one",
        handle: "dashboard-one",
        displayName: "Dashboard One",
      }),
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("sessionToken");
  });

  it("lets admin bearer inspect a requested tenant's dashboard accounts", async () => {
    const adminToken = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";
    app = await startServer({
      config: { adminToken },
    });
    app.store.createAccountUser({
      tenantId: "tenant-x",
      userId: "user-xfirst",
      handle: "xfirst",
      displayName: "X First",
      password: "supersecret",
    });
    app.store.createAccountUser({
      tenantId: "tenant-x",
      userId: "user-xsecond",
      handle: "xsecond",
      displayName: "X Second",
      password: "supersecret",
    });

    const response = await fetch(
      `${app.httpUrl}/_frick/dashboard/api/accounts?tenantId=tenant-x&limit=1`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      tenantId: "tenant-x",
      scope: "admin",
      count: 1,
      limit: 1,
      truncated: true,
    });
    expect(body.accounts).toEqual([
      expect.objectContaining({
        tenantId: "tenant-x",
        handle: "xfirst",
        displayName: "X First",
      }),
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("sessionToken");
  });

  it("serves only the current tenant through the dashboard tenants API for tenant sessions", async () => {
    app = await startServer();
    app.store.tenants.create("tenant-other", "Other");
    const login = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant-session", userId: "user-tenant-session" }),
    });
    expect(login.status).toBe(200);
    const { sessionToken } = (await login.json()) as { sessionToken: string };

    const response = await fetch(
      `${app.httpUrl}/_frick/dashboard/api/tenants?includeArchived=true`,
      { headers: { authorization: `Bearer ${sessionToken}` } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      schemaHash: foundationSchema.hash,
      scope: "tenant",
      includeArchived: true,
      count: 1,
      limit: 50,
      truncated: false,
    });
    expect(body.tenants).toEqual([
      expect.objectContaining({ tenantId: "tenant-session" }),
    ]);
    expect(JSON.stringify(body)).not.toContain("tenant-other");
  });

  it("lets admin bearer list dashboard tenants and include archived rows on request", async () => {
    const adminToken = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";
    app = await startServer({
      config: { adminToken },
    });
    app.store.tenants.create("tenant-alpha", "Alpha");
    app.store.tenants.create("tenant-archived", "Archived");
    app.store.tenants.archive("tenant-archived");

    const activeResponse = await fetch(`${app.httpUrl}/_frick/dashboard/api/tenants`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(activeResponse.status).toBe(200);
    const activeBody = await activeResponse.json();
    expect(activeBody).toMatchObject({
      schemaHash: foundationSchema.hash,
      scope: "admin",
      includeArchived: false,
      count: 2,
      limit: 50,
      truncated: false,
    });
    expect(activeBody.tenants.map((row: { tenantId: string }) => row.tenantId)).toEqual([
      "_default",
      "tenant-alpha",
    ]);

    const archivedResponse = await fetch(
      `${app.httpUrl}/_frick/dashboard/api/tenants?includeArchived=true&limit=2`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    expect(archivedResponse.status).toBe(200);
    const archivedBody = await archivedResponse.json();
    expect(archivedBody).toMatchObject({
      schemaHash: foundationSchema.hash,
      scope: "admin",
      includeArchived: true,
      count: 2,
      limit: 2,
      truncated: true,
    });
    expect(archivedBody.tenants.map((row: { tenantId: string }) => row.tenantId)).toEqual([
      "_default",
      "tenant-alpha",
    ]);

    const fullArchivedResponse = await fetch(
      `${app.httpUrl}/_frick/dashboard/api/tenants?includeArchived=true`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    expect(fullArchivedResponse.status).toBe(200);
    const fullArchivedBody = await fullArchivedResponse.json();
    expect(fullArchivedBody.tenants).toContainEqual(
      expect.objectContaining({ tenantId: "tenant-archived", archivedAt: expect.any(String) }),
    );
    const serialized = JSON.stringify(fullArchivedBody);
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("sessionToken");
  });

  it("rejects unknown dashboard object data types", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/dashboard/api/data/objects/NotAThing`, {
      headers: await inspectHeaders(app.httpUrl),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "unknown_object_type",
      type: "NotAThing",
    });
  });

  it("does not serve dashboard routes under app base paths", async () => {
    app = await startServer({
      apps: [{ id: "chat", basePath: "/chat", schema: foundationSchema }],
    });

    const response = await fetch(`${app.httpUrl}/chat/_frick/dashboard/`);

    expect(response.status).toBe(404);
  });

  it("requires production admin bearer for dashboard metadata in production", async () => {
    const adminToken = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "frick-dashboard-prod-"));
    const dbPath = path.join(dir, "frick.sqlite");
    try {
      app = await startServer({
        dbPath,
        config: {
          env: "production",
          dbPath,
          demoAuthEnabled: false,
          inspectionEnabled: false,
          adminToken,
        },
      });

      const shell = await fetch(`${app.httpUrl}/_frick/dashboard`);
      expect(shell.status).toBe(200);

      const denied = await fetch(`${app.httpUrl}/_frick/dashboard/api/metadata`);
      expect(denied.status).toBe(401);

      const allowed = await fetch(`${app.httpUrl}/_frick/dashboard/api/metadata`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(allowed.status).toBe(200);
    } finally {
      await app?.close();
      app = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function startServer(options: Parameters<typeof createFrickServer>[0] = {}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    ...options,
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

async function inspectHeaders(httpUrl: string): Promise<Record<string, string>> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "user-ada" }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { sessionToken: string };
  return { authorization: `Bearer ${body.sessionToken}` };
}
