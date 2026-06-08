import { afterEach, describe, expect, it } from "vitest";
import { productTestSchema, type FrickSchema } from "@fricken/protocol";

import { createFrickServer } from "../src/server.js";

/**
 * FR-153 — end-to-end app isolation over the HTTP surface (FR-6 epic).
 *
 * FR-37/FR-38/FR-40 proved per-app store/registry isolation at the store
 * layer. This suite proves the request boundary now resolves the appId and
 * threads it through, so two apps mounted on the SAME server — sharing one
 * database — cannot see each other's objects or streams. A single-app server
 * (the default) keeps everything under `_default` and is unaffected, which the
 * `multi-app.test.ts` + pre-existing route suites continue to assert.
 */

// Two apps share the foundation schema shape but advertise distinct schemaIds
// so the registry resolves them independently. Storage is server-shared; the
// only thing keeping their rows apart is the app_id boundary FR-153 threads.
const chatSchema: FrickSchema = {
  ...productTestSchema,
  schemaId: "frick.chat.e2e",
  hash: "chat-e2e-hash",
};
const docsSchema: FrickSchema = {
  ...productTestSchema,
  schemaId: "frick.docs.e2e",
  hash: "docs-e2e-hash",
};

interface RunningServer {
  httpUrl: string;
  close: () => Promise<void>;
}

async function startMultiAppServer(): Promise<RunningServer> {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    // The shared store schema (knows Conversation / MessageStream). The two
    // apps advertise distinct schemaIds for routing but share this storage
    // schema — exactly the v1 multi-app deployment shape.
    schema: productTestSchema,
    apps: [
      { id: "chat", schema: chatSchema, basePath: "/chat" },
      { id: "docs", schema: docsSchema, basePath: "/docs" },
    ],
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("no address");
  }
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    close: server.close,
  };
}

async function authHeaders(httpUrl: string, userId: string): Promise<Record<string, string>> {
  // Auth is server-wide (not app-scoped): dev-login is mounted at the root.
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { sessionToken: string };
  return {
    authorization: `Bearer ${body.sessionToken}`,
    "content-type": "application/json",
  };
}

describe("FR-153 end-to-end app isolation (HTTP)", () => {
  let app: RunningServer | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("objects written under one app are invisible to another app on the same server+tenant", async () => {
    app = await startMultiAppServer();
    const headers = await authHeaders(app.httpUrl, "user-ada");

    // Write a Conversation object through the /chat app boundary.
    const writeChat = await fetch(`${app.httpUrl}/chat/objects/Conversation/c-1`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ title: "chat-only convo" }),
    });
    expect(writeChat.status).toBeGreaterThanOrEqual(200);
    expect(writeChat.status).toBeLessThan(300);

    // The /chat app sees its own object.
    const readChat = await fetch(`${app.httpUrl}/chat/objects?type=Conversation`, { headers });
    expect(readChat.status).toBe(200);
    const chatBody = (await readChat.json()) as { data: Array<{ id?: string; title?: string }> };
    expect(chatBody.data.some((o) => o.title === "chat-only convo")).toBe(true);

    // The /docs app — same server, same tenant, same database — sees nothing.
    const readDocs = await fetch(`${app.httpUrl}/docs/objects?type=Conversation`, { headers });
    expect(readDocs.status).toBe(200);
    const docsBody = (await readDocs.json()) as { data: unknown[] };
    expect(docsBody.data).toEqual([]);
  });

  it("stream events appended under one app are invisible to another app", async () => {
    app = await startMultiAppServer();
    const headers = await authHeaders(app.httpUrl, "user-ada");

    const append = await fetch(`${app.httpUrl}/chat/append`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        stream: "MessageStream",
        key: "room-1",
        event: "MessageSent",
        payload: {
          messageId: "m-1",
          senderId: "user-ada",
          body: "hello from chat",
          createdAt: "2026-06-07T00:00:00.000Z",
        },
        requestId: "req-chat-1",
      }),
    });
    expect(append.status).toBe(200);

    // /chat reads its own event back.
    const readChat = await fetch(`${app.httpUrl}/chat/streams/MessageStream/room-1`, { headers });
    expect(readChat.status).toBe(200);
    const chatBody = (await readChat.json()) as { data: unknown[] };
    expect(chatBody.data.length).toBe(1);

    // /docs sees an empty stream at the same (tenant, stream, key).
    const readDocs = await fetch(`${app.httpUrl}/docs/streams/MessageStream/room-1`, { headers });
    expect(readDocs.status).toBe(200);
    const docsBody = (await readDocs.json()) as { data: unknown[] };
    expect(docsBody.data).toEqual([]);
  });

  it("each app lists only its own objects (distinct ids, same tenant+type)", async () => {
    app = await startMultiAppServer();
    const headers = await authHeaders(app.httpUrl, "user-ada");

    await fetch(`${app.httpUrl}/chat/objects/Conversation/chat-1`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ title: "chat side" }),
    });
    await fetch(`${app.httpUrl}/docs/objects/Conversation/docs-1`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ title: "docs side" }),
    });

    const chatBody = (await (
      await fetch(`${app.httpUrl}/chat/objects?type=Conversation`, { headers })
    ).json()) as { data: Array<{ title?: string }> };
    const docsBody = (await (
      await fetch(`${app.httpUrl}/docs/objects?type=Conversation`, { headers })
    ).json()) as { data: Array<{ title?: string }> };

    expect(chatBody.data.map((o) => o.title)).toEqual(["chat side"]);
    expect(docsBody.data.map((o) => o.title)).toEqual(["docs side"]);
  });

  it("rejects a cross-app write that would clobber another app's row at the same (tenant, type, id)", async () => {
    app = await startMultiAppServer();
    const headers = await authHeaders(app.httpUrl, "user-ada");

    const chatWrite = await fetch(`${app.httpUrl}/chat/objects/Conversation/shared-id`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ title: "owned by chat" }),
    });
    expect(chatWrite.status).toBeGreaterThanOrEqual(200);
    expect(chatWrite.status).toBeLessThan(300);

    // docs may not overwrite chat's row — the cross-app guard rejects it.
    const docsWrite = await fetch(`${app.httpUrl}/docs/objects/Conversation/shared-id`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ title: "docs attempting clobber" }),
    });
    expect(docsWrite.status).toBe(400);
    const body = (await docsWrite.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/cross-app access denied/i);

    // chat's row is untouched.
    const chatRead = (await (
      await fetch(`${app.httpUrl}/chat/objects?type=Conversation`, { headers })
    ).json()) as { data: Array<{ title?: string }> };
    expect(chatRead.data.map((o) => o.title)).toEqual(["owned by chat"]);
  });
});
