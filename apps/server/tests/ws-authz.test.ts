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

async function startServer(options: { policyHooks?: readonly FrickPolicyHook[] } = {}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
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
  const socket = new WebSocket(`${url}?sessionToken=${encodeURIComponent(sessionToken)}`);
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
      },
    ]),
  );
  await hello;
  return socket;
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
  body: { userId: string; deviceId?: string; replicaId?: string; platform?: string },
): Promise<{ sessionToken: string }> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { sessionToken: string };
}
