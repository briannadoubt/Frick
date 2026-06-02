import { describe, expect, it, vi } from "vitest";
import {
  FrameKind,
  decodeFrame,
  defaultClientCapabilities,
  defaultServerCapabilities,
  encodeFrame,
  productTestSchema,
  packStreamEvent,
} from "@fricken/protocol";
import {
  FrickCacheIncompatibleError,
  FrickClient,
  FrickClientLimitError,
  FrickObjectConflictError,
  FrickUserStateClearedError,
  MemoryFrickCache,
  type FrickClientTelemetryRuntime,
  type FrickClientTelemetrySpanResult,
  type FrickClientTelemetrySpanStart,
} from "../src/index.js";

const HELLO_ACK_FRAME_KIND = (FrameKind as typeof FrameKind & { HelloAck?: number }).HelloAck ?? 18;
const tenantAdaSession = {
  schemaHash: productTestSchema.hash,
  sessionToken: "session-token-a",
  tenantId: "tenant-a",
  userId: "user-ada",
  deviceId: "device-a",
  replicaId: "replica-a",
  expiresAt: "2026-05-09T13:00:00.000Z",
};
const tenantAdaScope = { tenantId: "tenant-a", userId: "user-ada" };

describe("foundation runtime", () => {
  it("hydrates objects and stream events from local cache", () => {
    const cache = new MemoryFrickCache();
    cache.saveObject(productTestSchema, "User", "user-ada", { displayName: "Ada Lovelace" }, 1, tenantAdaScope);
    cache.saveStreamEvent(productTestSchema, {
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
    }, tenantAdaScope);

    const client = new FrickClient({
      endpoint: "ws://unused",
      schema: productTestSchema,
      cache,
      session: tenantAdaSession,
    });

    expect(client.object("User", "user-ada")?.displayName).toBe("Ada Lovelace");
    expect(client.stream("MessageStream", "conversation-general").value).toHaveLength(1);
  });

  it("clears cached and pending user state when the session scope changes", async () => {
    const cache = new MemoryFrickCache();
    cache.saveObject(productTestSchema, "User", "user-ada", { displayName: "Ada Lovelace" }, 1, tenantAdaScope);
    cache.saveStreamEvent(productTestSchema, {
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
    }, tenantAdaScope);
    cache.savePendingAppend(productTestSchema, {
      requestId: "pending-1",
      stream: "MessageStream",
      key: "conversation-general",
      event: "MessageSent",
      payload: { body: "queued" },
    }, tenantAdaScope);
    const client = new FrickClient({
      endpoint: "ws://unused",
      schema: productTestSchema,
      cache,
      session: tenantAdaSession,
    });
    const users = client.objects("User");
    const stream = client.stream("MessageStream", "conversation-general");
    const pendingAppend = client
      .append(
        "MessageStream",
        "conversation-general",
        "MessageSent",
        { body: "optimistic" },
        { optimistic: { body: "optimistic" } },
      )
      .then(
        () => undefined,
        (error) => error,
      );
    const pendingUpsert = client
      .upsertObject("User", "user-pending", { displayName: "Pending" }, undefined, { optimistic: true })
      .then(
        () => undefined,
        (error) => error,
      );

    expect(users.value.length).toBeGreaterThan(0);
    expect(stream.value.length).toBeGreaterThan(0);
    expect(client.syncStatus.value.pendingMutations).toBeGreaterThan(0);

    client.setSession({
      schemaHash: productTestSchema.hash,
      sessionToken: "session-token-b",
      tenantId: "tenant-b",
      userId: "user-grace",
      deviceId: "device-b",
      replicaId: "replica-b",
      expiresAt: "2026-05-09T13:00:00.000Z",
    });

    expect(users.value).toEqual([]);
    expect(stream.value).toEqual([]);
    expect(client.object("User", "user-ada")).toBeUndefined();
    expect(client.syncStatus.value.pendingMutations).toBe(0);
    expect(client.syncStatus.value.cursors).toEqual({});
    expect(cache.load(productTestSchema)).toEqual({
      objects: [],
      streamEvents: [],
      cursors: {},
      pendingAppends: [],
    });
    await expect(pendingAppend).resolves.toBeInstanceOf(FrickUserStateClearedError);
    await expect(pendingUpsert).resolves.toBeInstanceOf(FrickUserStateClearedError);
  });

  it("queues appends while disconnected and tracks pending count", async () => {
    const cache = new MemoryFrickCache();
    const client = new FrickClient({ endpoint: "ws://unused", schema: productTestSchema, cache });

    await client.append("MessageStream", "conversation-general", "MessageSent", {
      messageId: "message-1",
      senderId: "user-ada",
      body: "queued",
      createdAt: "2026-05-09T00:00:00.000Z",
    });

    expect(client.syncStatus.value.pendingMutations).toBe(1);
    expect(cache.load(productTestSchema).pendingAppends).toHaveLength(1);
  });

  it("advances stream cursors when live deltas arrive", () => {
    const socket = TestWebSocket.prepare();
    const client = new FrickClient({
      endpoint: "ws://test",
      schema: productTestSchema,
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
            packStreamEvent(productTestSchema, {
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
      schema: productTestSchema,
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

  it("sends the session token in hello without putting it in websocket URLs", () => {
    const socket = TestWebSocket.prepare();
    const client = new FrickClient({
      endpoint: "ws://test/_frick/sync?sessionToken=secret&transport=websocket",
      schema: productTestSchema,
      session: {
        schemaHash: productTestSchema.hash,
        sessionToken: "session-token-123",
        userId: "user-ada",
        deviceId: "device-web",
        replicaId: "replica-web",
        expiresAt: "2026-05-09T13:00:00.000Z",
      },
      WebSocketImpl: TestWebSocket as never,
    });

    client.connect();
    socket.emit("open", {});

    expect(socket.endpoint).toBe("ws://test/_frick/sync?transport=websocket");
    const frame = decodeFrame(socket.sent[0] as Uint8Array);
    expect(frame[0]).toBe(FrameKind.Hello);
    if (frame[0] !== FrameKind.Hello) {
      throw new Error("Expected first frame to be Hello");
    }
    expect(frame[1]).toMatchObject({
      replicaId: "replica-web",
      deviceId: "device-web",
      schemaHash: productTestSchema.hash,
      knownCursors: {},
      sessionToken: "session-token-123",
    });
    expect(client.syncStatus.value).toEqual(
      expect.objectContaining({
        authenticated: true,
        userId: "user-ada",
        deviceId: "device-web",
      }),
    );
  });

  it("uses explicit HTTP endpoint overrides for scrollback reads", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }) as never,
    );
    const client = new FrickClient({
      endpoint: "ws://socket.example.test/_frick/sync",
      httpEndpoint: "https://api.example.test/frick",
      schema: productTestSchema,
    });

    try {
      await client.loadOlder("MessageStream", "conversation-general", 10, 20);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
        "https://api.example.test/frick/streams/MessageStream/conversation-general?before=20&limit=10",
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("sends client capabilities in the hello frame", () => {
    const socket = TestWebSocket.prepare();
    const client = new FrickClient({
      endpoint: "ws://test",
      schema: productTestSchema,
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
        schemaHash: productTestSchema.hash,
        knownCursors: {},
        clientCapabilities: defaultClientCapabilities({
          platform: "web",
          sdkVersion: "0.0.0-runtime",
          schema: productTestSchema,
        }),
      },
    ]);
  });

  it("stores server capabilities and schema compatibility from hello ack frames", () => {
    const socket = TestWebSocket.prepare();
    const client = new FrickClient({
      endpoint: "ws://test",
      schema: productTestSchema,
      WebSocketImpl: TestWebSocket as never,
    });
    const schemaCompatibility = {
      compatible: true,
      reason: "exact",
      clientRevision: productTestSchema.schemaRevision,
      serverRevision: productTestSchema.schemaRevision,
    } as const;
    const serverCapabilities = defaultServerCapabilities(productTestSchema);

    client.connect();
    socket.emit("open", {});
    socket.emit("message", {
      data: encodeFrame([
        HELLO_ACK_FRAME_KIND,
        {
          schemaHash: productTestSchema.hash,
          schemaId: productTestSchema.schemaId,
          schemaRevision: productTestSchema.schemaRevision,
          schemaCompatibility,
          serverCapabilities,
        },
      ] as never),
    });

    expect(client.syncStatus.value.serverCapabilities).toEqual(serverCapabilities);
    expect(client.syncStatus.value.schemaCompatibility).toEqual(schemaCompatibility);
  });

  it("records client WebSocket spans and bounded frame metrics", () => {
    const telemetry = new RecordingClientTelemetryRuntime();
    const socket = TestWebSocket.prepare();
    const client = new FrickClient({
      endpoint: "ws://test/_frick/sync",
      schema: productTestSchema,
      WebSocketImpl: TestWebSocket as never,
      telemetry,
    });

    client.connect();
    socket.emit("open", {});
    socket.emit("message", {
      data: encodeFrame([
        FrameKind.Ping,
        { sentAt: 1 },
      ]),
    });
    socket.emit("message", {
      data: encodeFrame([999_999, {}] as never),
    });
    socket.emit("close", { code: 1000, reason: "secret=session-token" });

    expect(telemetry.spans).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({
          name: "WebSocket /_frick/sync",
          kind: "client",
          attributes: expect.objectContaining({
            "network.protocol.name": "websocket",
            "url.path": "/_frick/sync",
            "frick.schema_id": productTestSchema.schemaId,
          }),
        }),
        result: expect.objectContaining({
          status: "ok",
          attributes: expect.objectContaining({
            "frick.ws.close_code": 1000,
            "frick.ws.close_category": "normal",
          }),
        }),
      }),
    ]);
    expect(JSON.stringify(telemetry.spans)).not.toContain("secret=session-token");
    expect(telemetry.counters).toContainEqual({
      name: "frick.client.ws.frames.sent.total",
      value: 1,
      attributes: { kind: "Hello" },
    });
    expect(telemetry.counters).toContainEqual({
      name: "frick.client.ws.frames.received.total",
      value: 1,
      attributes: { kind: "Ping" },
    });
    expect(telemetry.counters).toContainEqual({
      name: "frick.client.ws.frames.received.total",
      value: 1,
      attributes: { kind: "unknown" },
    });
    expect(telemetry.histograms).toEqual([
      expect.objectContaining({
        name: "frick.client.ws.connection.duration_ms",
        attributes: { closeCategory: "normal" },
      }),
    ]);
  });

  it("closes WebSocket telemetry when manual disconnect clears the socket before close fires", () => {
    const telemetry = new RecordingClientTelemetryRuntime();
    const socket = TestWebSocket.prepare();
    const client = new FrickClient({
      endpoint: "ws://test/_frick/sync",
      schema: productTestSchema,
      WebSocketImpl: TestWebSocket as never,
      telemetry,
    });

    client.connect();
    socket.emit("open", {});
    client.disconnect();
    socket.emit("close", { code: 1000 });

    expect(telemetry.spans[0]?.result).toMatchObject({
      status: "ok",
      attributes: expect.objectContaining({
        "frick.ws.close_code": 1000,
        "frick.ws.close_category": "normal",
      }),
    });
    expect(telemetry.histograms).toEqual([
      expect.objectContaining({
        name: "frick.client.ws.connection.duration_ms",
        attributes: { closeCategory: "normal" },
      }),
    ]);
  });

  it("keeps closing socket telemetry separate from an immediate reconnect", () => {
    const telemetry = new RecordingClientTelemetryRuntime();
    const sockets: TestWebSocket[] = [];
    const Impl: any = function (endpoint?: string) {
      const socket = new TestWebSocket(endpoint);
      sockets.push(socket);
      return socket;
    };
    const client = new FrickClient({
      endpoint: "ws://test/_frick/sync",
      schema: productTestSchema,
      WebSocketImpl: Impl,
      telemetry,
      session: tenantAdaSession,
    });

    client.connect();
    const firstSocket = sockets[0]!;
    firstSocket.emit("open", {});
    client.setSession({
      ...tenantAdaSession,
      sessionToken: "session-token-b",
      userId: "user-grace",
      deviceId: "device-b",
      replicaId: "replica-b",
    });
    const secondSocket = sockets[1]!;
    secondSocket.emit("open", {});
    firstSocket.emit("close", { code: 1000 });
    secondSocket.emit("close", { code: 1001 });

    expect(telemetry.spans.map((record) => record.result?.attributes?.["frick.ws.close_category"])).toEqual([
      "normal",
      "going_away",
    ]);
    expect(telemetry.histograms.map((record) => record.attributes)).toEqual([
      { closeCategory: "normal" },
      { closeCategory: "going_away" },
    ]);
  });

  it("keeps WebSocket connect alive when telemetry throws", () => {
    const socket = TestWebSocket.prepare();
    const client = new FrickClient({
      endpoint: "ws://test/_frick/sync",
      schema: productTestSchema,
      WebSocketImpl: TestWebSocket as never,
      telemetry: new ThrowingClientTelemetryRuntime(),
    });

    client.connect();
    socket.emit("open", {});

    expect(socket.sent.map((bytes) => decodeFrame(bytes as Uint8Array))[0]?.[0]).toBe(FrameKind.Hello);
  });

  it("stores shared error envelopes from nack frames while clearing pending appends", async () => {
    const socket = TestWebSocket.prepare();
    const cache = new MemoryFrickCache();
    const client = new FrickClient({
      endpoint: "ws://test",
      schema: productTestSchema,
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
    expect(cache.load(productTestSchema).pendingAppends).toHaveLength(0);
    expect(client.syncStatus.value.lastError).toEqual(error);
  });

  it("rejects appends past maxPendingAppends and records lastError", async () => {
    const cache = new MemoryFrickCache();
    const client = new FrickClient({
      endpoint: "ws://unused",
      schema: productTestSchema,
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
      schema: productTestSchema,
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
      schema: productTestSchema,
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
      schema: productTestSchema,
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
        schema: productTestSchema,
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

  it("merges optimistic stream events into the signal before server ack", async () => {
    const socket = TestWebSocket.prepare();
    const client = new FrickClient({
      endpoint: "ws://test",
      schema: productTestSchema,
      WebSocketImpl: TestWebSocket as never,
    });

    const stream = client.stream("MessageStream", "conversation-general");
    client.connect();
    socket.emit("open", {});
    // Drain the Hello / Schema handshake noise; we don't need it for the
    // optimistic-overlay assertion since the overlay merges client-side
    // independent of the socket state.

    const ack = client.append(
      "MessageStream",
      "conversation-general",
      "MessageSent",
      { messageId: "m1", senderId: "user-ada", body: "hello", createdAt: "2026-05-09T00:00:00.000Z" },
      { optimistic: { messageId: "m1", senderId: "user-ada", body: "hello", createdAt: "2026-05-09T00:00:00.000Z" } },
    );

    expect(stream.value).toHaveLength(1);
    expect(stream.value[0]!.eventId).toMatch(/^optimistic-/);

    // Simulate server Ack — overlay should drop, leaving the cached real
    // events (still empty here since we didn't deliver a Delta). The test
    // socket records Hello + Append in order; pick the Append by frame kind.
    const sentAppend = socket.sent
      .map((bytes) => decodeFrame(bytes as Uint8Array))
      .find((frame) => frame[0] === FrameKind.Append) as
      | [number, { requestId: string }]
      | undefined;
    expect(sentAppend).toBeDefined();
    const requestId = sentAppend![1].requestId;
    socket.emit("message", {
      data: encodeFrame([FrameKind.Ack, { requestId, cursor: 1, version: 1 }]),
    });

    await ack;
    expect(stream.value).toHaveLength(0);
  });
});

describe("memory cache schema compatibility", () => {
  it("records schema identity metadata after the first save and exposes it on load", () => {
    const cache = new MemoryFrickCache();
    cache.saveObject(productTestSchema, "User", "user-ada", { displayName: "Ada" }, 1);

    const state = cache.load(productTestSchema);

    expect(state.metadata).toEqual({
      schemaId: productTestSchema.schemaId,
      schemaVersion: productTestSchema.schemaVersion,
      schemaRevision: productTestSchema.schemaRevision,
      schemaHash: productTestSchema.hash,
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

    expect(() => cache.load(productTestSchema)).toThrowError(FrickCacheIncompatibleError);
    try {
      cache.load(productTestSchema);
    } catch (error) {
      if (!(error instanceof FrickCacheIncompatibleError)) {
        throw error;
      }
      expect(error.reason).toBe("schemaIdMismatch");
      expect(error.cachedMetadata.schemaId).toBe("legacy-app");
      expect(error.currentMetadata.schemaId).toBe(productTestSchema.schemaId);
    }
  });

  it("throws FrickCacheIncompatibleError when cache revision falls below the minimum", () => {
    const cache = new MemoryFrickCache({
      metadata: {
        schemaId: productTestSchema.schemaId,
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
    const upgradedSchema = { ...productTestSchema, schemaRevision: 5, minimumClientRevision: 5 };

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
        schemaId: productTestSchema.schemaId,
        schemaVersion: productTestSchema.schemaVersion,
        schemaRevision: productTestSchema.schemaRevision,
        schemaHash: "old-but-compatible-hash",
      },
      objects: [
        { type: "User", id: "user-ada", value: { id: "user-ada", displayName: "Ada" }, version: 1 },
      ],
    });

    const state = cache.load(productTestSchema);

    expect(state.metadata?.schemaHash).toBe("old-but-compatible-hash");
    expect(state.objects).toHaveLength(1);
  });

  it("throws FrickCacheIncompatibleError when cached session scope differs", () => {
    const cache = new MemoryFrickCache();
    cache.saveObject(productTestSchema, "User", "user-ada", { displayName: "Ada" }, 1, tenantAdaScope);

    expect(() =>
      cache.load(productTestSchema, { tenantId: "tenant-b", userId: "user-grace" }),
    ).toThrowError(FrickCacheIncompatibleError);
    try {
      cache.load(productTestSchema, { tenantId: "tenant-b", userId: "user-grace" });
    } catch (error) {
      if (!(error instanceof FrickCacheIncompatibleError)) {
        throw error;
      }
      expect(error.reason).toBe("sessionScopeMismatch");
      expect(error.pendingAppendCount).toBe(0);
    }
  });

  it("clears all state including metadata", () => {
    const cache = new MemoryFrickCache();
    cache.saveObject(productTestSchema, "User", "user-ada", { displayName: "Ada" }, 1);
    expect(cache.load(productTestSchema).metadata).toBeDefined();

    cache.clear();

    expect(cache.load(productTestSchema)).toEqual({
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
  }

  emit(name: string, event: unknown): void {
    for (const listener of this.#listeners.get(name) ?? []) {
      listener(event);
    }
  }
}

class RecordingClientTelemetryRuntime implements FrickClientTelemetryRuntime {
  readonly spans: Array<{
    input: FrickClientTelemetrySpanStart;
    result?: FrickClientTelemetrySpanResult;
  }> = [];
  readonly counters: Array<{
    name: string;
    value: number;
    attributes?: Record<string, string | number | boolean>;
  }> = [];
  readonly histograms: Array<{
    name: string;
    value: number;
    attributes?: Record<string, string | number | boolean>;
  }> = [];

  startSpan(input: FrickClientTelemetrySpanStart) {
    const record: {
      input: FrickClientTelemetrySpanStart;
      result?: FrickClientTelemetrySpanResult;
    } = { input };
    this.spans.push(record);
    return {
      end: (result?: FrickClientTelemetrySpanResult) => {
        record.result = result;
      },
    };
  }

  recordCounter(
    name: string,
    value: number,
    attributes?: Record<string, string | number | boolean>,
  ): void {
    this.counters.push({ name, value, attributes });
  }

  recordHistogram(
    name: string,
    value: number,
    attributes?: Record<string, string | number | boolean>,
  ): void {
    this.histograms.push({ name, value, attributes });
  }
}

class ThrowingClientTelemetryRuntime implements FrickClientTelemetryRuntime {
  startSpan(): never {
    throw new Error("telemetry failed");
  }

  recordCounter(): never {
    throw new Error("telemetry failed");
  }
}
