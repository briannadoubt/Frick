import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  FrameKind,
  decodeFrame,
  encodeFrame,
  productTestSchema,
  type FrickFrame,
  type ProjectionDeltaPayload,
} from "@frick/protocol";
import { createFrickServer } from "../src/server.js";
import type { FrickProjection } from "../src/projections/registry.js";

// Projection delta over the sync gateway. The previous suite assumed the
// built-in `conversation-inbox` projection that the framework boundary
// cleanup removed. This rewrite drives the same gateway code paths
// against a tiny test-only projection so the contract (subscribe,
// receive deltas on matching writes, tenant isolation, no fan-out
// without subscribe) still gets exercised.

const DEMO_PROJECTION_NAME = "demo-delta-inbox";

function createDemoDeltaProjection(): FrickProjection {
  return {
    name: DEMO_PROJECTION_NAME,
    sources: [{ kind: "stream", type: "MessageStream" }],
    handler: {
      apply(event) {
        if (event.kind !== "streamEvent" || event.streamEvent.event !== "MessageSent") {
          return undefined;
        }
        const senderId =
          typeof event.streamEvent.payload.senderId === "string"
            ? event.streamEvent.payload.senderId
            : "unknown";
        const key = `${senderId}:${event.streamId}`;
        return {
          changes: [
            {
              key,
              value: {
                userId: senderId,
                conversationId: event.streamId,
                lastEventId: event.streamEvent.eventId,
              },
            },
          ],
        };
      },
    },
  };
}

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("projection deltas over the sync gateway", () => {
  it("pushes row changes to subscribed clients in the same tenant", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connectAndHello(app.url, ada.sessionToken);
    const deltas = collectFrames(socket, FrameKind.ProjectionDelta);

    socket.send(
      encodeFrame([
        FrameKind.Subscribe,
        {
          subscriptionId: "sub-inbox",
          kind: "projection",
          name: DEMO_PROJECTION_NAME,
        },
      ]),
    );

    const append = await postJson(
      `${app.httpUrl}/append`,
      {
        requestId: "request-projection-delta",
        stream: "MessageStream",
        key: "conversation-general",
        event: "MessageSent",
        payload: {
          messageId: "message-projection",
          senderId: "user-ada",
          body: "hello",
          createdAt: "2026-05-09T00:00:00.000Z",
        },
      },
      ada.sessionToken,
    );
    expect(append.status).toBe(200);

    const delta = await deltas.next();
    expect(delta.projection).toBe(DEMO_PROJECTION_NAME);
    expect(delta.changes.map((change) => change.key)).toEqual([
      "user-ada:conversation-general",
    ]);
    expect(delta.changes[0]?.value).toMatchObject({
      userId: "user-ada",
      conversationId: "conversation-general",
    });
    socket.close();
  });

  it("does not push deltas from another tenant to a subscriber", async () => {
    app = await startServer();
    const a = await devLogin(app.httpUrl, { userId: "user-tenant-a", tenantId: "tenant-a" });
    const b = await devLogin(app.httpUrl, { userId: "user-tenant-b", tenantId: "tenant-b" });

    const socket = await connectAndHello(app.url, a.sessionToken);
    const deltas = collectFrames(socket, FrameKind.ProjectionDelta);
    socket.send(
      encodeFrame([
        FrameKind.Subscribe,
        {
          subscriptionId: "sub-inbox-cross-tenant",
          kind: "projection",
          name: DEMO_PROJECTION_NAME,
        },
      ]),
    );

    // Tenant-b emits a matching event; subscriber in tenant-a must not see
    // a delta because the gateway scopes by tenant.
    const append = await postJson(
      `${app.httpUrl}/append`,
      {
        requestId: "request-cross-tenant",
        stream: "MessageStream",
        key: "conv-b",
        event: "MessageSent",
        payload: {
          messageId: "message-cross-tenant",
          senderId: "user-tenant-b",
          body: "tenant-b only",
          createdAt: "2026-05-09T00:00:00.000Z",
        },
      },
      b.sessionToken,
    );
    expect(append.status).toBe(200);

    const delta = await deltas.maybeNext(100);
    expect(delta).toBeUndefined();
    socket.close();
  });

  it("does not push deltas to clients that did not subscribe", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connectAndHello(app.url, ada.sessionToken);
    const deltas = collectFrames(socket, FrameKind.ProjectionDelta);

    const append = await postJson(
      `${app.httpUrl}/append`,
      {
        requestId: "request-no-sub",
        stream: "MessageStream",
        key: "conversation-general",
        event: "MessageSent",
        payload: {
          messageId: "message-no-sub",
          senderId: "user-ada",
          body: "no listeners",
          createdAt: "2026-05-09T00:00:00.000Z",
        },
      },
      ada.sessionToken,
    );
    expect(append.status).toBe(200);

    const delta = await deltas.maybeNext(100);
    expect(delta).toBeUndefined();
    socket.close();
  });

  it("nacks subscribe to a projection that is not registered", async () => {
    app = await startServer();
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connectAndHello(app.url, ada.sessionToken);

    socket.send(
      encodeFrame([
        FrameKind.Subscribe,
        {
          subscriptionId: "sub-bogus",
          kind: "projection",
          name: "does-not-exist",
        },
      ]),
    );

    const frame = await nextFrame(socket);
    expect(frame[0]).toBe(FrameKind.Nack);
    expect(frame[1]).toMatchObject({
      requestId: "sub-bogus",
      code: "auth.forbidden",
    });
    expect((frame[1] as { error: { details: { reason: string } } }).error.details.reason).toBe(
      "projectionNotFound",
    );
    socket.close();
  });
});

async function startServer() {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    schema: productTestSchema,
  });
  server.store.projections.register(createDemoDeltaProjection());
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

async function devLogin(
  httpUrl: string,
  body: { userId: string; tenantId?: string },
): Promise<{ sessionToken: string; tenantId: string }> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { sessionToken: string; tenantId: string };
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  sessionToken?: string,
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined };
}

async function connectAndHello(url: string, sessionToken: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${sessionToken}` } });
  await new Promise<void>((resolve) => socket.once("open", resolve));
  socket.send(
    encodeFrame([
      FrameKind.Hello,
      {
        replicaId: "replica-test",
        deviceId: "device-test",
        schemaHash: productTestSchema.hash,
        knownCursors: {},
      },
    ]),
  );
  // Drain HelloAck + Schema before the test takes over message handling.
  await waitForFrames(socket, 2);
  return socket;
}

async function nextFrame(socket: WebSocket): Promise<FrickFrame> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(decodeFrame(data as Buffer)));
  });
}

function waitForFrames(socket: WebSocket, count: number): Promise<void> {
  return new Promise((resolve) => {
    let received = 0;
    const onMessage = () => {
      received += 1;
      if (received >= count) {
        socket.off("message", onMessage);
        resolve();
      }
    };
    socket.on("message", onMessage);
  });
}

interface FrameCollector<T> {
  next(): Promise<T>;
  maybeNext(timeoutMs: number): Promise<T | undefined>;
}

function collectFrames(
  socket: WebSocket,
  kind: FrameKind.ProjectionDelta,
): FrameCollector<ProjectionDeltaPayload> {
  const queue: ProjectionDeltaPayload[] = [];
  const waiters: Array<(value: ProjectionDeltaPayload) => void> = [];

  socket.on("message", (data) => {
    const frame = decodeFrame(data as Buffer);
    if (frame[0] !== kind) return;
    const payload = frame[1] as ProjectionDeltaPayload;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(payload);
    } else {
      queue.push(payload);
    }
  });

  return {
    next() {
      const ready = queue.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise<ProjectionDeltaPayload>((resolve) => waiters.push(resolve));
    },
    maybeNext(timeoutMs) {
      const ready = queue.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise<ProjectionDeltaPayload | undefined>((resolve) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(wrapped);
          if (idx >= 0) waiters.splice(idx, 1);
          resolve(undefined);
        }, timeoutMs);
        const wrapped = (value: ProjectionDeltaPayload) => {
          clearTimeout(timer);
          resolve(value);
        };
        waiters.push(wrapped);
      });
    },
  };
}
