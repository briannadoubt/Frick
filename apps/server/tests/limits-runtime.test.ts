import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  FrameKind,
  decodeFrame,
  encodeFrame,
  foundationSchema,
  type FrickFrame,
} from "@frick/protocol";
import { createFrickServer } from "../src/server.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("HTTP body & blob limits", () => {
  it("returns 413 with rateLimit.exceeded for oversized JSON bodies", async () => {
    app = await startServer({ limits: { maxHttpBodyBytes: 32 } });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const response = await fetch(`${app.httpUrl}/append`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(login.sessionToken) },
      body: JSON.stringify({
        requestId: "request-oversized",
        stream: "MessageStream",
        key: "conversation-general",
        event: "MessageSent",
        payload: { padding: "x".repeat(2048) },
      }),
    });

    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error).toMatchObject({
      code: "rateLimit.exceeded",
      details: expect.objectContaining({ limit: "maxHttpBodyBytes", configuredMax: 32 }),
    });
  });

  it("returns 413 with blob.tooLarge for oversized blob uploads", async () => {
    app = await startServer({ limits: { maxBlobBytes: 8 } });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const response = await fetch(`${app.httpUrl}/blobs/blob-oversize/content?ownerId=user-ada`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", ...authHeaders(login.sessionToken) },
      body: Buffer.from("this body is way too large"),
    });

    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error).toMatchObject({
      code: "blob.tooLarge",
      details: expect.objectContaining({ limit: "maxBlobBytes", configuredMax: 8 }),
    });
  });
});

describe("stream append payload bound", () => {
  it("rejects HTTP appends whose msgpack-encoded payload is too large", async () => {
    app = await startServer({ limits: { maxStreamAppendPayloadBytes: 64 } });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const response = await fetch(`${app.httpUrl}/append`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(login.sessionToken) },
      body: JSON.stringify({
        requestId: "request-oversized-payload",
        stream: "MessageStream",
        key: "conversation-general",
        event: "MessageSent",
        payload: {
          messageId: "message-oversized",
          senderId: "user-ada",
          body: "x".repeat(300),
          createdAt: "2026-05-09T00:00:00.000Z",
        },
      }),
    });

    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error).toMatchObject({
      code: "stream.appendRejected",
      details: expect.objectContaining({
        limit: "maxStreamAppendPayloadBytes",
        configuredMax: 64,
      }),
    });
  });
});

describe("websocket subscription cap", () => {
  it("nacks subscriptions beyond maxSubscriptionsPerConnection", async () => {
    app = await startServer({ limits: { maxSubscriptionsPerConnection: 1 } });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connect(`${app.url}?sessionToken=${encodeURIComponent(login.sessionToken)}`);

    const frames: FrickFrame[] = [];
    socket.on("message", (data) => {
      frames.push(decodeFrame(data as Buffer));
    });

    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: login.replicaId,
          deviceId: login.deviceId,
          schemaHash: foundationSchema.hash,
          knownCursors: {},
        },
      ]),
    );
    await waitForFrameCount(frames, 2);

    socket.send(
      encodeFrame([
        FrameKind.Subscribe,
        { subscriptionId: "sub-1", kind: "stream", name: "MessageStream", key: "conversation-general", cursor: 0 },
      ]),
    );
    await waitForFrameCount(frames, 3);

    socket.send(
      encodeFrame([
        FrameKind.Subscribe,
        { subscriptionId: "sub-2", kind: "object", name: "Conversation" },
      ]),
    );
    await waitForFrameCount(frames, 4);
    const nack = frames[3]!;
    expect(nack[0]).toBe(FrameKind.Nack);
    expect(nack[1]).toMatchObject({
      requestId: "sub-2",
      error: expect.objectContaining({
        code: "rateLimit.exceeded",
        details: expect.objectContaining({
          limit: "maxSubscriptionsPerConnection",
          configuredMax: 1,
        }),
      }),
    });
    socket.close();
  });
});

describe("pending append queue cap (server)", () => {
  it("nacks Append frames once the configured cap is reached", async () => {
    app = await startServer({ limits: { maxPendingAppendsPerClient: 0 } });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connect(`${app.url}?sessionToken=${encodeURIComponent(login.sessionToken)}`);

    const frames: FrickFrame[] = [];
    socket.on("message", (data) => frames.push(decodeFrame(data as Buffer)));

    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: login.replicaId,
          deviceId: login.deviceId,
          schemaHash: foundationSchema.hash,
          knownCursors: {},
        },
      ]),
    );
    await waitForFrameCount(frames, 2);

    socket.send(
      encodeFrame([
        FrameKind.Append,
        {
          requestId: "request-pending-cap",
          stream: "MessageStream",
          key: "conversation-general",
          event: "MessageSent",
          payload: {
            messageId: "message-pending-cap",
            senderId: "user-ada",
            body: "hi",
            createdAt: "2026-05-09T00:00:00.000Z",
          },
        },
      ]),
    );
    await waitForFrameCount(frames, 3);
    const nack = frames[2]!;
    expect(nack[0]).toBe(FrameKind.Nack);
    expect(nack[1].error).toMatchObject({
      code: "rateLimit.exceeded",
      details: expect.objectContaining({
        limit: "maxPendingAppendsPerClient",
        configuredMax: 0,
      }),
    });
    socket.close();
  });
});

describe("websocket heartbeat timeout", () => {
  it("disconnects clients that go silent past heartbeatTimeoutSeconds", async () => {
    app = await startServer({
      limits: { heartbeatIntervalSeconds: 0.05, heartbeatTimeoutSeconds: 0.1 },
    });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connect(`${app.url}?sessionToken=${encodeURIComponent(login.sessionToken)}`);

    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await Promise.race([
      closed,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("socket was not closed")), 2000)),
    ]);
  });
});

describe("presence TTL clamping", () => {
  it("clamps presence TTL above presenceTtlMaxSeconds", async () => {
    app = await startServer({ limits: { presenceTtlMaxSeconds: 7 } });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connect(`${app.url}?sessionToken=${encodeURIComponent(login.sessionToken)}`);

    const frames: FrickFrame[] = [];
    socket.on("message", (data) => frames.push(decodeFrame(data as Buffer)));

    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: login.replicaId,
          deviceId: login.deviceId,
          schemaHash: foundationSchema.hash,
          knownCursors: {},
        },
      ]),
    );
    await waitForFrameCount(frames, 2);

    socket.send(
      encodeFrame([
        FrameKind.PresenceSet,
        {
          requestId: "presence-clamp-1",
          name: "TypingState",
          key: "conversation-general",
          value: { isTyping: true },
        },
      ]),
    );
    await waitForFrameCount(frames, 3);
    const ack = frames[2]!;
    expect(ack[0]).toBe(FrameKind.Ack);

    // The presence row should have been stored with a clamped TTL — readPresence
    // returns the value if expires_at > now. Configured max is 7s, schema TTL is
    // 5s, so the lease is alive immediately after set.
    const presence = app.store.readPresence("TypingState", "conversation-general");
    expect(presence).toBeTruthy();
    socket.close();
  });

  it("clamps presence TTL down when configured max is below the schema TTL", async () => {
    // schema TypingState declares ttlMs=5000 (5s); we clamp to 0.1s so the
    // row should expire on the very next read.
    app = await startServer({ limits: { presenceTtlMaxSeconds: 0.1, presenceTtlMinSeconds: 0.05 } });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connect(`${app.url}?sessionToken=${encodeURIComponent(login.sessionToken)}`);

    const frames: FrickFrame[] = [];
    socket.on("message", (data) => frames.push(decodeFrame(data as Buffer)));

    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: login.replicaId,
          deviceId: login.deviceId,
          schemaHash: foundationSchema.hash,
          knownCursors: {},
        },
      ]),
    );
    await waitForFrameCount(frames, 2);

    socket.send(
      encodeFrame([
        FrameKind.PresenceSet,
        {
          requestId: "presence-clamp-down",
          name: "TypingState",
          key: "conversation-clamp-down",
          value: { isTyping: true },
        },
      ]),
    );
    await waitForFrameCount(frames, 3);

    await new Promise((resolve) => setTimeout(resolve, 200));
    const presence = app.store.readPresence("TypingState", "conversation-clamp-down");
    expect(presence).toBeUndefined();
    socket.close();
  });
});

async function startServer(options: { limits?: Parameters<typeof createFrickServer>[0]["limits"] } = {}) {
  const server = createFrickServer({ port: 0, dbPath: ":memory:", ...options });
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

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve) => socket.once("open", resolve));
  return socket;
}

async function nextFrame(socket: WebSocket): Promise<FrickFrame> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(decodeFrame(data as Buffer)));
  });
}

async function waitForFrameCount(frames: FrickFrame[], target: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (frames.length < target) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${target} frames (got ${frames.length})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function devLogin(
  httpUrl: string,
  body: { userId: string; deviceId?: string; replicaId?: string; platform?: string },
): Promise<{
  schemaHash: string;
  sessionToken: string;
  userId: string;
  deviceId: string;
  replicaId: string;
  expiresAt: string;
}> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    schemaHash: string;
    sessionToken: string;
    userId: string;
    deviceId: string;
    replicaId: string;
    expiresAt: string;
  };
}

function authHeaders(sessionToken: string): Record<string, string> {
  return { authorization: `Bearer ${sessionToken}` };
}
