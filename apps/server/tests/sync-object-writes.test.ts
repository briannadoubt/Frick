import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  FrameKind,
  decodeFrame,
  encodeFrame,
  foundationSchema,
  validateSchema,
  type FrickFrame,
  type FrickSchema,
  type HelloAckPayload,
} from "@frick/protocol";
import { createFrickServer } from "../src/server.js";
import type { FrickPolicyHook } from "../src/authz.js";

/**
 * Derived schema with a Note object whose mergePolicy is configurable, so we
 * can exercise both lastWriteWins and versionPrecondition behaviors from one
 * suite without disturbing the foundation schema.
 */
function schemaWithNote(mergePolicy: "lastWriteWins" | "versionPrecondition"): FrickSchema {
  const next = structuredClone(foundationSchema);
  next.hash = `${next.hash}-syncnote-${mergePolicy}`;
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

describe("sync gateway object upserts", () => {
  it("rejects an HTTP direct RoomMember write but still allows a custom Note object", async () => {
    app = await startServer({ schema: schemaWithNote("lastWriteWins") });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const forged = await fetch(`${app.httpUrl}/objects/RoomMember/member-forged-http`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${login.sessionToken}` },
      body: JSON.stringify({
        conversationId: "conversation-general",
        userId: "user-mallory",
        role: "member",
      }),
    });
    expect(forged.status).toBe(403);
    expect(app.store.readObject("_default", "RoomMember", "member-forged-http")).toBeUndefined();

    const note = await fetch(`${app.httpUrl}/objects/Note/note-http`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${login.sessionToken}` },
      body: JSON.stringify({ body: "custom objects are app-owned" }),
    });
    expect(note.status).toBe(201);
    expect(app.store.readObject("_default", "Note", "note-http")).toMatchObject({
      body: "custom objects are app-owned",
    });
  });

  it("acks an lastWriteWins ObjectUpsert with version 1 on first write and 2 on update", async () => {
    app = await startServer({ schema: schemaWithNote("lastWriteWins") });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connectAndHello(app.url, app.schemaHash, login.sessionToken);

    socket.send(
      encodeFrame([
        FrameKind.ObjectUpsert,
        {
          requestId: "req-lww-1",
          objectType: "Note",
          objectId: "note-lww",
          value: { body: "first" },
        },
      ]),
    );
    const ack1 = await nextAck(socket);
    expect(ack1[0]).toBe(FrameKind.Ack);
    expect(ack1[1]).toMatchObject({ requestId: "req-lww-1", version: 1 });

    socket.send(
      encodeFrame([
        FrameKind.ObjectUpsert,
        {
          requestId: "req-lww-2",
          objectType: "Note",
          objectId: "note-lww",
          value: { body: "second" },
        },
      ]),
    );
    const ack2 = await nextAck(socket);
    expect(ack2[1]).toMatchObject({ requestId: "req-lww-2", version: 2 });

    socket.close();
  });

  it("nacks a websocket direct RoomMember write", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connectAndHello(app.url, app.schemaHash, login.sessionToken);

    socket.send(
      encodeFrame([
        FrameKind.ObjectUpsert,
        {
          requestId: "req-forged-roommember",
          objectType: "RoomMember",
          objectId: "member-forged-ws",
          value: {
            conversationId: "conversation-general",
            userId: "user-mallory",
            role: "member",
          },
        },
      ]),
    );

    const frame = await nextAck(socket);
    expect(frame[0]).toBe(FrameKind.Nack);
    expect(frame[1]).toMatchObject({
      requestId: "req-forged-roommember",
      code: "auth.forbidden",
    });
    expect(app.store.readObject("_default", "RoomMember", "member-forged-ws")).toBeUndefined();
    socket.close();
  });

  it("acks a versionPrecondition create then update, and nacks a stale update with storage.conflict", async () => {
    app = await startServer({ schema: schemaWithNote("versionPrecondition") });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connectAndHello(app.url, app.schemaHash, login.sessionToken);

    socket.send(
      encodeFrame([
        FrameKind.ObjectUpsert,
        {
          requestId: "req-vp-create",
          objectType: "Note",
          objectId: "note-vp",
          value: { body: "v1" },
        },
      ]),
    );
    const create = await nextAck(socket);
    expect(create[1]).toMatchObject({ requestId: "req-vp-create", version: 1 });

    socket.send(
      encodeFrame([
        FrameKind.ObjectUpsert,
        {
          requestId: "req-vp-update",
          objectType: "Note",
          objectId: "note-vp",
          value: { body: "v2" },
          expectedVersion: 1,
        },
      ]),
    );
    const update = await nextAck(socket);
    expect(update[1]).toMatchObject({ requestId: "req-vp-update", version: 2 });

    socket.send(
      encodeFrame([
        FrameKind.ObjectUpsert,
        {
          requestId: "req-vp-stale",
          objectType: "Note",
          objectId: "note-vp",
          value: { body: "stale" },
          expectedVersion: 1,
        },
      ]),
    );
    const conflict = await nextAck(socket);
    expect(conflict[0]).toBe(FrameKind.Nack);
    expect(conflict[1]).toMatchObject({
      requestId: "req-vp-stale",
      code: "storage.conflict",
    });
    expect(conflict[1].error).toMatchObject({
      code: "storage.conflict",
      details: {
        expectedVersion: 1,
        actualVersion: 2,
        mergePolicy: "versionPrecondition",
      },
    });

    socket.close();
  });

  it("nacks ObjectUpsert from an unauthenticated client with auth.unauthenticated", async () => {
    app = await startServer();
    const socket = new WebSocket(app.url);
    await new Promise<void>((resolve) => socket.once("open", resolve));

    socket.send(
      encodeFrame([
        FrameKind.ObjectUpsert,
        {
          requestId: "req-noauth",
          objectType: "User",
          objectId: "user-x",
          value: { displayName: "X" },
        },
      ]),
    );
    const frame = await nextAck(socket);
    expect(frame[0]).toBe(FrameKind.Nack);
    expect(frame[1]).toMatchObject({
      requestId: "req-noauth",
      code: "auth.unauthenticated",
    });
    socket.close();
  });

  it("nacks ObjectUpsert with auth.forbidden when a policy hook denies for tenant mismatch", async () => {
    const denyAcrossTenant: FrickPolicyHook = (input) => {
      if (input.action === "object.write" && input.resource.name === "Note") {
        return {
          allow: false,
          reason: "tenantMismatch",
          publicMessage: "Cross-tenant write rejected by policy",
        };
      }
      return null;
    };
    app = await startServer({ schema: schemaWithNote("lastWriteWins"), policyHooks: [denyAcrossTenant] });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connectAndHello(app.url, app.schemaHash, login.sessionToken);

    socket.send(
      encodeFrame([
        FrameKind.ObjectUpsert,
        {
          requestId: "req-cross-tenant",
          objectType: "Note",
          objectId: "note-x",
          value: { body: "nope" },
        },
      ]),
    );

    const frame = await nextAck(socket);
    expect(frame[0]).toBe(FrameKind.Nack);
    expect(frame[1]).toMatchObject({
      requestId: "req-cross-tenant",
      code: "auth.forbidden",
    });
    expect(frame[1].error).toMatchObject({
      code: "auth.forbidden",
      details: { reason: "tenantMismatch" },
    });
    socket.close();
  });
});

async function startServer(
  options: { schema?: FrickSchema; policyHooks?: readonly FrickPolicyHook[] } = {},
) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    ...(options.schema ? { schema: options.schema } : {}),
    ...(options.policyHooks ? { policyHooks: options.policyHooks } : {}),
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  const schema = options.schema ?? foundationSchema;
  return {
    url: `ws://127.0.0.1:${address.port}/_frick/sync`,
    httpUrl: `http://127.0.0.1:${address.port}`,
    schemaHash: schema.hash,
    store: server.store,
    close: server.close,
  };
}

async function connectAndHello(
  url: string,
  schemaHash: string,
  sessionToken: string,
): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${sessionToken}` } });
  await new Promise<void>((resolve) => socket.once("open", resolve));
  const hello = expectHelloAckThenSchema(socket);
  socket.send(
    encodeFrame([
      FrameKind.Hello,
      {
        replicaId: "replica-test",
        deviceId: "device-test",
        schemaHash,
        knownCursors: {},
      },
    ]),
  );
  await hello;
  return socket;
}

async function nextAck(socket: WebSocket): Promise<FrickFrame> {
  return new Promise((resolve) => {
    socket.once("message", (data) => {
      resolve(decodeFrame(data as Buffer));
    });
  });
}

async function expectHelloAckThenSchema(socket: WebSocket): Promise<HelloAckPayload> {
  return new Promise((resolve) => {
    const frames: FrickFrame[] = [];
    const onMessage = (data: Buffer) => {
      frames.push(decodeFrame(data));
      if (frames.length === 2) {
        socket.off("message", onMessage);
        resolve(frames[0]![1] as HelloAckPayload);
      }
    };
    socket.on("message", onMessage);
  });
}

async function devLogin(
  httpUrl: string,
  body: { userId: string; tenantId?: string },
): Promise<{ sessionToken: string }> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { sessionToken: string };
}
