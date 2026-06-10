import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  FrameKind,
  decodeFrame,
  encodeFrame,
  type FrickFrame,
  type FrickSchema,
} from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";
import { FrickStore, type FrickObjectVisibilityOptions } from "../src/store.js";

// Coverage for FR-235 (object reads are owner-scoped by default, not
// tenant-wide allow-all) and FR-234 (a stale pre-0.2.0 grant must not
// suppress the writer's own delta). Modelled on RangerCRM's shape: a single
// app, the default tenant, per-user data keyed by an `ownerUserId` field.

// A schema with an owner-bearing type (Account, via the `ownerUserId`
// convention) and an owner-less type (Tag) to pin that types without an owner
// field stay tenant-visible.
const schema: FrickSchema = {
  name: "owner-scope-test",
  schemaId: "owner-scope-test",
  schemaVersion: "1.0.0",
  schemaRevision: 1,
  minimumClientRevision: 1,
  minimumServerRevision: 1,
  protocol: "frick.realtime",
  protocolVersion: 1,
  compatibility: "greenfield-cutover",
  hash: "owner-scope-test-1.0.0",
  objects: [
    {
      id: 1,
      name: "Account",
      fields: [
        { id: 1, name: "ownerUserId", kind: "string", required: true },
        { id: 2, name: "accountName", kind: "string", required: false },
      ],
      indexes: [{ id: 1, name: "byOwner", fields: ["ownerUserId"] }],
      mergePolicy: "lastWriteWins",
    },
    {
      id: 2,
      name: "Tag",
      fields: [{ id: 1, name: "label", kind: "string", required: false }],
      indexes: [],
      mergePolicy: "lastWriteWins",
    },
  ],
  streams: [],
  events: [],
  presences: [],
  signals: [],
  blobs: [],
  jobs: [],
  projections: [],
};

let app: ReturnType<typeof createFrickServer> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("FR-235 owner-scoped object reads by default", () => {
  it("store.isObjectVisibleToUser owner-scopes a type with an ownerUserId field", () => {
    const store = new FrickStore({ path: ":memory:", schema });
    try {
      const row = { id: "a1", ownerUserId: "alice", accountName: "Acme" };
      expect(store.isObjectVisibleToUser("_default", "Account", row, "alice")).toBe(true);
      expect(store.isObjectVisibleToUser("_default", "Account", row, "bob")).toBe(false);
      // Owner-less type stays tenant-visible.
      const tag = { id: "t1", label: "vip" };
      expect(store.isObjectVisibleToUser("_default", "Tag", tag, "bob")).toBe(true);
      // Fail-open: a row with no owner value is visible (migrated legacy row).
      const legacy = { id: "a2", accountName: "Legacy" };
      expect(store.isObjectVisibleToUser("_default", "Account", legacy, "bob")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("REST /objects returns only the caller's own rows when no grant exists", async () => {
    const ctx = await startServer();
    const alice = await devLogin(ctx.httpUrl, { userId: "alice" });
    const bob = await devLogin(ctx.httpUrl, { userId: "bob" });

    await seed(ctx, alice.tenantId, "a-1", "alice");
    await seed(ctx, alice.tenantId, "a-2", "alice");
    await seed(ctx, bob.tenantId, "b-1", "bob");

    const bobRows = await listObjects(ctx.httpUrl, bob.sessionToken, "Account");
    expect(bobRows.map((r) => r.id).sort()).toEqual(["b-1"]);

    const aliceRows = await listObjects(ctx.httpUrl, alice.sessionToken, "Account");
    expect(aliceRows.map((r) => r.id).sort()).toEqual(["a-1", "a-2"]);
  });

  it("WS subscribe snapshot contains only the subscriber's own rows", async () => {
    const ctx = await startServer();
    const alice = await devLogin(ctx.httpUrl, { userId: "alice" });
    const bob = await devLogin(ctx.httpUrl, { userId: "bob" });

    await seed(ctx, alice.tenantId, "a-1", "alice");
    await seed(ctx, alice.tenantId, "a-2", "alice");
    await seed(ctx, bob.tenantId, "b-1", "bob");

    const socket = await connectAndHello(ctx.wsUrl, bob.sessionToken);
    const snapshots = collect(socket, FrameKind.Snapshot);
    subscribe(socket);
    const snapshot = await snapshots.next();
    expect(idsOf(snapshot.objects)).toEqual(["b-1"]);
    socket.close();
  });

  it("after a grant, the grantee sees exactly that record live; revoke removes it", async () => {
    const ctx = await startServer();
    const alice = await devLogin(ctx.httpUrl, { userId: "alice" });
    const bob = await devLogin(ctx.httpUrl, { userId: "bob" });

    await seed(ctx, alice.tenantId, "a-1", "alice");
    await seed(ctx, alice.tenantId, "a-2", "alice");

    const socket = await connectAndHello(ctx.wsUrl, bob.sessionToken);
    const snapshots = collect(socket, FrameKind.Snapshot);
    const deltas = collect(socket, FrameKind.Delta);
    subscribe(socket);
    expect(idsOf((await snapshots.next()).objects)).toEqual([]);

    // Grant bob read on a-1 via the accept flow (issues a real grant + live push).
    const grantId = await shareRecord(ctx, alice, "bob", "Account", "a-1");

    // Live: bob receives a-1 as a delta.
    const delta = await deltas.next();
    expect(idsOf(delta.objects)).toEqual(["a-1"]);

    // REST list now includes the granted record (plus none of alice's others).
    const bobRows = await listObjects(ctx.httpUrl, bob.sessionToken, "Account");
    expect(bobRows.map((r) => r.id).sort()).toEqual(["a-1"]);

    // Revoke: bob receives a removal delta for a-1.
    await revokeGrant(ctx.httpUrl, alice.sessionToken, grantId);
    const removal = await deltas.next();
    expect(removal.removed?.map((r) => r.id)).toEqual(["a-1"]);

    const afterRevoke = await listObjects(ctx.httpUrl, bob.sessionToken, "Account");
    expect(afterRevoke).toEqual([]);
    socket.close();
  });

  it("objectVisibility { mode: 'tenantWide' } restores allow-all (explicit opt-in)", async () => {
    const ctx = await startServer({ mode: "tenantWide" });
    const alice = await devLogin(ctx.httpUrl, { userId: "alice" });
    const bob = await devLogin(ctx.httpUrl, { userId: "bob" });

    await seed(ctx, alice.tenantId, "a-1", "alice");
    await seed(ctx, bob.tenantId, "b-1", "bob");

    const bobRows = await listObjects(ctx.httpUrl, bob.sessionToken, "Account");
    expect(bobRows.map((r) => r.id).sort()).toEqual(["a-1", "b-1"]);
  });
});

describe("FR-234 stale pre-0.2.0 grant must not suppress the writer's own delta", () => {
  it("writer receives its own delta + snapshot row even with a stale grant present", async () => {
    const ctx = await startServer();
    const writer = await devLogin(ctx.httpUrl, { userId: "writer" });

    // Seed a 0.1.1-shaped grant: a grant row exists (so per-record authz is
    // active) but it references a record that has no ownership row of its own.
    await ctx.store.grants.create({
      id: randomUUID(),
      tenantId: writer.tenantId,
      ownerUserId: "someone-else",
      recordType: "Account",
      recordId: "legacy-shared",
      granteeUserId: "third-party",
      permission: "read",
      createdAt: new Date().toISOString(),
    });

    const socket = await connectAndHello(ctx.wsUrl, writer.sessionToken);
    const snapshots = collect(socket, FrameKind.Snapshot);
    const deltas = collect(socket, FrameKind.Delta);
    subscribe(socket);
    await snapshots.next();

    // Writer writes a NEW Account over WS — it must echo back to the writer
    // regardless of the stale-grant-activated per-record path.
    writeObject(socket, "Account", "new-1", { ownerUserId: "writer", accountName: "Fresh" });
    const delta = await deltas.next();
    expect(idsOf(delta.objects)).toEqual(["new-1"]);

    // A fresh subscription's snapshot also includes the writer's own row.
    const socket2 = await connectAndHello(ctx.wsUrl, writer.sessionToken);
    const snap2 = collect(socket2, FrameKind.Snapshot);
    subscribe(socket2);
    expect(idsOf((await snap2.next()).objects)).toEqual(["new-1"]);
    socket.close();
    socket2.close();
  });

  it("writer gets its echo even when the row is owned by another user", async () => {
    const ctx = await startServer();
    const writer = await devLogin(ctx.httpUrl, { userId: "writer" });
    // Make per-record authz active.
    await ctx.store.grants.create({
      id: randomUUID(),
      tenantId: writer.tenantId,
      ownerUserId: "x",
      recordType: "Account",
      recordId: "y",
      granteeUserId: "z",
      permission: "read",
      createdAt: new Date().toISOString(),
    });

    const socket = await connectAndHello(ctx.wsUrl, writer.sessionToken);
    const deltas = collect(socket, FrameKind.Delta);
    collect(socket, FrameKind.Snapshot);
    subscribe(socket);

    // Row's ownerUserId is someone else, but THIS principal performed the
    // write — the writer-echo guarantee must still deliver it.
    writeObject(socket, "Account", "owned-elsewhere", {
      ownerUserId: "not-writer",
      accountName: "Imported",
    });
    const delta = await deltas.next();
    expect(idsOf(delta.objects)).toEqual(["owned-elsewhere"]);
    socket.close();
  });
});

// ---------------------------------------------------------------------------

interface ServerCtx {
  wsUrl: string;
  httpUrl: string;
  store: ReturnType<typeof createFrickServer>["store"];
}

async function startServer(objectVisibility?: FrickObjectVisibilityOptions): Promise<ServerCtx> {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    schema,
    ...(objectVisibility ? { objectVisibility } : {}),
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
  };
}

async function devLogin(
  httpUrl: string,
  body: { userId: string; tenantId?: string },
): Promise<{ sessionToken: string; tenantId: string; userId: string }> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  const json = (await response.json()) as { sessionToken: string; tenantId: string; userId: string };
  return json;
}

async function seed(ctx: ServerCtx, tenantId: string, id: string, ownerUserId: string): Promise<void> {
  await ctx.store.upsertObjectWithPolicy({
    tenantId,
    type: "Account",
    id,
    value: { id, ownerUserId, accountName: `acct-${id}` },
  });
}

async function listObjects(
  httpUrl: string,
  token: string,
  type: string,
): Promise<Array<{ id: string }>> {
  const response = await fetch(`${httpUrl}/objects?type=${encodeURIComponent(type)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const json = (await response.json()) as { data: Array<{ id: string }> };
  return json.data;
}

// Issue an invitation as owner, accept it as grantee. Returns the grant id.
async function shareRecord(
  ctx: ServerCtx,
  owner: { sessionToken: string },
  granteeUserId: string,
  recordType: string,
  recordId: string,
): Promise<string> {
  const grantee = await devLogin(ctx.httpUrl, { userId: granteeUserId });
  const inviteResp = await fetch(`${ctx.httpUrl}/share/invite`, {
    method: "POST",
    headers: { authorization: `Bearer ${owner.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({ recordType, recordId, permission: "read" }),
  });
  expect(inviteResp.status).toBe(201);
  const invite = (await inviteResp.json()) as { invitation: { token: string } };
  const acceptResp = await fetch(`${ctx.httpUrl}/share/accept`, {
    method: "POST",
    headers: { authorization: `Bearer ${grantee.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({ token: invite.invitation.token }),
  });
  expect(acceptResp.status).toBe(201);
  const accepted = (await acceptResp.json()) as { grant: { id: string } };
  return accepted.grant.id;
}

async function revokeGrant(httpUrl: string, ownerToken: string, grantId: string): Promise<void> {
  const resp = await fetch(`${httpUrl}/share/grants/${encodeURIComponent(grantId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  expect(resp.status).toBe(200);
}

function subscribe(socket: WebSocket): void {
  socket.send(
    encodeFrame([
      FrameKind.Subscribe,
      { subscriptionId: "sub-1", kind: "object", name: "Account" },
    ]),
  );
}

function writeObject(
  socket: WebSocket,
  objectType: string,
  objectId: string,
  value: Record<string, unknown>,
): void {
  socket.send(
    encodeFrame([
      FrameKind.ObjectUpsert,
      { requestId: randomUUID(), objectType, objectId, value: { id: objectId, ...value } },
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
        schemaHash: schema.hash,
        knownCursors: {},
      },
    ]),
  );
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
  removed?: Array<{ type: string; id: string }>;
}

interface FrameCollector {
  next(): Promise<ObjectsPayload>;
  maybeNext(timeoutMs: number): Promise<ObjectsPayload | undefined>;
}

function idsOf(objects: unknown[]): string[] {
  return objects.map((record) => (record as [string, string])[1]);
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
