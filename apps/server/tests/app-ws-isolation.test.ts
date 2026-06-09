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

/**
 * FR-153 — end-to-end app isolation over the WEBSOCKET surface (FR-6 epic).
 *
 * The companion `app-end-to-end-isolation.test.ts` proves isolation over HTTP.
 * This suite proves the same boundary holds across the WS handshake + live
 * fan-out: two clients Hello onto the SAME server under DIFFERENT apps (distinct
 * schemaIds), both subscribe to the same object type at the same tenant, and a
 * write made under one app is delivered live ONLY to that app's subscriber —
 * the other app's subscriber sees nothing. `SyncClient.appId` is pinned at
 * Hello and the gateway filters every fan-out by it.
 */

const CONVERSATION = "Conversation";

// Two apps share the storage schema shape but advertise distinct schemaIds/
// hashes so the registry resolves (and the gateway pins) them independently.
const chatSchema: FrickSchema = {
  ...productTestSchema,
  schemaId: "frick.chat.ws",
  hash: "chat-ws-hash",
};
const docsSchema: FrickSchema = {
  ...productTestSchema,
  schemaId: "frick.docs.ws",
  hash: "docs-ws-hash",
};

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("FR-153 end-to-end app isolation (WebSocket)", () => {
  it("a write under one app delivers a live Delta only to that app's WS subscriber", async () => {
    app = await startMultiAppServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });

    // Two sockets onto the same server, pinned to different apps via Hello.
    const chatSocket = await connectAndHello(app.url, ada.sessionToken, chatSchema);
    const docsSocket = await connectAndHello(app.url, ada.sessionToken, docsSchema);

    const chatDeltas = collectDeltas(chatSocket);
    const docsDeltas = collectDeltas(docsSocket);
    await subscribeObjects(chatSocket, "sub-chat", CONVERSATION);
    await subscribeObjects(docsSocket, "sub-docs", CONVERSATION);

    // Write a Conversation through the /chat HTTP boundary, which stamps the
    // chat app id and drives the gateway fan-out.
    const write = await fetch(`${app.httpUrl}/chat/objects/${CONVERSATION}/c-1`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ada.sessionToken}`,
      },
      body: JSON.stringify({ title: "chat-only" }),
    });
    expect(write.status).toBeGreaterThanOrEqual(200);
    expect(write.status).toBeLessThan(300);

    // The chat subscriber receives the live delta.
    const delta = await chatDeltas.next();
    const records = delta.objects.map((packed) => unpackObjectRecord(productTestSchema, packed));
    expect(records.some((r) => r.type === CONVERSATION && r.id === "c-1")).toBe(true);

    // The docs subscriber — same server, same tenant, same object type, same
    // database — receives nothing for the chat-app write.
    expect(await docsDeltas.maybeNext(300)).toBeUndefined();

    chatSocket.close();
    docsSocket.close();
  });

  it("each app's subscriber only sees its own app's writes", async () => {
    app = await startMultiAppServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });

    const chatSocket = await connectAndHello(app.url, ada.sessionToken, chatSchema);
    const docsSocket = await connectAndHello(app.url, ada.sessionToken, docsSchema);
    const chatDeltas = collectDeltas(chatSocket);
    const docsDeltas = collectDeltas(docsSocket);
    await subscribeObjects(chatSocket, "sub-chat", CONVERSATION);
    await subscribeObjects(docsSocket, "sub-docs", CONVERSATION);

    // A write under docs reaches docs, not chat.
    const docsWrite = await fetch(`${app.httpUrl}/docs/objects/${CONVERSATION}/d-1`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ada.sessionToken}`,
      },
      body: JSON.stringify({ title: "docs-only" }),
    });
    expect(docsWrite.status).toBeLessThan(300);

    const docsDelta = await docsDeltas.next();
    const docsRecords = docsDelta.objects.map((packed) =>
      unpackObjectRecord(productTestSchema, packed),
    );
    expect(docsRecords.some((r) => r.id === "d-1")).toBe(true);
    expect(await chatDeltas.maybeNext(300)).toBeUndefined();

    chatSocket.close();
    docsSocket.close();
  });

  it("rejects a Hello advertising an UNREGISTERED app schemaId (tenant-app-isolation-4)", async () => {
    app = await startMultiAppServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });

    // A schema whose schemaId matches no registered app on this server.
    const rogueSchema: FrickSchema = {
      ...productTestSchema,
      schemaId: "frick.rogue.ws",
      hash: "rogue-ws-hash",
    };

    const socket = new WebSocket(app.url, { headers: { authorization: `Bearer ${ada.sessionToken}` } });
    await new Promise<void>((resolve) => socket.once("open", resolve));
    const frame = await sendHelloAwaitFrame(socket, ada.sessionToken, rogueSchema);

    expect(frame[0]).toBe(FrameKind.Nack);
    expect(frame[1]).toMatchObject({ requestId: "hello", code: "auth.forbidden" });
    expect(
      (frame[1] as { error: { details: { reason: string } } }).error.details.reason,
    ).toBe("appNotAuthorized");
    socket.close();
  });

  it("still accepts a Hello advertising a REGISTERED app schemaId (no regression)", async () => {
    app = await startMultiAppServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });

    const socket = new WebSocket(app.url, { headers: { authorization: `Bearer ${ada.sessionToken}` } });
    await new Promise<void>((resolve) => socket.once("open", resolve));
    const frame = await sendHelloAwaitFrame(socket, ada.sessionToken, chatSchema);

    // A registered app id is tenant-wide acceptable: HelloAck, not a nack.
    expect(frame[0]).toBe(FrameKind.HelloAck);
    socket.close();
  });
});

/** Send a Hello advertising `schema` and resolve the FIRST returned frame. */
function sendHelloAwaitFrame(
  socket: WebSocket,
  sessionToken: string,
  schema: FrickSchema,
): Promise<FrickFrame> {
  const result = new Promise<FrickFrame>((resolve) => {
    socket.once("message", (data: Buffer) => resolve(decodeFrame(data)));
  });
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
  return result;
}

async function startServer(options: Parameters<typeof createFrickServer>[0] = {}) {
  const server = createFrickServer({ port: 0, dbPath: ":memory:", ...options });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("no address");
  }
  return {
    url: `ws://127.0.0.1:${address.port}/_frick/sync`,
    httpUrl: `http://127.0.0.1:${address.port}`,
    store: server.store,
    close: server.close,
  };
}

function startMultiAppServer() {
  return startServer({
    schema: productTestSchema,
    apps: [
      { id: "chat", schema: chatSchema, basePath: "/chat" },
      { id: "docs", schema: docsSchema, basePath: "/docs" },
    ],
  });
}

async function connectAndHello(
  url: string,
  sessionToken: string,
  schema: FrickSchema,
): Promise<WebSocket> {
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
        // clientCapabilities carries the schemaId so the gateway resolves which
        // app this client is pinned to (and thus its storage appId at Hello).
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
