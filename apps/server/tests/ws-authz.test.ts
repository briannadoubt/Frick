import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  FrameKind,
  decodeFrame,
  encodeFrame,
  foundationSchema,
  type FrickFrame,
  type HelloAckPayload,
} from "@frick/protocol";
import { createFrickServer } from "../src/server.js";
import type { FrickPolicyHook } from "../src/authz.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("websocket authorization parity", () => {
  it("accepts websocket session tokens from the Authorization header", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connectAndHelloWithHeaders(app.url, {
      authorization: `Bearer ${login.sessionToken}`,
    });

    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it("authenticates an initially anonymous websocket from Hello.sessionToken", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connectAndHelloFromHelloToken(app.url, login.sessionToken);

    socket.send(
      encodeFrame([
        FrameKind.Append,
        {
          requestId: "request-hello-token-append",
          stream: "MessageStream",
          key: "conversation-general",
          event: "MessageSent",
          payload: {
            messageId: "message-hello-token",
            senderId: "user-ada",
            body: "hello token auth",
            createdAt: "2026-05-09T00:00:00.000Z",
          },
        },
      ]),
    );

    const frame = await nextFrame(socket);
    expect(frame[0]).toBe(FrameKind.Ack);
    expect(frame[1]).toMatchObject({
      requestId: "request-hello-token-append",
    });
    socket.close();
  });

  it("nacks pre-Hello append frames and does not write storage", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = new WebSocket(app.url, {
      headers: { authorization: `Bearer ${login.sessionToken}` },
    });
    await new Promise<void>((resolve) => socket.once("open", resolve));

    socket.send(
      encodeFrame([
        FrameKind.Append,
        {
          requestId: "request-pre-hello-append",
          stream: "MessageStream",
          key: "conversation-general",
          event: "MessageSent",
          payload: {
            messageId: "message-pre-hello-append",
            senderId: "user-ada",
            body: "must not store before hello",
            createdAt: "2026-05-09T00:00:00.000Z",
          },
        },
      ]),
    );

    const frame = await nextFrame(socket);
    expect(frame[0]).toBe(FrameKind.Nack);
    expect(frame[1]).toMatchObject({
      requestId: "request-pre-hello-append",
      code: "sync.protocolError",
    });
    expect(app.store.readEvents("MessageStream", "conversation-general", 0)).toHaveLength(0);
    socket.close();
  });

  it("does not authenticate websocket sessions from the sessionToken query parameter", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = new WebSocket(`${app.url}?sessionToken=${encodeURIComponent(login.sessionToken)}`);
    await finishHello(socket);

    socket.send(
      encodeFrame([
        FrameKind.ObjectUpsert,
        {
          requestId: "request-query-token-write",
          objectType: "User",
          objectId: "user-ada",
          value: { displayName: "Ada Query Token" },
        },
      ]),
    );

    const frame = await nextFrame(socket);
    expect(frame[0]).toBe(FrameKind.Nack);
    expect(frame[1]).toMatchObject({
      requestId: "request-query-token-write",
      code: "auth.unauthenticated",
    });
    socket.close();
  });

  it("nacks unauthenticated websocket writes with request-specific auth errors", async () => {
    app = await startServer();
    const socket = new WebSocket(app.url);
    await finishHello(socket);

    socket.send(
      encodeFrame([
        FrameKind.Append,
        {
          requestId: "request-unauthenticated-append",
          stream: "MessageStream",
          key: "conversation-general",
          event: "MessageSent",
          payload: {
            messageId: "message-unauthenticated-append",
            senderId: "user-ada",
            body: "missing auth",
            createdAt: "2026-05-09T00:00:00.000Z",
          },
        },
      ]),
    );

    const frame = await nextFrame(socket);
    expect(frame[0]).toBe(FrameKind.Nack);
    expect(frame[1]).toMatchObject({
      requestId: "request-unauthenticated-append",
      code: "auth.unauthenticated",
    });
    socket.close();
  });

  it("nacks invalid Hello.sessionToken credentials", async () => {
    app = await startServer();
    const socket = new WebSocket(app.url);
    await new Promise<void>((resolve) => socket.once("open", resolve));
    const nack = nextFrame(socket);

    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: "replica-test",
          deviceId: "device-test",
          schemaHash: foundationSchema.hash,
          knownCursors: {},
          sessionToken: "not-a-valid-session",
        },
      ]),
    );

    const frame = await nack;
    expect(frame[0]).toBe(FrameKind.Nack);
    expect(frame[1]).toMatchObject({
      requestId: "hello",
      code: "auth.unauthenticated",
    });
    socket.close();
  });

  it("nacks signal frames from non-members of a conversation with auth.forbidden", async () => {
    app = await startServer();
    app.store.upsertObject("User", "user-mallory", {
      displayName: "Mallory",
      avatarBlobId: undefined,
    });
    const malloryLogin = await devLogin(app.httpUrl, { userId: "user-mallory" });
    const socket = await connectAndHello(app.url, malloryLogin.sessionToken);

    socket.send(
      encodeFrame([
        FrameKind.SignalSend,
        {
          requestId: "request-ws-signal-mallory",
          name: "WebRTCSignal",
          key: "conversation-general",
          value: {
            senderDeviceId: "device-mallory",
            kind: "offer",
            payload: "sdp-from-outsider",
          },
        },
      ]),
    );

    const frame = await nextFrame(socket);
    expect(frame[0]).toBe(FrameKind.Nack);
    expect(frame[1]).toMatchObject({
      requestId: "request-ws-signal-mallory",
      code: "auth.forbidden",
    });
    expect(frame[1].error).toMatchObject({
      code: "auth.forbidden",
      details: { reason: "notMember" },
    });
    socket.close();
  });

  it("nacks append frames from non-members with auth.forbidden", async () => {
    app = await startServer();
    app.store.upsertObject("User", "user-mallory", {
      displayName: "Mallory",
      avatarBlobId: undefined,
    });
    const malloryLogin = await devLogin(app.httpUrl, { userId: "user-mallory" });
    const socket = await connectAndHello(app.url, malloryLogin.sessionToken);

    socket.send(
      encodeFrame([
        FrameKind.Append,
        {
          requestId: "request-ws-append-mallory",
          stream: "MessageStream",
          key: "conversation-general",
          event: "MessageSent",
          payload: {
            messageId: "message-ws-mallory",
            senderId: "user-mallory",
            body: "nope",
            createdAt: "2026-05-09T00:00:00.000Z",
          },
        },
      ]),
    );

    const frame = await nextFrame(socket);
    expect(frame[0]).toBe(FrameKind.Nack);
    expect(frame[1]).toMatchObject({
      requestId: "request-ws-append-mallory",
      code: "auth.forbidden",
    });
    expect(frame[1].error).toMatchObject({
      code: "auth.forbidden",
      details: { reason: "notMember" },
    });
    socket.close();
  });

  it("nacks subscribe frames from non-members with auth.forbidden", async () => {
    app = await startServer();
    app.store.upsertObject("User", "user-mallory", {
      displayName: "Mallory",
      avatarBlobId: undefined,
    });
    const malloryLogin = await devLogin(app.httpUrl, { userId: "user-mallory" });
    const socket = await connectAndHello(app.url, malloryLogin.sessionToken);

    socket.send(
      encodeFrame([
        FrameKind.Subscribe,
        {
          subscriptionId: "sub-ws-mallory",
          kind: "stream",
          name: "MessageStream",
          key: "conversation-general",
        },
      ]),
    );

    const frame = await nextFrame(socket);
    expect(frame[0]).toBe(FrameKind.Nack);
    expect(frame[1]).toMatchObject({
      requestId: "sub-ws-mallory",
      code: "auth.forbidden",
    });
    expect(frame[1].error).toMatchObject({
      code: "auth.forbidden",
      details: { reason: "notMember" },
    });
    socket.close();
  });

  it("nacks signal subscriptions from non-members with auth.forbidden", async () => {
    app = await startServer();
    app.store.upsertObject("User", "user-mallory", {
      displayName: "Mallory",
      avatarBlobId: undefined,
    });
    const malloryLogin = await devLogin(app.httpUrl, { userId: "user-mallory" });
    const socket = await connectAndHello(app.url, malloryLogin.sessionToken);

    socket.send(
      encodeFrame([
        FrameKind.Subscribe,
        {
          subscriptionId: "sub-signal-mallory",
          kind: "signal",
          name: "WebRTCSignal",
          key: "conversation-general",
        },
      ]),
    );

    const frame = await nextFrame(socket);
    expect(frame[0]).toBe(FrameKind.Nack);
    expect(frame[1]).toMatchObject({
      requestId: "sub-signal-mallory",
      code: "auth.forbidden",
    });
    expect(frame[1].error).toMatchObject({
      code: "auth.forbidden",
      details: { reason: "notMember" },
    });
    socket.close();
  });

  it("nacks TypingState presence subscriptions from non-members", async () => {
    app = await startServer();
    app.store.upsertObject("User", "user-mallory", {
      displayName: "Mallory",
      avatarBlobId: undefined,
    });
    const malloryLogin = await devLogin(app.httpUrl, { userId: "user-mallory" });
    const socket = await connectAndHello(app.url, malloryLogin.sessionToken);

    socket.send(
      encodeFrame([
        FrameKind.Subscribe,
        {
          subscriptionId: "sub-presence-mallory",
          kind: "presence",
          name: "TypingState",
          key: "conversation-general:user-mallory:device-test",
        },
      ]),
    );

    const frame = await nextFrame(socket);
    expect(frame[0]).toBe(FrameKind.Nack);
    expect(frame[1]).toMatchObject({
      requestId: "sub-presence-mallory",
      code: "auth.forbidden",
    });
    expect(frame[1].error).toMatchObject({
      code: "auth.forbidden",
      details: { reason: "notMember" },
    });
    socket.close();
  });

  it("nacks TypingState presence writes from non-members and member owner spoofing", async () => {
    app = await startServer();
    app.store.upsertObject("User", "user-mallory", {
      displayName: "Mallory",
      avatarBlobId: undefined,
    });
    const malloryLogin = await devLogin(app.httpUrl, { userId: "user-mallory" });
    const mallorySocket = await connectAndHello(app.url, malloryLogin.sessionToken);

    mallorySocket.send(
      encodeFrame([
        FrameKind.PresenceSet,
        {
          requestId: "request-presence-mallory",
          name: "TypingState",
          key: "conversation-general:user-mallory:device-test",
          value: {
            isTyping: true,
            conversationId: "conversation-general",
            userId: "user-mallory",
            deviceId: "device-test",
          },
        },
      ]),
    );

    const malloryFrame = await nextFrame(mallorySocket);
    expect(malloryFrame[0]).toBe(FrameKind.Nack);
    expect(malloryFrame[1]).toMatchObject({
      requestId: "request-presence-mallory",
      code: "auth.forbidden",
    });
    expect(malloryFrame[1].error).toMatchObject({
      details: { reason: "notMember" },
    });
    expect(app.store.readPresence("TypingState", "conversation-general:user-mallory:device-test")).toBeUndefined();
    mallorySocket.close();

    const adaLogin = await devLogin(app.httpUrl, { userId: "user-ada" });
    const adaSocket = await connectAndHello(app.url, adaLogin.sessionToken);

    adaSocket.send(
      encodeFrame([
        FrameKind.PresenceSet,
        {
          requestId: "request-presence-spoof",
          name: "TypingState",
          key: "conversation-general:user-grace:device-test",
          value: {
            isTyping: true,
            conversationId: "conversation-general",
            userId: "user-grace",
            deviceId: "device-test",
          },
        },
      ]),
    );

    const spoofFrame = await nextFrame(adaSocket);
    expect(spoofFrame[0]).toBe(FrameKind.Nack);
    expect(spoofFrame[1]).toMatchObject({
      requestId: "request-presence-spoof",
      code: "auth.forbidden",
    });
    expect(spoofFrame[1].error).toMatchObject({
      details: { reason: "ownerMismatch" },
    });
    expect(app.store.readPresence("TypingState", "conversation-general:user-grace:device-test")).toBeUndefined();
    adaSocket.close();
  });

  it("rejects websocket writes when the session tenant is archived after socket authentication", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    await fetch(`${app.httpUrl}/_frick/admin/tenants`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant-archived-ws" }),
    });
    const login = await devLogin(app.httpUrl, {
      userId: "user-archived",
      tenantId: "tenant-archived-ws",
    });
    const socket = await connectAndHello(app.url, login.sessionToken);
    const archive = await fetch(
      `${app.httpUrl}/_frick/admin/tenants/tenant-archived-ws/archive`,
      { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
    );
    expect(archive.status).toBe(200);

    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.send(
      encodeFrame([
        FrameKind.ObjectUpsert,
        {
          requestId: "req-archived-ws",
          objectType: "Note",
          objectId: "note-archived-ws",
          value: { body: "no writes after archive" },
        },
      ]),
    );

    const frame = await nextFrame(socket);
    expect(frame[0]).toBe(FrameKind.Nack);
    expect(frame[1]).toMatchObject({
      requestId: "req-archived-ws",
      code: "auth.unauthenticated",
    });
    expect(app.store.readObject("tenant-archived-ws", "Note", "note-archived-ws")).toBeUndefined();
    await closed;
    socket.close();
  });

  it("invokes registered policy hooks on the websocket signal path", async () => {
    const denySignals: FrickPolicyHook = (input) => {
      if (input.action === "signal.send") {
        return {
          allow: false,
          reason: "notAuthorizedForResource",
          publicMessage: "Signals disabled by app policy",
        };
      }
      return null;
    };
    app = await startServer({ policyHooks: [denySignals] });
    const adaLogin = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connectAndHello(app.url, adaLogin.sessionToken);

    socket.send(
      encodeFrame([
        FrameKind.SignalSend,
        {
          requestId: "request-ws-hook-ada",
          name: "WebRTCSignal",
          key: "conversation-general",
          value: {
            senderDeviceId: "device-ada",
            kind: "offer",
            payload: "sdp-hooked",
          },
        },
      ]),
    );

    const frame = await nextFrame(socket);
    expect(frame[0]).toBe(FrameKind.Nack);
    expect(frame[1]).toMatchObject({
      requestId: "request-ws-hook-ada",
      code: "auth.forbidden",
      message: "Signals disabled by app policy",
    });
    expect(frame[1].error).toMatchObject({
      code: "auth.forbidden",
      details: { reason: "notAuthorizedForResource" },
    });
    socket.close();
  });
});

const ADMIN_TOKEN = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";

async function startServer(options: { policyHooks?: readonly FrickPolicyHook[]; adminToken?: string } = {}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    ...(options.adminToken ? { config: { adminToken: options.adminToken } } : {}),
    ...(options.policyHooks ? { policyHooks: options.policyHooks } : {}),
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

async function connectAndHello(url: string, sessionToken: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${sessionToken}` } });
  await finishHello(socket);
  return socket;
}

async function connectAndHelloFromHelloToken(url: string, sessionToken: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await finishHello(socket, sessionToken);
  return socket;
}

async function connectAndHelloWithHeaders(
  url: string,
  headers: Record<string, string>,
): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers });
  await finishHello(socket);
  return socket;
}

async function finishHello(socket: WebSocket, sessionToken?: string): Promise<void> {
  await new Promise<void>((resolve) => socket.once("open", resolve));
  const hello = expectHelloAckThenSchema(socket);
  socket.send(
    encodeFrame([
      FrameKind.Hello,
      {
        replicaId: "replica-test",
        deviceId: "device-test",
        schemaHash: foundationSchema.hash,
        knownCursors: {},
        ...(sessionToken ? { sessionToken } : {}),
      },
    ]),
  );
  await hello;
}

async function nextFrame(socket: WebSocket): Promise<FrickFrame> {
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
  body: { userId: string; tenantId?: string; deviceId?: string; replicaId?: string; platform?: string },
): Promise<{ sessionToken: string }> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { sessionToken: string };
}
