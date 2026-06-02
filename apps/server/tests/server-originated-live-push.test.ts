import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  FrameKind,
  decodeFrame,
  encodeFrame,
  productTestSchema,
  unpackObjectRecord,
  type DeltaPayload,
  type FrickFrame,
} from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";

// End-to-end coverage for FR-114 "Live-push server-originated object/stream
// writes to gateway subscribers". Writes made SERVER-SIDE through the store
// (`store.upsertObject` / `store.appendEvent`) — the path a background job or
// an app command route takes — now fan out to already-subscribed connections
// over the sync gateway as `Delta` frames, exactly like client-originated
// mutations. These tests prove:
//   1. a subscribed client receives a live Delta on a server-side object upsert,
//   2. a subscribed client receives a live Delta on a server-side stream append,
//   3. cross-tenant subscribers never see another tenant's server-side write, and
//   4. a CLIENT-originated mutation still produces exactly ONE Delta to other
//      subscribers (no double-broadcast now that the store listener is the
//      single fan-out funnel).

const CONVERSATION = "Conversation";
const MESSAGE_STREAM = "MessageStream";
const CONVERSATION_KEY = "conversation-general";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("FR-114 server-originated live push", () => {
  it("pushes a live Delta when the server upserts an object directly", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });

    const socket = await connectAndHello(app.url, ada.sessionToken);
    const deltas = collectDeltas(socket);
    await subscribeObjects(socket, "sub-conv", CONVERSATION);

    // Simulate a background job / app route writing through the store. No WS
    // frame and no HTTP request — the gateway must still fan this out.
    app.store.upsertObject(ada.tenantId, CONVERSATION, "conversation-general", {
      kind: "group",
      title: "Ops standup",
      createdBy: "user-ada",
    });

    const delta = await deltas.next();
    const objects = delta.objects.map((packed) => unpackObjectRecord(productTestSchema, packed));
    expect(objects).toEqual([
      {
        type: CONVERSATION,
        id: "conversation-general",
        value: {
          id: "conversation-general",
          kind: "group",
          title: "Ops standup",
          createdBy: "user-ada",
        },
      },
    ]);
    expect(delta.events).toEqual([]);

    socket.close();
  });

  it("pushes a live Delta when the server appends a stream event directly", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });

    const socket = await connectAndHello(app.url, ada.sessionToken);
    const deltas = collectDeltas(socket);
    await subscribeStream(socket, "sub-stream", MESSAGE_STREAM, CONVERSATION_KEY);

    const result = app.store.appendEvent({
      tenantId: ada.tenantId,
      requestId: "server-append-1",
      replicaId: "server-job",
      stream: MESSAGE_STREAM,
      streamId: CONVERSATION_KEY,
      event: "MessageSent",
      payload: {
        messageId: "message-1",
        senderId: "user-ada",
        body: "deployed via job",
        createdAt: "2026-05-31T00:00:00.000Z",
      },
    });
    expect(result.created).toBe(true);

    const delta = await deltas.next();
    expect(delta.objects).toEqual([]);
    expect(delta.events).toHaveLength(1);
    // Packed stream event: [streamId-or-streamRef, streamId, sequence, eventId, eventOrdinal, fields]
    expect(delta.events[0]?.[2]).toBe(result.event.sequence);

    socket.close();
  });

  it("scopes server-originated writes to the writer's tenant", async () => {
    app = await startServer();
    const a = await devLogin(app.httpUrl, { userId: "user-alpha", tenantId: "tenant-a" });
    const b = await devLogin(app.httpUrl, { userId: "user-bravo", tenantId: "tenant-b" });

    const socketA = await connectAndHello(app.url, a.sessionToken);
    const deltasA = collectDeltas(socketA);
    await subscribeObjects(socketA, "sub-conv-a", CONVERSATION);

    // A server-side write in tenant B must NOT reach tenant A's subscriber.
    app.store.upsertObject(b.tenantId, CONVERSATION, "conversation-b", {
      kind: "group",
      title: "Tenant B room",
      createdBy: "user-bravo",
    });
    expect(await deltasA.maybeNext(150)).toBeUndefined();

    // A server-side write in tenant A does reach tenant A's subscriber.
    app.store.upsertObject(a.tenantId, CONVERSATION, "conversation-a", {
      kind: "group",
      title: "Tenant A room",
      createdBy: "user-alpha",
    });
    const delta = await deltasA.next();
    const objects = delta.objects.map((packed) => unpackObjectRecord(productTestSchema, packed));
    expect(objects).toEqual([
      {
        type: CONVERSATION,
        id: "conversation-a",
        value: {
          id: "conversation-a",
          kind: "group",
          title: "Tenant A room",
          createdBy: "user-alpha",
        },
      },
    ]);

    socketA.close();
  });

  it("delivers exactly ONE Delta to another subscriber for a client object upsert (no double-broadcast)", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });

    // Subscriber: watches Conversation objects and counts Delta frames.
    const watcher = await connectAndHello(app.url, ada.sessionToken);
    const deltas = collectDeltas(watcher);
    await subscribeObjects(watcher, "sub-watch", CONVERSATION);

    // Writer: a second connection in the same tenant performs a CLIENT
    // mutation. Before FR-114 this broadcast inline; now it routes through the
    // store write listener. The watcher must still see exactly one delta.
    const writer = await connectAndHello(app.url, ada.sessionToken);
    writer.send(
      encodeFrame([
        FrameKind.ObjectUpsert,
        {
          requestId: "client-upsert-1",
          objectType: CONVERSATION,
          objectId: "conversation-client",
          value: { kind: "group", title: "Client room", createdBy: "user-ada" },
        },
      ]),
    );

    const delta = await deltas.next();
    const objects = delta.objects.map((packed) => unpackObjectRecord(productTestSchema, packed));
    expect(objects).toEqual([
      {
        type: CONVERSATION,
        id: "conversation-client",
        value: {
          id: "conversation-client",
          kind: "group",
          title: "Client room",
          createdBy: "user-ada",
        },
      },
    ]);

    // The single-funnel guarantee: no SECOND delta arrives for the same write.
    expect(await deltas.maybeNext(200)).toBeUndefined();

    writer.close();
    watcher.close();
  });

  it("delivers exactly ONE Delta to another subscriber for a client stream append (no double-broadcast)", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });

    const watcher = await connectAndHello(app.url, ada.sessionToken);
    const deltas = collectDeltas(watcher);
    await subscribeStream(watcher, "sub-watch-stream", MESSAGE_STREAM, CONVERSATION_KEY);

    const writer = await connectAndHello(app.url, ada.sessionToken);
    writer.send(
      encodeFrame([
        FrameKind.Append,
        {
          requestId: "client-append-1",
          stream: MESSAGE_STREAM,
          key: CONVERSATION_KEY,
          event: "MessageSent",
          payload: {
            messageId: "message-client-1",
            senderId: "user-ada",
            body: "from the client",
            createdAt: "2026-05-31T00:00:00.000Z",
          },
        },
      ]),
    );

    const delta = await deltas.next();
    expect(delta.objects).toEqual([]);
    expect(delta.events).toHaveLength(1);

    // No duplicate delta for the same append.
    expect(await deltas.maybeNext(200)).toBeUndefined();

    writer.close();
    watcher.close();
  });
});

async function startServer() {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    schema: productTestSchema,
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    url: `ws://127.0.0.1:${address.port}/_frick/sync`,
    httpUrl: `http://127.0.0.1:${address.port}`,
    store: server.store,
    close: server.close,
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

async function connectAndHello(url: string, sessionToken: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${sessionToken}` } });
  await new Promise<void>((resolve) => socket.once("open", resolve));
  socket.send(
    encodeFrame([
      FrameKind.Hello,
      {
        replicaId: "replica-test",
        deviceId: "device-test",
        schemaHash: productTestSchema.hash,
        knownCursors: {},
      },
    ]),
  );
  // Drain HelloAck + Schema before the test takes over message handling.
  await waitForFrames(socket, 2);
  return socket;
}

/** Subscribe to an object type and drain the initial Snapshot frame. */
async function subscribeObjects(socket: WebSocket, subscriptionId: string, name: string): Promise<void> {
  const snapshot = waitForFrameKind(socket, FrameKind.Snapshot);
  socket.send(encodeFrame([FrameKind.Subscribe, { subscriptionId, kind: "object", name }]));
  await snapshot;
}

/** Subscribe to a stream key and drain the initial StreamPage frame. */
async function subscribeStream(
  socket: WebSocket,
  subscriptionId: string,
  name: string,
  key: string,
): Promise<void> {
  const page = waitForFrameKind(socket, FrameKind.StreamPage);
  socket.send(encodeFrame([FrameKind.Subscribe, { subscriptionId, kind: "stream", name, key, cursor: 0 }]));
  await page;
}

function waitForFrames(socket: WebSocket, count: number): Promise<void> {
  return new Promise((resolve) => {
    let received = 0;
    const onMessage = () => {
      received += 1;
      if (received >= count) {
        socket.off("message", onMessage);
        resolve();
      }
    };
    socket.on("message", onMessage);
  });
}

function waitForFrameKind(socket: WebSocket, kind: FrameKind): Promise<FrickFrame> {
  return new Promise((resolve) => {
    const onMessage = (data: Buffer) => {
      const frame = decodeFrame(data);
      if (frame[0] === kind) {
        socket.off("message", onMessage);
        resolve(frame);
      }
    };
    socket.on("message", onMessage);
  });
}

interface DeltaCollector {
  next(): Promise<DeltaPayload>;
  maybeNext(timeoutMs: number): Promise<DeltaPayload | undefined>;
}

/**
 * Collect every `Delta` frame the socket receives. Used both to await an
 * expected delta and to assert the *absence* of a (duplicate) delta — the
 * latter is what proves there is exactly one broadcast per write.
 */
function collectDeltas(socket: WebSocket): DeltaCollector {
  const queue: DeltaPayload[] = [];
  const waiters: Array<(value: DeltaPayload) => void> = [];

  socket.on("message", (data) => {
    const frame: FrickFrame = decodeFrame(data as Buffer);
    if (frame[0] !== FrameKind.Delta) return;
    const payload = frame[1] as DeltaPayload;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(payload);
    } else {
      queue.push(payload);
    }
  });

  return {
    next() {
      const ready = queue.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise<DeltaPayload>((resolve) => waiters.push(resolve));
    },
    maybeNext(timeoutMs) {
      const ready = queue.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise<DeltaPayload | undefined>((resolve) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(wrapped);
          if (idx >= 0) waiters.splice(idx, 1);
          resolve(undefined);
        }, timeoutMs);
        const wrapped = (value: DeltaPayload) => {
          clearTimeout(timer);
          resolve(value);
        };
        waiters.push(wrapped);
      });
    },
  };
}
