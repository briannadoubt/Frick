import { describe, expect, it } from "vitest";
import {
  FrameKind,
  decodeFrame,
  defaultClientCapabilities,
  defaultServerCapabilities,
  encodeFrame,
  foundationSchema,
  rejectSchemaMismatch,
  type FrickFrame,
} from "../src/index.js";

describe("foundation frames", () => {
  it("round-trips hello, subscribe, append, presence, signal, and cursor frames", () => {
    const frames: FrickFrame[] = [
      [
        FrameKind.Hello,
        {
          replicaId: "replica-1",
          deviceId: "device-1",
          schemaHash: foundationSchema.hash,
          knownCursors: {},
          clientCapabilities: defaultClientCapabilities({
            platform: "web",
            sdkVersion: "0.0.0-test",
            schema: foundationSchema,
          }),
        },
      ],
      [
        FrameKind.HelloAck,
        {
          schemaHash: foundationSchema.hash,
          schemaId: foundationSchema.schemaId,
          schemaRevision: foundationSchema.schemaRevision,
          schemaCompatibility: {
            compatible: true,
            reason: "exact",
            clientRevision: foundationSchema.schemaRevision,
            serverRevision: foundationSchema.schemaRevision,
          },
          serverCapabilities: defaultServerCapabilities(foundationSchema),
        },
      ],
      [
        FrameKind.Subscribe,
        {
          subscriptionId: "sub-1",
          kind: "stream",
          name: "MessageStream",
          key: "conversation-1",
          cursor: 0,
        },
      ],
      [
        FrameKind.Append,
        {
          requestId: "request-1",
          stream: "MessageStream",
          key: "conversation-1",
          event: "MessageSent",
          payload: { body: "hi" },
        },
      ],
      [
        FrameKind.PresenceSet,
        {
          requestId: "presence-1",
          name: "TypingState",
          key: "conversation-1:user-1:device-1",
          value: { isTyping: true },
        },
      ],
      [
        FrameKind.SignalSend,
        {
          requestId: "signal-1",
          name: "WebRTCSignal",
          key: "call-1",
          value: { kind: "offer", payload: new Uint8Array([1]) },
        },
      ],
      [
        FrameKind.Nack,
        {
          requestId: "request-nack",
          error: {
            code: "schema.incompatible",
            message: "Schema mismatch",
            requestId: "request-nack",
            retryable: false,
            schemaRevision: foundationSchema.schemaRevision,
          },
          code: "schema.incompatible",
          message: "Schema mismatch",
        },
      ],
      [FrameKind.CursorCommit, { subscriptionId: "sub-1", cursor: 12 }],
      [
        FrameKind.ProjectionDelta,
        {
          projection: "conversation-inbox",
          changes: [
            { key: "user-1:conversation-1", value: { unread: 1, lastSequence: 12 } },
            { key: "user-2:conversation-1", value: null },
          ],
        },
      ],
      [
        FrameKind.ObjectUpsert,
        {
          requestId: "request-upsert",
          objectType: "User",
          objectId: "user-ada",
          value: { displayName: "Ada" },
          expectedVersion: 1,
        },
      ],
      [
        FrameKind.Ack,
        {
          requestId: "request-upsert",
          version: 2,
        },
      ],
    ];

    for (const frame of frames) {
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    }
  });

  it("rejects schema hash mismatch during greenfield cutover", () => {
    expect(() => rejectSchemaMismatch("old-schema", foundationSchema.hash)).toThrow(/schema mismatch/i);
  });

  it("round-trips call control-plane command + result frames (FR-15)", () => {
    const frames: FrickFrame[] = [
      [
        FrameKind.CallCommand,
        {
          requestId: "call-create-1",
          command: {
            op: "create",
            conversationId: "conversation-1",
            inviteeUserIds: ["user-2", "user-3"],
            kind: "video",
            regionHint: "us-east",
          },
        },
      ],
      [
        FrameKind.CallCommand,
        { requestId: "call-join-1", command: { op: "join", callId: "call-1" } },
      ],
      [
        FrameKind.CallCommand,
        {
          requestId: "call-media-1",
          command: { op: "setMediaState", callId: "call-1", media: { micEnabled: false } },
        },
      ],
      [
        FrameKind.CallCommandResult,
        {
          requestId: "call-create-1",
          op: "create",
          room: {
            id: "call-1",
            conversationId: "conversation-1",
            state: "ringing",
            createdBy: "user-1",
            kind: "video",
            createdAt: "2026-06-07T00:00:00.000Z",
          },
          invites: [
            {
              id: "call-1:user-2",
              callId: "call-1",
              inviteeUserId: "user-2",
              status: "ringing",
              invitedBy: "user-1",
              invitedAt: "2026-06-07T00:00:00.000Z",
            },
          ],
        },
      ],
      [
        FrameKind.CallCommandResult,
        {
          requestId: "call-join-1",
          op: "join",
          room: {
            id: "call-1",
            conversationId: "conversation-1",
            state: "active",
            createdBy: "user-1",
            kind: "video",
            createdAt: "2026-06-07T00:00:00.000Z",
            startedAt: "2026-06-07T00:00:01.000Z",
          },
          participant: {
            id: "call-1:user-2:device-2",
            callId: "call-1",
            userId: "user-2",
            deviceId: "device-2",
            state: "joined",
            joinedAt: "2026-06-07T00:00:01.000Z",
            micEnabled: true,
            cameraEnabled: false,
            screenSharing: false,
            speaking: false,
            networkQuality: "good",
          },
          mediaGrant: {
            callId: "call-1",
            mediaSessionId: "room-1",
            userId: "user-2",
            deviceId: "device-2",
            token: "fake-token",
            expiresAt: "2026-06-07T00:05:00.000Z",
            connection: { iceServers: "fake://turn" },
          },
        },
      ],
    ];

    for (const frame of frames) {
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    }
  });
});
