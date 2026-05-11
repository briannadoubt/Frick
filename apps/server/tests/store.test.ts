import { afterEach, describe, expect, it } from "vitest";
import { FrickStore } from "../src/store.js";

let store: FrickStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

describe("FrickStore foundation storage", () => {
  it("stores objects and appends ordered stream events", () => {
    store = new FrickStore({ path: ":memory:", seed: true });

    const user = store.readObject("User", "user-ada");
    expect(user?.displayName).toBe("Ada Lovelace");

    const result = store.appendEvent({
      requestId: "request-1",
      replicaId: "replica-1",
      stream: "MessageStream",
      streamId: "conversation-general",
      event: "MessageSent",
      payload: {
        messageId: "message-1",
        senderId: "user-ada",
        body: "Foundation online",
        createdAt: "2026-05-09T00:00:00.000Z",
      },
    });

    expect(result.created).toBe(true);
    expect(result.event.sequence).toBe(1);
    expect(store.readEvents("MessageStream", "conversation-general", 0)).toHaveLength(1);
  });

  it("deduplicates appends by replica and request id", () => {
    store = new FrickStore({ path: ":memory:", seed: true });

    const input = {
      requestId: "request-1",
      replicaId: "replica-1",
      stream: "MessageStream",
      streamId: "conversation-general",
      event: "MessageSent",
      payload: {
        messageId: "message-1",
        senderId: "user-ada",
        body: "once",
        createdAt: "2026-05-09T00:00:00.000Z",
      },
    };

    const first = store.appendEvent(input);
    const second = store.appendEvent(input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.event.eventId).toBe(first.event.eventId);
    expect(store.readEvents("MessageStream", "conversation-general", 0)).toHaveLength(1);
  });

  it("preserves idempotency when the front cache evicts the entry", () => {
    // Capacity of 1 forces the original request's cache entry to be evicted
    // by the second distinct request. The repeated append of request-1 must
    // still resolve to the same eventId by falling through to SQLite.
    store = new FrickStore({ path: ":memory:", seed: true, idempotencyCacheCapacity: 1 });

    const first = store.appendEvent({
      requestId: "request-1",
      replicaId: "replica-1",
      stream: "MessageStream",
      streamId: "conversation-general",
      event: "MessageSent",
      payload: {
        messageId: "message-1",
        senderId: "user-ada",
        body: "first",
        createdAt: "2026-05-09T00:00:00.000Z",
      },
    });

    // Different requestId — evicts request-1 from the front cache.
    store.appendEvent({
      requestId: "request-2",
      replicaId: "replica-1",
      stream: "MessageStream",
      streamId: "conversation-general",
      event: "MessageSent",
      payload: {
        messageId: "message-2",
        senderId: "user-ada",
        body: "second",
        createdAt: "2026-05-09T00:00:01.000Z",
      },
    });

    expect(store.idempotencyCache.evictions).toBeGreaterThan(0);

    // Replaying request-1 must still hit the durable idempotency table.
    const replay = store.appendEvent({
      requestId: "request-1",
      replicaId: "replica-1",
      stream: "MessageStream",
      streamId: "conversation-general",
      event: "MessageSent",
      payload: {
        messageId: "message-1",
        senderId: "user-ada",
        body: "first",
        createdAt: "2026-05-09T00:00:00.000Z",
      },
    });
    expect(replay.created).toBe(false);
    expect(replay.event.eventId).toBe(first.event.eventId);
    expect(replay.event.sequence).toBe(first.event.sequence);
  });

  it("stores presence leases, signal envelopes, blob metadata, and jobs", () => {
    store = new FrickStore({ path: ":memory:", seed: true });

    store.setPresence("TypingState", "conversation-general:user-ada:device-1", { isTyping: true }, 5000);
    store.enqueueSignal("WebRTCSignal", "call-1", {
      senderDeviceId: "device-1",
      kind: "offer",
      payload: new Uint8Array([1]),
    });
    store.createBlobMetadata({
      blobId: "blob-1",
      ownerId: "user-ada",
      contentHash: "sha256-demo",
      byteLength: 10,
      mimeType: "text/plain",
    });
    store.enqueueJob("PushNotificationJob", {
      recipientUserId: "user-grace",
      kind: "message",
      payload: "{}",
    });

    expect(store.readPresence("TypingState", "conversation-general:user-ada:device-1")?.isTyping).toBe(true);
    expect(store.drainSignals("WebRTCSignal", "call-1")).toHaveLength(1);
    expect(store.readBlobMetadata("blob-1")?.mimeType).toBe("text/plain");
    expect(store.nextJob("PushNotificationJob")?.name).toBe("PushNotificationJob");
  });
});
