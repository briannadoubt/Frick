import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  FrameKind,
  decodeFrame,
  defaultClientCapabilities,
  encodeFrame,
  productTestSchema,
  unpackObjectRecord,
  type DeltaPayload,
  type FrickFrame,
  type FrickSchema,
} from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";
import { MemoryClusterBus, MemoryClusterChannel } from "../src/cluster/bus.js";

/**
 * tenant-app-isolation-1 (CRITICAL) — cross-node app isolation.
 *
 * The local-fanout app filter (proven by app-ws-isolation.test.ts) was correct,
 * but the ClusterEnvelope carried no appId, so on a SECOND node every peer
 * delta was fanned out as the `_default` app. That both leaked app B's deltas
 * to `_default` subscribers and dropped them from app B's own subscribers.
 *
 * These tests wire TWO server instances onto one in-process MemoryClusterChannel
 * (each with its own MemoryClusterBus peer — the contract a Redis/NATS adapter
 * must satisfy) and assert app scoping survives the cross-node hop in BOTH
 * directions: a write under app A on node 1 reaches app A's subscriber on node 2
 * but NOT app B's subscriber on node 2.
 */

const CONVERSATION = "Conversation";

const chatSchema: FrickSchema = {
  ...productTestSchema,
  schemaId: "frick.chat.cluster",
  hash: "chat-cluster-hash",
};
const docsSchema: FrickSchema = {
  ...productTestSchema,
  schemaId: "frick.docs.cluster",
  hash: "docs-cluster-hash",
};

let node1: Awaited<ReturnType<typeof startNode>> | undefined;
let node2: Awaited<ReturnType<typeof startNode>> | undefined;

afterEach(async () => {
  await node1?.close();
  await node2?.close();
  node1 = undefined;
  node2 = undefined;
});

describe("tenant-app-isolation-1 cross-node app isolation", () => {
  it("an app's write on node 1 reaches ONLY that app's subscriber on node 2 (no leak, no loss)", async () => {
    // Shared bus channel = the same broker two nodes talk over.
    const channel = new MemoryClusterChannel();
    node1 = await startNode(channel, "node-1");
    node2 = await startNode(channel, "node-2");

    // Each node has its own in-memory store, so authenticate against each. Same
    // userId resolves to the same (_default) tenant on both, which is what the
    // cross-node fan-out's tenant+app filter keys on — the delta payload itself
    // rides the bus envelope, not either node's store.
    const writer = await devLogin(node1.httpUrl, { userId: "user-ada" });
    const reader = await devLogin(node2.httpUrl, { userId: "user-ada" });
    expect(reader.tenantId).toBe(writer.tenantId);

    // Both subscribers live on NODE 2, pinned to different apps.
    const chatSocket = await connectAndHello(node2.url, reader.sessionToken, chatSchema);
    const docsSocket = await connectAndHello(node2.url, reader.sessionToken, docsSchema);
    const chatDeltas = collectDeltas(chatSocket);
    const docsDeltas = collectDeltas(docsSocket);
    await subscribeObjects(chatSocket, "sub-chat", CONVERSATION);
    await subscribeObjects(docsSocket, "sub-docs", CONVERSATION);

    // The write happens on NODE 1, under the chat app, and must cross the bus.
    const write = await fetch(`${node1.httpUrl}/chat/objects/${CONVERSATION}/c-1`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${writer.sessionToken}` },
      body: JSON.stringify({ title: "chat-only" }),
    });
    expect(write.status).toBeLessThan(300);

    // LOSS guard: the chat subscriber on node 2 DOES receive the cross-node delta.
    const delta = await chatDeltas.next();
    const records = delta.objects.map((p) => unpackObjectRecord(productTestSchema, p));
    expect(records.some((r) => r.type === CONVERSATION && r.id === "c-1")).toBe(true);

    // LEAK guard: the docs subscriber on node 2 — same tenant, same type, same
    // bus — receives nothing for the chat-app write.
    expect(await docsDeltas.maybeNext(300)).toBeUndefined();

    chatSocket.close();
    docsSocket.close();
  });

  it("each app's node-2 subscriber sees only its own app's node-1 writes", async () => {
    const channel = new MemoryClusterChannel();
    node1 = await startNode(channel, "node-1");
    node2 = await startNode(channel, "node-2");
    const writer = await devLogin(node1.httpUrl, { userId: "user-ada" });
    const reader = await devLogin(node2.httpUrl, { userId: "user-ada" });

    const chatSocket = await connectAndHello(node2.url, reader.sessionToken, chatSchema);
    const docsSocket = await connectAndHello(node2.url, reader.sessionToken, docsSchema);
    const chatDeltas = collectDeltas(chatSocket);
    const docsDeltas = collectDeltas(docsSocket);
    await subscribeObjects(chatSocket, "sub-chat", CONVERSATION);
    await subscribeObjects(docsSocket, "sub-docs", CONVERSATION);

    // A docs write on node 1 reaches the docs subscriber on node 2, not chat.
    const docsWrite = await fetch(`${node1.httpUrl}/docs/objects/${CONVERSATION}/d-1`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${writer.sessionToken}` },
      body: JSON.stringify({ title: "docs-only" }),
    });
    expect(docsWrite.status).toBeLessThan(300);

    const docsDelta = await docsDeltas.next();
    const docsRecords = docsDelta.objects.map((p) => unpackObjectRecord(productTestSchema, p));
    expect(docsRecords.some((r) => r.id === "d-1")).toBe(true);
    expect(await chatDeltas.maybeNext(300)).toBeUndefined();

    chatSocket.close();
    docsSocket.close();
  });
});

async function startNode(channel: MemoryClusterChannel, nodeId: string) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    schema: productTestSchema,
    apps: [
      { id: "chat", schema: chatSchema, basePath: "/chat" },
      { id: "docs", schema: docsSchema, basePath: "/docs" },
    ],
    clusterBus: new MemoryClusterBus({ channel, nodeId }),
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("no address");
  }
  return {
    url: `ws://127.0.0.1:${address.port}/_frick/sync`,
    httpUrl: `http://127.0.0.1:${address.port}`,
    close: server.close,
  };
}

async function connectAndHello(url: string, sessionToken: string, schema: FrickSchema): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${sessionToken}` } });
  await new Promise<void>((resolve) => socket.once("open", resolve));
  const hello = waitForFrames(socket, 2);
  socket.send(
    encodeFrame([
      FrameKind.Hello,
      {
        replicaId: `replica-${schema.hash}`,
        deviceId: `device-${schema.hash}`,
        schemaHash: schema.hash,
        knownCursors: {},
        clientCapabilities: defaultClientCapabilities({
          platform: "web",
          sdkVersion: "0.0.0-test",
          schema,
        }),
      },
    ]),
  );
  await hello;
  return socket;
}

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
  const json = (await response.json()) as { sessionToken: string; tenantId?: string };
  return { sessionToken: json.sessionToken, tenantId: json.tenantId ?? "_default" };
}
