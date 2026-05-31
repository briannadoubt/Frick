import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { productTestSchema } from "@frick/protocol";
import { startTestServer, demoLogin, type RunningServer } from "./util/server-harness.js";

let running: RunningServer;

beforeEach(async () => {
  running = await startTestServer(productTestSchema);
});

afterEach(async () => {
  await running.close();
});

async function append(streamId: string, text: string, token: string): Promise<void> {
  const res = await fetch(`${running.baseUrl}/streams/MessageStream/${streamId}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      requestId: `req-${streamId}-${text}`,
      replicaId: "replica-1",
      event: "MessageSent",
      payload: { messageId: `msg-${streamId}-${text}`, authorId: "u1", text },
    }),
  });
  if (!res.ok) throw new Error(`append failed: ${res.status} ${await res.text()}`);
}

async function get(path: string, token: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${running.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("stream cursor query API (FR-116)", () => {
  it("GET /streams/:type/:id/cursor returns head sequence + count without payloads", async () => {
    const token = await demoLogin(running, { userId: "u1", tenantId: "t1" });
    for (const t of ["a", "b", "c", "d", "e"]) await append("conv1", t, token);

    const { status, body } = await get("/streams/MessageStream/conv1/cursor", token);
    expect(status).toBe(200);
    expect(body).toEqual({ headSequence: 5, count: 5 });
    expect(body.events).toBeUndefined();
  });

  it("returns headSequence 0 for an empty/unknown stream", async () => {
    const token = await demoLogin(running, { userId: "u1", tenantId: "t1" });
    const { status, body } = await get("/streams/MessageStream/never-written/cursor", token);
    expect(status).toBe(200);
    expect(body).toEqual({ headSequence: 0, count: 0 });
  });

  it("GET ?since=N returns only events after N, ascending", async () => {
    const token = await demoLogin(running, { userId: "u1", tenantId: "t1" });
    for (const t of ["a", "b", "c", "d", "e"]) await append("conv2", t, token);

    const { status, body } = await get("/streams/MessageStream/conv2?since=2", token);
    expect(status).toBe(200);
    expect(body.events.map((e: any) => e.payload.text)).toEqual(["c", "d", "e"]);
  });

  it("?since at the head returns no events", async () => {
    const token = await demoLogin(running, { userId: "u1", tenantId: "t1" });
    for (const t of ["a", "b", "c"]) await append("conv3", t, token);
    const { body } = await get("/streams/MessageStream/conv3?since=3", token);
    expect(body.events).toEqual([]);
  });

  it("?since respects ?limit and stays ascending", async () => {
    const token = await demoLogin(running, { userId: "u1", tenantId: "t1" });
    for (const t of ["a", "b", "c", "d", "e"]) await append("conv4", t, token);
    const { body } = await get("/streams/MessageStream/conv4?since=1&limit=2", token);
    expect(body.events.map((e: any) => e.payload.text)).toEqual(["b", "c"]);
  });

  it("rejects a non-numeric ?since with 400", async () => {
    const token = await demoLogin(running, { userId: "u1", tenantId: "t1" });
    await append("conv5", "a", token);
    const { status, body } = await get("/streams/MessageStream/conv5?since=notanumber", token);
    expect(status).toBe(400);
    expect(body.error?.code ?? body.code).toBe("stream.invalidCursor");
  });

  it("cursor + since are tenant-scoped", async () => {
    const t1 = await demoLogin(running, { userId: "u1", tenantId: "t1" });
    for (const t of ["a", "b", "c"]) await append("shared", t, t1);

    const t2 = await demoLogin(running, { userId: "u2", tenantId: "t2" });
    const cursor = await get("/streams/MessageStream/shared/cursor", t2);
    expect(cursor.body).toEqual({ headSequence: 0, count: 0 });

    const since = await get("/streams/MessageStream/shared?since=0", t2);
    expect(since.body.events).toEqual([]);
  });
});
