import { afterEach, describe, expect, it } from "vitest";
import { FrickStore } from "../src/store.js";
import { createNoopLogger } from "../src/logger.js";
import { createFrickPerAppRegistries } from "../src/apps/per-app-registries.js";
import { createFrickJobWorker, type FrickJobWorker } from "../src/jobs/worker.js";

/**
 * FR-153 (tail) — per-app job DISPATCH isolation. A multi-app server shares one
 * `jobs` table and one worker, but a handler registered for app A must never
 * run app B's jobs of the same type. The worker resolves each claimed job's
 * handler from `perAppRegistries.for(job.appId).jobs`, so the dispatch is keyed
 * by the job's stamped app_id.
 */

let store: FrickStore | undefined;
let worker: FrickJobWorker | undefined;

afterEach(async () => {
  if (worker) {
    await worker.stop();
    worker = undefined;
  }
  store?.close();
  store = undefined;
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  predicate: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== undefined && value !== null && value !== false) {
      return value as T;
    }
    await sleep(10);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("per-app job dispatch (FR-153)", () => {
  it("routes each job to its own app's handler — app A's handler never runs app B's job", async () => {
    store = new FrickStore({ path: ":memory:", seed: false });

    const ranByA: string[] = [];
    const ranByB: string[] = [];

    const perAppRegistries = createFrickPerAppRegistries();
    // Both apps register a handler for the SAME job type "Echo", but with
    // distinct behavior. With a single shared registry one would shadow the
    // other; per-app registries keep them independent.
    perAppRegistries.for("app-a").jobs.register("Echo", async (ctx) => {
      ranByA.push(String((ctx.payload as { tag: string }).tag));
      return { status: "completed" };
    });
    perAppRegistries.for("app-b").jobs.register("Echo", async (ctx) => {
      ranByB.push(String((ctx.payload as { tag: string }).tag));
      return { status: "completed" };
    });

    worker = createFrickJobWorker({
      store,
      // The shared registry is unused once perAppRegistries is supplied, but the
      // worker contract still requires one.
      registry: perAppRegistries.for("_default").jobs,
      perAppRegistries,
      logger: createNoopLogger(),
      pollIntervalMs: 10,
      workerId: "worker-dispatch",
    });
    worker.start();

    const aJob = await store.jobs.enqueue({
      tenantId: "_default",
      appId: "app-a",
      jobType: "Echo",
      payload: { tag: "from-a" },
    });
    const bJob = await store.jobs.enqueue({
      tenantId: "_default",
      appId: "app-b",
      jobType: "Echo",
      payload: { tag: "from-b" },
    });

    await waitFor(async () => (await store!.jobs.getById(aJob.id))?.status === "completed");
    await waitFor(async () => (await store!.jobs.getById(bJob.id))?.status === "completed");

    // Each app's handler ran ONLY its own app's job.
    expect(ranByA).toEqual(["from-a"]);
    expect(ranByB).toEqual(["from-b"]);
  });

  it("dead-letters an app's job when that app has no handler, even if another app does", async () => {
    store = new FrickStore({ path: ":memory:", seed: false });

    const ranByA: string[] = [];
    const perAppRegistries = createFrickPerAppRegistries();
    perAppRegistries.for("app-a").jobs.register("OnlyA", async (ctx) => {
      ranByA.push(String((ctx.payload as { tag: string }).tag));
      return { status: "completed" };
    });
    // app-b registers NO handler for "OnlyA".

    worker = createFrickJobWorker({
      store,
      registry: perAppRegistries.for("_default").jobs,
      perAppRegistries,
      logger: createNoopLogger(),
      pollIntervalMs: 10,
      workerId: "worker-dispatch-2",
    });
    worker.start();

    const aJob = await store.jobs.enqueue({
      tenantId: "_default",
      appId: "app-a",
      jobType: "OnlyA",
      payload: { tag: "a" },
    });
    const bJob = await store.jobs.enqueue({
      tenantId: "_default",
      appId: "app-b",
      jobType: "OnlyA",
      payload: { tag: "b" },
    });

    await waitFor(async () => (await store!.jobs.getById(aJob.id))?.status === "completed");
    // app-b's job has no handler in app-b's registry → dead-lettered, NOT run by
    // app-a's handler.
    await waitFor(async () => (await store!.jobs.getById(bJob.id))?.status === "dead_lettered");

    expect(ranByA).toEqual(["a"]);
  });
});
