import { afterEach, describe, expect, it } from "vitest";
import {
  foundationSchema,
  isFrickErrorEnvelope,
  validateSchema,
  type FrickSchema,
} from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";
import { FrickStore } from "../src/store.js";
import { FrickObjectVersionConflictError } from "../src/storage/object-errors.js";

/**
 * The foundation schema doesn't currently contain a versionPrecondition
 * object. These tests build a derived schema that adds a single "Note" type
 * configured for versionPrecondition so we can exercise both code paths from
 * one server instance.
 */
function schemaWithNote(mergePolicy: "versionPrecondition" | "lastWriteWins"): FrickSchema {
  const next = structuredClone(foundationSchema);
  next.hash = `${next.hash}-note-${mergePolicy}`;
  next.objects.push({
    id: 99,
    name: "Note",
    fields: [
      { id: 1, name: "body", kind: "string", required: true },
      { id: 2, name: "tag", kind: "string", required: false },
    ],
    indexes: [],
    mergePolicy,
  });
  return validateSchema(next);
}

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("object versioning", () => {
  it("creates an object via POST /objects/:type/:id with version 1", async () => {
    app = await startServer({ schema: schemaWithNote("versionPrecondition") });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const response = await fetch(`${app.httpUrl}/objects/Note/note-1`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(login.sessionToken) },
      body: JSON.stringify({ body: "first" }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("etag")).toBe("1");
    const body = (await response.json()) as {
      version: number;
      object: { id: string; body: string };
      mergePolicy: string;
    };
    expect(body.version).toBe(1);
    expect(body.object).toMatchObject({ id: "note-1", body: "first" });
    expect(body.mergePolicy).toBe("versionPrecondition");
  });

  it("accepts a versionPrecondition update with the matching If-Match header", async () => {
    app = await startServer({ schema: schemaWithNote("versionPrecondition") });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    await postNote(app.httpUrl, login.sessionToken, "note-2", { body: "v1" });

    const update = await fetch(`${app.httpUrl}/objects/Note/note-2`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "if-match": "1",
        ...authHeaders(login.sessionToken),
      },
      body: JSON.stringify({ body: "v2" }),
    });

    expect(update.status).toBe(200);
    expect(update.headers.get("etag")).toBe("2");
    const body = (await update.json()) as { version: number };
    expect(body.version).toBe(2);
  });

  it("rejects a versionPrecondition update with a stale If-Match (409 storage.conflict)", async () => {
    app = await startServer({ schema: schemaWithNote("versionPrecondition") });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    await postNote(app.httpUrl, login.sessionToken, "note-3", { body: "v1" });
    // Advance to v2.
    await postNote(app.httpUrl, login.sessionToken, "note-3", { body: "v2" }, { ifMatch: "1" });

    const stale = await fetch(`${app.httpUrl}/objects/Note/note-3`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "if-match": "1",
        ...authHeaders(login.sessionToken),
      },
      body: JSON.stringify({ body: "v?" }),
    });

    expect(stale.status).toBe(409);
    expect(stale.headers.get("etag")).toBe("2");
    const body = (await stale.json()) as { error: unknown; code: string };
    expect(isFrickErrorEnvelope(body.error)).toBe(true);
    expect(body.code).toBe("storage.conflict");
    expect((body.error as { details: Record<string, unknown> }).details).toMatchObject({
      expectedVersion: 1,
      actualVersion: 2,
      mergePolicy: "versionPrecondition",
      objectType: "Note",
      objectId: "note-3",
    });
  });

  it("rejects a versionPrecondition write without If-Match when the row already exists", async () => {
    app = await startServer({ schema: schemaWithNote("versionPrecondition") });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    await postNote(app.httpUrl, login.sessionToken, "note-4", { body: "v1" });

    const duplicate = await fetch(`${app.httpUrl}/objects/Note/note-4`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(login.sessionToken) },
      body: JSON.stringify({ body: "again" }),
    });

    expect(duplicate.status).toBe(409);
    const body = (await duplicate.json()) as { code: string; error: unknown };
    expect(body.code).toBe("storage.conflict");
    expect((body.error as { details: Record<string, unknown> }).details.actualVersion).toBe(1);
  });

  it("updates a lastWriteWins object without If-Match and increments the version", async () => {
    app = await startServer({ schema: schemaWithNote("lastWriteWins") });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const first = await postNote(app.httpUrl, login.sessionToken, "note-5", { body: "v1" });
    expect(first.status).toBe(201);
    expect(first.body.version).toBe(1);

    const second = await postNote(app.httpUrl, login.sessionToken, "note-5", { body: "v2" });
    expect(second.status).toBe(200);
    expect(second.body.version).toBe(2);
    expect(second.body.mergePolicy).toBe("lastWriteWins");
  });

  it("ignores If-Match for lastWriteWins schemas", async () => {
    app = await startServer({ schema: schemaWithNote("lastWriteWins") });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    await postNote(app.httpUrl, login.sessionToken, "note-6", { body: "v1" });

    const stale = await fetch(`${app.httpUrl}/objects/Note/note-6`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "if-match": "999",
        ...authHeaders(login.sessionToken),
      },
      body: JSON.stringify({ body: "wins anyway" }),
    });

    expect(stale.status).toBe(200);
    const body = (await stale.json()) as { version: number };
    expect(body.version).toBe(2);
  });

  it("FrickObjectVersionConflictError carries tenant/object/version metadata", () => {
    const store = new FrickStore({
      path: ":memory:",
      schema: schemaWithNote("versionPrecondition"),
      seed: false,
    });
    try {
      store.upsertObjectWithPolicy({
        type: "Note",
        id: "note-storage",
        value: { body: "v1" },
      });

      let captured: FrickObjectVersionConflictError | undefined;
      try {
        store.upsertObjectWithPolicy({
          type: "Note",
          id: "note-storage",
          value: { body: "v2" },
          expectedVersion: 99,
        });
      } catch (error) {
        captured = error as FrickObjectVersionConflictError;
      }

      expect(captured).toBeInstanceOf(FrickObjectVersionConflictError);
      expect(captured?.code).toBe("storage.conflict");
      expect(captured?.objectType).toBe("Note");
      expect(captured?.objectId).toBe("note-storage");
      expect(captured?.expectedVersion).toBe(99);
      expect(captured?.actualVersion).toBe(1);
    } finally {
      store.close();
    }
  });
});

async function startServer(options: { schema?: FrickSchema } = {}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    ...(options.schema ? { schema: options.schema } : {}),
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
  body: { userId: string },
): Promise<{ sessionToken: string }> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { sessionToken: string };
}

function authHeaders(sessionToken: string): Record<string, string> {
  return { authorization: `Bearer ${sessionToken}` };
}

async function postNote(
  httpUrl: string,
  sessionToken: string,
  id: string,
  body: Record<string, unknown>,
  options: { ifMatch?: string } = {},
): Promise<{ status: number; body: { version: number; mergePolicy: string } }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...authHeaders(sessionToken),
  };
  if (options.ifMatch !== undefined) {
    headers["if-match"] = options.ifMatch;
  }
  const response = await fetch(`${httpUrl}/objects/Note/${encodeURIComponent(id)}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as { version: number; mergePolicy: string },
  };
}
