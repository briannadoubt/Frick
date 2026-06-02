import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  FrameKind,
  decodeFrame,
  encodeFrame,
  productTestSchema,
  type FrickFrame,
  type PlainObject,
  type ProjectionDeltaPayload,
} from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";
import type { FrickProjection } from "../src/projections/registry.js";

// End-to-end coverage for FR-109 "Live projection delta-push over the sync
// gateway" (FR-110 app registration + FR-111 gateway push). A projection is
// registered through `ServerOptions.projections`, then a client subscribing
// over a real WebSocket receives an initial snapshot followed by live,
// tenant-scoped `ProjectionDelta` frames as the source object changes.

const ROOM_ROSTER = "room-roster";

/**
 * A tiny projection over the `RoomMember` object type. Maintains a
 * tenant-scoped row per `${conversationId}:${userId}` so we can assert both
 * the framework snapshot (materialized from declared changes) and the
 * projection's own `read()` view.
 */
function createRoomRosterProjection(): {
  projection: FrickProjection;
  rowsFor(tenantId: string): Map<string, PlainObject>;
} {
  const rowsByTenant = new Map<string, Map<string, PlainObject>>();
  function rowsFor(tenantId: string): Map<string, PlainObject> {
    let rows = rowsByTenant.get(tenantId);
    if (!rows) {
      rows = new Map();
      rowsByTenant.set(tenantId, rows);
    }
    return rows;
  }
  const projection: FrickProjection = {
    name: ROOM_ROSTER,
    sources: [{ kind: "object", type: "RoomMember" }],
    handler: {
      apply(event, ctx) {
        if (event.kind !== "objectUpsert" || !event.object) {
          return undefined;
        }
        const object = event.object as PlainObject;
        const conversationId = typeof object.conversationId === "string" ? object.conversationId : "unknown";
        const userId = typeof object.userId === "string" ? object.userId : "unknown";
        const role = typeof object.role === "string" ? object.role : "member";
        const key = `${conversationId}:${userId}`;
        const value: PlainObject = { conversationId, userId, role };
        rowsFor(ctx.tenantId).set(key, value);
        return { changes: [{ key, value }] };
      },
      read(ctx) {
        return { rows: Object.fromEntries(rowsFor(ctx.tenantId)) };
      },
    },
  };
  return { projection, rowsFor };
}

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("FR-109 projection delta-push end-to-end", () => {
  it("runs apply() on a matching object upsert so read() reflects the change (FR-110)", async () => {
    const roster = createRoomRosterProjection();
    app = await startServer([roster.projection]);
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });

    const upsert = await putObject(
      `${app.httpUrl}/objects/RoomMember/member-ada`,
      { conversationId: "conversation-general", userId: "user-ada", role: "owner" },
      ada.sessionToken,
    );
    expect(upsert.status).toBe(201);

    // The projection's own read view reflects the applied write...
    const read = await getJson(`${app.httpUrl}/projections/${ROOM_ROSTER}`, ada.sessionToken);
    expect(read.status).toBe(200);
    expect(read.body.data.rows).toMatchObject({
      "conversation-general:user-ada": { userId: "user-ada", role: "owner" },
    });
    // ...and the framework-materialized snapshot agrees.
    expect(app.store.projections.snapshot(ROOM_ROSTER, ada.tenantId)).toEqual([
      {
        key: "conversation-general:user-ada",
        value: { conversationId: "conversation-general", userId: "user-ada", role: "owner" },
      },
    ]);
  });

  it("delivers an initial snapshot then live deltas to a subscriber (FR-111)", async () => {
    const roster = createRoomRosterProjection();
    app = await startServer([roster.projection]);
    const ada = await devLogin(app.httpUrl, { userId: "user-ada" });

    // Seed a row BEFORE the client subscribes, so it can only learn about it
    // via the initial snapshot (not a live delta).
    const seeded = await putObject(
      `${app.httpUrl}/objects/RoomMember/member-seed`,
      { conversationId: "conversation-general", userId: "user-seed", role: "member" },
      ada.sessionToken,
    );
    expect(seeded.status).toBe(201);

    const socket = await connectAndHello(app.url, ada.sessionToken);
    const deltas = collectFrames(socket, FrameKind.ProjectionDelta);
    socket.send(
      encodeFrame([
        FrameKind.Subscribe,
        { subscriptionId: "sub-roster", kind: "projection", name: ROOM_ROSTER },
      ]),
    );

    // First frame back is the snapshot containing the pre-existing row.
    const snapshot = await deltas.next();
    expect(snapshot.projection).toBe(ROOM_ROSTER);
    expect(snapshot.changes).toEqual([
      {
        key: "conversation-general:user-seed",
        value: { conversationId: "conversation-general", userId: "user-seed", role: "member" },
      },
    ]);

    // A subsequent write streams a live delta to the same subscriber.
    const live = await putObject(
      `${app.httpUrl}/objects/RoomMember/member-live`,
      { conversationId: "conversation-general", userId: "user-live", role: "member" },
      ada.sessionToken,
    );
    expect(live.status).toBe(201);

    const delta = await deltas.next();
    expect(delta.projection).toBe(ROOM_ROSTER);
    expect(delta.changes).toEqual([
      {
        key: "conversation-general:user-live",
        value: { conversationId: "conversation-general", userId: "user-live", role: "member" },
      },
    ]);
    socket.close();
  });

  it("scopes the snapshot and deltas to the subscriber's tenant (FR-111)", async () => {
    const roster = createRoomRosterProjection();
    app = await startServer([roster.projection]);
    const a = await devLogin(app.httpUrl, { userId: "user-alpha", tenantId: "tenant-a" });
    const b = await devLogin(app.httpUrl, { userId: "user-bravo", tenantId: "tenant-b" });

    // Tenant B seeds a row that tenant A's subscriber must never see — not in
    // the snapshot, and not as a live delta.
    const seededB = await putObject(
      `${app.httpUrl}/objects/RoomMember/member-b-seed`,
      { conversationId: "conversation-b", userId: "user-b", role: "owner" },
      b.sessionToken,
    );
    expect(seededB.status).toBe(201);

    const socketA = await connectAndHello(app.url, a.sessionToken);
    const deltasA = collectFrames(socketA, FrameKind.ProjectionDelta);
    socketA.send(
      encodeFrame([
        FrameKind.Subscribe,
        { subscriptionId: "sub-roster-a", kind: "projection", name: ROOM_ROSTER },
      ]),
    );

    // Tenant A's snapshot is empty — tenant B's seeded row is not leaked.
    const snapshotA = await deltasA.next();
    expect(snapshotA.changes).toEqual([]);

    // A write in tenant B must not push a delta to tenant A's subscriber.
    const liveB = await putObject(
      `${app.httpUrl}/objects/RoomMember/member-b-live`,
      { conversationId: "conversation-b", userId: "user-b2", role: "member" },
      b.sessionToken,
    );
    expect(liveB.status).toBe(201);
    expect(await deltasA.maybeNext(100)).toBeUndefined();

    // A write in tenant A does reach tenant A's subscriber.
    const liveA = await putObject(
      `${app.httpUrl}/objects/RoomMember/member-a-live`,
      { conversationId: "conversation-a", userId: "user-a", role: "owner" },
      a.sessionToken,
    );
    expect(liveA.status).toBe(201);
    const deltaA = await deltasA.next();
    expect(deltaA.changes).toEqual([
      {
        key: "conversation-a:user-a",
        value: { conversationId: "conversation-a", userId: "user-a", role: "owner" },
      },
    ]);
    socketA.close();
  });

  it("throws a config error when a projection source references an unknown type (FR-110)", () => {
    expect(() =>
      createFrickServer({
        port: 0,
        dbPath: ":memory:",
        schema: productTestSchema,
        projections: [
          {
            name: "bad-source",
            sources: [{ kind: "object", type: "NotARealObject" }],
            handler: { apply: () => undefined },
          },
        ],
      }),
    ).toThrow(/unknown object source "NotARealObject"/);
  });
});

async function startServer(projections: readonly FrickProjection[]) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    schema: productTestSchema,
    projections,
  });
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

async function putObject(
  url: string,
  value: Record<string, unknown>,
  sessionToken: string,
): Promise<{ status: number; body: any }> {
  // The object write route reads the entire JSON body as the object value.
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify(value),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined };
}

async function getJson(
  url: string,
  sessionToken: string,
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${sessionToken}` },
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
    const frame: FrickFrame = decodeFrame(data as Buffer);
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
