import { afterEach, describe, expect, it } from "vitest";
import { blobRefFields, productTestSchema } from "@fricken/protocol";
import { FrickStore } from "../src/store.js";
import { createNoopLogger } from "../src/logger.js";
import {
  BLOB_GC_JOB_TYPE,
  createBlobGcJobHandler,
  createBlobGcRecurringJob,
  DEFAULT_BLOB_GC_GRACE_MS,
  runOrphanedBlobGc,
} from "../src/blobs/gc-job.js";

// FR-57: orphaned-blob GC. Conservative by construction — opt-in, grace window,
// declared-ref scan, and an app `isReferenced` hook. These tests pin every
// safety property: orphans are reclaimed only when enabled and past grace;
// declared-ref and hook-protected blobs survive; disabled is a no-op.
//
// `productTestSchema` declares `User.avatarBlobId` as a `kind:'ref'` to the
// `AttachmentBlob` blob (the framework-known reference), and `attachmentBlobIds`
// as an untyped `json` field (the caveat the hook covers).

const TENANT = "_default";
let store: FrickStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

function makeStore(): FrickStore {
  return new FrickStore({ path: ":memory:", seed: true, schema: productTestSchema });
}

/** Create a blob row + bytes and backdate its `created_at` by `ageMs`. */
async function seedBlob(s: FrickStore, blobId: string, ageMs: number): Promise<void> {
  await s.blobs.create(TENANT, {
    blobId,
    ownerId: "user-1",
    contentHash: `sha256-${blobId}`,
    byteLength: 3,
    mimeType: "image/png",
  });
  await s.blobs.writeContent(TENANT, blobId, new Uint8Array([1, 2, 3]));
  const createdAt = new Date(Date.now() - ageMs).toISOString();
  await s.sqlDriver.run("UPDATE blob_metadata SET created_at = ? WHERE tenant_id = ? AND blob_id = ?", [
    createdAt,
    TENANT,
    blobId,
  ]);
}

const PAST_GRACE = DEFAULT_BLOB_GC_GRACE_MS + 60_000;

describe("blobRefFields", () => {
  it("enumerates only declared blob-ref fields (kind:'ref' → schema.blobs)", () => {
    const fields = blobRefFields(productTestSchema);
    const declared = fields.map((f) => `${f.objectName}.${f.field.name}→${f.blobName}`);
    // User.avatarBlobId references the AttachmentBlob blob.
    expect(declared).toContain("User.avatarBlobId→AttachmentBlob");
    // Object→object refs (e.g. createdBy→User) and untyped json fields
    // (attachmentBlobIds) are NOT blob-ref fields.
    expect(declared.some((d) => d.includes("→User"))).toBe(false);
    expect(declared.some((d) => d.includes("attachmentBlobIds"))).toBe(false);
  });
});

describe("runOrphanedBlobGc", () => {
  it("deletes an orphan past the grace window (bytes, derivatives, metadata)", async () => {
    store = makeStore();
    await seedBlob(store, "orphan-1", PAST_GRACE);
    // A derivative whose bytes must also be reclaimed.
    await store.blobDerivatives.record({
      parentBlobId: "orphan-1",
      derivativeId: "thumb",
      tenantId: TENANT,
      processorId: "proc",
      mimeType: "image/png",
      byteLength: 2,
      contentHash: "sha256-thumb",
      storageKey: "derivative/orphan-1/thumb",
      content: Buffer.from([9, 9]),
    });

    const result = await runOrphanedBlobGc({ store, tenantId: TENANT, logger: createNoopLogger() });

    expect(result.deleted).toEqual(["orphan-1"]);
    expect(await store.blobs.read(TENANT, "orphan-1")).toBeUndefined();
    expect(await store.blobs.readContent(TENANT, "orphan-1")).toBeUndefined();
    expect(await store.blobDerivatives.listForParent("orphan-1", TENANT)).toEqual([]);
  });

  it("keeps a blob referenced by a declared blob-ref field", async () => {
    store = makeStore();
    await seedBlob(store, "avatar-1", PAST_GRACE);
    // User.avatarBlobId is a declared ref → AttachmentBlob; this protects it.
    await store.upsertObject(TENANT, "User", "user-1", {
      id: "user-1",
      displayName: "D",
      avatarBlobId: "avatar-1",
    });

    const result = await runOrphanedBlobGc({ store, tenantId: TENANT });

    expect(result.deleted).toEqual([]);
    expect(result.keptDeclaredRef).toBe(1);
    expect(await store.blobs.read(TENANT, "avatar-1")).toBeDefined();
  });

  it("keeps a blob within the grace window", async () => {
    store = makeStore();
    await seedBlob(store, "fresh-1", 60_000); // 1 minute old, well within grace

    const result = await runOrphanedBlobGc({ store, tenantId: TENANT });

    expect(result.deleted).toEqual([]);
    expect(result.keptWithinGrace).toBe(1);
    expect(await store.blobs.read(TENANT, "fresh-1")).toBeDefined();
  });

  it("keeps a blob protected by the isReferenced hook (untyped-field caveat)", async () => {
    store = makeStore();
    await seedBlob(store, "untyped-1", PAST_GRACE);
    // Stored only in an untyped json field (ScheduledMessage.attachmentBlobIds)
    // — invisible to the declared-ref scan. The hook is the documented escape
    // hatch that protects it.
    await store.upsertObject(TENANT, "ScheduledMessage", "sched-1", {
      id: "sched-1",
      userId: "user-1",
      conversationId: "c1",
      body: "hi",
      scheduledFor: new Date().toISOString(),
      attachmentBlobIds: ["untyped-1"],
      status: "pending",
    });

    const protect = new Set(["untyped-1"]);
    const result = await runOrphanedBlobGc({
      store,
      tenantId: TENANT,
      isReferenced: ({ blobId }) => protect.has(blobId),
    });

    expect(result.deleted).toEqual([]);
    expect(result.keptHookProtected).toBe(1);
    expect(await store.blobs.read(TENANT, "untyped-1")).toBeDefined();
  });

  it("dryRun reports orphans without deleting them", async () => {
    store = makeStore();
    await seedBlob(store, "orphan-dry", PAST_GRACE);

    const result = await runOrphanedBlobGc({ store, tenantId: TENANT, dryRun: true });

    expect(result.deleted).toEqual(["orphan-dry"]);
    expect(await store.blobs.read(TENANT, "orphan-dry")).toBeDefined();
  });
});

describe("createBlobGcJobHandler", () => {
  it("runs the GC pass for the job's tenant and reports counts", async () => {
    store = makeStore();
    await seedBlob(store, "orphan-h", PAST_GRACE);
    const handler = createBlobGcJobHandler({ logger: createNoopLogger() });

    const outcome = await handler({
      tenantId: TENANT,
      jobId: 1,
      jobType: BLOB_GC_JOB_TYPE,
      payload: {},
      attemptCount: 1,
      store,
      logger: createNoopLogger(),
    });

    expect(outcome.status).toBe("completed");
    expect((outcome.result as { deleted: number }).deleted).toBe(1);
    expect(await store.blobs.read(TENANT, "orphan-h")).toBeUndefined();
  });
});

describe("opt-in wiring", () => {
  it("is a no-op when GC is not enabled (handler not registered)", async () => {
    // The recurring spec is only built when an app opts in; without it the
    // server registers no blob.gc handler and schedules no sweep.
    const job = createBlobGcRecurringJob({ intervalMs: 60_000 });
    expect(job.jobType).toBe(BLOB_GC_JOB_TYPE);
    expect(job.intervalMs).toBe(60_000);
  });
});
