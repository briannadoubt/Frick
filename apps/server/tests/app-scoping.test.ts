import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { productTestSchema } from "@fricken/protocol";
import { initializeStorage } from "../src/storage/schema.js";
import { SqliteSqlDriver } from "../src/storage/sql-driver.js";
import { ObjectStore } from "../src/storage/object-store.js";
import { StreamStore } from "../src/storage/stream-store.js";
import { FrickCrossAppAccessError } from "../src/storage/object-errors.js";
import { DEFAULT_APP_ID } from "../src/app-id.js";

/**
 * FR-37: per-app scoping threaded through the read/write store layer. Every
 * read filters by app_id, every write stamps it, and cross-app writes to the
 * same (tenant, type, id) are rejected. These tests prove an app can neither
 * read nor write another app's objects or streams, while the defaulted
 * '_default' app keeps existing single-app callers working unchanged.
 */

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function makeDb(): SqliteSqlDriver {
  db = new DatabaseSync(":memory:");
  initializeStorage(db, productTestSchema.schemaRevision);
  return new SqliteSqlDriver(db);
}

const TYPE = "Conversation";
const TENANT = "tenant-1";

function convo(id: string, title: string) {
  return { id, title } as Record<string, unknown>;
}

describe("ObjectStore per-app scoping (FR-37)", () => {
  it("isolates reads: app B cannot read app A's object at the same tenant+id", async () => {
    const store = new ObjectStore(makeDb(), productTestSchema);

    await store.upsert(TENANT, TYPE, "c-1", convo("c-1", "A's convo"), 1, "app-a");

    // Same tenant + type + id, different app: invisible to app B.
    expect(await store.read(TENANT, TYPE, "c-1", "app-b")).toBeUndefined();
    // Visible to its owner.
    expect(await store.read(TENANT, TYPE, "c-1", "app-a")).toMatchObject({ title: "A's convo" });
    // And invisible to the default app too.
    expect(await store.read(TENANT, TYPE, "c-1")).toBeUndefined();
  });

  it("isolates lists: each app only lists its own objects", async () => {
    const store = new ObjectStore(makeDb(), productTestSchema);

    await store.upsert(TENANT, TYPE, "a-1", convo("a-1", "A1"), 1, "app-a");
    await store.upsert(TENANT, TYPE, "b-1", convo("b-1", "B1"), 1, "app-b");

    const a = await store.list(TENANT, TYPE, "app-a");
    const b = await store.list(TENANT, TYPE, "app-b");
    expect(a.map((o) => o.id)).toEqual(["a-1"]);
    expect(b.map((o) => o.id)).toEqual(["b-1"]);
  });

  it("rejects a cross-app write to a row owned by another app", async () => {
    const store = new ObjectStore(makeDb(), productTestSchema);

    await store.upsert(TENANT, TYPE, "c-1", convo("c-1", "A's convo"), 1, "app-a");

    // app B tries to clobber the same PK row — denied.
    await expect(
      store.upsert(TENANT, TYPE, "c-1", convo("c-1", "B's hijack"), 2, "app-b"),
    ).rejects.toBeInstanceOf(FrickCrossAppAccessError);

    // The policy write path is guarded too.
    await expect(
      store.upsertWithPolicy({
        appId: "app-b",
        tenantId: TENANT,
        objectType: TYPE,
        objectId: "c-1",
        value: convo("c-1", "B's hijack"),
        mergePolicy: "lastWriteWins",
      }),
    ).rejects.toBeInstanceOf(FrickCrossAppAccessError);

    // A's row is untouched.
    expect(await store.read(TENANT, TYPE, "c-1", "app-a")).toMatchObject({ title: "A's convo" });
  });

  it("isolates deletes: app B deleting app A's id is a no-op", async () => {
    const store = new ObjectStore(makeDb(), productTestSchema);

    await store.upsert(TENANT, TYPE, "c-1", convo("c-1", "A's convo"), 1, "app-a");

    expect(await store.delete(TENANT, TYPE, "c-1", "app-b")).toBe(false);
    expect(await store.read(TENANT, TYPE, "c-1", "app-a")).toMatchObject({ title: "A's convo" });

    expect(await store.delete(TENANT, TYPE, "c-1", "app-a")).toBe(true);
    expect(await store.read(TENANT, TYPE, "c-1", "app-a")).toBeUndefined();
  });

  it("defaults to '_default' so single-app callers are unaffected", async () => {
    const store = new ObjectStore(makeDb(), productTestSchema);

    await store.upsert(TENANT, TYPE, "c-1", convo("c-1", "Default"), 1);
    // No appId arg reads back the same row.
    expect(await store.read(TENANT, TYPE, "c-1")).toMatchObject({ title: "Default" });
    // Explicit DEFAULT_APP_ID is equivalent.
    expect(await store.read(TENANT, TYPE, "c-1", DEFAULT_APP_ID)).toMatchObject({
      title: "Default",
    });
  });
});

describe("StreamStore per-app scoping (FR-37)", () => {
  const STREAM = "MessageStream";

  function makeStreams(): StreamStore {
    return new StreamStore(makeDb(), productTestSchema);
  }

  async function appendMsg(store: StreamStore, streamId: string, body: string, appId?: string) {
    return store.append({
      appId,
      tenantId: TENANT,
      stream: STREAM,
      streamId,
      replicaId: "r1",
      requestId: `${appId ?? "_default"}-${streamId}-${body}`,
      event: "MessageSent",
      payload: {
        messageId: `m-${body}`,
        senderId: "user-ada",
        body,
        createdAt: "2026-05-31T00:00:00.000Z",
      },
    });
  }

  it("isolates stream reads: app B cannot read app A's events", async () => {
    const store = makeStreams();

    await appendMsg(store, "room-1", "from-a", "app-a");

    expect(await store.read(TENANT, STREAM, "room-1", 0, undefined, "app-a")).toHaveLength(1);
    expect(await store.read(TENANT, STREAM, "room-1", 0, undefined, "app-b")).toHaveLength(0);
    // Default app sees nothing either.
    expect(await store.read(TENANT, STREAM, "room-1", 0)).toHaveLength(0);
  });

  it("stamps appId on stored events; sequence is shared across the stream PK", async () => {
    const store = makeStreams();

    const a1 = await appendMsg(store, "room-1", "a1", "app-a");
    const a2 = await appendMsg(store, "room-1", "a2", "app-a");
    const b1 = await appendMsg(store, "room-1", "b1", "app-b");

    expect(a1.event.appId).toBe("app-a");
    expect(a1.event.sequence).toBe(1);
    expect(a2.event.sequence).toBe(2);
    // The stream_events PRIMARY KEY (tenant, stream_type, stream_id, sequence)
    // does NOT include app_id, so sequence is shared across the key — app-b's
    // event takes the next global sequence (3), not a per-app 1. Isolation is
    // enforced on reads (each app only sees its own events), proven below.
    expect(b1.event.appId).toBe("app-b");
    expect(b1.event.sequence).toBe(3);
    // app-a sees only its two events; app-b sees only its one.
    expect(await store.read(TENANT, STREAM, "room-1", 0, undefined, "app-a")).toHaveLength(2);
    expect(await store.read(TENANT, STREAM, "room-1", 0, undefined, "app-b")).toHaveLength(1);
  });

  it("stamps app_id on the idempotency row and dedups replays within an app", async () => {
    const store = makeStreams();

    const a = await store.append({
      appId: "app-a",
      tenantId: TENANT,
      stream: STREAM,
      streamId: "room-1",
      replicaId: "r-1",
      requestId: "req-1",
      event: "MessageSent",
      payload: { messageId: "m-a", senderId: "u", body: "a", createdAt: "2026-05-31T00:00:00.000Z" },
    });
    expect(a.created).toBe(true);
    expect(a.event.appId).toBe("app-a");

    // A replay within the same app dedupes to the same event (the idempotency
    // row is stamped with app_id and looked up app-scoped).
    const aReplay = await store.append({
      appId: "app-a",
      tenantId: TENANT,
      stream: STREAM,
      streamId: "room-1",
      replicaId: "r-1",
      requestId: "req-1",
      event: "MessageSent",
      payload: { messageId: "m-a", senderId: "u", body: "a", createdAt: "2026-05-31T00:00:00.000Z" },
    });
    expect(aReplay.created).toBe(false);
    expect(aReplay.event.eventId).toBe(a.event.eventId);

    // The persisted idempotency row carries the app stamp.
    const idemRow = db!
      .prepare(
        "SELECT app_id FROM idempotency_keys WHERE tenant_id = ? AND replica_id = ? AND request_id = ?",
      )
      .get(TENANT, "r-1", "req-1") as { app_id: string } | undefined;
    expect(idemRow?.app_id).toBe("app-a");
  });

  it("listAll / head are app-scoped", async () => {
    const store = makeStreams();

    await appendMsg(store, "room-1", "a1", "app-a");
    await appendMsg(store, "room-1", "b1", "app-b");

    expect(await store.listAll(TENANT, "app-a")).toHaveLength(1);
    expect(await store.listAll(TENANT, "app-b")).toHaveLength(1);

    const headA = await store.head(TENANT, STREAM, "room-1", "app-a");
    const headB = await store.head(TENANT, STREAM, "room-1", "app-b");
    expect(headA.count).toBe(1);
    expect(headB.count).toBe(1);
    // Default app: empty.
    expect((await store.head(TENANT, STREAM, "room-1")).count).toBe(0);
  });
});
