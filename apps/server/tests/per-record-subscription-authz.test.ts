import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  FrameKind,
  decodeFrame,
  encodeFrame,
  productTestSchema,
  type FrickFrame,
} from "@frick/protocol";
import { createFrickServer } from "../src/server.js";
import type { FrickPolicyHook } from "../src/authz.js";

// End-to-end coverage for FR-116 "Per-record authz + grants on object
// subscriptions/snapshots". An object SUBSCRIPTION (objects(type)) is now
// authorized per record: the initial snapshot and every live object delta are
// filtered for each subscriber with the same decide() + policy-hook + grant
// pipeline the HTTP object read path uses, layered on tenant scoping. A
// tightening-only hook that denies object.read for a principal removes those
// rows; a grant on a record makes exactly that record visible to the grantee.
// Found via aquarius-os AQ-63 (per-record customer portal visibility).

// A real object type in productTestSchema. The value shape is unconstrained at
// the store layer (upsertObjectWithPolicy stores arbitrary JSON), so we only
// need the type to exist in the schema for packObjectRecord to resolve it.
const TYPE = "RoomMember";

// Tightening-only hook: deny object.read for the "viewer" principal. The
// subscription baseline is tenant-wide allow, so this hook is the per-role
// "deny by default" piece; grants then relax it record-by-record.
function denyViewerObjectReads(): FrickPolicyHook[] {
  return [
    (input) => {
      if (input.action === "object.read" && input.principal?.userId === "viewer") {
        return { allow: false, reason: "notAuthorizedForResource", publicMessage: "denied" };
      }
      return null;
    },
  ];
}

let app: ReturnType<typeof createFrickServer> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("FR-116 per-record object subscription authz", () => {
  it("snapshot delivers ONLY granted rows to a denied subscriber", async () => {
    const ctx = await startServer(denyViewerObjectReads());
    const viewer = await devLogin(ctx.httpUrl, { userId: "viewer" });

    // Seed three tenant rows before the viewer subscribes.
    for (const id of ["doc-1", "doc-2", "doc-3"]) {
      seed(ctx, viewer.tenantId, id);
    }
    // Grant the viewer read on exactly one of them.
    grant(ctx, viewer.tenantId, "writer", "viewer", "doc-2");

    const socket = await connectAndHello(ctx.wsUrl, viewer.sessionToken);
    const snapshots = collect(socket, FrameKind.Snapshot);
    subscribe(socket);

    const snapshot = await snapshots.next();
    expect(idsOf(snapshot.objects)).toEqual(["doc-2"]);
    socket.close();
  });

  it("live deltas fan out ONLY granted rows to a denied subscriber", async () => {
    const ctx = await startServer(denyViewerObjectReads());
    const viewer = await devLogin(ctx.httpUrl, { userId: "viewer" });

    // Pre-grant the row the viewer is allowed to see once written.
    grant(ctx, viewer.tenantId, "writer", "viewer", "granted");

    const socket = await connectAndHello(ctx.wsUrl, viewer.sessionToken);
    const snapshots = collect(socket, FrameKind.Snapshot);
    const deltas = collect(socket, FrameKind.Delta);
    subscribe(socket);
    const snapshot = await snapshots.next();
    expect(snapshot.objects).toEqual([]);

    // Write a NON-granted record first: it must never reach the viewer.
    seed(ctx, viewer.tenantId, "secret");
    // Then write the GRANTED record: only this one should arrive.
    seed(ctx, viewer.tenantId, "granted");

    const delta = await deltas.next();
    expect(idsOf(delta.objects)).toEqual(["granted"]);

    // No further delta (e.g. a delayed "secret") should follow.
    expect(await deltas.maybeNext(150)).toBeUndefined();
    socket.close();
  });

  it("an un-denied principal still sees all tenant rows (no regression)", async () => {
    const ctx = await startServer(denyViewerObjectReads());
    // "writer" is not targeted by the deny hook; a grant exists so per-record
    // authz IS active, but writer's baseline object.read still allows all.
    const writer = await devLogin(ctx.httpUrl, { userId: "writer" });

    for (const id of ["doc-1", "doc-2", "doc-3"]) {
      seed(ctx, writer.tenantId, id);
    }
    grant(ctx, writer.tenantId, "writer", "viewer", "doc-2");

    const socket = await connectAndHello(ctx.wsUrl, writer.sessionToken);
    const snapshots = collect(socket, FrameKind.Snapshot);
    const deltas = collect(socket, FrameKind.Delta);
    subscribe(socket);

    const snapshot = await snapshots.next();
    expect(idsOf(snapshot.objects).sort()).toEqual(["doc-1", "doc-2", "doc-3"]);

    // A live write also reaches the un-denied subscriber.
    seed(ctx, writer.tenantId, "doc-4");
    const delta = await deltas.next();
    expect(idsOf(delta.objects)).toEqual(["doc-4"]);
    socket.close();
  });

  it("with no policy hooks and no grants, every in-tenant row is delivered (short-circuit)", async () => {
    const ctx = await startServer();
    const sub = await devLogin(ctx.httpUrl, { userId: "anyone" });

    seed(ctx, sub.tenantId, "doc-1");

    const socket = await connectAndHello(ctx.wsUrl, sub.sessionToken);
    const snapshots = collect(socket, FrameKind.Snapshot);
    const deltas = collect(socket, FrameKind.Delta);
    subscribe(socket);

    const snapshot = await snapshots.next();
    expect(idsOf(snapshot.objects)).toEqual(["doc-1"]);

    seed(ctx, sub.tenantId, "doc-2");
    const delta = await deltas.next();
    expect(idsOf(delta.objects)).toEqual(["doc-2"]);
    socket.close();
  });

  it("cross-tenant isolation still holds with per-record authz active", async () => {
    const ctx = await startServer(denyViewerObjectReads());
    const a = await devLogin(ctx.httpUrl, { userId: "writer", tenantId: "tenant-a" });

    // A grant in tenant-a turns on per-record authz; the cross-tenant write
    // below must still be invisible regardless.
    grant(ctx, "tenant-a", "writer", "viewer", "doc-a");

    const socket = await connectAndHello(ctx.wsUrl, a.sessionToken);
    const snapshots = collect(socket, FrameKind.Snapshot);
    const deltas = collect(socket, FrameKind.Delta);
    subscribe(socket);
    await snapshots.next();

    seed(ctx, "tenant-b", "doc-x");
    expect(await deltas.maybeNext(150)).toBeUndefined();
    socket.close();
  });
});

interface ServerCtx {
  wsUrl: string;
  httpUrl: string;
  store: ReturnType<typeof createFrickServer>["store"];
  close: () => Promise<void>;
}

async function startServer(policyHooks?: FrickPolicyHook[]): Promise<ServerCtx> {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    schema: productTestSchema,
    ...(policyHooks ? { policyHooks } : {}),
  });
  app = server;
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    wsUrl: `ws://127.0.0.1:${address.port}/_frick/sync`,
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

// Write directly through the store so the FR-114 store-write listener fans the
// upsert out to gateway subscribers exactly as a client/HTTP write would.
function seed(ctx: ServerCtx, tenantId: string, id: string): void {
  ctx.store.upsertObjectWithPolicy({
    tenantId,
    type: TYPE,
    id,
    value: { id, conversationId: "conversation-1", userId: id, role: "member" },
  });
}

function grant(
  ctx: ServerCtx,
  tenantId: string,
  ownerUserId: string,
  granteeUserId: string,
  recordId: string,
): void {
  ctx.store.grants.create({
    id: randomUUID(),
    tenantId,
    ownerUserId,
    recordType: TYPE,
    recordId,
    granteeUserId,
    permission: "read",
    createdAt: new Date().toISOString(),
  });
}

// ObjectRecord is [type, id, fields, version, updatedAt]; index 1 is the id.
function idsOf(objects: unknown[]): string[] {
  return objects.map((record) => (record as [string, string])[1]);
}

function subscribe(socket: WebSocket): void {
  socket.send(
    encodeFrame([
      FrameKind.Subscribe,
      { subscriptionId: "sub-1", kind: "object", name: TYPE },
    ]),
  );
}

async function connectAndHello(url: string, sessionToken: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${sessionToken}` } });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
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

interface ObjectsPayload {
  objects: unknown[];
}

interface FrameCollector {
  next(): Promise<ObjectsPayload>;
  maybeNext(timeoutMs: number): Promise<ObjectsPayload | undefined>;
}

function collect(socket: WebSocket, kind: FrameKind): FrameCollector {
  const queue: ObjectsPayload[] = [];
  const waiters: Array<(value: ObjectsPayload) => void> = [];

  socket.on("message", (data) => {
    const frame: FrickFrame = decodeFrame(data as Buffer);
    if (frame[0] !== kind) return;
    const payload = frame[1] as ObjectsPayload;
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
      return new Promise<ObjectsPayload>((resolve) => waiters.push(resolve));
    },
    maybeNext(timeoutMs) {
      const ready = queue.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise<ObjectsPayload | undefined>((resolve) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(wrapped);
          if (idx >= 0) waiters.splice(idx, 1);
          resolve(undefined);
        }, timeoutMs);
        const wrapped = (value: ObjectsPayload) => {
          clearTimeout(timer);
          resolve(value);
        };
        waiters.push(wrapped);
      });
    },
  };
}
