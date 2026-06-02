import { afterEach, describe, expect, it } from "vitest";
import type { FrickSchema } from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";
import type { OnAccountDelete } from "../src/compliance/account-delete.js";

// Minimal schema with one clearly owned object type. `ownerId` is the
// framework's default ownership field (shared with the account export).
const deleteSchema: FrickSchema = {
  name: "frick-account-delete-test",
  schemaId: "frick-account-delete-test",
  schemaVersion: "0.1.0",
  schemaRevision: 1,
  minimumClientRevision: 1,
  minimumServerRevision: 1,
  protocol: "frick.realtime",
  protocolVersion: 1,
  compatibility: "greenfield-cutover",
  hash: "frick-account-delete-test-0.1.0",
  objects: [
    {
      id: 1,
      name: "Note",
      fields: [
        { id: 1, name: "ownerId", kind: "string", required: true, sensitivity: "public" },
        { id: 2, name: "body", kind: "string", required: false, sensitivity: "content" },
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

describe("DELETE /account", () => {
  it("requires an authenticated session", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/account`, { method: "DELETE" });
    expect(response.status).toBe(401);
  });

  it("deletes the caller's account, sessions, and owned objects", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, "user-ada");

    app.store.upsertObject(ada.tenantId, "Note", "note-1", { ownerId: "user-ada", body: "a" });
    app.store.upsertObject(ada.tenantId, "Note", "note-2", { ownerId: "user-ada", body: "b" });

    const { status, body } = await deleteAccount(`${app.httpUrl}/account`, ada.sessionToken);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.userId).toBe("user-ada");
    expect(body.tenantId).toBe(ada.tenantId);
    expect(body.accountDeleted).toBe(true);
    expect(body.deletedSessions).toBe(1);
    expect(body.deletedObjects.Note).toBe(2);

    // Owned objects are gone from storage.
    expect(app.store.listObjects(ada.tenantId, "Note")).toHaveLength(0);
    // Account row is gone.
    expect(app.store.hasUser(ada.tenantId, "user-ada")).toBe(false);
    // The caller's session no longer authenticates: a follow-up protected
    // request is rejected.
    const after = await fetch(`${app.httpUrl}/account/export`, {
      headers: { authorization: `Bearer ${ada.sessionToken}` },
    });
    expect(after.status).toBe(401);
  });

  it("invokes the onAccountDelete hook with the framework result", async () => {
    let seen:
      | { userId: string; tenantId: string; deletedObjects: Record<string, number> }
      | undefined;
    const onAccountDelete: OnAccountDelete = (principal, result) => {
      seen = {
        userId: principal.userId,
        tenantId: principal.tenantId,
        deletedObjects: result.deletedObjects,
      };
    };
    app = await startServer({ onAccountDelete });
    const ada = await devLogin(app.httpUrl, "user-ada");
    app.store.upsertObject(ada.tenantId, "Note", "note-1", { ownerId: "user-ada", body: "x" });

    const { status } = await deleteAccount(`${app.httpUrl}/account`, ada.sessionToken);
    expect(status).toBe(200);
    expect(seen).toEqual({
      userId: "user-ada",
      tenantId: ada.tenantId,
      deletedObjects: { Note: 1 },
    });
  });

  it("leaves another principal's data untouched", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, "user-ada");
    const grace = await devLogin(app.httpUrl, "user-grace");

    app.store.upsertObject(ada.tenantId, "Note", "note-ada", { ownerId: "user-ada", body: "ada" });
    app.store.upsertObject(grace.tenantId, "Note", "note-grace", { ownerId: "user-grace", body: "grace" });

    const { status } = await deleteAccount(`${app.httpUrl}/account`, ada.sessionToken);
    expect(status).toBe(200);

    // Grace's object survives; Ada's is gone.
    const notes = app.store.listObjects(grace.tenantId, "Note");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.id).toBe("note-grace");
    // Grace's account + session still work.
    expect(app.store.hasUser(grace.tenantId, "user-grace")).toBe(true);
    const graceExport = await fetch(`${app.httpUrl}/account/export`, {
      headers: { authorization: `Bearer ${grace.sessionToken}` },
    });
    expect(graceExport.status).toBe(200);
  });

  it("leaves another tenant's data untouched, including same-named owner decoys", async () => {
    app = await startServer();
    // Distinct user ids per tenant (user_id is globally unique in accounts).
    const t1 = await devLogin(app.httpUrl, "user-alpha", "tenant-one");
    const t2 = await devLogin(app.httpUrl, "user-bravo", "tenant-two");

    app.store.upsertObject("tenant-one", "Note", "note-t1", { ownerId: "user-alpha", body: "t1" });
    app.store.upsertObject("tenant-two", "Note", "note-t2", { ownerId: "user-bravo", body: "t2" });
    // Cross-tenant decoy: tenant-two owns a Note whose ownerId matches
    // tenant-one's principal. Tenant scoping (not just owner scoping) must keep
    // the deletion from reaching it.
    app.store.upsertObject("tenant-two", "Note", "note-decoy", { ownerId: "user-alpha", body: "leak?" });

    const { status, body } = await deleteAccount(`${app.httpUrl}/account`, t1.sessionToken);
    expect(status).toBe(200);
    expect(body.deletedObjects.Note).toBe(1);

    // tenant-one's data gone; tenant-two fully intact (both its own row and the
    // decoy whose ownerId collided with tenant-one's principal).
    expect(app.store.listObjects("tenant-one", "Note")).toHaveLength(0);
    const t2Notes = app.store
      .listObjects("tenant-two", "Note")
      .map((n) => n.id)
      .sort();
    expect(t2Notes).toEqual(["note-decoy", "note-t2"]);
    expect(app.store.hasUser("tenant-two", "user-bravo")).toBe(true);
  });

  it("accepts POST /account as an alias for DELETE", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, "user-ada");
    const response = await fetch(`${app.httpUrl}/account`, {
      method: "POST",
      headers: { authorization: `Bearer ${ada.sessionToken}` },
    });
    expect(response.status).toBe(200);
    expect(app.store.hasUser(ada.tenantId, "user-ada")).toBe(false);
  });

  it("records an account.delete audit row", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, "user-ada");
    app.store.upsertObject(ada.tenantId, "Note", "note-1", { ownerId: "user-ada", body: "x" });

    const { status } = await deleteAccount(`${app.httpUrl}/account`, ada.sessionToken);
    expect(status).toBe(200);

    const entries = app.store.adminAudit.list({ action: "account.delete" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe("account.delete");
    expect(entries[0]?.target).toBe("user-ada");
    expect(entries[0]?.outcome).toBe("allow");
    // Chain stays intact after the deletion-driven append.
    expect(app.store.adminAudit.verifyChain().valid).toBe(true);
  });
});

async function startServer(
  options: Parameters<typeof createFrickServer>[0] = {},
) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    schema: deleteSchema,
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
  return (await response.json()) as { sessionToken: string; tenantId: string; userId: string };
}

async function deleteAccount(
  url: string,
  sessionToken: string,
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined };
}
