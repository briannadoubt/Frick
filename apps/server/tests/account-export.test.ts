import { afterEach, describe, expect, it } from "vitest";
import type { FrickSchema } from "@fricken/protocol";
import { REDACTED_FIELD_VALUE } from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";
import type { OnAccountExport } from "../src/compliance/account-export.js";

// A minimal schema with a clearly owned object type and one field of each
// sensitivity that matters for export: `pii` (included — it is the user's own
// data), `content` (included), and `secret` (masked). `ownerId` is the
// framework's default ownership field.
const exportSchema: FrickSchema = {
  name: "frick-account-export-test",
  schemaId: "frick-account-export-test",
  schemaVersion: "0.1.0",
  schemaRevision: 1,
  minimumClientRevision: 1,
  minimumServerRevision: 1,
  protocol: "frick.realtime",
  protocolVersion: 1,
  compatibility: "greenfield-cutover",
  hash: "frick-account-export-test-0.1.0",
  objects: [
    {
      id: 1,
      name: "Note",
      fields: [
        { id: 1, name: "ownerId", kind: "string", required: true, sensitivity: "public" },
        { id: 2, name: "email", kind: "string", required: false, sensitivity: "pii" },
        { id: 3, name: "body", kind: "string", required: false, sensitivity: "content" },
        { id: 4, name: "apiKey", kind: "string", required: false, sensitivity: "secret" },
      ],
      indexes: [{ id: 1, name: "byOwner", fields: ["ownerId"] }],
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

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /account/export", () => {
  it("requires an authenticated session", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/account/export`);
    expect(response.status).toBe(401);
  });

  it("returns the calling principal's owned objects, grouped by type", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, "user-ada");

    app.store.upsertObject(ada.tenantId, "Note", "note-1", {
      ownerId: "user-ada",
      email: "ada@example.com",
      body: "ada's secret diary",
      apiKey: "sk-live-ada",
    });

    const { status, body } = await getJson(`${app.httpUrl}/account/export`, ada.sessionToken);
    expect(status).toBe(200);
    expect(body.userId).toBe("user-ada");
    expect(body.tenantId).toBe(ada.tenantId);
    expect(body.schemaHash).toBe(exportSchema.hash);
    expect(body.objects.Note).toHaveLength(1);
    const note = body.objects.Note[0];
    expect(note.id).toBe("note-1");
    // The user's own PII + content come back in full.
    expect(note.email).toBe("ada@example.com");
    expect(note.body).toBe("ada's secret diary");
    // Secret-classified fields are masked even in a self-service export.
    expect(note.apiKey).toBe(REDACTED_FIELD_VALUE);
  });

  it("does not include another principal's objects", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, "user-ada");
    const grace = await devLogin(app.httpUrl, "user-grace");

    app.store.upsertObject(ada.tenantId, "Note", "note-ada", { ownerId: "user-ada", body: "ada" });
    app.store.upsertObject(grace.tenantId, "Note", "note-grace", { ownerId: "user-grace", body: "grace" });

    const adaExport = await getJson(`${app.httpUrl}/account/export`, ada.sessionToken);
    expect(adaExport.body.objects.Note).toHaveLength(1);
    expect(adaExport.body.objects.Note[0].id).toBe("note-ada");
    expect(adaExport.body.objects.Note[0].ownerId).toBe("user-ada");
  });

  it("holds tenant isolation: never returns another tenant's objects", async () => {
    app = await startServer();
    // `user_id` is globally unique in auth_accounts, so use distinct ids per
    // tenant. The owner field on each Note matches the tenant's principal; the
    // export must only see the calling session's tenant even though both
    // tenants own a Note row.
    const t1 = await devLogin(app.httpUrl, "user-alpha", "tenant-one");
    const t2 = await devLogin(app.httpUrl, "user-bravo", "tenant-two");

    app.store.upsertObject("tenant-one", "Note", "note-t1", { ownerId: "user-alpha", body: "tenant-1 data" });
    app.store.upsertObject("tenant-two", "Note", "note-t2", { ownerId: "user-bravo", body: "tenant-2 data" });
    // Cross-tenant decoy: tenant-two owns a Note whose ownerId matches
    // tenant-one's principal. Tenant isolation (not just owner scoping) must
    // still hide it.
    app.store.upsertObject("tenant-two", "Note", "note-decoy", { ownerId: "user-alpha", body: "leak?" });

    const exportT1 = await getJson(`${app.httpUrl}/account/export`, t1.sessionToken);
    expect(exportT1.body.tenantId).toBe("tenant-one");
    expect(exportT1.body.objects.Note).toHaveLength(1);
    expect(exportT1.body.objects.Note[0].id).toBe("note-t1");

    const exportT2 = await getJson(`${app.httpUrl}/account/export`, t2.sessionToken);
    expect(exportT2.body.tenantId).toBe("tenant-two");
    expect(exportT2.body.objects.Note).toHaveLength(1);
    expect(exportT2.body.objects.Note[0].id).toBe("note-t2");
  });

  it("merges the onAccountExport hook output under `app`", async () => {
    const onAccountExport: OnAccountExport = (principal, base) => {
      // The hook can derive from the framework base and add app-specific data.
      return {
        ownedNoteCount: base.objects.Note?.length ?? 0,
        principalUserId: principal.userId,
        streams: ["app-specific-stream"],
      };
    };
    app = await startServer({ onAccountExport });
    const ada = await devLogin(app.httpUrl, "user-ada");
    app.store.upsertObject(ada.tenantId, "Note", "note-1", { ownerId: "user-ada", body: "x" });

    const { body } = await getJson(`${app.httpUrl}/account/export`, ada.sessionToken);
    expect(body.app).toEqual({
      ownedNoteCount: 1,
      principalUserId: "user-ada",
      streams: ["app-specific-stream"],
    });
  });

  it("omits `app` when no hook is registered", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, "user-ada");
    const { body } = await getJson(`${app.httpUrl}/account/export`, ada.sessionToken);
    expect("app" in body).toBe(false);
  });
});

async function startServer(
  options: Parameters<typeof createFrickServer>[0] = {},
) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    schema: exportSchema,
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

async function devLogin(
  httpUrl: string,
  userId: string,
  tenantId?: string,
): Promise<{ sessionToken: string; tenantId: string; userId: string }> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, ...(tenantId ? { tenantId } : {}) }),
  });
  if (response.status !== 200) {
    throw new Error(`dev-login failed (${response.status}): ${await response.text()}`);
  }
  expect(response.status).toBe(200);
  return (await response.json()) as { sessionToken: string; tenantId: string; userId: string };
}

async function getJson(
  url: string,
  sessionToken: string,
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined };
}
