import { afterEach, describe, expect, it } from "vitest";
import { productTestSchema } from "@fricken/protocol";
import { FrickStore } from "../src/store.js";
import { createNoopLogger } from "../src/logger.js";
import {
  createBlobGcRecurringJob,
  DEFAULT_BLOB_GC_GRACE_MS,
  runOrphanedBlobGc,
} from "../src/blobs/gc-job.js";

// Regression tests for the audited blob-GC findings:
//   blob-gc-2 / tenant-app-isolation-6 — sweep ALL apps, not just `_default`.
//   blob-gc-3 — TOCTOU: re-referencing an aged orphan during a pass must NOT
//               delete the now-live blob.
//   blob-gc-4 — bounded/paginated scan (no full materialization).
//   blob-gc-6 — isReferenced hook: only an explicit `false` may delete; any
//               non-boolean / undefined / throwing return fails SAFE (keep).
//
// `productTestSchema` declares `User.avatarBlobId` as a declared blob-ref and
// `ScheduledMessage.attachmentBlobIds` as an untyped json field (hook caveat).

const TENANT = "_default";
const OTHER_APP = "app-b";
const PAST_GRACE = DEFAULT_BLOB_GC_GRACE_MS + 60_000;

let store: FrickStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

function makeStore(): FrickStore {
  return new FrickStore({ path: ":memory:", seed: true, schema: productTestSchema });
}

async function seedBlob(
  s: FrickStore,
  blobId: string,
  ageMs: number,
  appId = "_default",
): Promise<void> {
  await s.blobs.create(
    TENANT,
    {
      blobId,
      ownerId: "user-1",
      contentHash: `sha256-${blobId}`,
      byteLength: 3,
      mimeType: "image/png",
    },
    appId,
  );
  await s.blobs.writeContent(TENANT, blobId, new Uint8Array([1, 2, 3]), appId);
  const createdAt = new Date(Date.now() - ageMs).toISOString();
  await s.sqlDriver.run(
    "UPDATE blob_metadata SET created_at = ? WHERE app_id = ? AND tenant_id = ? AND blob_id = ?",
    [createdAt, appId, TENANT, blobId],
  );
}

describe("blob GC — multi-app sweep (blob-gc-2 / tenant-app-isolation-6)", () => {
  it("reclaims an orphan in a NON-default app when appId is threaded", async () => {
    store = makeStore();
    await seedBlob(store, "orphan-b", PAST_GRACE, OTHER_APP);

    // Default-app sweep must NOT see the other app's blob (isolation).
    const defaultPass = await runOrphanedBlobGc({ store, tenantId: TENANT });
    expect(defaultPass.scanned).toBe(0);
    expect(defaultPass.deleted).toEqual([]);
    expect(await store.blobs.read(TENANT, "orphan-b", OTHER_APP)).toBeDefined();

    // Scoped to the owning app, the orphan IS reclaimed.
    const appPass = await runOrphanedBlobGc({ store, tenantId: TENANT, appId: OTHER_APP });
    expect(appPass.deleted).toEqual(["orphan-b"]);
    expect(await store.blobs.read(TENANT, "orphan-b", OTHER_APP)).toBeUndefined();
    expect(await store.blobs.readContent(TENANT, "orphan-b", OTHER_APP)).toBeUndefined();
  });

  it("keeps a declared-ref blob in a non-default app (scan scoped to app)", async () => {
    store = makeStore();
    await seedBlob(store, "avatar-b", PAST_GRACE, OTHER_APP);
    // Declared ref lives in the SAME (tenant, app) partition.
    await store.objects.upsert(
      TENANT,
      "User",
      "user-1",
      { id: "user-1", displayName: "D", avatarBlobId: "avatar-b" },
      1,
      OTHER_APP,
    );

    const pass = await runOrphanedBlobGc({ store, tenantId: TENANT, appId: OTHER_APP });
    expect(pass.deleted).toEqual([]);
    expect(pass.keptDeclaredRef).toBe(1);
    expect(await store.blobs.read(TENANT, "avatar-b", OTHER_APP)).toBeDefined();
  });

  it("recurring resolver fans out one target per (tenant, app) that holds blobs", async () => {
    store = makeStore();
    await seedBlob(store, "d-1", PAST_GRACE, "_default");
    await seedBlob(store, "b-1", PAST_GRACE, OTHER_APP);

    const job = createBlobGcRecurringJob();
    const targets = [
      ...(await job.resolveTargets({ store, logger: createNoopLogger() })),
    ];
    const appIds = targets
      .filter((t) => t.tenantId === TENANT)
      .map((t) => t.appId)
      .sort();
    expect(appIds).toEqual(["_default", OTHER_APP]);
  });
});

describe("blob GC — TOCTOU re-reference (blob-gc-3)", () => {
  it("does NOT delete an aged orphan that gets re-referenced mid-pass", async () => {
    store = makeStore();
    await seedBlob(store, "aged-1", PAST_GRACE);

    // Simulate the race: the hook is consulted at delete time. On first call we
    // re-attach the blob to a real declared-ref object, exactly as a concurrent
    // client write would. The delete-time declared-ref re-scan must then see it.
    let attached = false;
    const result = await runOrphanedBlobGc({
      store,
      tenantId: TENANT,
      isReferenced: async ({ blobId }) => {
        if (!attached && blobId === "aged-1") {
          attached = true;
          await store!.objects.upsert(
            TENANT,
            "User",
            "user-1",
            { id: "user-1", displayName: "D", avatarBlobId: "aged-1" },
            1,
          );
        }
        // The hook itself does not protect it — the declared-ref RE-SCAN must.
        return false;
      },
    });

    expect(result.deleted).toEqual([]);
    expect(result.keptDeclaredRef).toBe(1);
    expect(await store.blobs.read(TENANT, "aged-1")).toBeDefined();
    expect(await store.blobs.readContent(TENANT, "aged-1")).toBeDefined();
  });

  it("skips a blob already removed by a concurrent actor before delete", async () => {
    store = makeStore();
    await seedBlob(store, "gone-1", PAST_GRACE);

    const result = await runOrphanedBlobGc({
      store,
      tenantId: TENANT,
      isReferenced: async ({ blobId }) => {
        if (blobId === "gone-1") {
          // Another actor deletes it out from under the sweep right before the
          // re-check. The GC must not crash and must not "double delete".
          await store!.blobs.deleteContent(TENANT, "gone-1");
          await store!.blobs.deleteMetadata(TENANT, "gone-1");
        }
        return false;
      },
    });

    expect(result.deleted).toEqual([]);
  });
});

describe("blob GC — bounded/paginated scan (blob-gc-4)", () => {
  it("reclaims every orphan across multiple pages with a tiny pageSize", async () => {
    store = makeStore();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const id = `p-${i}`;
      ids.push(id);
      await seedBlob(store, id, PAST_GRACE + i * 1000);
    }

    const result = await runOrphanedBlobGc({
      store,
      tenantId: TENANT,
      pageSize: 2,
    });

    expect(result.scanned).toBe(7);
    expect(result.deleted.slice().sort()).toEqual(ids.slice().sort());
    for (const id of ids) {
      expect(await store.blobs.read(TENANT, id)).toBeUndefined();
    }
  });

  it("does not load the whole tenant: listAllOldestFirst is never called", async () => {
    store = makeStore();
    await seedBlob(store, "x-1", PAST_GRACE);
    await seedBlob(store, "x-2", PAST_GRACE);

    let fullScans = 0;
    const original = store.blobs.listAllOldestFirst.bind(store.blobs);
    store.blobs.listAllOldestFirst = async (...a: Parameters<typeof original>) => {
      fullScans += 1;
      return original(...a);
    };

    const result = await runOrphanedBlobGc({ store, tenantId: TENANT, pageSize: 1 });
    expect(result.deleted.sort()).toEqual(["x-1", "x-2"]);
    expect(fullScans).toBe(0);
  });
});

describe("blob GC — isReferenced fail-safe coercion (blob-gc-6)", () => {
  async function runWithHook(hookReturn: unknown): Promise<{
    deleted: string[];
    present: boolean;
  }> {
    const s = makeStore();
    store = s;
    await seedBlob(s, "hook-1", PAST_GRACE);
    const result = await runOrphanedBlobGc({
      store: s,
      tenantId: TENANT,
      logger: createNoopLogger(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isReferenced: (() => hookReturn) as any,
    });
    const present = (await s.blobs.read(TENANT, "hook-1")) !== undefined;
    return { deleted: result.deleted, present };
  }

  it("deletes ONLY when the hook returns a strict boolean false", async () => {
    const { deleted, present } = await runWithHook(false);
    expect(deleted).toEqual(["hook-1"]);
    expect(present).toBe(false);
  });

  it("keeps the blob when the hook returns true", async () => {
    const { deleted, present } = await runWithHook(true);
    expect(deleted).toEqual([]);
    expect(present).toBe(true);
  });

  it("keeps the blob when the hook returns undefined (forgotten return)", async () => {
    const { deleted, present } = await runWithHook(undefined);
    expect(deleted).toEqual([]);
    expect(present).toBe(true);
  });

  it("keeps the blob when the hook returns a falsy non-boolean (0 / '' / null)", async () => {
    for (const v of [0, "", null]) {
      const { deleted, present } = await runWithHook(v);
      expect(deleted).toEqual([]);
      expect(present).toBe(true);
    }
  });

  it("keeps the blob when the hook throws (unknown → fail safe)", async () => {
    store = makeStore();
    await seedBlob(store, "throw-1", PAST_GRACE);
    const result = await runOrphanedBlobGc({
      store,
      tenantId: TENANT,
      logger: createNoopLogger(),
      isReferenced: () => {
        throw new Error("boom");
      },
    });
    expect(result.deleted).toEqual([]);
    expect(await store.blobs.read(TENANT, "throw-1")).toBeDefined();
  });
});
