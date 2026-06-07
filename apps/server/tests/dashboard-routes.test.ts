import { afterEach, describe, expect, it } from "vitest";
import { foundationSchema, productTestSchema, type FrickSchema } from "@fricken/protocol";
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

  it("requires authentication for dashboard tenant settings", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/dashboard/api/tenant-settings`);

    expect(response.status).toBe(401);
  });

  it("requires authentication for dashboard blob metadata", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/dashboard/api/blobs`);

    expect(response.status).toBe(401);
  });

  it("requires authentication for dashboard jobs", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/dashboard/api/jobs`);

    expect(response.status).toBe(401);
  });

  it("serves dashboard metadata API when authenticated", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/dashboard/api/metadata`, {
      headers: await inspectHeaders(app.httpUrl),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.project.schemaId).toBe(productTestSchema.schemaId);
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
    expect(script).toContain("/_frick/dashboard/api/tenant-settings");
    expect(script).toContain("/_frick/dashboard/api/blobs");
    expect(script).toContain("/_frick/dashboard/api/jobs");
  });

  it("serves schema object rows through the mounted dashboard data API", async () => {
    app = await startServer();
    // No default seeding anymore — explicitly insert the User row the
    // assertion needs. A second row makes truncated=true meaningful.
    await app.store.upsertObject("_default", "User", "user-ada", { displayName: "Ada Lovelace" });
    await app.store.upsertObject("_default", "User", "user-grace", { displayName: "Grace Hopper" });
    const response = await fetch(`${app.httpUrl}/_frick/dashboard/api/data/objects/User?limit=1`, {
      headers: await inspectHeaders(app.httpUrl),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      schemaHash: productTestSchema.hash,
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

  it("exposes every tenant row through the dashboard object data API by default", async () => {
    // Framework-level row visibility (MessageDraft-owner-only) is no longer
    // built-in — `FrickStore.isObjectVisibleToUser` always returns true.
    // Apps that want ownership filters must register a `object.read`
    // policy hook. This test pins the new "no built-in filter" contract.
    app = await startServer();
    await app.store.upsertObject("_default", "MessageDraft", "user-ada:conversation-general", {
      userId: "user-ada",
      conversationId: "conversation-general",
      body: "ada draft",
      updatedAt: 1_700_000_000_000,
    });
    await app.store.upsertObject("_default", "MessageDraft", "user-grace:conversation-general", {
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
    expect(body.rows.map((row: { userId?: string }) => row.userId).sort()).toEqual([
      "user-ada",
      "user-grace",
    ]);
  });

  it("lets admin bearer inspect a requested tenant's dashboard object data", async () => {
    const adminToken = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";
    app = await startServer({
      config: { adminToken },
    });
    await app.store.upsertObject("tenant-x", "User", "user-tenant-x", {
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

  it("masks secret/pii/content field values in dashboard object data while keeping public values", async () => {
    const sensitiveSchema: FrickSchema = {
      ...productTestSchema,
      name: "frick-sensitivity-dashboard",
      schemaId: "frick-sensitivity-dashboard",
      hash: "frick-sensitivity-dashboard-0.1.0",
      objects: [
        {
          id: 1,
          name: "Credential",
          fields: [
            { id: 1, name: "label", kind: "string", required: true, sensitivity: "public" },
            { id: 2, name: "email", kind: "string", required: true, sensitivity: "pii" },
            { id: 3, name: "apiToken", kind: "string", required: false, sensitivity: "secret" },
            { id: 4, name: "note", kind: "string", required: false, sensitivity: "content" },
            { id: 5, name: "internalRef", kind: "string", required: false }, // default private
          ],
          indexes: [{ id: 1, name: "all", fields: ["label"] }],
        },
      ],
      streams: [],
      events: [],
      presences: [],
      signals: [],
      blobs: [],
      jobs: [],
      projections: [],
    };

    app = await startServer({ schema: sensitiveSchema });
    await app.store.upsertObject("_default", "Credential", "cred-1", {
      label: "Primary key",
      email: "ada@example.com",
      apiToken: "tok_live_secret",
      note: "do not share",
      internalRef: "ref-123",
    });

    const response = await fetch(`${app.httpUrl}/_frick/dashboard/api/data/objects/Credential`, {
      headers: await inspectHeaders(app.httpUrl),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rows).toHaveLength(1);
    const row = body.rows[0];
    expect(row.label).toBe("Primary key"); // public passes through
    expect(row.email).toBe("<redacted>"); // pii masked
    expect(row.apiToken).toBe("<redacted>"); // secret masked
    expect(row.note).toBe("<redacted>"); // content masked
    expect(row.internalRef).toBe("ref-123"); // private default not masked
  });

  it("serves tenant-scoped accounts through the mounted dashboard accounts API", async () => {
    app = await startServer();
    await app.store.createAccountUser({
      tenantId: "_default",
      userId: "user-dashboard-one",
      handle: "dashboard-one",
      displayName: "Dashboard One",
      password: "supersecret",
    });
    await app.store.createAccountUser({
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
      schemaHash: productTestSchema.hash,
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
    await app.store.createAccountUser({
      tenantId: "tenant-x",
      userId: "user-xfirst",
      handle: "xfirst",
      displayName: "X First",
      password: "supersecret",
    });
    await app.store.createAccountUser({
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
    await app.store.tenants.create("tenant-other", "Other");
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
      schemaHash: productTestSchema.hash,
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
    await app.store.tenants.create("tenant-alpha", "Alpha");
    await app.store.tenants.create("tenant-archived", "Archived");
    await app.store.tenants.archive("tenant-archived");

    const activeResponse = await fetch(`${app.httpUrl}/_frick/dashboard/api/tenants`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(activeResponse.status).toBe(200);
    const activeBody = await activeResponse.json();
    expect(activeBody).toMatchObject({
      schemaHash: productTestSchema.hash,
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
      schemaHash: productTestSchema.hash,
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

  it("serves only the current tenant settings through the dashboard API for tenant sessions", async () => {
    app = await startServer();
    await app.store.tenants.create("tenant-other", "Other");
    await app.store.tenantSettings.set("tenant-other", "retentionMs", 12345);
    await app.store.tenantSettings.set("tenant-session", "limits", { maxBlobBytes: 8 });
    const login = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant-session", userId: "user-tenant-session" }),
    });
    expect(login.status).toBe(200);
    const { sessionToken } = (await login.json()) as { sessionToken: string };

    const response = await fetch(
      `${app.httpUrl}/_frick/dashboard/api/tenant-settings?tenantId=tenant-other`,
      { headers: { authorization: `Bearer ${sessionToken}` } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      schemaHash: productTestSchema.hash,
      tenantId: "tenant-session",
      scope: "tenant",
      settings: {
        limits: { maxBlobBytes: 8 },
        push: {
          apns: { configured: false },
          fcm: { configured: false },
          webPush: { configured: false },
        },
        configuredKeys: ["limits"],
        redactedKeys: [],
        otherKeys: [],
      },
    });
    expect(JSON.stringify(body)).not.toContain("12345");
  });

  it("lets admin bearer inspect sanitized dashboard tenant settings", async () => {
    const adminToken = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";
    app = await startServer({
      config: { adminToken },
    });
    await app.store.tenants.create("tenant-settings", "Settings");
    app.store.tenantSettings.set("tenant-settings", "limits", {
      maxBlobBytes: 8,
      maxStreamAppendPayloadBytes: 16,
      ignoredGlobalLimit: 999,
    });
    await app.store.tenantSettings.set("tenant-settings", "retentionMs", 60000);
    await app.store.tenantSettings.set("tenant-settings", "push.apns.encrypted", "apns-secret-ciphertext");
    await app.store.tenantSettings.set("tenant-settings", "push.fcm.encrypted", "fcm-secret-ciphertext");
    await app.store.tenantSettings.set("tenant-settings", "customFeature", { enabled: true });

    const response = await fetch(
      `${app.httpUrl}/_frick/dashboard/api/tenant-settings?tenantId=tenant-settings`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      schemaHash: productTestSchema.hash,
      tenantId: "tenant-settings",
      scope: "admin",
      settings: {
        limits: {
          maxBlobBytes: 8,
          maxStreamAppendPayloadBytes: 16,
        },
        retentionMs: 60000,
        push: {
          apns: { configured: true },
          fcm: { configured: true },
          webPush: { configured: false },
        },
        configuredKeys: [
          "customFeature",
          "limits",
          "push.apns.encrypted",
          "push.fcm.encrypted",
          "retentionMs",
        ],
        redactedKeys: ["push.apns.encrypted", "push.fcm.encrypted"],
        otherKeys: ["customFeature"],
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("apns-secret-ciphertext");
    expect(serialized).not.toContain("fcm-secret-ciphertext");
    expect(serialized).not.toContain("ignoredGlobalLimit");
  });

  it("serves tenant-owned blob metadata through the dashboard API without content bytes", async () => {
    app = await startServer();
    await app.store.blobs.create("_default", {
      blobId: "blob-dashboard-ada",
      ownerId: "user-ada",
      contentHash: "sha256-dashboard-ada",
      byteLength: 18,
      mimeType: "text/plain",
      storageKey: "secret/storage/key",
    });
    app.store.blobs.writeContent(
      "_default",
      "blob-dashboard-ada",
      Buffer.from("secret blob bytes"),
    );
    await app.store.blobs.create("_default", {
      blobId: "blob-dashboard-grace",
      ownerId: "user-grace",
      contentHash: "sha256-dashboard-grace",
      byteLength: 20,
      mimeType: "text/plain",
      storageKey: "grace/storage/key",
    });

    const response = await fetch(
      `${app.httpUrl}/_frick/dashboard/api/blobs?ownerId=user-grace&limit=10`,
      { headers: await inspectHeaders(app.httpUrl) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      schemaHash: productTestSchema.hash,
      tenantId: "_default",
      ownerId: "user-ada",
      scope: "tenant",
      count: 1,
      total: 1,
      limit: 10,
      truncated: false,
    });
    expect(body.blobs).toEqual([
      {
        tenantId: "_default",
        blobId: "blob-dashboard-ada",
        ownerId: "user-ada",
        contentHash: "sha256-dashboard-ada",
        byteLength: 18,
        mimeType: "text/plain",
        derivatives: {
          count: 0,
          totalBytes: 0,
          processors: [],
          mimeTypes: [],
          hasMetadata: false,
        },
        createdAt: expect.any(String),
      },
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret blob bytes");
    expect(serialized).not.toContain("secret/storage/key");
    expect(serialized).not.toContain("blob-dashboard-grace");
  });

  it("lets admin bearer inspect tenant blob metadata with owner filters", async () => {
    const adminToken = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";
    app = await startServer({
      config: { adminToken },
    });
    await app.store.blobs.create("tenant-x", {
      blobId: "blob-x-first",
      ownerId: "user-x",
      contentHash: "sha256-x-first",
      byteLength: 128,
      mimeType: "image/png",
      storageKey: "tenant-x/first",
    });
    await app.store.blobs.create("tenant-x", {
      blobId: "blob-x-second",
      ownerId: "user-x",
      contentHash: "sha256-x-second",
      byteLength: 64,
      mimeType: "image/png",
      storageKey: "tenant-x/second",
    });
    await app.store.blobs.create("tenant-x", {
      blobId: "blob-x-other",
      ownerId: "user-other",
      contentHash: "sha256-x-other",
      byteLength: 32,
      mimeType: "text/plain",
      storageKey: "tenant-x/other",
    });

    const response = await fetch(
      `${app.httpUrl}/_frick/dashboard/api/blobs?tenantId=tenant-x&ownerId=user-x&limit=1`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      schemaHash: productTestSchema.hash,
      tenantId: "tenant-x",
      ownerId: "user-x",
      scope: "admin",
      count: 1,
      total: 2,
      limit: 1,
      truncated: true,
    });
    expect(body.blobs).toEqual([
      {
        tenantId: "tenant-x",
        blobId: expect.stringMatching(/^blob-x-/),
        ownerId: "user-x",
        contentHash: expect.stringMatching(/^sha256-x-/),
        byteLength: expect.any(Number),
        mimeType: "image/png",
        derivatives: {
          count: 0,
          totalBytes: 0,
          processors: [],
          mimeTypes: [],
          hasMetadata: false,
        },
        createdAt: expect.any(String),
      },
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("tenant-x/first");
    expect(serialized).not.toContain("tenant-x/second");
    expect(serialized).not.toContain("blob-x-other");
  });

  it("summarizes blob derivative metadata without exposing derivative content or raw metadata", async () => {
    const adminToken = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";
    app = await startServer({
      config: { adminToken },
    });
    await app.store.blobs.create("tenant-x", {
      blobId: "blob-with-derivatives",
      ownerId: "user-x",
      contentHash: "sha256-parent",
      byteLength: 1024,
      mimeType: "image/png",
      storageKey: "tenant-x/parent-storage-key",
    });
    await app.store.blobDerivatives.record({
      parentBlobId: "blob-with-derivatives",
      derivativeId: "thumb",
      tenantId: "tenant-x",
      processorId: "image.thumbnail",
      mimeType: "image/webp",
      byteLength: 256,
      contentHash: "sha256-thumb",
      storageKey: "tenant-x/secret-thumb-storage-key",
      content: Buffer.from("secret derivative thumbnail bytes"),
      metadata: {
        width: 128,
        privateExif: "gps secret",
      },
    });
    await app.store.blobDerivatives.record({
      parentBlobId: "blob-with-derivatives",
      derivativeId: "ocr",
      tenantId: "tenant-x",
      processorId: "image.ocr",
      mimeType: "application/json",
      byteLength: 128,
      contentHash: "sha256-ocr",
      storageKey: "tenant-x/secret-ocr-storage-key",
      content: Buffer.from("secret extracted text"),
      metadata: {
        language: "en",
        text: "sensitive sidecar metadata",
      },
    });
    await app.store.blobDerivatives.record({
      parentBlobId: "blob-other-tenant",
      derivativeId: "thumb",
      tenantId: "tenant-other",
      processorId: "image.thumbnail",
      mimeType: "image/webp",
      byteLength: 999,
      contentHash: "sha256-other",
      storageKey: "tenant-other/secret",
      content: Buffer.from("other tenant derivative bytes"),
    });

    const response = await fetch(
      `${app.httpUrl}/_frick/dashboard/api/blobs?tenantId=tenant-x&ownerId=user-x`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.blobs).toEqual([
      expect.objectContaining({
        tenantId: "tenant-x",
        blobId: "blob-with-derivatives",
        derivatives: {
          count: 2,
          totalBytes: 384,
          processors: ["image.ocr", "image.thumbnail"],
          mimeTypes: ["application/json", "image/webp"],
          hasMetadata: true,
          latestCreatedAt: expect.any(String),
        },
      }),
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret derivative thumbnail bytes");
    expect(serialized).not.toContain("secret extracted text");
    expect(serialized).not.toContain("secret-thumb-storage-key");
    expect(serialized).not.toContain("secret-ocr-storage-key");
    expect(serialized).not.toContain("privateExif");
    expect(serialized).not.toContain("gps secret");
    expect(serialized).not.toContain("sensitive sidecar metadata");
    expect(serialized).not.toContain("tenant-other/secret");
  });

  it("serves tenant-scoped dashboard jobs without payloads or secret errors", async () => {
    app = await startServer();
    const row = await app.store.jobs.enqueue({
      tenantId: "tenant-session",
      jobType: "EmailDigest",
      payload: {
        recipient: "secret@example.com",
        token: "secret-token",
      },
      idempotencyKey: "secret-idempotency-key",
    });
    await app.store.jobs.fail(row.id, "email.provider_error", "smtp password leaked in error", false);
    await app.store.jobs.enqueue({
      tenantId: "tenant-other",
      jobType: "EmailDigest",
      payload: { recipient: "other@example.com" },
    });
    const login = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant-session", userId: "user-tenant-session" }),
    });
    expect(login.status).toBe(200);
    const { sessionToken } = (await login.json()) as { sessionToken: string };

    const response = await fetch(
      `${app.httpUrl}/_frick/dashboard/api/jobs?tenantId=tenant-other&limit=10`,
      { headers: { authorization: `Bearer ${sessionToken}` } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      schemaHash: productTestSchema.hash,
      tenantId: "tenant-session",
      scope: "tenant",
      count: 1,
      limit: 10,
      truncated: false,
    });
    expect(body.jobs).toEqual([
      {
        id: row.id,
        tenantId: "tenant-session",
        jobType: "EmailDigest",
        status: "dead_lettered",
        attemptCount: 0,
        maxAttempts: 5,
        availableAt: expect.any(String),
        createdAt: expect.any(String),
        failedAt: expect.any(String),
        deadLetteredAt: expect.any(String),
        lastErrorCode: "email.provider_error",
      },
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret@example.com");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("secret-idempotency-key");
    expect(serialized).not.toContain("smtp password leaked");
    expect(serialized).not.toContain("tenant-other");
  });

  it("lets admin bearer filter dashboard jobs by tenant, type, and status", async () => {
    const adminToken = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";
    app = await startServer({
      config: { adminToken },
    });
    await app.store.jobs.enqueue({
      tenantId: "tenant-jobs",
      jobType: "Digest",
      payload: { batch: 1 },
    });
    await app.store.jobs.enqueue({
      tenantId: "tenant-jobs",
      jobType: "Digest",
      payload: { batch: 2 },
    });
    await app.store.jobs.enqueue({
      tenantId: "tenant-jobs",
      jobType: "Cleanup",
      payload: { batch: 3 },
    });
    await app.store.jobs.enqueue({
      tenantId: "tenant-other",
      jobType: "Digest",
      payload: { batch: 4 },
    });

    const response = await fetch(
      `${app.httpUrl}/_frick/dashboard/api/jobs?tenantId=tenant-jobs&jobType=Digest&status=ready&limit=1`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      schemaHash: productTestSchema.hash,
      tenantId: "tenant-jobs",
      scope: "admin",
      status: "ready",
      jobType: "Digest",
      count: 1,
      limit: 1,
      truncated: true,
    });
    expect(body.jobs).toEqual([
      expect.objectContaining({
        tenantId: "tenant-jobs",
        jobType: "Digest",
        status: "ready",
      }),
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("tenant-other");
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
  const baseDefaults: Parameters<typeof createFrickServer>[0] = {
    port: 0,
    dbPath: ":memory:",
  };
  // Default to productTestSchema only when the caller hasn't supplied their
  // own schema/project/apps, so the platform-project tests below keep
  // exercising the explicit-schema path.
  if (options.schema === undefined && options.project === undefined && options.apps === undefined) {
    baseDefaults.schema = productTestSchema;
  }
  const server = createFrickServer({ ...baseDefaults, ...options });
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
