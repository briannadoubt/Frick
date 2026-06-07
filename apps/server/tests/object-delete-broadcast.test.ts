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

// Coverage for FR-142 "Object deletes not broadcast over sync gateway". A
// server-side delete through the store (`store.deleteObject`) — the path the
// HTTP DELETE route and background jobs take — now fans out to already-
// subscribed connections as a `Delta` frame, exactly like upserts and stream
// appends. The frame carries the removed id BOTH as a tombstone object record
// (the current SDKs refetch on any object delta and drop the now-absent row)
// AND as a clean `removed` list (a forward-looking client drops the ids
// directly, no refetch). These tests prove:
//   1. a subscribed client receives a live Delta with `removed` on a delete,
//   2. cross-tenant subscribers never see another tenant's delete, and
//   3. deleting a row that does not exist broadcasts nothing.

const CONVERSATION = "Conversation";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("FR-142 object-delete broadcast", () => {
  it("pushes a live Delta with a tombstone + removed list when the server deletes an object", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });

    app.store.upsertObject(ada.tenantId, CONVERSATION, "conversation-general", {
      kind: "group",
      title: "Ops standup",
      createdBy: "user-ada",
    });

    const socket = await connectAndHello(app.url, ada.sessionToken);
    const deltas = collectDeltas(socket);
    await subscribeObjects(socket, "sub-conv", CONVERSATION);

    const existed = app.store.deleteObject(ada.tenantId, CONVERSATION, "conversation-general");
    expect(existed).toBe(true);

    const delta = await deltas.next();
    // Forward-compat `removed` list names the dropped id directly.
    expect(delta.removed).toEqual([{ type: CONVERSATION, id: "conversation-general" }]);
    // Back-compat tombstone: an id-only record that drives a refetch on the
    // current SDKs. The id is preserved; non-id fields are absent/empty.
    const tombstones = delta.objects.map((packed) => unpackObjectRecord(productTestSchema, packed));
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.type).toBe(CONVERSATION);
    expect(tombstones[0]?.id).toBe("conversation-general");
    expect(delta.events).toEqual([]);

    socket.close();
  });

  it("scopes deletes to the deleter's tenant", async () => {
    app = await startServer();
    const a = await devLogin(app.httpUrl, { userId: "user-alpha", tenantId: "tenant-a" });
    const b = await devLogin(app.httpUrl, { userId: "user-bravo", tenantId: "tenant-b" });

    app.store.upsertObject(a.tenantId, CONVERSATION, "conversation-a", {
      kind: "group",
      title: "Tenant A room",
      createdBy: "user-alpha",
    });
    app.store.upsertObject(b.tenantId, CONVERSATION, "conversation-b", {
      kind: "group",
      title: "Tenant B room",
      createdBy: "user-bravo",
    });

    const socketA = await connectAndHello(app.url, a.sessionToken);
    const deltasA = collectDeltas(socketA);
    await subscribeObjects(socketA, "sub-conv-a", CONVERSATION);

    // A delete in tenant B must NOT reach tenant A's subscriber.
    app.store.deleteObject(b.tenantId, CONVERSATION, "conversation-b");
    expect(await deltasA.maybeNext(150)).toBeUndefined();

    // A delete in tenant A does reach tenant A's subscriber.
    app.store.deleteObject(a.tenantId, CONVERSATION, "conversation-a");
    const delta = await deltasA.next();
    expect(delta.removed).toEqual([{ type: CONVERSATION, id: "conversation-a" }]);

    socketA.close();
  });

  it("broadcasts nothing when the deleted row did not exist", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });

    const socket = await connectAndHello(app.url, ada.sessionToken);
    const deltas = collectDeltas(socket);
    await subscribeObjects(socket, "sub-conv", CONVERSATION);

    const existed = app.store.deleteObject(ada.tenantId, CONVERSATION, "never-existed");
    expect(existed).toBe(false);
    expect(await deltas.maybeNext(150)).toBeUndefined();

    socket.close();
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
