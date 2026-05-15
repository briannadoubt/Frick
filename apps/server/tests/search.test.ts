import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("POST /search with the built-in messages-fts index", () => {
  it("returns hits for an indexed MessageSent body", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    await appendMessage(app.httpUrl, ada.sessionToken, {
      requestId: "req-search-1",
      conversationId: "conversation-general",
      messageId: "message-1",
      senderId: "user-ada",
      body: "hello world from the search test",
    });

    const result = await postSearch(app.httpUrl, ada.sessionToken, {
      index: "messages-fts",
      q: "hello",
    });
    expect(result.status).toBe(200);
    expect(result.body.index).toBe("messages-fts");
    expect(result.body.hits.length).toBeGreaterThan(0);
    expect(result.body.hits[0].fields.conversationId).toBe("conversation-general");
    expect(result.body.hits[0].fields.senderId).toBe("user-ada");
  });

  it("filters hits by conversationId", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    // Two conversations, both contain "salmon" — filter selects only one.
    await appendMessage(app.httpUrl, ada.sessionToken, {
      requestId: "req-filter-a",
      conversationId: "conversation-general",
      messageId: "message-a",
      senderId: "user-ada",
      body: "salmon in the general room",
    });
    const otherConvId = await createConversation(app.httpUrl, ada.sessionToken, "Other");
    await appendMessage(app.httpUrl, ada.sessionToken, {
      requestId: "req-filter-b",
      conversationId: otherConvId,
      messageId: "message-b",
      senderId: "user-ada",
      body: "salmon in the other room",
    });

    const filtered = await postSearch(app.httpUrl, ada.sessionToken, {
      index: "messages-fts",
      q: "salmon",
      filter: { conversationId: otherConvId },
    });
    expect(filtered.status).toBe(200);
    expect(filtered.body.hits.length).toBe(1);
    expect(filtered.body.hits[0].fields.conversationId).toBe(otherConvId);
  });

  it("isolates results across tenants", async () => {
    app = await startServer();
    const a = await devLogin(app.httpUrl, {
      userId: "user-shared",
      tenantId: "tenant-a",
    });
    const b = await devLogin(app.httpUrl, {
      userId: "user-shared",
      tenantId: "tenant-b",
    });
    const convA = await createConversation(app.httpUrl, a.sessionToken, "A Only");
    const convB = await createConversation(app.httpUrl, b.sessionToken, "B Only");
    await appendMessage(app.httpUrl, a.sessionToken, {
      requestId: "req-tenant-a",
      conversationId: convA,
      messageId: "msg-a",
      senderId: "user-shared",
      body: "alpine secrets",
    });
    await appendMessage(app.httpUrl, b.sessionToken, {
      requestId: "req-tenant-b",
      conversationId: convB,
      messageId: "msg-b",
      senderId: "user-shared",
      body: "alpine secrets",
    });

    const aResult = await postSearch(app.httpUrl, a.sessionToken, {
      index: "messages-fts",
      q: "alpine",
    });
    expect(aResult.status).toBe(200);
    expect(aResult.body.hits.length).toBe(1);
    expect(aResult.body.hits[0].fields.conversationId).toBe(convA);
    const bResult = await postSearch(app.httpUrl, b.sessionToken, {
      index: "messages-fts",
      q: "alpine",
    });
    expect(bResult.status).toBe(200);
    expect(bResult.body.hits.length).toBe(1);
    expect(bResult.body.hits[0].fields.conversationId).toBe(convB);
  });

  it("filters messages-fts hits to conversations where the caller is a member", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    await appendMessage(app.httpUrl, ada.sessionToken, {
      requestId: "req-search-member-only",
      conversationId: "conversation-general",
      messageId: "msg-member-only",
      senderId: "user-ada",
      body: "ravenclaw-only searchable text",
    });
    app.store.upsertObject("_default", "User", "user-mallory", {
      displayName: "Mallory",
      avatarBlobId: undefined,
    });
    const mallory = await devLogin(app.httpUrl, { userId: "user-mallory" });

    const result = await postSearch(app.httpUrl, mallory.sessionToken, {
      index: "messages-fts",
      q: "ravenclaw",
    });

    expect(result.status).toBe(200);
    expect(result.body.hits).toEqual([]);
    expect(result.body.total).toBe(0);
  });

  it("orders more-relevant hits ahead of less-relevant ones", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    // First message contains the target token twice — should rank higher.
    await appendMessage(app.httpUrl, ada.sessionToken, {
      requestId: "req-score-1",
      conversationId: "conversation-general",
      messageId: "msg-high",
      senderId: "user-ada",
      body: "magpie magpie sings at dawn",
    });
    await appendMessage(app.httpUrl, ada.sessionToken, {
      requestId: "req-score-2",
      conversationId: "conversation-general",
      messageId: "msg-low",
      senderId: "user-ada",
      body: "a single magpie flew past the window",
    });

    const result = await postSearch(app.httpUrl, ada.sessionToken, {
      index: "messages-fts",
      q: "magpie",
    });
    expect(result.status).toBe(200);
    expect(result.body.hits.length).toBe(2);
    // bm25 returns negative numbers — lower (more negative) = more relevant.
    expect(result.body.hits[0].score).toBeLessThanOrEqual(result.body.hits[1].score);
  });

  it("honors the limit parameter", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    for (let i = 0; i < 5; i += 1) {
      await appendMessage(app.httpUrl, ada.sessionToken, {
        requestId: `req-limit-${i}`,
        conversationId: "conversation-general",
        messageId: `msg-limit-${i}`,
        senderId: "user-ada",
        body: `quokka iteration ${i}`,
      });
    }
    const result = await postSearch(app.httpUrl, ada.sessionToken, {
      index: "messages-fts",
      q: "quokka",
      limit: 2,
    });
    expect(result.status).toBe(200);
    expect(result.body.hits.length).toBe(2);
    expect(result.body.total).toBe(5);
  });

  it("treats an empty query as zero hits without erroring", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    const result = await postSearch(app.httpUrl, ada.sessionToken, {
      index: "messages-fts",
      q: "   ",
    });
    expect(result.status).toBe(200);
    expect(result.body.hits).toEqual([]);
    expect(result.body.total).toBe(0);
  });

  it("returns 404 envelope for an unknown index", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    const result = await postSearch(app.httpUrl, ada.sessionToken, {
      index: "no-such-index",
      q: "anything",
    });
    expect(result.status).toBe(404);
    expect(result.body.error.details.reason).toBe("searchIndexNotFound");
    expect(result.body.error.details.index).toBe("no-such-index");
  });

  it("requires authentication", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index: "messages-fts", q: "anything" }),
    });
    expect(response.status).toBe(401);
  });

  it("exposes /_frick/inspect/search when inspection is enabled", async () => {
    app = await startServer({ inspectionEnabled: true });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const response = await fetch(`${app.httpUrl}/_frick/inspect/search`, {
      headers: { authorization: `Bearer ${login.sessionToken}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      adapter: string;
      indexes: Array<{ name: string; source: unknown }>;
    };
    expect(body.adapter).toBe("sqlite-fts5");
    const names = body.indexes.map((i) => i.name);
    expect(names).toContain("messages-fts");
  });
});

async function startServer(
  overrides: { inspectionEnabled?: boolean } = {},
): Promise<{
  httpUrl: string;
  store: ReturnType<typeof createFrickServer>["store"];
  close: () => Promise<void>;
}> {
  const config: Record<string, unknown> = {};
  if (overrides.inspectionEnabled !== undefined)
    config.inspectionEnabled = overrides.inspectionEnabled;
  const server = createFrickServer({ port: 0, dbPath: ":memory:", config });
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
  body: { userId: string; tenantId?: string },
): Promise<{ sessionToken: string; tenantId: string; userId: string }> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    sessionToken: string;
    tenantId: string;
    userId: string;
  };
}

async function createConversation(
  httpUrl: string,
  sessionToken: string,
  title: string,
): Promise<string> {
  const response = await fetch(`${httpUrl}/conversations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({ kind: "group", title, participantUserIds: [] }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { conversation: { id: string } };
  return body.conversation.id;
}

async function appendMessage(
  httpUrl: string,
  sessionToken: string,
  args: {
    requestId: string;
    conversationId: string;
    messageId: string;
    senderId: string;
    body: string;
  },
): Promise<void> {
  const response = await fetch(`${httpUrl}/append`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({
      requestId: args.requestId,
      stream: "MessageStream",
      key: args.conversationId,
      event: "MessageSent",
      payload: {
        messageId: args.messageId,
        senderId: args.senderId,
        body: args.body,
        createdAt: "2026-05-09T00:00:00.000Z",
      },
    }),
  });
  expect(response.status).toBe(200);
}

async function postSearch(
  httpUrl: string,
  sessionToken: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${httpUrl}/search`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined };
}
