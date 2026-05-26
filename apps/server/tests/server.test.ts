import { WebSocket } from "ws";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FrameKind,
  decodeFrame,
  defaultClientCapabilities,
  defaultServerCapabilities,
  encodeFrame,
  productTestSchema,
  unpackSignalEnvelope,
  type FrickFrame,
  type HelloAckPayload,
} from "@frick/protocol";
import { createFrickServer, defaultDatabasePath } from "../src/server.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("foundation sync gateway", () => {
  it("resolves the default database path from the server package", () => {
    const dbPath = defaultDatabasePath();

    expect(path.isAbsolute(dbPath)).toBe(true);
    expect(dbPath.endsWith(path.join("apps", "server", "data", "frick.sqlite"))).toBe(true);
    expect(dbPath).not.toContain(path.join("apps", "server", "apps", "server"));
  });

  it("returns 401 for missing auth on objects", async () => {
    app = await startServer();

    const response = await fetch(`${app.httpUrl}/objects`);

    expect(response.status).toBe(401);
  });

  it("creates a dev session for Ada and accepts authenticated object reads", async () => {
    app = await startServer();

    const login = await devLogin(app.httpUrl, {
      userId: "user-ada",
      deviceId: "device-ada-web",
      replicaId: "replica-ada-web",
      platform: "web",
    });

    expect(login.sessionToken).toEqual(expect.any(String));
    expect(login.sessionToken.length).toBeGreaterThan(30);
    expect(login).toMatchObject({
      schemaHash: productTestSchema.hash,
      userId: "user-ada",
      deviceId: "device-ada-web",
      replicaId: "replica-ada-web",
    });
    expect(Date.parse(login.expiresAt)).not.toBeNaN();

    // Route requires ?type — pick any registered type from the test schema.
    const response = await fetch(`${app.httpUrl}/objects?type=User`, {
      headers: authHeaders(login.sessionToken),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).schemaHash).toBe(productTestSchema.hash);
  });

  it("logs in an existing chat account and rejects wrong passwords", async () => {
    app = await startServer();
    await signUp(app.httpUrl, {
      displayName: "Katherine Johnson",
      handle: "katherine",
      password: "launch window math",
    });

    const rejected = await fetch(`${app.httpUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identity: "katherine",
        password: "wrong password",
        platform: "web",
      }),
    });
    expect(rejected.status).toBe(401);

    const login = await loginAccount(app.httpUrl, {
      identity: "katherine",
      password: "launch window math",
      deviceId: "device-katherine-web",
      replicaId: "replica-katherine-web",
      platform: "web",
    });

    expect(login).toMatchObject({
      schemaHash: productTestSchema.hash,
      userId: "user-katherine",
      displayName: "Katherine Johnson",
      handle: "katherine",
      deviceId: "device-katherine-web",
      replicaId: "replica-katherine-web",
    });
  });

  it("authenticates WebSocket appends from sessionToken without replicaId naming", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, {
      userId: "user-ada",
      deviceId: "device-ada-session",
      replicaId: "replica-ada-session",
    });
    const socket = await connectWithSession(app.url, login.sessionToken);

    const hello = expectHelloAckThenSchema(socket);
    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: "replica-mallory-should-not-matter",
          deviceId: "device-mallory-should-not-matter",
          schemaHash: productTestSchema.hash,
          knownCursors: {},
        },
      ]),
    );
    await hello;

    socket.send(
      encodeFrame([
        FrameKind.Append,
        {
          requestId: "request-ws-session-ada",
          stream: "MessageStream",
          key: "conversation-general",
          event: "MessageSent",
          payload: {
            messageId: "message-ws-session-ada",
            senderId: "user-ada",
            body: "hello from a session",
            createdAt: "2026-05-09T00:00:00.000Z",
          },
        },
      ]),
    );

    const frame = await nextFrame(socket);
    expect(frame[0]).toBe(FrameKind.Ack);
    socket.close();
  });

  it("rejects blob uploads whose ownerId does not match the session user", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const response = await fetch(`${app.httpUrl}/blobs/blob-owner-spoof/content?ownerId=user-grace`, {
      method: "PUT",
      headers: { "content-type": "text/plain", ...authHeaders(login.sessionToken) },
      body: Buffer.from("not ada's blob"),
    });

    expect(response.status).toBe(403);
  });

  it("hard rejects schema hash mismatch for legacy hello without capabilities", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connectWithSession(app.url, login.sessionToken);

    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: "replica-1",
          deviceId: "device-1",
          schemaHash: "wrong",
          knownCursors: {},
        },
      ]),
    );

    const frame = await nextFrame(socket);
    expect(frame[0]).toBe(FrameKind.Nack);
    expect(frame[1].error).toMatchObject({
      code: "schema.incompatible",
      message: expect.stringMatching(/schema mismatch/i),
      requestId: "hello",
      retryable: false,
      schemaHash: productTestSchema.hash,
      schemaRevision: productTestSchema.schemaRevision,
    });
    expect(frame[1]).toMatchObject({
      code: "schema.incompatible",
      message: expect.stringMatching(/schema mismatch/i),
    });
    socket.close();
  });

  it("accepts compatible client capabilities with a different schema hash", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connectWithSession(app.url, login.sessionToken);

    const hello = expectHelloAckThenSchema(socket);
    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: "replica-compatible",
          deviceId: "device-compatible",
          schemaHash: "legacy-top-level-hash-is-ignored-when-capabilities-exist",
          knownCursors: {},
          clientCapabilities: {
            ...defaultClientCapabilities({
              platform: "web",
              sdkVersion: "0.0.0-test",
              schema: productTestSchema,
            }),
            schema: {
              schemaId: productTestSchema.schemaId,
              schemaRevision: productTestSchema.schemaRevision,
              schemaHash: "compatible-but-different",
            },
          },
        },
      ]),
    );

    const ack = await hello;
    expect(ack.schemaCompatibility).toMatchObject({
      compatible: true,
      reason: "revisionCompatibleHashMismatch",
      clientRevision: productTestSchema.schemaRevision,
      serverRevision: productTestSchema.schemaRevision,
    });
    socket.close();
  });

  it("rejects hello with unsupported required capabilities", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connectWithSession(app.url, login.sessionToken);

    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: "replica-unsupported",
          deviceId: "device-unsupported",
          schemaHash: productTestSchema.hash,
          knownCursors: {},
          clientCapabilities: {
            ...defaultClientCapabilities({
              platform: "web",
              sdkVersion: "0.0.0-test",
              schema: productTestSchema,
            }),
            required: ["transport.websocket", "primitive.telepathy", "push.apns"],
          },
        },
      ]),
    );

    const frame = await nextFrame(socket);
    expect(frame[0]).toBe(FrameKind.Nack);
    expect(frame[1].error).toMatchObject({
      code: "sync.protocolError",
      requestId: "hello",
      retryable: false,
      details: { unsupportedCapabilities: ["primitive.telepathy", "push.apns"] },
      schemaHash: productTestSchema.hash,
      schemaRevision: productTestSchema.schemaRevision,
    });
    socket.close();
  });

  it("subscribes to message stream and receives appended events", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connectWithSession(app.url, login.sessionToken);

    const hello = expectHelloAckThenSchema(socket);
    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: "replica-1",
          deviceId: "device-1",
          schemaHash: productTestSchema.hash,
          knownCursors: {},
        },
      ]),
    );
    await hello;

    socket.send(
      encodeFrame([
        FrameKind.Subscribe,
        {
          subscriptionId: "sub-messages",
          kind: "stream",
          name: "MessageStream",
          key: "conversation-general",
          cursor: 0,
        },
      ]),
    );

    const page = await nextFrame(socket);
    expect(page[0]).toBe(FrameKind.StreamPage);

    const appendFrames = collectFrames(socket, 2);
    socket.send(
      encodeFrame([
        FrameKind.Append,
        {
          requestId: "request-1",
          stream: "MessageStream",
          key: "conversation-general",
          event: "MessageSent",
          payload: {
            messageId: "message-1",
            senderId: "user-ada",
            body: "hello",
            createdAt: "2026-05-09T00:00:00.000Z",
          },
        },
      ]),
    );

    const frames = await appendFrames;
    expect(frames.map((frame) => frame[0])).toEqual([FrameKind.Ack, FrameKind.Delta]);
    socket.close();
  });

  it("bounds WebSocket stream subscription pages", async () => {
    app = await startServer({ limits: { maxStreamPageSize: 2 } });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    await postAppend(app.httpUrl, login.sessionToken, "request-ws-page-1", "ws one");
    await postAppend(app.httpUrl, login.sessionToken, "request-ws-page-2", "ws two");
    await postAppend(app.httpUrl, login.sessionToken, "request-ws-page-3", "ws three");
    const socket = await connectWithSession(app.url, login.sessionToken);

    const hello = expectHelloAckThenSchema(socket);
    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: "replica-1",
          deviceId: "device-1",
          schemaHash: productTestSchema.hash,
          knownCursors: {},
        },
      ]),
    );
    await hello;

    socket.send(
      encodeFrame([
        FrameKind.Subscribe,
        {
          subscriptionId: "sub-messages-page",
          kind: "stream",
          name: "MessageStream",
          key: "conversation-general",
          cursor: 0,
        },
      ]),
    );

    const page = await nextFrame(socket);
    expect(page[0]).toBe(FrameKind.StreamPage);
    expect(page[1]).toMatchObject({
      subscriptionId: "sub-messages-page",
      cursor: 2,
      hasMore: true,
    });
    const payload = page[1] as { events: Array<[number, string, number, ...unknown[]]> };
    expect(payload.events.map((event) => event[2])).toEqual([1, 2]);
    socket.close();
  });

  it("fans out HTTP appends to WebSocket stream subscribers", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connectWithSession(app.url, login.sessionToken);

    const hello = expectHelloAckThenSchema(socket);
    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: "replica-1",
          deviceId: "device-1",
          schemaHash: productTestSchema.hash,
          knownCursors: {},
        },
      ]),
    );
    await hello;

    socket.send(
      encodeFrame([
        FrameKind.Subscribe,
        {
          subscriptionId: "sub-messages",
          kind: "stream",
          name: "MessageStream",
          key: "conversation-general",
          cursor: 0,
        },
      ]),
    );
    await nextFrame(socket);

    const deltaFrame = nextFrame(socket);
    await postAppend(app.httpUrl, login.sessionToken, "request-http-ws", "hello from http");

    const frame = await withTimeout(deltaFrame, "expected websocket delta from HTTP append");
    expect(frame[0]).toBe(FrameKind.Delta);
    socket.close();
  });

  it("does not fan out idempotent HTTP append retries", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connectWithSession(app.url, login.sessionToken);

    const hello = expectHelloAckThenSchema(socket);
    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: "replica-1",
          deviceId: "device-1",
          schemaHash: productTestSchema.hash,
          knownCursors: {},
        },
      ]),
    );
    await hello;
    socket.send(
      encodeFrame([
        FrameKind.Subscribe,
        {
          subscriptionId: "sub-messages",
          kind: "stream",
          name: "MessageStream",
          key: "conversation-general",
          cursor: 0,
        },
      ]),
    );
    await nextFrame(socket);

    const firstDelta = nextFrame(socket);
    await postAppend(app.httpUrl, login.sessionToken, "request-http-retry", "first delivery");
    expect((await withTimeout(firstDelta, "expected first HTTP append delta"))[0]).toBe(FrameKind.Delta);

    const retryDelta = nextFrame(socket);
    await postAppend(app.httpUrl, login.sessionToken, "request-http-retry", "first delivery");
    await expect(withTimeout(retryDelta, "unexpected retry delta")).rejects.toThrow("unexpected retry delta");
    socket.close();
  });

  it("streams HTTP appends over SSE", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const abort = new AbortController();
    const response = await fetch(`${app.httpUrl}/streams/MessageStream/conversation-general/events?after=0`, {
      headers: authHeaders(login.sessionToken),
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.body).toBeTruthy();

    const reader = response.body!.getReader();
    const page = await readSseEvent(reader);
    expect(page.event).toBe("stream-page");
    expect(JSON.parse(page.data)).toMatchObject({
      schemaHash: productTestSchema.hash,
      stream: "MessageStream",
      key: "conversation-general",
      data: [],
    });

    const deltaEvent = readSseEvent(reader);
    await postAppend(app.httpUrl, login.sessionToken, "request-http-sse", "hello over sse");

    const delta = await withTimeout(deltaEvent, "expected SSE delta from HTTP append");
    expect(delta.event).toBe("delta");
    expect(JSON.parse(delta.data).data[0].payload.body).toBe("hello over sse");
    abort.abort();
  });

  it("bounds the initial SSE stream page", async () => {
    app = await startServer({ limits: { maxStreamPageSize: 2 } });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    await postAppend(app.httpUrl, login.sessionToken, "request-sse-page-1", "sse one");
    await postAppend(app.httpUrl, login.sessionToken, "request-sse-page-2", "sse two");
    await postAppend(app.httpUrl, login.sessionToken, "request-sse-page-3", "sse three");

    const abort = new AbortController();
    const response = await fetch(`${app.httpUrl}/streams/MessageStream/conversation-general/events?after=0`, {
      headers: authHeaders(login.sessionToken),
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();

    const reader = response.body!.getReader();
    const page = await readSseEvent(reader);
    expect(page.event).toBe("stream-page");
    const payload = JSON.parse(page.data);
    expect(payload.data.map((event: { sequence: number }) => event.sequence)).toEqual([1, 2]);
    expect(payload.cursor).toBe(2);
    expect(payload.hasMore).toBe(true);
    abort.abort();
  });

  it("rejects SSE connections above maxSseConnections", async () => {
    app = await startServer({ limits: { maxSseConnections: 1 } });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const abort = new AbortController();
    const first = await fetch(`${app.httpUrl}/streams/MessageStream/conversation-general/events?after=0`, {
      headers: authHeaders(login.sessionToken),
      signal: abort.signal,
    });
    expect(first.status).toBe(200);
    expect(first.body).toBeTruthy();
    const reader = first.body!.getReader();
    expect((await readSseEvent(reader)).event).toBe("stream-page");

    const second = await fetch(`${app.httpUrl}/streams/MessageStream/conversation-general/events?after=0`, {
      headers: authHeaders(login.sessionToken),
    });
    expect(second.status).toBe(429);
    const body = await second.json();
    expect(body.error).toMatchObject({
      code: "rateLimit.exceeded",
      details: {
        limit: "maxSseConnections",
        configuredMax: 1,
        actualValue: 2,
      },
    });
    abort.abort();
  });

  // Cross-tenant SSE isolation is covered by tests/tenant-isolation.test.ts
  // against generic streams. The chat-coupled version that lived here
  // depended on per-conversation RoomMember authz which was removed with
  // the framework boundary cleanup.

  it("streams WebSocket appends over SSE", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const abort = new AbortController();
    const response = await fetch(`${app.httpUrl}/streams/MessageStream/conversation-general/events?after=0`, {
      headers: authHeaders(login.sessionToken),
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();

    const reader = response.body!.getReader();
    expect((await readSseEvent(reader)).event).toBe("stream-page");

    const socket = await connectWithSession(app.url, login.sessionToken);
    const hello = expectHelloAckThenSchema(socket);
    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: "replica-web",
          deviceId: "device-web",
          schemaHash: productTestSchema.hash,
          knownCursors: {},
        },
      ]),
    );
    await hello;

    const deltaEvent = readSseEvent(reader);
    socket.send(
      encodeFrame([
        FrameKind.Append,
        {
          requestId: "request-ws-sse",
          stream: "MessageStream",
          key: "conversation-general",
          event: "MessageSent",
          payload: {
            messageId: "message-request-ws-sse",
            senderId: "user-ada",
            body: "hello from websocket",
            createdAt: "2026-05-09T00:00:00.000Z",
          },
        },
      ]),
    );
    await nextFrame(socket);

    const delta = await withTimeout(deltaEvent, "expected SSE delta from WebSocket append");
    expect(delta.event).toBe("delta");
    expect(JSON.parse(delta.data).data[0].payload.body).toBe("hello from websocket");
    socket.close();
    abort.abort();
  });

  it("keeps quiet SSE connections alive with comments", async () => {
    app = await startServer({ sseHeartbeatMs: 10 });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const abort = new AbortController();
    const response = await fetch(`${app.httpUrl}/streams/MessageStream/conversation-general/events?after=999999`, {
      headers: authHeaders(login.sessionToken),
      signal: abort.signal,
    });
    expect(response.body).toBeTruthy();

    const reader = response.body!.getReader();
    expect((await readSseEvent(reader)).event).toBe("stream-page");

    const keepAlive = await withTimeout(readRawSseBlock(reader), "expected SSE keep-alive");
    expect(keepAlive).toContain(": keep-alive");
    abort.abort();
  });

  it("bounds forward HTTP stream pages and reports cursor state", async () => {
    app = await startServer({ limits: { maxStreamPageSize: 2 } });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    await postAppend(app.httpUrl, login.sessionToken, "request-http-page-1", "page one");
    await postAppend(app.httpUrl, login.sessionToken, "request-http-page-2", "page two");
    await postAppend(app.httpUrl, login.sessionToken, "request-http-page-3", "page three");

    const firstResponse = await fetch(`${app.httpUrl}/streams/MessageStream/conversation-general?after=0`, {
      headers: authHeaders(login.sessionToken),
    });
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first.data.map((event: { sequence: number }) => event.sequence)).toEqual([1, 2]);
    expect(first.cursor).toBe(2);
    expect(first.hasMore).toBe(true);

    const secondResponse = await fetch(`${app.httpUrl}/streams/MessageStream/conversation-general?after=2`, {
      headers: authHeaders(login.sessionToken),
    });
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json();
    expect(second.data.map((event: { sequence: number }) => event.sequence)).toEqual([3]);
    expect(second.cursor).toBe(3);
    expect(second.hasMore).toBe(false);
  });

  it("creates, lists, and reads blob metadata over HTTP", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const createResponse = await fetch(`${app.httpUrl}/blobs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(login.sessionToken) },
      body: JSON.stringify({
        blobId: "blob-http-1",
        contentHash: "sha256-http-1",
        byteLength: 42,
        mimeType: "text/plain",
        ownerId: "user-ada",
      }),
    });
    expect(createResponse.status).toBe(201);

    const readResponse = await fetch(`${app.httpUrl}/blobs/blob-http-1`, {
      headers: authHeaders(login.sessionToken),
    });
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toMatchObject({
      blobId: "blob-http-1",
      contentHash: "sha256-http-1",
      byteLength: 42,
      mimeType: "text/plain",
      ownerId: "user-ada",
    });

    const listResponse = await fetch(`${app.httpUrl}/blobs?ownerId=user-ada`, {
      headers: authHeaders(login.sessionToken),
    });
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    expect(listBody.data).toEqual([
      expect.objectContaining({
        blobId: "blob-http-1",
        ownerId: "user-ada",
      }),
    ]);
  });

  it("stores raw blob bytes and creates metadata when missing", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const bytes = Buffer.from("hello attachment bytes");
    const expectedHash = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;

    const putResponse = await fetch(`${app.httpUrl}/blobs/blob-content-1/content?ownerId=user-ada`, {
      method: "PUT",
      headers: { "content-type": "text/plain", ...authHeaders(login.sessionToken) },
      body: bytes,
    });
    expect(putResponse.status).toBe(201);
    expect(await putResponse.json()).toMatchObject({
      ok: true,
      blobId: "blob-content-1",
      byteLength: bytes.byteLength,
      contentHash: expectedHash,
    });

    const metadataResponse = await fetch(`${app.httpUrl}/blobs/blob-content-1`, {
      headers: authHeaders(login.sessionToken),
    });
    expect(metadataResponse.status).toBe(200);
    expect(await metadataResponse.json()).toMatchObject({
      blobId: "blob-content-1",
      ownerId: "user-ada",
      byteLength: bytes.byteLength,
      contentHash: expectedHash,
      mimeType: "text/plain",
    });

    const contentResponse = await fetch(`${app.httpUrl}/blobs/blob-content-1/content`, {
      headers: authHeaders(login.sessionToken),
    });
    expect(contentResponse.status).toBe(200);
    expect(contentResponse.headers.get("content-type")).toContain("text/plain");
    expect(contentResponse.headers.get("x-frick-blob-id")).toBe("blob-content-1");
    expect(contentResponse.headers.get("x-frick-content-hash")).toBe(expectedHash);
    expect(Buffer.from(await contentResponse.arrayBuffer())).toEqual(bytes);
  });

  it("requires an owner before creating blob metadata from raw bytes", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const response = await fetch(`${app.httpUrl}/blobs/blob-content-no-owner/content`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", ...authHeaders(login.sessionToken) },
      body: Buffer.from([1, 2, 3]),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain("ownerId");
  });

  it("rejects raw blob bytes when existing metadata byte length differs", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const createResponse = await fetch(`${app.httpUrl}/blobs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(login.sessionToken) },
      body: JSON.stringify({
        blobId: "blob-content-length",
        contentHash: "external-hash",
        byteLength: 99,
        mimeType: "application/octet-stream",
        ownerId: "user-ada",
      }),
    });
    expect(createResponse.status).toBe(201);

    const response = await fetch(`${app.httpUrl}/blobs/blob-content-length/content`, {
      method: "PUT",
      headers: authHeaders(login.sessionToken),
      body: Buffer.from([1, 2, 3]),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain("byteLength");
  });

  it("rejects raw blob bytes when existing sha256 metadata hash differs", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const createResponse = await fetch(`${app.httpUrl}/blobs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(login.sessionToken) },
      body: JSON.stringify({
        blobId: "blob-content-hash",
        contentHash: "sha256-deadbeef",
        byteLength: 3,
        mimeType: "application/octet-stream",
        ownerId: "user-ada",
      }),
    });
    expect(createResponse.status).toBe(201);

    const response = await fetch(`${app.httpUrl}/blobs/blob-content-hash/content`, {
      method: "PUT",
      headers: authHeaders(login.sessionToken),
      body: Buffer.from([1, 2, 3]),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain("contentHash");
  });

  it("returns 404 for blob content that has metadata but no stored bytes", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const createResponse = await fetch(`${app.httpUrl}/blobs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(login.sessionToken) },
      body: JSON.stringify({
        blobId: "blob-content-missing",
        contentHash: "sha256-missing",
        byteLength: 3,
        mimeType: "text/plain",
        ownerId: "user-ada",
      }),
    });
    expect(createResponse.status).toBe(201);

    const response = await fetch(`${app.httpUrl}/blobs/blob-content-missing/content`, {
      headers: authHeaders(login.sessionToken),
    });

    expect(response.status).toBe(404);
  });

  it("enqueues and drains HTTP signals", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const postResponse = await fetch(`${app.httpUrl}/signals/WebRTCSignal/call-http`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(login.sessionToken) },
      body: JSON.stringify({
        senderDeviceId: "device-http",
        kind: "offer",
        payload: "sdp-offer",
      }),
    });
    expect(postResponse.status).toBe(200);
    expect(await postResponse.json()).toEqual({ ok: true });

    const firstRead = await fetch(`${app.httpUrl}/signals/WebRTCSignal/call-http`, {
      headers: authHeaders(login.sessionToken),
    });
    expect(firstRead.status).toBe(200);
    expect(await firstRead.json()).toMatchObject({
      schemaHash: productTestSchema.hash,
      name: "WebRTCSignal",
      key: "call-http",
      data: [
        {
          senderDeviceId: "device-http",
          kind: "offer",
          payload: "sdp-offer",
        },
      ],
    });

    const secondRead = await fetch(`${app.httpUrl}/signals/WebRTCSignal/call-http`, {
      headers: authHeaders(login.sessionToken),
    });
    expect((await secondRead.json()).data).toEqual([]);
  });

  it("fans out HTTP signals to WebSocket signal subscribers", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connectWithSession(app.url, login.sessionToken);

    const hello = expectHelloAckThenSchema(socket);
    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: "replica-signal",
          deviceId: "device-signal",
          schemaHash: productTestSchema.hash,
          knownCursors: {},
        },
      ]),
    );
    await hello;

    socket.send(
      encodeFrame([
        FrameKind.Subscribe,
        {
          subscriptionId: "sub-signal",
          kind: "signal",
          name: "WebRTCSignal",
          key: "call-http-ws",
        },
      ]),
    );

    const signalFrame = nextFrame(socket);
    const postResponse = await fetch(`${app.httpUrl}/signals/WebRTCSignal/call-http-ws`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(login.sessionToken) },
      body: JSON.stringify({
        senderDeviceId: "device-http",
        kind: "answer",
        payload: "sdp-answer",
      }),
    });
    expect(postResponse.status).toBe(200);

    const frame = await withTimeout(signalFrame, "expected websocket signal from HTTP POST");
    expect(frame[0]).toBe(FrameKind.SignalDeliver);
    const envelope = unpackSignalEnvelope(productTestSchema, frame[1].envelope);
    expect(envelope).toEqual({
      type: "WebRTCSignal",
      key: "call-http-ws",
      value: {
        senderDeviceId: "device-http",
        kind: "answer",
        payload: "sdp-answer",
      },
    });
    socket.close();
  });
});

async function startServer(
  options: { sseHeartbeatMs?: number; limits?: Parameters<typeof createFrickServer>[0]["limits"] } = {},
) {
  const server = createFrickServer({ port: 0, dbPath: ":memory:", schema: productTestSchema, ...options });
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

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve) => socket.once("open", resolve));
  return socket;
}

async function connectWithSession(url: string, sessionToken: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: authHeaders(sessionToken) });
  await new Promise<void>((resolve) => socket.once("open", resolve));
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
  const [ack, schema] = await collectFrames(socket, 2);
  expect(ack[0]).toBe(FrameKind.HelloAck);
  expect(ack[1]).toMatchObject({
    schemaHash: productTestSchema.hash,
    schemaId: productTestSchema.schemaId,
    schemaRevision: productTestSchema.schemaRevision,
    schemaCompatibility: {
      compatible: true,
      clientRevision: productTestSchema.schemaRevision,
      serverRevision: productTestSchema.schemaRevision,
    },
    serverCapabilities: defaultServerCapabilities(productTestSchema),
  });

  expect(schema).toEqual([FrameKind.Schema, productTestSchema]);
  return ack[1] as HelloAckPayload;
}

async function collectFrames(socket: WebSocket, count: number): Promise<FrickFrame[]> {
  return new Promise((resolve) => {
    const frames: FrickFrame[] = [];
    const onMessage = (data: Buffer) => {
      frames.push(decodeFrame(data));
      if (frames.length === count) {
        socket.off("message", onMessage);
        resolve(frames);
      }
    };
    socket.on("message", onMessage);
  });
}

async function postAppend(httpUrl: string, sessionToken: string, requestId: string, body: string): Promise<void> {
  const response = await fetch(`${httpUrl}/append`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify({
      requestId,
      replicaId: "http-test",
      stream: "MessageStream",
      key: "conversation-general",
      event: "MessageSent",
      payload: {
        messageId: `message-${requestId}`,
        senderId: "user-ada",
        body,
        createdAt: "2026-05-09T00:00:00.000Z",
      },
    }),
  });
  expect(response.status).toBe(200);
}

async function getInbox(httpUrl: string, sessionToken: string, userId: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${httpUrl}/inbox?userId=${encodeURIComponent(userId)}`, {
    headers: authHeaders(sessionToken),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function devLogin(
  httpUrl: string,
  body: { userId: string; tenantId?: string; deviceId?: string; replicaId?: string; platform?: string },
): Promise<{
  schemaHash: string;
  sessionToken: string;
  userId: string;
  deviceId: string;
  replicaId: string;
  expiresAt: string;
}> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    schemaHash: string;
    sessionToken: string;
    userId: string;
    deviceId: string;
    replicaId: string;
    expiresAt: string;
  };
}

async function signUp(
  httpUrl: string,
  body: {
    displayName: string;
    handle: string;
    password: string;
    deviceId?: string;
    replicaId?: string;
    platform?: string;
  },
): Promise<{
  schemaHash: string;
  sessionToken: string;
  userId: string;
  displayName: string;
  handle: string;
  deviceId: string;
  replicaId: string;
  expiresAt: string;
}> {
  const response = await fetch(`${httpUrl}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    schemaHash: string;
    sessionToken: string;
    userId: string;
    displayName: string;
    handle: string;
    deviceId: string;
    replicaId: string;
    expiresAt: string;
  };
}

async function loginAccount(
  httpUrl: string,
  body: {
    identity: string;
    password: string;
    deviceId?: string;
    replicaId?: string;
    platform?: string;
  },
): Promise<{
  schemaHash: string;
  sessionToken: string;
  userId: string;
  displayName: string;
  handle: string;
  deviceId: string;
  replicaId: string;
  expiresAt: string;
}> {
  const response = await fetch(`${httpUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    schemaHash: string;
    sessionToken: string;
    userId: string;
    displayName: string;
    handle: string;
    deviceId: string;
    replicaId: string;
    expiresAt: string;
  };
}

function authHeaders(sessionToken: string): Record<string, string> {
  return { authorization: `Bearer ${sessionToken}` };
}

interface SseEvent {
  event: string;
  data: string;
}

async function readRawSseBlock(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const delimiter = buffer.indexOf("\n\n");
    if (delimiter !== -1) {
      return buffer.slice(0, delimiter);
    }

    const { value, done } = await reader.read();
    if (done) {
      throw new Error("SSE stream ended before the next block");
    }
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
  }
}

async function readSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const delimiter = buffer.indexOf("\n\n");
    if (delimiter !== -1) {
      const rawEvent = buffer.slice(0, delimiter);
      buffer = buffer.slice(delimiter + 2);
      const parsed = parseSseEvent(rawEvent);
      if (parsed) {
        return parsed;
      }
    }

    const { value, done } = await reader.read();
    if (done) {
      throw new Error("SSE stream ended before the next event");
    }
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
  }
}

function parseSseEvent(rawEvent: string): SseEvent | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of rawEvent.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    }
    if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trim());
    }
  }
  return data.length > 0 ? { event, data: data.join("\n") } : undefined;
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 500);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
