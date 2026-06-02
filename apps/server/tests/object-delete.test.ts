import { afterEach, describe, expect, it } from "vitest";
import { foundationSchema, validateSchema, type FrickSchema } from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";

/// A throwaway schema with a single "Note" object so the tests can write,
/// confirm, then delete a row and observe the route's idempotent shape.
function schemaWithNote(): FrickSchema {
  const next = structuredClone(foundationSchema);
  next.hash = `${next.hash}-delete-test`;
  next.objects.push({
    id: 99,
    name: "Note",
    fields: [{ id: 1, name: "body", kind: "string", required: true }],
    indexes: [],
  });
  return validateSchema(next);
}

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("DELETE /objects/:type/:id", () => {
  it("removes an existing row and reports existed: true", async () => {
    app = await startServer({ schema: schemaWithNote() });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const post = await fetch(`${app.httpUrl}/objects/Note/note-1`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(login.sessionToken) },
      body: JSON.stringify({ body: "hi" }),
    });
    expect(post.status).toBe(201);

    const del = await fetch(`${app.httpUrl}/objects/Note/note-1`, {
      method: "DELETE",
      headers: authHeaders(login.sessionToken),
    });
    expect(del.status).toBe(200);
    const body = (await del.json()) as { existed: boolean; schemaHash: string };
    expect(body.existed).toBe(true);

    // A follow-up GET should no longer see it in the list.
    const list = await fetch(`${app.httpUrl}/objects?type=Note`, {
      headers: authHeaders(login.sessionToken),
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: unknown[] };
    expect(listBody.data).toHaveLength(0);
  });

  it("is idempotent — a second delete reports existed: false without 404", async () => {
    app = await startServer({ schema: schemaWithNote() });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const first = await fetch(`${app.httpUrl}/objects/Note/never-existed`, {
      method: "DELETE",
      headers: authHeaders(login.sessionToken),
    });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { existed: boolean };
    expect(body.existed).toBe(false);
  });

  it("requires auth", async () => {
    app = await startServer({ schema: schemaWithNote() });

    const del = await fetch(`${app.httpUrl}/objects/Note/anything`, {
      method: "DELETE",
    });
    expect(del.status).toBe(401);
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
