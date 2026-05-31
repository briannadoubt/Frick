import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFrickServer, type FrickServer } from "../src/server.js";
import { productTestSchema } from "@frick/protocol";
import { createHarnessToken } from "./helpers/auth-harness.js";

let server: FrickServer | undefined;
let baseUrl = "";
let token = "";

beforeEach(async () => {
  server = createFrickServer({
    schema: productTestSchema,
    env: { FRICK_ENV: "test", FRICK_DEMO_AUTH_ENABLED: "true" },
  });
  await server.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  token = await createHarnessToken(server, { tenantId: "t1", userId: "u1" });
});

afterEach(async () => {
  await server?.close();
});

async function append(streamId: string, body: string, authToken = token) {
  const res = await fetch(`${baseUrl}/streams/MessageStream/${streamId}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
    body: JSON.stringify({
      requestId: `req-${streamId}-${body}`,
      replicaId: "r1",
      event: "MessageSent",
      payload: { messageId: `m-${body}`, senderId: "u1", body, createdAt: "2026-05-10T00:00:00.000Z" },
    }),
  });
  if (!res.ok) throw new Error(`append failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function get(path: string, authToken = token) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${authToken}` },
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("stream cursor query API (FR-116)", () => {
  it("GET /streams/:type/:id/cursor returns head sequence + count without payloads", async () => {
    for (const b of ["a", "b", "c", "d", "e"]) await append("conv1", b);

    const { status, body } = await get("/streams/MessageStream/conv1/cursor");
    expect(status).toBe(200);
    expect(body).toEqual({ headSequence: 5, count: 5 });
    expect(body.events).toBeUndefined();
  });

  it("returns headSequence 0 for an empty/unknown stream", async () => {
    const { status, body } = await get("/streams/MessageStream/never-written/cursor");
    expect(status).toBe(200);
    expect(body).toEqual({ headSequence: 0, count: 0 });
  });

  it("GET ?since=N returns only events after N, ascending", async () => {
    for (const b of ["a", "b", "c", "d", "e"]) await append("conv2", b);

    const { status, body } = await get("/streams/MessageStream/conv2?since=2");
    expect(status).toBe(200);
    expect(body.events.map((e: any) => e.payload.body)).toEqual(["c", "d", "e"]);
  });

  it("?since at the head returns no events", async () => {
    for (const b of ["a", "b", "c"]) await append("conv3", b);
    const { body } = await get("/streams/MessageStream/conv3?since=3");
    expect(body.events).toEqual([]);
  });

  it("?since respects ?limit and stays ascending", async () => {
    for (const b of ["a", "b", "c", "d", "e"]) await append("conv4", b);
    const { body } = await get("/streams/MessageStream/conv4?since=1&limit=2");
    expect(body.events.map((e: any) => e.payload.body)).toEqual(["b", "c"]);
  });

  it("rejects a non-numeric ?since with 400", async () => {
    await append("conv5", "a");
    const { status, body } = await get("/streams/MessageStream/conv5?since=notanumber");
    expect(status).toBe(400);
    expect(body.error?.code ?? body.code).toBe("stream.invalidCursor");
  });

  it("cursor + since are tenant-scoped", async () => {
    for (const b of ["a", "b", "c"]) await append("shared", b); // tenant t1
    const t2 = await createHarnessToken(server!, { tenantId: "t2", userId: "u2" });

    const cursor = await get("/streams/MessageStream/shared/cursor", t2);
    expect(cursor.body).toEqual({ headSequence: 0, count: 0 });

    const since = await get("/streams/MessageStream/shared?since=0", t2);
    expect(since.body.events).toEqual([]);
  });
});
