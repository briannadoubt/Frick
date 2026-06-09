import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  FrameKind,
  decodeFrame,
  encodeFrame,
  type CallCommandOp,
  type CallCommandResultPayload,
  type FrickFrame,
  type FrickSchema,
  type HelloAckPayload,
  type NackPayload,
} from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";
import {
  DEFAULT_SFU_MEDIA_CODECS,
  FakeSfuBackend,
  SfuMediaPlaneAdapter,
  buildCallSchema,
  type MediaPlaneAdapter,
  type SfuTransportParams,
} from "../src/calls/index.js";

/**
 * FR-15 — call control-plane wire contract (Phase 1).
 *
 * Exercises the `CallCommand`/`CallCommandResult` frames end-to-end over the
 * sync WebSocket against a server whose schema declares the call types (so the
 * control plane auto-enables with the deterministic fake media adapter).
 */

const callSchema: FrickSchema = buildCallSchema();

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("FR-15 — call command wire", () => {
  it("creates a call, returning the room + invites", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connectAndHello(app.url, app.schemaHash, ada.sessionToken, "device-ada");

    const result = await sendCommand(socket, {
      op: "create",
      conversationId: "conversation-1",
      inviteeUserIds: ["user-bob"],
      kind: "video",
    });

    expect(result.op).toBe("create");
    expect(result.room?.state).toBe("ringing");
    expect(result.room?.createdBy).toBe("user-ada");
    expect(result.room?.kind).toBe("video");
    expect(result.invites).toHaveLength(1);
    expect(result.invites?.[0]?.inviteeUserId).toBe("user-bob");
    socket.close();
  });

  it("lets an invitee join — returning room=active, participant, and a media grant", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    const bob = await devLogin(app.httpUrl, { userId: "user-bob" });
    const adaSocket = await connectAndHello(app.url, app.schemaHash, ada.sessionToken, "device-ada");
    const created = await sendCommand(adaSocket, {
      op: "create",
      conversationId: "conversation-1",
      inviteeUserIds: ["user-bob"],
    });
    const callId = created.room!.id;

    const bobSocket = await connectAndHello(app.url, app.schemaHash, bob.sessionToken, "device-bob");
    const joined = await sendCommand(bobSocket, { op: "join", callId });

    expect(joined.op).toBe("join");
    expect(joined.room?.state).toBe("active");
    expect(joined.participant?.userId).toBe("user-bob");
    expect(joined.participant?.deviceId).toBeTruthy();
    expect(joined.participant?.micEnabled).toBe(true);
    expect(joined.mediaGrant?.callId).toBe(callId);
    expect(joined.mediaGrant?.token).toContain("fake-token");
    adaSocket.close();
    bobSocket.close();
  });

  it("updates a participant's media state (FR-82 presence surface)", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    const bob = await devLogin(app.httpUrl, { userId: "user-bob" });
    const adaSocket = await connectAndHello(app.url, app.schemaHash, ada.sessionToken, "device-ada");
    const created = await sendCommand(adaSocket, {
      op: "create",
      conversationId: "conversation-1",
      inviteeUserIds: ["user-bob"],
    });
    const callId = created.room!.id;
    const bobSocket = await connectAndHello(app.url, app.schemaHash, bob.sessionToken, "device-bob");
    await sendCommand(bobSocket, { op: "join", callId });

    const muted = await sendCommand(bobSocket, {
      op: "setMediaState",
      callId,
      media: { micEnabled: false, cameraEnabled: true },
    });

    expect(muted.participant?.micEnabled).toBe(false);
    expect(muted.participant?.cameraEnabled).toBe(true);
    expect(muted.participant?.screenSharing).toBe(false);
    adaSocket.close();
    bobSocket.close();
  });

  it("nacks a join from a non-invitee with the control-plane reason", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    const mallory = await devLogin(app.httpUrl, { userId: "user-mallory" });
    const adaSocket = await connectAndHello(app.url, app.schemaHash, ada.sessionToken, "device-ada");
    const created = await sendCommand(adaSocket, {
      op: "create",
      conversationId: "conversation-1",
      inviteeUserIds: ["user-bob"],
    });
    const callId = created.room!.id;

    const malSocket = await connectAndHello(app.url, app.schemaHash, mallory.sessionToken, "device-mal");
    const nack = await sendCommandExpectingNack(malSocket, { op: "join", callId });

    expect(nack.code).toBe("auth.forbidden");
    expect((nack.error.details as { reason?: string }).reason).toBe("notInvitee");
    adaSocket.close();
    malSocket.close();
  });

  it("nacks a call command when the server has calls disabled", async () => {
    app = await startServer({ disableCalls: true });
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connectAndHello(app.url, app.schemaHash, ada.sessionToken, "device-ada");

    const nack = await sendCommandExpectingNack(socket, {
      op: "create",
      conversationId: "conversation-1",
      inviteeUserIds: ["user-bob"],
    });

    expect(nack.code).toBe("auth.forbidden");
    expect((nack.error.details as { reason?: string }).reason).toBe("callsDisabled");
    socket.close();
  });

  // -- FR-155: SFU media negotiation over the wire -------------------------

  it("round-trips SFU connect/produce/consume against an SFU media plane", async () => {
    const sfuPlane = new SfuMediaPlaneAdapter({
      backend: new FakeSfuBackend(),
      announcedIp: "203.0.113.9",
      mediaCodecs: DEFAULT_SFU_MEDIA_CODECS,
      tokenSecret: "wire-secret-at-least-16-bytes",
    });
    app = await startServer({ mediaPlane: sfuPlane });
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    const bob = await devLogin(app.httpUrl, { userId: "user-bob" });
    const adaSocket = await connectAndHello(app.url, app.schemaHash, ada.sessionToken, "device-ada");
    const created = await sendCommand(adaSocket, {
      op: "create",
      conversationId: "conversation-1",
      inviteeUserIds: ["user-bob"],
    });
    const callId = created.room!.id;

    const bobSocket = await connectAndHello(app.url, app.schemaHash, bob.sessionToken, "device-bob");
    const joined = await sendCommand(bobSocket, { op: "join", callId });
    const token = joined.mediaGrant!.token;
    const send = JSON.parse(joined.mediaGrant!.connection!["sendTransport"]!) as SfuTransportParams;
    const recv = JSON.parse(joined.mediaGrant!.connection!["recvTransport"]!) as SfuTransportParams;

    const connected = await sendCommand(bobSocket, {
      op: "sfuConnectTransport",
      callId,
      token,
      transportId: send.id,
      dtlsParameters: { fingerprints: [{ algorithm: "sha-256", value: "AA:BB" }] },
    });
    expect(connected.op).toBe("sfuConnectTransport");

    const produced = await sendCommand(bobSocket, {
      op: "sfuProduce",
      callId,
      token,
      transportId: send.id,
      kind: "audio",
      rtpParameters: { codecs: [] },
    });
    expect(produced.producer?.producerId).toBeTruthy();
    expect(produced.producer?.kind).toBe("audio");

    const consumed = await sendCommand(bobSocket, {
      op: "sfuConsume",
      callId,
      token,
      transportId: recv.id,
      producerId: produced.producer!.producerId,
      rtpCapabilities: { codecs: [] },
    });
    expect(consumed.consumer?.producerId).toBe(produced.producer!.producerId);
    expect(consumed.consumer?.kind).toBe("audio");
    expect(consumed.consumer?.rtpParameters).toBeTruthy();

    adaSocket.close();
    bobSocket.close();
  });

  it("nacks SFU media ops on a non-SFU media plane", async () => {
    // The default fake media plane has no produce/consume companion.
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    const bob = await devLogin(app.httpUrl, { userId: "user-bob" });
    const adaSocket = await connectAndHello(app.url, app.schemaHash, ada.sessionToken, "device-ada");
    const created = await sendCommand(adaSocket, {
      op: "create",
      conversationId: "conversation-1",
      inviteeUserIds: ["user-bob"],
    });
    const callId = created.room!.id;
    const bobSocket = await connectAndHello(app.url, app.schemaHash, bob.sessionToken, "device-bob");
    await sendCommand(bobSocket, { op: "join", callId });

    const nack = await sendCommandExpectingNack(bobSocket, {
      op: "sfuProduce",
      callId,
      token: "tok",
      transportId: "t",
      kind: "audio",
      rtpParameters: {},
    });
    expect(nack.code).toBe("sync.protocolError");
    expect((nack.error.details as { reason?: string }).reason).toBe("sfuUnsupported");
    adaSocket.close();
    bobSocket.close();
  });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function startServer(
  options: { disableCalls?: boolean; mediaPlane?: MediaPlaneAdapter } = {},
) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    schema: callSchema,
    ...(options.disableCalls
      ? { calls: { enabled: false } }
      : options.mediaPlane
        ? { calls: { mediaPlane: options.mediaPlane } }
        : {}),
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    url: `ws://127.0.0.1:${address.port}/_frick/sync`,
    httpUrl: `http://127.0.0.1:${address.port}`,
    schemaHash: callSchema.hash,
    store: server.store,
    close: server.close,
  };
}

async function connectAndHello(
  url: string,
  schemaHash: string,
  sessionToken: string,
  deviceId: string,
): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${sessionToken}` } });
  await new Promise<void>((resolve) => socket.once("open", resolve));
  const hello = expectHelloAckThenSchema(socket);
  socket.send(
    encodeFrame([
      FrameKind.Hello,
      { replicaId: `replica-${deviceId}`, deviceId, schemaHash, knownCursors: {} },
    ]),
  );
  await hello;
  return socket;
}

async function sendCommand(
  socket: WebSocket,
  command: CallCommandOp,
): Promise<CallCommandResultPayload> {
  const requestId = `req-${Math.random().toString(36).slice(2)}`;
  const frame = await roundTrip(socket, requestId, command);
  if (frame[0] !== FrameKind.CallCommandResult) {
    throw new Error(`Expected CallCommandResult, got ${frame[0]}: ${JSON.stringify(frame[1])}`);
  }
  return frame[1] as CallCommandResultPayload;
}

async function sendCommandExpectingNack(
  socket: WebSocket,
  command: CallCommandOp,
): Promise<NackPayload> {
  const requestId = `req-${Math.random().toString(36).slice(2)}`;
  const frame = await roundTrip(socket, requestId, command);
  if (frame[0] !== FrameKind.Nack) {
    throw new Error(`Expected Nack, got ${frame[0]}`);
  }
  return frame[1] as NackPayload;
}

function roundTrip(
  socket: WebSocket,
  requestId: string,
  command: CallCommandOp,
): Promise<FrickFrame> {
  return new Promise((resolve) => {
    const onMessage = (data: Buffer) => {
      const frame = decodeFrame(data) as FrickFrame;
      const body = frame[1] as { requestId?: string };
      if (body?.requestId === requestId) {
        socket.off("message", onMessage);
        resolve(frame);
      }
    };
    socket.on("message", onMessage);
    socket.send(encodeFrame([FrameKind.CallCommand, { requestId, command }]));
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
