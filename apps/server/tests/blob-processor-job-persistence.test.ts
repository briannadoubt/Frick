import { afterEach, describe, expect, it } from "vitest";
import { productTestSchema } from "@fricken/protocol";
import { FrickStore } from "../src/store.js";
import { createNoopLogger } from "../src/logger.js";
import {
  BLOB_PROCESS_JOB_TYPE,
  createBlobProcessorJobHandler,
} from "../src/blobs/processor-job.js";
import { createFrickBlobProcessorRegistry } from "../src/blobs/processor.js";
import type { FrickBlobProcessor } from "../src/blobs/processor.js";

// Regression for blob-gc-1: derivative persistence must be AWAITED. A
// `record()` rejection must surface as a failed+retryable job (so the write is
// retried, never silently lost) — not a fire-and-forget floating promise that
// (a) lets the job report "completed" before the write lands and (b) becomes an
// unhandled rejection that can crash the worker.

const TENANT = "_default";

let store: FrickStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

function makeStore(): FrickStore {
  return new FrickStore({ path: ":memory:", seed: true, schema: productTestSchema });
}

async function seedParentBlob(s: FrickStore, blobId: string): Promise<void> {
  await s.blobs.create(TENANT, {
    blobId,
    ownerId: "user-1",
    contentHash: `sha256-${blobId}`,
    byteLength: 3,
    mimeType: "image/png",
  });
  await s.blobs.writeContent(TENANT, blobId, new Uint8Array([1, 2, 3]));
}

function makeHandler(s: FrickStore, processor: FrickBlobProcessor) {
  const blobProcessors = createFrickBlobProcessorRegistry();
  blobProcessors.register(processor);
  return createBlobProcessorJobHandler({
    store: s,
    blobProcessors,
    logger: createNoopLogger(),
  });
}

describe("blob.process derivative persistence (blob-gc-1)", () => {
  it("reports failed+retryable when record() rejects (no fire-and-forget)", async () => {
    store = makeStore();
    await seedParentBlob(store, "parent-1");

    // Force the derivative write to reject, as a transient DB error would.
    store.blobDerivatives.record = async () => {
      throw new Error("disk full");
    };

    const processor: FrickBlobProcessor = {
      id: "proc-fail",
      matches: {},
      async process() {
        return {
          derivatives: [{ derivativeId: "d1", mimeType: "image/png", bytes: Buffer.from([7]) }],
        };
      },
    };
    const handler = makeHandler(store, processor);

    const outcome = await handler({
      tenantId: TENANT,
      jobId: 1,
      jobType: BLOB_PROCESS_JOB_TYPE,
      payload: { blobId: "parent-1", processorId: "proc-fail" },
      attemptCount: 1,
      store,
      logger: createNoopLogger(),
    });

    // The detached-promise bug would have returned "completed" here.
    expect(outcome.status).toBe("failed");
    expect(outcome.retryable).toBe(true);
    expect(outcome.errorMessage).toContain("disk full");
  });

  it("awaits the write so the derivative is durable before reporting completed", async () => {
    store = makeStore();
    await seedParentBlob(store, "parent-2");

    const processor: FrickBlobProcessor = {
      id: "proc-ok",
      matches: {},
      async process() {
        return {
          derivatives: [
            { derivativeId: "d1", mimeType: "image/png", bytes: Buffer.from([1, 2]) },
          ],
        };
      },
    };
    const handler = makeHandler(store, processor);

    const outcome = await handler({
      tenantId: TENANT,
      jobId: 2,
      jobType: BLOB_PROCESS_JOB_TYPE,
      payload: { blobId: "parent-2", processorId: "proc-ok" },
      attemptCount: 1,
      store,
      logger: createNoopLogger(),
    });

    expect(outcome.status).toBe("completed");
    // The row is already durable the instant the handler resolves completed —
    // no need to poll, because the write was awaited.
    const rows = await store.blobDerivatives.listForParent("parent-2", TENANT);
    expect(rows.map((r) => r.derivativeId)).toEqual(["d1"]);
  });
});
