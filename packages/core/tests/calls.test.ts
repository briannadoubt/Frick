import { describe, expect, it } from "vitest";
import {
  FrameKind,
  decodeFrame,
  encodeFrame,
  packObjectRecord,
  productTestSchema,
  validateSchema,
  type CallCommandPayload,
  type CallParticipantRecord,
  type CallRoomRecord,
  type FrickSchema,
} from "@fricken/protocol";
import {
  FrickClient,
  FrickClientLimitError,
  callState,
  createCall,
  joinCall,
  leaveCall,
  setCallMediaState,
} from "../src/index.js";

/**
 * FR-80 / FR-82 — TS call client surface, exercised against a mock socket.
 * The runtime sends `CallCommand` frames and settles the helper Promise on the
 * correlated `CallCommandResult` (or `Nack`); `callState` composes the synced
 * CallRoom + CallParticipant object deltas into a reactive view.
 */

// The product-test fixture now carries the canonical call control-plane object
// set (FR-294: CallRoom/CallInvite/CallParticipant mirror the Rust
// `call_object_defs` field-for-field), so `packObjectRecord` can encode
// CallParticipant/CallRoom deltas directly — no strip-and-splice needed.
const callTestSchema: FrickSchema = validateSchema(productTestSchema);

describe("FR-80 — call client helpers", () => {
  it("createCall sends a create CallCommand and resolves with room + invites", async () => {
    const socket = TestWebSocket.prepare();
    const client = newClient(socket);
    socket.emit("open", {});

    const room: CallRoomRecord = {
      id: "call-1",
      conversationId: "conversation-1",
      state: "ringing",
      createdBy: "user-ada",
      kind: "video",
      createdAt: "2026-06-07T00:00:00.000Z",
    };
    const promise = createCall(client, {
      conversationId: "conversation-1",
      inviteeUserIds: ["user-bob"],
      kind: "video",
    });

    const sent = decodeFrame(socket.sent.at(-1) as Uint8Array) as [FrameKind, CallCommandPayload];
    expect(sent[0]).toBe(FrameKind.CallCommand);
    expect(sent[1].command).toMatchObject({ op: "create", conversationId: "conversation-1" });
    const requestId = sent[1].requestId;

    socket.emit("message", {
      data: encodeFrame([
        FrameKind.CallCommandResult,
        {
          requestId,
          op: "create",
          room,
          invites: [
            {
              id: "call-1:user-bob",
              callId: "call-1",
              inviteeUserId: "user-bob",
              status: "ringing",
              invitedBy: "user-ada",
              invitedAt: "2026-06-07T00:00:00.000Z",
            },
          ],
        },
      ]),
    });

    const result = await promise;
    expect(result.room).toEqual(room);
    expect(result.invites).toHaveLength(1);
  });

  it("joinCall resolves with the media grant", async () => {
    const socket = TestWebSocket.prepare();
    const client = newClient(socket);
    socket.emit("open", {});

    const promise = joinCall(client, "call-1");
    const requestId = (decodeFrame(socket.sent.at(-1) as Uint8Array) as [FrameKind, CallCommandPayload])[1]
      .requestId;
    socket.emit("message", {
      data: encodeFrame([
        FrameKind.CallCommandResult,
        {
          requestId,
          op: "join",
          room: {
            id: "call-1",
            conversationId: "conversation-1",
            state: "active",
            createdBy: "user-ada",
            kind: "video",
            createdAt: "2026-06-07T00:00:00.000Z",
          },
          participant: participantRecord({ micEnabled: true }),
          mediaGrant: {
            callId: "call-1",
            mediaSessionId: "room-1",
            userId: "user-bob",
            deviceId: "device-b",
            token: "fake-token",
            expiresAt: "2026-06-07T00:05:00.000Z",
          },
        },
      ]),
    });
    const result = await promise;
    expect(result.mediaGrant.token).toBe("fake-token");
    expect(result.room.state).toBe("active");
  });

  it("rejects with FrickClientLimitError when the server nacks a command", async () => {
    const socket = TestWebSocket.prepare();
    const client = newClient(socket);
    socket.emit("open", {});

    const promise = leaveCall(client, "call-1");
    const requestId = (decodeFrame(socket.sent.at(-1) as Uint8Array) as [FrameKind, CallCommandPayload])[1]
      .requestId;
    socket.emit("message", {
      data: encodeFrame([
        FrameKind.Nack,
        {
          requestId,
          error: {
            code: "sync.protocolError",
            message: "not a participant",
            requestId,
            retryable: false,
            details: { reason: "notParticipant" },
          },
          code: "sync.protocolError",
          message: "not a participant",
        },
      ]),
    });
    await expect(promise).rejects.toBeInstanceOf(FrickClientLimitError);
  });
});

describe("FR-82 — observable call state", () => {
  it("composes participants from synced deltas and surfaces presence", async () => {
    const socket = TestWebSocket.prepare();
    const client = newClient(socket);
    socket.emit("open", {});

    const { signal, dispose } = callState(client, "call-1");
    expect(signal.value.room).toBeUndefined();
    expect(signal.value.participants).toHaveLength(0);

    // Server fans out the room + a participant via a Delta.
    socket.emit("message", {
      data: encodeFrame([
        FrameKind.Delta,
        {
          objects: [
            packObjectRecord(callTestSchema, "CallRoom", "call-1", {
              conversationId: "conversation-1",
              state: "active",
              createdBy: "user-ada",
              kind: "video",
              createdAt: "2026-06-07T00:00:00.000Z",
            }),
            packObjectRecord(callTestSchema, "CallParticipant", "call-1:user-bob:device-b", {
              callId: "call-1",
              userId: "user-bob",
              deviceId: "device-b",
              state: "joined",
              joinedAt: "2026-06-07T00:00:01.000Z",
              micEnabled: false,
              cameraEnabled: false,
              screenSharing: false,
            }),
          ],
          events: [],
          cursor: 1,
        },
      ]),
    });

    expect(signal.value.isActive).toBe(true);
    expect(signal.value.participants).toHaveLength(1);
    const bob = signal.value.participants[0]!;
    expect(bob.userId).toBe("user-bob");
    expect(bob.micEnabled).toBe(false);
    expect(bob.speaking).toBe(false);
    expect(bob.networkQuality).toBe("unknown");

    dispose();
  });

  it("setCallMediaState issues a setMediaState command", async () => {
    const socket = TestWebSocket.prepare();
    const client = newClient(socket);
    socket.emit("open", {});

    const promise = setCallMediaState(client, "call-1", { micEnabled: false });
    const sent = decodeFrame(socket.sent.at(-1) as Uint8Array) as [FrameKind, CallCommandPayload];
    expect(sent[1].command).toEqual({ op: "setMediaState", callId: "call-1", media: { micEnabled: false } });
    socket.emit("message", {
      data: encodeFrame([
        FrameKind.CallCommandResult,
        { requestId: sent[1].requestId, op: "setMediaState", participant: participantRecord({ micEnabled: false }) },
      ]),
    });
    const participant = await promise;
    expect(participant.micEnabled).toBe(false);
  });
});

function participantRecord(overrides: Partial<CallParticipantRecord>): CallParticipantRecord {
  return {
    id: "call-1:user-bob:device-b",
    callId: "call-1",
    userId: "user-bob",
    deviceId: "device-b",
    state: "joined",
    joinedAt: "2026-06-07T00:00:01.000Z",
    micEnabled: true,
    cameraEnabled: false,
    screenSharing: false,
    ...overrides,
  };
}

function newClient(socket: TestWebSocket): FrickClient {
  const client = new FrickClient({
    endpoint: "ws://unused",
    schema: callTestSchema,
    sessionToken: "session-token",
    WebSocketImpl: TestWebSocket as never,
  });
  client.connect();
  void socket;
  return client;
}

type SocketListener = (event: unknown) => void;

class TestWebSocket {
  static #next: TestWebSocket | undefined;

  static prepare(): TestWebSocket {
    this.#next = new TestWebSocket();
    return this.#next;
  }

  endpoint: string | undefined;
  readonly sent: unknown[] = [];
  readyState = 1;
  binaryType = "arraybuffer";
  #listeners = new Map<string, SocketListener[]>();

  constructor(endpoint?: string) {
    if (TestWebSocket.#next) {
      const prepared = TestWebSocket.#next;
      TestWebSocket.#next = undefined;
      prepared.endpoint = endpoint;
      return prepared;
    }
    this.endpoint = endpoint;
  }

  addEventListener(name: string, listener: SocketListener): void {
    this.#listeners.set(name, [...(this.#listeners.get(name) ?? []), listener]);
  }

  send(payload: unknown): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
  }

  emit(name: string, event: unknown): void {
    for (const listener of this.#listeners.get(name) ?? []) {
      listener(event);
    }
  }
}
