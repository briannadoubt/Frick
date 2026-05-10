import { describe, expect, it } from "vitest";
import { FrameKind, encodeFrame, foundationSchema, packStreamEvent } from "@frick/protocol";
import { FrickClient, MemoryFrickCache } from "../src/index.js";

describe("foundation runtime", () => {
  it("hydrates objects and stream events from local cache", () => {
    const cache = new MemoryFrickCache();
    cache.saveObject(foundationSchema, "User", "user-ada", { displayName: "Ada Lovelace" }, 1);
    cache.saveStreamEvent(foundationSchema, {
      stream: "MessageStream",
      streamId: "conversation-general",
      sequence: 1,
      eventId: "event-1",
      event: "MessageSent",
      payload: {
        messageId: "message-1",
        senderId: "user-ada",
        body: "cached",
        createdAt: "2026-05-09T00:00:00.000Z",
      },
    });

    const client = new FrickClient({ endpoint: "ws://unused", schema: foundationSchema, cache });

    expect(client.object("User", "user-ada")?.displayName).toBe("Ada Lovelace");
    expect(client.stream("MessageStream", "conversation-general").value).toHaveLength(1);
  });

  it("queues appends while disconnected and tracks pending count", async () => {
    const cache = new MemoryFrickCache();
    const client = new FrickClient({ endpoint: "ws://unused", schema: foundationSchema, cache });

    await client.append("MessageStream", "conversation-general", "MessageSent", {
      messageId: "message-1",
      senderId: "user-ada",
      body: "queued",
      createdAt: "2026-05-09T00:00:00.000Z",
    });

    expect(client.syncStatus.value.pendingMutations).toBe(1);
    expect(cache.load(foundationSchema).pendingAppends).toHaveLength(1);
  });

  it("advances stream cursors when live deltas arrive", () => {
    const socket = TestWebSocket.prepare();
    const client = new FrickClient({
      endpoint: "ws://test",
      schema: foundationSchema,
      WebSocketImpl: TestWebSocket as never,
    });

    client.stream("MessageStream", "conversation-general");
    client.connect();
    socket.emit("open", {});
    socket.emit("message", {
      data: encodeFrame([
        FrameKind.Delta,
        {
          objects: [],
          events: [
            packStreamEvent(foundationSchema, {
              stream: "MessageStream",
              streamId: "conversation-general",
              sequence: 42,
              eventId: "event-live",
              event: "MessageSent",
              payload: {
                messageId: "message-live",
                senderId: "user-grace",
                body: "live",
                createdAt: "2026-05-09T00:00:00.000Z",
              },
            }),
          ],
          cursor: 42,
        },
      ]),
    });

    expect(client.stream("MessageStream", "conversation-general").value).toHaveLength(1);
    expect(client.syncStatus.value.cursors["MessageStream:conversation-general"]).toBe(42);
  });

  it("appends the session token to websocket URLs", () => {
    const socket = TestWebSocket.prepare();
    const client = new FrickClient({
      endpoint: "ws://test/_frick/sync?transport=websocket",
      schema: foundationSchema,
      session: {
        schemaHash: foundationSchema.hash,
        sessionToken: "session-token-123",
        userId: "user-ada",
        deviceId: "device-web",
        replicaId: "replica-web",
        expiresAt: "2026-05-09T13:00:00.000Z",
      },
      WebSocketImpl: TestWebSocket as never,
    });

    client.connect();

    expect(socket.endpoint).toBe(
      "ws://test/_frick/sync?transport=websocket&sessionToken=session-token-123",
    );
    expect(client.syncStatus.value).toEqual(
      expect.objectContaining({
        authenticated: true,
        userId: "user-ada",
        deviceId: "device-web",
      }),
    );
  });
});

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
    this.emit("close", {});
  }

  emit(name: string, event: unknown): void {
    for (const listener of this.#listeners.get(name) ?? []) {
      listener(event);
    }
  }
}
