import { describe, expect, it } from "vitest";
import {
  FrameKind,
  decodeFrame,
  defaultClientCapabilities,
  defaultServerCapabilities,
  encodeFrame,
  foundationSchema,
  packStreamEvent,
} from "@frick/protocol";
import {
  FrickCacheIncompatibleError,
  FrickClient,
  FrickClientLimitError,
  FrickObjectConflictError,
  MemoryFrickCache,
} from "../src/index.js";

const HELLO_ACK_FRAME_KIND = (FrameKind as typeof FrameKind & { HelloAck?: number }).HelloAck ?? 18;

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

  it("merges projection deltas into the projection signal", () => {
    const socket = TestWebSocket.prepare();
    const client = new FrickClient({
      endpoint: "ws://test",
      schema: foundationSchema,
      WebSocketImpl: TestWebSocket as never,
    });

    const inbox = client.projection<{ unreadCount: number }>("conversation-inbox");
    client.connect();
    socket.emit("open", {});

    socket.emit("message", {
      data: encodeFrame([
        FrameKind.ProjectionDelta,
        {
          projection: "conversation-inbox",
          changes: [
            { key: "user-ada:conversation-general", value: { unreadCount: 2 } },
            { key: "user-grace:conversation-general", value: { unreadCount: 0 } },
          ],
        },
      ]),
    });

    expect(inbox.value.size).toBe(2);
    expect(inbox.value.get("user-ada:conversation-general")?.unreadCount).toBe(2);
    expect(inbox.value.get("user-grace:conversation-general")?.unreadCount).toBe(0);

    socket.emit("message", {
      data: encodeFrame([
        FrameKind.ProjectionDelta,
        {
          projection: "conversation-inbox",
          changes: [{ key: "user-grace:conversation-general", value: null }],
        },
      ]),
    });

    expect(inbox.value.size).toBe(1);
    expect(inbox.value.has("user-grace:conversation-general")).toBe(false);
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

  it("sends client capabilities in the hello frame", () => {
    const socket = TestWebSocket.prepare();
    const client = new FrickClient({
      endpoint: "ws://test",
      schema: foundationSchema,
      replicaId: "replica-web",
      deviceId: "device-web",
      WebSocketImpl: TestWebSocket as never,
    });

    client.connect();
    socket.emit("open", {});

    expect(decodeFrame(socket.sent[0] as Uint8Array)).toEqual([
      FrameKind.Hello,
      {
        replicaId: "replica-web",
        deviceId: "device-web",
        schemaHash: foundationSchema.hash,
        knownCursors: {},
        clientCapabilities: defaultClientCapabilities({
          platform: "web",
          sdkVersion: "0.0.0-runtime",
          schema: foundationSchema,
        }),
      },
    ]);
  });

  it("stores server capabilities and schema compatibility from hello ack frames", () => {
    const socket = TestWebSocket.prepare();
    const client = new FrickClient({
      endpoint: "ws://test",
      schema: foundationSchema,
      WebSocketImpl: TestWebSocket as never,
    });
    const schemaCompatibility = {
      compatible: true,
      reason: "exact",
      clientRevision: foundationSchema.schemaRevision,
      serverRevision: foundationSchema.schemaRevision,
    } as const;
    const serverCapabilities = defaultServerCapabilities(foundationSchema);

    client.connect();
    socket.emit("open", {});
    socket.emit("message", {
      data: encodeFrame([
        HELLO_ACK_FRAME_KIND,
        {
          schemaHash: foundationSchema.hash,
          schemaId: foundationSchema.schemaId,
          schemaRevision: foundationSchema.schemaRevision,
          schemaCompatibility,
          serverCapabilities,
        },
      ] as never),
    });

    expect(client.syncStatus.value.serverCapabilities).toEqual(serverCapabilities);
    expect(client.syncStatus.value.schemaCompatibility).toEqual(schemaCompatibility);
  });

  it("stores shared error envelopes from nack frames while clearing pending appends", async () => {
    const socket = TestWebSocket.prepare();
    const cache = new MemoryFrickCache();
    const client = new FrickClient({
      endpoint: "ws://test",
      schema: foundationSchema,
      cache,
      WebSocketImpl: TestWebSocket as never,
    });
    await client.append("MessageStream", "conversation-general", "MessageSent", {
      messageId: "message-1",
      senderId: "user-ada",
      body: "queued",
      createdAt: "2026-05-09T00:00:00.000Z",
    });

    client.connect();
    socket.emit("open", {});
    const appendFrame = decodeFrame(socket.sent[1] as Uint8Array);
    if (appendFrame[0] !== FrameKind.Append) {
      throw new Error("Expected pending append to flush after hello");
    }
    const error = {
      code: "stream.appendRejected",
      message: "Append rejected",
      requestId: appendFrame[1].requestId,
      retryable: false,
    } as const;

    socket.emit("message", {
      data: encodeFrame([
        FrameKind.Nack,
        {
          requestId: appendFrame[1].requestId,
          error,
        },
      ]),
    });

    expect(client.syncStatus.value.pendingMutations).toBe(0);
    expect(cache.load(foundationSchema).pendingAppends).toHaveLength(0);
    expect(client.syncStatus.value.lastError).toEqual(error);
  });

  it("rejects appends past maxPendingAppends and records lastError", async () => {
    const cache = new MemoryFrickCache();
    const client = new FrickClient({
      endpoint: "ws://unused",
      schema: foundationSchema,
      cache,
      maxPendingAppends: 2,
    });

    await client.append("MessageStream", "conversation-general", "MessageSent", {
      messageId: "message-1",
      senderId: "user-ada",
      body: "1",
      createdAt: "2026-05-09T00:00:00.000Z",
    });
    await client.append("MessageStream", "conversation-general", "MessageSent", {
      messageId: "message-2",
      senderId: "user-ada",
      body: "2",
      createdAt: "2026-05-09T00:00:00.000Z",
    });

    await expect(
      client.append("MessageStream", "conversation-general", "MessageSent", {
        messageId: "message-3",
        senderId: "user-ada",
        body: "3",
        createdAt: "2026-05-09T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(FrickClientLimitError);

    expect(client.syncStatus.value.pendingMutations).toBe(2);
    expect(client.syncStatus.value.lastError).toMatchObject({
      code: "rateLimit.exceeded",
      details: expect.objectContaining({ limit: "maxPendingAppends", configuredMax: 2 }),
    });
  });

  it("resolves upsertObject with the server-reported version when an ack arrives", async () => {
    const socket = TestWebSocket.prepare();
    const client = new FrickClient({
      endpoint: "ws://test",
      schema: foundationSchema,
      WebSocketImpl: TestWebSocket as never,
    });

    client.connect();
    socket.emit("open", {});
    const pending = client.upsertObject("User", "user-ada", { displayName: "Ada" });

    const upsertFrame = decodeFrame(socket.sent[1] as Uint8Array);
    if (upsertFrame[0] !== FrameKind.ObjectUpsert) {
      throw new Error("Expected upsert frame to flush after hello");
    }
    expect(upsertFrame[1]).toMatchObject({
      objectType: "User",
      objectId: "user-ada",
      value: { displayName: "Ada" },
    });

    socket.emit("message", {
      data: encodeFrame([
        FrameKind.Ack,
        { requestId: upsertFrame[1].requestId, version: 1 },
      ]),
    });

    await expect(pending).resolves.toEqual({ version: 1 });
    expect(client.syncStatus.value.pendingMutations).toBe(0);
  });

  it("rejects upsertObject with FrickObjectConflictError on a storage.conflict nack", async () => {
    const socket = TestWebSocket.prepare();
    const client = new FrickClient({
      endpoint: "ws://test",
      schema: foundationSchema,
      WebSocketImpl: TestWebSocket as never,
    });

    client.connect();
    socket.emit("open", {});
    const pending = client.upsertObject("User", "user-ada", { displayName: "Ada" }, 1);

    const upsertFrame = decodeFrame(socket.sent[1] as Uint8Array);
    if (upsertFrame[0] !== FrameKind.ObjectUpsert) {
      throw new Error("Expected upsert frame to flush after hello");
    }

    socket.emit("message", {
      data: encodeFrame([
        FrameKind.Nack,
        {
          requestId: upsertFrame[1].requestId,
          error: {
            code: "storage.conflict",
            message: "Version conflict",
            requestId: upsertFrame[1].requestId,
            retryable: false,
            details: {
              expectedVersion: 1,
              actualVersion: 2,
              mergePolicy: "versionPrecondition",
            },
          },
        },
      ]),
    });

    await expect(pending).rejects.toBeInstanceOf(FrickObjectConflictError);
    try {
      await pending;
    } catch (error) {
      if (!(error instanceof FrickObjectConflictError)) {
        throw error;
      }
      expect(error.expectedVersion).toBe(1);
      expect(error.actualVersion).toBe(2);
      expect(error.mergePolicy).toBe("versionPrecondition");
    }
  });

  it("queues upsertObject while disconnected and flushes after reconnect", async () => {
    const socket = TestWebSocket.prepare();
    const client = new FrickClient({
      endpoint: "ws://test",
      schema: foundationSchema,
      WebSocketImpl: TestWebSocket as never,
    });

    const pending = client.upsertObject("User", "user-ada", { displayName: "Ada" });
    expect(client.syncStatus.value.pendingMutations).toBe(1);

    client.connect();
    socket.emit("open", {});

    const upsertFrame = decodeFrame(socket.sent[1] as Uint8Array);
    if (upsertFrame[0] !== FrameKind.ObjectUpsert) {
      throw new Error("Expected upsert frame to flush after hello");
    }
    socket.emit("message", {
      data: encodeFrame([
        FrameKind.Ack,
        { requestId: upsertFrame[1].requestId, version: 1 },
      ]),
    });

    await expect(pending).resolves.toEqual({ version: 1 });
  });

  it("uses monotonic reconnect backoff between attempts", () => {
    const sockets: TestWebSocket[] = [];
    const Impl: any = function (endpoint?: string) {
      const ws = new TestWebSocket(endpoint);
      sockets.push(ws);
      return ws;
    };

    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (handler: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return realSetTimeout(() => {}, 0); // capture only; do not invoke
    };

    try {
      const client = new FrickClient({
        endpoint: "ws://test",
        schema: foundationSchema,
        reconnectDelayMs: 100,
        maxReconnectDelayMs: 5_000,
        WebSocketImpl: Impl,
      });
      client.connect();
      sockets[0]!.emit("close", {});
      sockets[0]!.emit("close", {}); // duplicate ignored — only first triggers schedule
      // simulate further failed attempts by toggling state manually
      client.connect();
      sockets[1]?.emit("close", {});
      client.connect();
      sockets[2]?.emit("close", {});
    } finally {
      (globalThis as any).setTimeout = realSetTimeout;
    }

    // first three close-triggered backoffs should be monotonically nondecreasing
    expect(delays.length).toBeGreaterThanOrEqual(3);
    expect(delays[1]).toBeGreaterThanOrEqual(delays[0]!);
    expect(delays[2]).toBeGreaterThanOrEqual(delays[1]!);
    expect(Math.max(...delays)).toBeLessThanOrEqual(5_000);
  });
});

describe("memory cache schema compatibility", () => {
  it("records schema identity metadata after the first save and exposes it on load", () => {
    const cache = new MemoryFrickCache();
    cache.saveObject(foundationSchema, "User", "user-ada", { displayName: "Ada" }, 1);

    const state = cache.load(foundationSchema);

    expect(state.metadata).toEqual({
      schemaId: foundationSchema.schemaId,
      schemaVersion: foundationSchema.schemaVersion,
      schemaRevision: foundationSchema.schemaRevision,
      schemaHash: foundationSchema.hash,
    });
  });

  it("throws FrickCacheIncompatibleError when cached schema id differs", () => {
    const cache = new MemoryFrickCache({
      metadata: {
        schemaId: "legacy-app",
        schemaVersion: "0.1.0",
        schemaRevision: 1,
        schemaHash: "legacy-hash",
      },
    });

    expect(() => cache.load(foundationSchema)).toThrowError(FrickCacheIncompatibleError);
    try {
      cache.load(foundationSchema);
    } catch (error) {
      if (!(error instanceof FrickCacheIncompatibleError)) {
        throw error;
      }
      expect(error.reason).toBe("schemaIdMismatch");
      expect(error.cachedMetadata.schemaId).toBe("legacy-app");
      expect(error.currentMetadata.schemaId).toBe(foundationSchema.schemaId);
    }
  });

  it("throws FrickCacheIncompatibleError when cache revision falls below the minimum", () => {
    const cache = new MemoryFrickCache({
      metadata: {
        schemaId: foundationSchema.schemaId,
        schemaVersion: "0.0.9",
        schemaRevision: 1,
        schemaHash: "obsolete-hash",
      },
      pendingAppends: [
        {
          requestId: "request-1",
          stream: "MessageStream",
          key: "conversation-general",
          event: "MessageSent",
          payload: {},
        },
      ],
    });
    const upgradedSchema = { ...foundationSchema, schemaRevision: 5, minimumClientRevision: 5 };

    try {
      cache.load(upgradedSchema);
      throw new Error("expected throw");
    } catch (error) {
      if (!(error instanceof FrickCacheIncompatibleError)) {
        throw error;
      }
      expect(error.reason).toBe("cacheTooOld");
      expect(error.minimumClientRevision).toBe(5);
      expect(error.pendingAppendCount).toBe(1);
    }
  });

  it("allows load when cached hash differs but revision is still compatible", () => {
    const cache = new MemoryFrickCache({
      metadata: {
        schemaId: foundationSchema.schemaId,
        schemaVersion: foundationSchema.schemaVersion,
        schemaRevision: foundationSchema.schemaRevision,
        schemaHash: "old-but-compatible-hash",
      },
      objects: [
        { type: "User", id: "user-ada", value: { id: "user-ada", displayName: "Ada" }, version: 1 },
      ],
    });

    const state = cache.load(foundationSchema);

    expect(state.metadata?.schemaHash).toBe("old-but-compatible-hash");
    expect(state.objects).toHaveLength(1);
  });

  it("clears all state including metadata", () => {
    const cache = new MemoryFrickCache();
    cache.saveObject(foundationSchema, "User", "user-ada", { displayName: "Ada" }, 1);
    expect(cache.load(foundationSchema).metadata).toBeDefined();

    cache.clear();

    expect(cache.load(foundationSchema)).toEqual({
      objects: [],
      streamEvents: [],
      cursors: {},
      pendingAppends: [],
    });
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
