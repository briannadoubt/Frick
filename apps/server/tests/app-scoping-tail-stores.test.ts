import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { productTestSchema } from "@fricken/protocol";
import { initializeStorage } from "../src/storage/schema.js";
import { SqliteSqlDriver } from "../src/storage/sql-driver.js";
import { BlobStore } from "../src/storage/blob-store.js";
import { PresenceStore } from "../src/storage/presence-store.js";
import { SignalStore } from "../src/storage/signal-store.js";
import { JobStore } from "../src/storage/job-store.js";
import { FrickCrossAppAccessError } from "../src/storage/object-errors.js";
import { DEFAULT_APP_ID } from "../src/app-id.js";

/**
 * FR-153 (tail) — per-app scoping threaded through the remaining stores that
 * previously defaulted everything: blobs (metadata + bytes), presence, signals,
 * and jobs. Mirrors `app-scoping.test.ts` (objects/streams): every read filters
 * by app_id, every write stamps it, and the defaulted `_default` app keeps
 * single-app callers byte-for-byte unchanged.
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

const TENANT = "tenant-1";

describe("BlobStore per-app scoping (FR-153)", () => {
  function meta(blobId: string, ownerId = "owner-1") {
    return {
      blobId,
      ownerId,
      contentHash: `hash-${blobId}`,
      byteLength: 3,
      mimeType: "text/plain",
    };
  }

  it("isolates metadata reads/lists across apps", async () => {
    const blobs = new BlobStore(makeDb());

    await blobs.create(TENANT, meta("a-1"), "app-a");
    await blobs.create(TENANT, meta("b-1"), "app-b");

    expect(await blobs.read(TENANT, "a-1", "app-a")).toMatchObject({ blobId: "a-1", appId: "app-a" });
    expect(await blobs.read(TENANT, "a-1", "app-b")).toBeUndefined();
    expect(await blobs.read(TENANT, "a-1")).toBeUndefined();

    expect((await blobs.list(TENANT, undefined, "app-a")).map((b) => b.blobId)).toEqual(["a-1"]);
    expect((await blobs.list(TENANT, undefined, "app-b")).map((b) => b.blobId)).toEqual(["b-1"]);
  });

  it("rejects a cross-app metadata write to a blob id owned by another app", async () => {
    const blobs = new BlobStore(makeDb());
    await blobs.create(TENANT, meta("shared"), "app-a");

    await expect(blobs.create(TENANT, meta("shared", "owner-2"), "app-b")).rejects.toBeInstanceOf(
      FrickCrossAppAccessError,
    );
    // app-a's row is untouched.
    expect(await blobs.read(TENANT, "shared", "app-a")).toMatchObject({ ownerId: "owner-1" });
  });

  it("isolates blob bytes (sqlite content backend) across apps", async () => {
    const blobs = new BlobStore(makeDb());
    const a = new TextEncoder().encode("AAA");
    const b = new TextEncoder().encode("BBB");

    // blob_content has an FK to blob_metadata, so create the metadata rows
    // first (each under its own app).
    await blobs.create(TENANT, meta("blob-1"), "app-a");
    await blobs.create(TENANT, meta("blob-2"), "app-b");

    await blobs.writeContent(TENANT, "blob-1", a, "app-a");
    await blobs.writeContent(TENANT, "blob-2", b, "app-b");

    expect(await blobs.readContent(TENANT, "blob-1", "app-a")).toEqual(Buffer.from(a));
    expect(await blobs.readContent(TENANT, "blob-1", "app-b")).toBeUndefined();
    expect(await blobs.hasContent(TENANT, "blob-2", "app-b")).toBe(true);
    expect(await blobs.hasContent(TENANT, "blob-2", "app-a")).toBe(false);
  });

  it("totalBytesForOwner is app-scoped", async () => {
    const blobs = new BlobStore(makeDb());
    await blobs.create(TENANT, { ...meta("a-1"), byteLength: 10 }, "app-a");
    await blobs.create(TENANT, { ...meta("a-2"), byteLength: 5 }, "app-a");
    await blobs.create(TENANT, { ...meta("b-1"), byteLength: 99 }, "app-b");

    expect(await blobs.totalBytesForOwner(TENANT, "owner-1", "app-a")).toBe(15);
    expect(await blobs.totalBytesForOwner(TENANT, "owner-1", "app-b")).toBe(99);
    expect(await blobs.totalBytesForOwner(TENANT, "owner-1")).toBe(0);
  });

  it("defaults to '_default' so single-app callers are unaffected", async () => {
    const blobs = new BlobStore(makeDb());
    await blobs.create(TENANT, meta("d-1"));
    expect(await blobs.read(TENANT, "d-1")).toMatchObject({ blobId: "d-1", appId: DEFAULT_APP_ID });
    expect(await blobs.read(TENANT, "d-1", DEFAULT_APP_ID)).toMatchObject({ blobId: "d-1" });
  });
});

describe("PresenceStore per-app scoping (FR-153)", () => {
  const TYPE = "TypingState";
  const KEY_A = "conversation-general:user-ada:device-1";
  const KEY_B = "conversation-general:user-grace:device-2";

  it("stamps app_id and isolates reads across apps", async () => {
    const presence = new PresenceStore(makeDb(), productTestSchema);

    await presence.set(TENANT, TYPE, KEY_A, { isTyping: true }, 60_000, "app-a");
    await presence.set(TENANT, TYPE, KEY_B, { isTyping: false }, 60_000, "app-b");

    // Each app reads only its own lease; cross-app reads return undefined.
    expect(await presence.read(TENANT, TYPE, KEY_A, "app-a")).toMatchObject({ isTyping: true });
    expect(await presence.read(TENANT, TYPE, KEY_A, "app-b")).toBeUndefined();
    expect(await presence.read(TENANT, TYPE, KEY_B, "app-b")).toMatchObject({ isTyping: false });
    expect(await presence.read(TENANT, TYPE, KEY_B, "app-a")).toBeUndefined();
    // Default app sees neither.
    expect(await presence.read(TENANT, TYPE, KEY_A)).toBeUndefined();

    // Clearing under app-b (wrong app for KEY_A) is a no-op; the owning app's
    // lease survives. The presence_leases PK is (tenant, type, key) — like the
    // stream sequence, the key namespace is shared, so isolation is enforced on
    // the app_id read filter, and clear() is likewise app-scoped.
    await presence.clear(TENANT, TYPE, KEY_A, "app-b");
    expect(await presence.read(TENANT, TYPE, KEY_A, "app-a")).toMatchObject({ isTyping: true });
    await presence.clear(TENANT, TYPE, KEY_A, "app-a");
    expect(await presence.read(TENANT, TYPE, KEY_A, "app-a")).toBeUndefined();
  });

  it("defaults to '_default' so single-app callers are unaffected", async () => {
    const presence = new PresenceStore(makeDb(), productTestSchema);
    await presence.set(TENANT, TYPE, KEY_A, { isTyping: true }, 60_000);
    expect(await presence.read(TENANT, TYPE, KEY_A)).toMatchObject({ isTyping: true });
    expect(await presence.read(TENANT, TYPE, KEY_A, DEFAULT_APP_ID)).toMatchObject({ isTyping: true });
  });
});

describe("SignalStore per-app scoping (FR-153)", () => {
  const TYPE = "WebRTCSignal";

  function sig(sender: string) {
    return { senderDeviceId: sender, kind: "offer", payload: new Uint8Array([1]) } as Record<
      string,
      unknown
    >;
  }

  it("isolates signal drains across apps", async () => {
    const signals = new SignalStore(makeDb(), productTestSchema);

    await signals.enqueue(TENANT, TYPE, "call-1", sig("a"), 60_000, "app-a");
    await signals.enqueue(TENANT, TYPE, "call-1", sig("b"), 60_000, "app-b");

    // app-a only drains its own queued signal; app-b's stays put.
    const a = await signals.drain(TENANT, TYPE, "call-1", "app-a");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ senderDeviceId: "a" });
    // app-a is now empty; app-b still has its signal.
    expect(await signals.drain(TENANT, TYPE, "call-1", "app-a")).toEqual([]);
    const b = await signals.drain(TENANT, TYPE, "call-1", "app-b");
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ senderDeviceId: "b" });
    // Default app never saw either.
    expect(await signals.drain(TENANT, TYPE, "call-1")).toEqual([]);
  });
});

describe("JobStore per-app scoping + dispatch (FR-153)", () => {
  it("stamps app_id on enqueue and surfaces it on the row", async () => {
    const jobs = new JobStore(makeDb());
    const row = await jobs.enqueue({ tenantId: TENANT, appId: "app-a", jobType: "send", payload: { n: 1 } });
    expect(row.appId).toBe("app-a");
    const defaultRow = await jobs.enqueue({ tenantId: TENANT, jobType: "send", payload: { n: 2 } });
    expect(defaultRow.appId).toBe(DEFAULT_APP_ID);
  });

  it("an app-scoped claim only claims that app's jobs (per-app dispatch)", async () => {
    const jobs = new JobStore(makeDb());
    await jobs.enqueue({ tenantId: TENANT, appId: "app-a", jobType: "send", payload: { who: "a" } });
    await jobs.enqueue({ tenantId: TENANT, appId: "app-b", jobType: "send", payload: { who: "b" } });

    const claimedA = await jobs.claim("worker-a", undefined, 10, "app-a");
    expect(claimedA).toHaveLength(1);
    expect(claimedA[0]?.appId).toBe("app-a");
    expect(claimedA[0]?.payload).toMatchObject({ who: "a" });

    // app-b's job was not claimed by the app-a worker.
    const claimedB = await jobs.claim("worker-b", undefined, 10, "app-b");
    expect(claimedB).toHaveLength(1);
    expect(claimedB[0]?.appId).toBe("app-b");
    expect(claimedB[0]?.payload).toMatchObject({ who: "b" });
  });

  it("idempotency dedupe is app-scoped: same key in two apps yields two jobs", async () => {
    const jobs = new JobStore(makeDb());
    const a = await jobs.enqueue({
      tenantId: TENANT,
      appId: "app-a",
      jobType: "send",
      payload: { n: 1 },
      idempotencyKey: "k-1",
    });
    const b = await jobs.enqueue({
      tenantId: TENANT,
      appId: "app-b",
      jobType: "send",
      payload: { n: 2 },
      idempotencyKey: "k-1",
    });
    expect(b.id).not.toBe(a.id);
    expect(a.appId).toBe("app-a");
    expect(b.appId).toBe("app-b");

    // A second enqueue with the same (app, key) dedupes back to the existing row.
    const aAgain = await jobs.enqueue({
      tenantId: TENANT,
      appId: "app-a",
      jobType: "send",
      payload: { n: 99 },
      idempotencyKey: "k-1",
    });
    expect(aAgain.id).toBe(a.id);
  });

  it("list filters by app; default cross-app claim is unchanged", async () => {
    const jobs = new JobStore(makeDb());
    await jobs.enqueue({ tenantId: TENANT, appId: "app-a", jobType: "send", payload: {} });
    await jobs.enqueue({ tenantId: TENANT, appId: "app-b", jobType: "send", payload: {} });

    expect(await jobs.list({ appId: "app-a" })).toHaveLength(1);
    expect(await jobs.list({ appId: "app-b" })).toHaveLength(1);
    expect(await jobs.list({})).toHaveLength(2);

    // A claim with no appId (the single-app default) still drains across apps.
    const claimed = await jobs.claim("worker", undefined, 10);
    expect(claimed).toHaveLength(2);
  });
});
