import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { productTestSchema } from "@frick/protocol";
import { createFrickServer } from "../src/server.js";

let server: ReturnType<typeof createFrickServer>;
let httpUrl: string;

beforeEach(async () => {
  server = createFrickServer({ port: 0, dbPath: ":memory:", schema: productTestSchema });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  httpUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await server.close();
});

async function devLogin(userId: string, tenantId?: string): Promise<string> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, ...(tenantId ? { tenantId } : {}) }),
  });
  if (response.status !== 200) {
    throw new Error(`dev-login failed (${response.status}): ${await response.text()}`);
  }
  return ((await response.json()) as { sessionToken: string }).sessionToken;
}

async function append(conversationId: string, body: string, token: string): Promise<void> {
  const res = await fetch(`${httpUrl}/append`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      requestId: `req-${conversationId}-${body}`,
      replicaId: "replica-1",
      stream: "MessageStream",
      key: conversationId,
      event: "MessageSent",
      payload: {
        messageId: `msg-${conversationId}-${body}`,
        senderId: "u1",
        body,
        createdAt: "2026-05-31T00:00:00.000Z",
      },
    }),
  });
  if (!res.ok) throw new Error(`append failed: ${res.status} ${await res.text()}`);
}

async function get(path: string, token: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${httpUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("stream cursor query API (FR-116)", () => {
  it("GET /streams/:type/:id/cursor returns head sequence + count without payloads", async () => {
    const token = await devLogin("user-one", "t1");
    for (const t of ["a", "b", "c", "d", "e"]) await append("conv1", t, token);

    const { status, body } = await get("/streams/MessageStream/conv1/cursor", token);
    expect(status).toBe(200);
    expect(body).toEqual({ headSequence: 5, count: 5 });
    expect(body.events).toBeUndefined();
  });

  it("returns headSequence 0 for an empty/unknown stream", async () => {
    const token = await devLogin("user-one", "t1");
    const { status, body } = await get("/streams/MessageStream/never-written/cursor", token);
    expect(status).toBe(200);
    expect(body).toEqual({ headSequence: 0, count: 0 });
  });

  it("GET ?since=N returns only events after N, ascending", async () => {
    const token = await devLogin("user-one", "t1");
    for (const t of ["a", "b", "c", "d", "e"]) await append("conv2", t, token);

    const { status, body } = await get("/streams/MessageStream/conv2?since=2", token);
    expect(status).toBe(200);
    expect(body.events.map((e: any) => e.payload.body)).toEqual(["c", "d", "e"]);
  });

  it("?since at the head returns no events", async () => {
    const token = await devLogin("user-one", "t1");
    for (const t of ["a", "b", "c"]) await append("conv3", t, token);
    const { body } = await get("/streams/MessageStream/conv3?since=3", token);
    expect(body.events).toEqual([]);
  });

  it("?since respects ?limit and stays ascending", async () => {
    const token = await devLogin("user-one", "t1");
    for (const t of ["a", "b", "c", "d", "e"]) await append("conv4", t, token);
    const { body } = await get("/streams/MessageStream/conv4?since=1&limit=2", token);
    expect(body.events.map((e: any) => e.payload.body)).toEqual(["b", "c"]);
  });

  it("rejects a non-numeric ?since with 400", async () => {
    const token = await devLogin("user-one", "t1");
    await append("conv5", "a", token);
    const { status, body } = await get("/streams/MessageStream/conv5?since=notanumber", token);
    expect(status).toBe(400);
    expect(body.error?.code ?? body.code).toBe("stream.invalidCursor");
  });

  it("cursor + since are tenant-scoped", async () => {
    const t1 = await devLogin("user-one", "t1");
    for (const t of ["a", "b", "c"]) await append("shared", t, t1);

    const t2 = await devLogin("user-two", "t2");
    const cursor = await get("/streams/MessageStream/shared/cursor", t2);
    expect(cursor.body).toEqual({ headSequence: 0, count: 0 });

    const since = await get("/streams/MessageStream/shared?since=0", t2);
    expect(since.body.events).toEqual([]);
  });
});
