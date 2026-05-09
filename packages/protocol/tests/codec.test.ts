import { describe, expect, it } from "vitest";
import {
  foundationSchema,
  packObjectRecord,
  packPresenceRecord,
  packSignalEnvelope,
  packStreamEvent,
  unpackObjectRecord,
  unpackPresenceRecord,
  unpackSignalEnvelope,
  unpackStreamEvent,
} from "../src/index.js";

describe("foundation codecs", () => {
  it("packs and unpacks object records by stable field id", () => {
    const packed = packObjectRecord(foundationSchema, "User", "user-1", {
      displayName: "Ada",
      avatarBlobId: "blob-1",
    });

    expect(packed).toEqual([
      1,
      "user-1",
      [
        [1, "Ada"],
        [2, "blob-1"],
      ],
    ]);
    expect(unpackObjectRecord(foundationSchema, packed)).toEqual({
      type: "User",
      id: "user-1",
      value: { id: "user-1", displayName: "Ada", avatarBlobId: "blob-1" },
    });
  });

  it("packs stream events with stream key and event payload", () => {
    const packed = packStreamEvent(foundationSchema, {
      stream: "MessageStream",
      streamId: "conversation-1",
      sequence: 7,
      eventId: "event-7",
      event: "MessageSent",
      payload: {
        messageId: "message-1",
        senderId: "user-1",
        body: "hello",
        createdAt: "2026-05-09T00:00:00.000Z",
      },
    });

    expect(packed[0]).toBe(1);
    expect(packed[2]).toBe(7);
    expect(unpackStreamEvent(foundationSchema, packed).event).toBe("MessageSent");
  });

  it("packs presence and signal records", () => {
    const presence = packPresenceRecord(foundationSchema, "TypingState", "conversation-1:user-1:device-1", {
      isTyping: true,
    });
    const signal = packSignalEnvelope(foundationSchema, "WebRTCSignal", "call-1", {
      senderDeviceId: "device-1",
      kind: "offer",
      payload: new Uint8Array([1, 2, 3]),
    });

    expect(unpackPresenceRecord(foundationSchema, presence).value.isTyping).toBe(true);
    expect(unpackSignalEnvelope(foundationSchema, signal).value.kind).toBe("offer");
  });
});
