import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";
import type { FrickSearchIndexDefinition } from "../src/search/types.js";

const ADMIN_TOKEN = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("admin search rebuild route", () => {
  it("re-projects object-backed indexes from raw source state", async () => {
    const conversationsIndex: FrickSearchIndexDefinition = {
      name: "conversations-fts",
      source: { kind: "object", type: "Conversation" },
      project(input) {
        const value = input.object?.value;
        if (!value) return null;
        const title = typeof value.title === "string" ? value.title : "";
        const id = typeof value.id === "string" ? value.id : "";
        if (!title) return null;
        return { docId: id, text: title, fields: { conversationId: id } };
      },
    };
    app = await startServer({ indexes: [conversationsIndex] });
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    const convId = await createConversation(app.httpUrl, ada.sessionToken, "Penguin Plotters");

    // Index populated via the on-write hook — search should find it.
    const initial = await postSearch(app.httpUrl, ada.sessionToken, {
      index: "conversations-fts",
      q: "penguin",
    });
    expect(initial.status).toBe(200);
    expect(initial.body.hits.length).toBe(1);
    expect(initial.body.hits[0].fields.conversationId).toBe(convId);

    // Wipe the index directly so rebuild has something to recover. Reach
    // into the store to avoid baking a dev-only "clear index" route.
    app.searchAdapter.delete("_default", "conversations-fts", convId);
    const wiped = await postSearch(app.httpUrl, ada.sessionToken, {
      index: "conversations-fts",
      q: "penguin",
    });
    expect(wiped.body.hits.length).toBe(0);

    // Admin rebuild should re-project the Conversation object and repopulate.
    const rebuild = await fetch(
      `${app.httpUrl}/_frick/admin/search/conversations-fts/rebuild`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      },
    );
    expect(rebuild.status).toBe(200);
    const rebuildBody = (await rebuild.json()) as {
      index: string;
      tenantId: string;
      rebuiltAt: string;
    };
    expect(rebuildBody.index).toBe("conversations-fts");
    expect(rebuildBody.tenantId).toBe("_default");

    const after = await postSearch(app.httpUrl, ada.sessionToken, {
      index: "conversations-fts",
      q: "penguin",
    });
    expect(after.body.hits.length).toBe(1);
    expect(after.body.hits[0].fields.conversationId).toBe(convId);
  });

  it("rejects rebuild of an unknown index with a 404 envelope", async () => {
    app = await startServer();
    const rebuild = await fetch(
      `${app.httpUrl}/_frick/admin/search/no-such-index/rebuild`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      },
    );
    expect(rebuild.status).toBe(404);
    const body = (await rebuild.json()) as {
      error: { details: { reason: string; index: string } };
    };
    expect(body.error.details.reason).toBe("searchIndexNotFound");
    expect(body.error.details.index).toBe("no-such-index");
  });
});

async function startServer(
  overrides: { indexes?: FrickSearchIndexDefinition[] } = {},
): Promise<{
  httpUrl: string;
  close: () => Promise<void>;
  searchAdapter: ReturnType<typeof createFrickServer>["store"]["searchAdapter"];
}> {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    config: { adminToken: ADMIN_TOKEN },
    ...(overrides.indexes !== undefined ? { search: { indexes: overrides.indexes } } : {}),
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    close: server.close,
    searchAdapter: server.store.searchAdapter,
  };
}

async function devLogin(
  httpUrl: string,
  body: { userId: string; tenantId?: string },
): Promise<{ sessionToken: string; tenantId: string }> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { sessionToken: string; tenantId: string };
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
