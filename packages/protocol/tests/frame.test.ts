import { describe, expect, it } from "vitest";
import {
  FrameKind,
  decodeFrame,
  defaultClientCapabilities,
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
    ];

    for (const frame of frames) {
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    }
  });

  it("rejects schema hash mismatch during greenfield cutover", () => {
    expect(() => rejectSchemaMismatch("old-schema", foundationSchema.hash)).toThrow(/schema mismatch/i);
  });
});
