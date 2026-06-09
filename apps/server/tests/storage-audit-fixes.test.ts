import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { productTestSchema } from "@fricken/protocol";
import { initializeStorage } from "../src/storage/schema.js";
import { SqliteSqlDriver } from "../src/storage/sql-driver.js";
import { StreamStore } from "../src/storage/stream-store.js";
import { PresenceStore } from "../src/storage/presence-store.js";
import { SignalStore } from "../src/storage/signal-store.js";
import { AdminAuditStore } from "../src/storage/admin-audit-store.js";

/**
 * Regression suite for the storage-domain audit findings:
 *   - server-storage-1: admin audit hash-chain forks under concurrent record()
 *   - server-storage-2 / tenant-app-isolation-5: cross-app idempotency clobber
 *   - server-storage-3: cross-app presence-lease eviction
 *   - server-storage-4: duplicate signal delivery under concurrent drain()
 *   - server-storage-7: pruneRetention blast radius / optional tenant scoping
 *
 * Each test fails against the pre-fix code and passes after.
 */

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function makeDriver(): SqliteSqlDriver {
  db = new DatabaseSync(":memory:");
  initializeStorage(db, productTestSchema.schemaRevision);
  return new SqliteSqlDriver(db);
}

const STREAM = "MessageStream";

function streamPayload(body: string) {
  return {
    messageId: `m-${body}`,
    senderId: "user-ada",
    body,
    createdAt: "2026-05-31T00:00:00.000Z",
  };
}

describe("server-storage-2 / tenant-app-isolation-5 — cross-app idempotency isolation", () => {
  it("two apps sharing (tenant, replica, request) keep independent idempotency records", async () => {
    const store = new StreamStore(makeDriver(), productTestSchema);
    const shared = {
      tenantId: "tenant-1",
      replicaId: "r1",
      requestId: "req-shared",
      stream: STREAM,
      streamId: "room",
      event: "MessageSent",
    } as const;

    // App A appends first; its row is stamped app_id=app-a.
    const a1 = await store.append({ ...shared, appId: "app-a", payload: streamPayload("A") });
    expect(a1.created).toBe(true);

    // App B appends the SAME (tenant, replica, request). Before the fix B's
    // ON CONFLICT would overwrite A's row and rewrite app_id=app-b. With the
    // app-scoped PK, B gets its own row and its own event.
    const b1 = await store.append({ ...shared, appId: "app-b", payload: streamPayload("B") });
    expect(b1.created).toBe(true);
    expect(b1.event.eventId).not.toBe(a1.event.eventId);

    // App A replays the same requestId: it MUST dedupe to its ORIGINAL event,
    // not mint a duplicate. Pre-fix, A's row had been clobbered to app-b so the
    // lookup missed and A minted a fresh event (the idempotency bypass).
    const a2 = await store.append({ ...shared, appId: "app-a", payload: streamPayload("A") });
    expect(a2.created).toBe(false);
    expect(a2.event.eventId).toBe(a1.event.eventId);

    // App B likewise still dedupes to its own original event.
    const b2 = await store.append({ ...shared, appId: "app-b", payload: streamPayload("B") });
    expect(b2.created).toBe(false);
    expect(b2.event.eventId).toBe(b1.event.eventId);
  });

  it("single-app deployments are unaffected (default app still dedupes)", async () => {
    const store = new StreamStore(makeDriver(), productTestSchema);
    const base = {
      tenantId: "_default",
      replicaId: "r1",
      requestId: "req-1",
      stream: STREAM,
      streamId: "room",
      event: "MessageSent",
      payload: streamPayload("X"),
    } as const;
    const first = await store.append(base);
    const replay = await store.append(base);
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.event.eventId).toBe(first.event.eventId);
  });
});

const PRESENCE_TYPE = "TypingState";
const PRESENCE_KEY = "conv-1|user-1|device-1";

describe("server-storage-3 — cross-app presence isolation", () => {
  it("app B cannot evict app A's lease at the same (tenant, type, key)", async () => {
    const store = new PresenceStore(makeDriver(), productTestSchema);
    const ttl = 60_000;

    await store.set("tenant-1", PRESENCE_TYPE, PRESENCE_KEY, { isTyping: true }, ttl, "app-a");
    // App B writes the same (tenant, type, key). Pre-fix this overwrote A's row
    // and rewrote app_id=app-b, so A's read returned undefined (silent eviction).
    await store.set("tenant-1", PRESENCE_TYPE, PRESENCE_KEY, { isTyping: false }, ttl, "app-b");

    // Both apps still observe their own value at the shared key.
    expect(await store.read("tenant-1", PRESENCE_TYPE, PRESENCE_KEY, "app-a")).toMatchObject({
      isTyping: true,
    });
    expect(await store.read("tenant-1", PRESENCE_TYPE, PRESENCE_KEY, "app-b")).toMatchObject({
      isTyping: false,
    });
  });

  it("clear in one app does not clear the other app's lease", async () => {
    const store = new PresenceStore(makeDriver(), productTestSchema);
    await store.set("tenant-1", PRESENCE_TYPE, PRESENCE_KEY, { isTyping: true }, 60_000, "app-a");
    await store.set("tenant-1", PRESENCE_TYPE, PRESENCE_KEY, { isTyping: false }, 60_000, "app-b");

    await store.clear("tenant-1", PRESENCE_TYPE, PRESENCE_KEY, "app-b");

    expect(await store.read("tenant-1", PRESENCE_TYPE, PRESENCE_KEY, "app-a")).toMatchObject({
      isTyping: true,
    });
    expect(await store.read("tenant-1", PRESENCE_TYPE, PRESENCE_KEY, "app-b")).toBeUndefined();
  });
});

const SIGNAL_TYPE = "WebRTCSignal";
const SIGNAL_KEY = "call-1";
function sig(sender: string) {
  return { senderDeviceId: sender, kind: "offer", payload: new Uint8Array([1]) } as Record<
    string,
    unknown
  >;
}

describe("server-storage-4 — signal drain is atomic (no duplicate delivery)", () => {
  it("two concurrent drains deliver each queued signal exactly once", async () => {
    const store = new SignalStore(makeDriver(), productTestSchema);
    const ttl = 60_000;
    for (const sender of ["a", "b", "c"]) {
      await store.enqueue("tenant-1", SIGNAL_TYPE, SIGNAL_KEY, sig(sender), ttl, "app-a");
    }

    // Race two drains of the same (app, tenant, type, key). Pre-fix both ran
    // their SELECT before either DELETE and each returned all three rows
    // (at-least-once). With DELETE … RETURNING each row is claimed once.
    const [first, second] = await Promise.all([
      store.drain("tenant-1", SIGNAL_TYPE, SIGNAL_KEY, "app-a"),
      store.drain("tenant-1", SIGNAL_TYPE, SIGNAL_KEY, "app-a"),
    ]);

    const delivered = [...first, ...second]
      .map((v) => (v as { senderDeviceId: string }).senderDeviceId)
      .sort();
    expect(delivered).toEqual(["a", "b", "c"]);
    // No signal delivered twice.
    expect(new Set(delivered).size).toBe(delivered.length);

    // Outbox is empty afterwards.
    const again = await store.drain("tenant-1", SIGNAL_TYPE, SIGNAL_KEY, "app-a");
    expect(again).toEqual([]);
  });

  it("drained signals are returned oldest-first", async () => {
    const store = new SignalStore(makeDriver(), productTestSchema);
    for (const sender of ["first", "second", "third"]) {
      await store.enqueue("tenant-1", SIGNAL_TYPE, SIGNAL_KEY, sig(sender), 60_000, "app-a");
    }
    const drained = await store.drain("tenant-1", SIGNAL_TYPE, SIGNAL_KEY, "app-a");
    expect(drained.map((v) => (v as { senderDeviceId: string }).senderDeviceId)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("a different app cannot drain another app's signals", async () => {
    const store = new SignalStore(makeDriver(), productTestSchema);
    await store.enqueue("tenant-1", SIGNAL_TYPE, SIGNAL_KEY, sig("a"), 60_000, "app-a");
    expect(await store.drain("tenant-1", SIGNAL_TYPE, SIGNAL_KEY, "app-b")).toEqual([]);
    expect(await store.drain("tenant-1", SIGNAL_TYPE, SIGNAL_KEY, "app-a")).toHaveLength(1);
  });
});

describe("server-storage-1 — admin audit hash-chain holds under concurrent record()", () => {
  it("a burst of concurrent record() calls produces an intact chain", async () => {
    const store = new AdminAuditStore(makeDriver());

    // Fire many record() calls concurrently. Pre-fix, the non-atomic
    // read-then-insert let interleaved calls chain off the same predecessor,
    // forking the chain so verifyChain() returns {valid:false}.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.record({
          adminTokenFingerprint: "abc123def456",
          action: "tenants.create",
          target: `tenant-${i}`,
          outcome: "allow",
        }),
      ),
    );

    const verification = await store.verifyChain();
    expect(verification).toEqual({ valid: true });

    const rows = await store.list({ limit: 1000 });
    expect(rows).toHaveLength(20);
    // No two rows share a previous_hash (each chains off a distinct predecessor).
    const prevHashes = rows.map((r) => r.previousHash);
    expect(new Set(prevHashes).size).toBe(prevHashes.length);
  });

  it("sequential record() still chains correctly", async () => {
    const store = new AdminAuditStore(makeDriver());
    const a = await store.record({
      adminTokenFingerprint: "abc123def456",
      action: "tenants.create",
      target: "t1",
      outcome: "allow",
    });
    const b = await store.record({
      adminTokenFingerprint: "abc123def456",
      action: "tenants.archive",
      target: "t1",
      outcome: "allow",
    });
    expect(a.previousHash).toBe("");
    expect(b.previousHash).toBe(a.entryHash);
    expect(await store.verifyChain()).toEqual({ valid: true });
  });
});

describe("server-storage-7 — pruneRetention optional tenant/app scoping", () => {
  async function append(
    store: StreamStore,
    tenant: string,
    app: string,
    streamId: string,
    body: string,
  ) {
    return store.append({
      appId: app,
      tenantId: tenant,
      stream: STREAM,
      streamId,
      replicaId: "r1",
      requestId: `${tenant}-${app}-${streamId}-${body}-${Math.random()}`,
      event: "MessageSent",
      payload: streamPayload(body),
    });
  }

  it("an unscoped age policy prunes the stream type across ALL tenants (documented default)", async () => {
    const store = new StreamStore(makeDriver(), productTestSchema);
    await append(store, "tenant-1", "_default", "room", "old");
    await append(store, "tenant-2", "_default", "room", "old");

    // Far-future clock so every event is older than maxAgeMs.
    const future = () => Date.parse("2030-01-01T00:00:00.000Z");
    const result = await store.pruneRetention({ [STREAM]: { maxAgeMs: 1 } }, future);

    expect(result.prunedByAge).toBe(2);
    expect(await store.read("tenant-1", STREAM, "room", 0)).toHaveLength(0);
    expect(await store.read("tenant-2", STREAM, "room", 0)).toHaveLength(0);
  });

  it("a tenant-scoped age policy only prunes that tenant's events", async () => {
    const store = new StreamStore(makeDriver(), productTestSchema);
    await append(store, "tenant-1", "_default", "room", "old");
    await append(store, "tenant-2", "_default", "room", "old");

    const future = () => Date.parse("2030-01-01T00:00:00.000Z");
    const result = await store.pruneRetention(
      { [STREAM]: { maxAgeMs: 1, tenantId: "tenant-1" } },
      future,
    );

    expect(result.prunedByAge).toBe(1);
    expect(await store.read("tenant-1", STREAM, "room", 0)).toHaveLength(0);
    // tenant-2's history is untouched.
    expect(await store.read("tenant-2", STREAM, "room", 0)).toHaveLength(1);
  });

  it("an app-scoped age policy only prunes that app's events", async () => {
    const store = new StreamStore(makeDriver(), productTestSchema);
    // Two apps in the same tenant, distinct stream ids (the common case).
    await append(store, "tenant-1", "app-a", "room-a", "old");
    await append(store, "tenant-1", "app-b", "room-b", "old");

    const future = () => Date.parse("2030-01-01T00:00:00.000Z");
    const result = await store.pruneRetention(
      { [STREAM]: { maxAgeMs: 1, appId: "app-a" } },
      future,
    );

    expect(result.prunedByAge).toBe(1);
    expect(await store.read("tenant-1", STREAM, "room-a", 0, undefined, "app-a")).toHaveLength(0);
    // app-b's history is untouched.
    expect(await store.read("tenant-1", STREAM, "room-b", 0, undefined, "app-b")).toHaveLength(1);
  });

  it("an app-scoped count policy only prunes that app's events", async () => {
    const store = new StreamStore(makeDriver(), productTestSchema);
    // Two apps in the same tenant, distinct stream ids; keep newest 1 per stream
    // for app-a only. Distinct stream ids keep the per-stream sequence math
    // unambiguous (sequence is global across apps for a SHARED streamId).
    for (const body of ["1", "2", "3"]) await append(store, "tenant-1", "app-a", "room-a", body);
    for (const body of ["1", "2", "3"]) await append(store, "tenant-1", "app-b", "room-b", body);

    const result = await store.pruneRetention({
      [STREAM]: { maxEvents: 1, appId: "app-a" },
    });

    expect(result.prunedByCount).toBe(2);
    expect(await store.read("tenant-1", STREAM, "room-a", 0, undefined, "app-a")).toHaveLength(1);
    // app-b keeps all three.
    expect(await store.read("tenant-1", STREAM, "room-b", 0, undefined, "app-b")).toHaveLength(3);
  });
});
