import { afterEach, describe, expect, it } from "vitest";
import { createFrickJobRegistry } from "../src/jobs/registry.js";
import { createFrickJobWorker, type FrickJobWorker } from "../src/jobs/worker.js";
import { createNoopLogger } from "../src/logger.js";
import { MemoryPlatformEventPipeline } from "../src/platform-events/memory.js";
import type { PlatformEventDelivery, PlatformEventPipeline } from "../src/platform-events/types.js";
import { createFrickServer } from "../src/server.js";
import { FrickStore } from "../src/store.js";

let app: ReturnType<typeof createFrickServer> | undefined;
let store: FrickStore | undefined;
let worker: FrickJobWorker | undefined;

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await app?.close();
  app = undefined;
  store?.close();
  store = undefined;
});

async function waitFor<T>(
  predicate: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

async function waitForPlatformEvent(
  pipeline: PlatformEventPipeline,
  name: string,
): Promise<PlatformEventDelivery> {
  return waitFor(async () => {
    const deliveries = await pipeline.claim(`runtime-test-${name}`);
    return deliveries.find((delivery) => delivery.event.name === name);
  });
}

describe("runtime platform event publishers", () => {
  it("emits jobs.lifecycle events for completed jobs", async () => {
    store = new FrickStore({ path: ":memory:", seed: false });
    const registry = createFrickJobRegistry();
    registry.register("ExampleJob", async () => ({ status: "completed" }));
    worker = createFrickJobWorker({
      store,
      registry,
      logger: createNoopLogger(),
      pollIntervalMs: 10,
      platformEvents: store.platformEvents,
    });
    worker.start();
    const row = await store.jobs.enqueue({ tenantId: "_default", jobType: "ExampleJob", payload: {} });

    await waitFor(async () => ((await store!.jobs.getById(row.id))?.status === "completed" ? true : undefined));

    const delivery = await waitForPlatformEvent(store.platformEvents, "job.completed");
    expect(delivery.event).toMatchObject({
      family: "jobs.lifecycle",
      name: "job.completed",
      source: "frick.jobs",
      tenantId: "_default",
      idempotencyKey: `jobs.lifecycle:_default:${row.id}:job.completed:1`,
      payload: {
        jobId: row.id,
        jobType: "ExampleJob",
        attemptCount: 1,
      },
    });
  });

  it("emits job.failed events for retryable failures", async () => {
    store = new FrickStore({ path: ":memory:", seed: false });
    const registry = createFrickJobRegistry();
    registry.register("RetryJob", async () => ({
      status: "failed",
      errorCode: "jobs.tryAgain",
      errorMessage: "try again",
      retryable: true,
    }));
    worker = createFrickJobWorker({
      store,
      registry,
      logger: createNoopLogger(),
      pollIntervalMs: 10,
      platformEvents: store.platformEvents,
    });
    worker.start();
    const row = await store.jobs.enqueue({
      tenantId: "_default",
      jobType: "RetryJob",
      payload: {},
      maxAttempts: 2,
    });

    await waitFor(async () => ((await store!.jobs.getById(row.id))?.status === "ready" ? true : undefined));

    const delivery = await waitForPlatformEvent(store.platformEvents, "job.failed");
    expect(delivery.event.payload).toMatchObject({
      jobId: row.id,
      jobType: "RetryJob",
      attemptCount: 1,
      errorCode: "jobs.tryAgain",
      retryable: true,
    });
  });

  it("emits job.dead_lettered events for terminal failures", async () => {
    store = new FrickStore({ path: ":memory:", seed: false });
    const registry = createFrickJobRegistry();
    registry.register("DeadJob", async () => ({
      status: "failed",
      errorCode: "jobs.nope",
      errorMessage: "nope",
      retryable: false,
    }));
    worker = createFrickJobWorker({
      store,
      registry,
      logger: createNoopLogger(),
      pollIntervalMs: 10,
      platformEvents: store.platformEvents,
    });
    worker.start();
    const row = await store.jobs.enqueue({ tenantId: "_default", jobType: "DeadJob", payload: {} });

    await waitFor(async () =>
      (await store!.jobs.getById(row.id))?.status === "dead_lettered" ? true : undefined,
    );

    const delivery = await waitForPlatformEvent(store.platformEvents, "job.dead_lettered");
    expect(delivery.event).toMatchObject({
      family: "jobs.lifecycle",
      name: "job.dead_lettered",
      source: "frick.jobs",
      tenantId: "_default",
      payload: {
        jobId: row.id,
        jobType: "DeadJob",
        attemptCount: 1,
        errorCode: "jobs.nope",
        retryable: false,
      },
    });
  });

  it("passes the server platform event pipeline into the default job worker", async () => {
    const platformEvents = new MemoryPlatformEventPipeline();
    app = createFrickServer({
      dbPath: ":memory:",
      platformEvents,
      jobs: {
        workerEnabled: true,
        pollIntervalMs: 10,
        handlers: {
          ServerJob: async () => ({ status: "completed" }),
        },
      },
    });
    const row = await app.store.jobs.enqueue({ tenantId: "_default", jobType: "ServerJob", payload: {} });

    await waitFor(async () => (app!.store.jobs.getById(row.id)?.status === "completed" ? true : undefined));

    const delivery = await waitForPlatformEvent(platformEvents, "job.completed");
    expect(delivery.event.payload).toMatchObject({
      jobId: row.id,
      jobType: "ServerJob",
      attemptCount: 1,
    });
  });

  it("does not let synchronous platform event publisher failures break the worker", async () => {
    store = new FrickStore({ path: ":memory:", seed: false });
    const registry = createFrickJobRegistry();
    const completed: number[] = [];
    registry.register("SafeJob", async (ctx) => {
      completed.push(ctx.jobId);
      return { status: "completed" };
    });
    const throwingPipeline: PlatformEventPipeline = {
      ...new MemoryPlatformEventPipeline(),
      publish() {
        throw new Error("publisher exploded");
      },
    };
    worker = createFrickJobWorker({
      store,
      registry,
      logger: createNoopLogger(),
      pollIntervalMs: 10,
      claimBatchSize: 2,
      platformEvents: throwingPipeline,
    });
    worker.start();
    const first = await store.jobs.enqueue({ tenantId: "_default", jobType: "SafeJob", payload: {} });
    const second = await store.jobs.enqueue({ tenantId: "_default", jobType: "SafeJob", payload: {} });

    await waitFor(async () =>
      (await store!.jobs.getById(first.id))?.status === "completed" &&
      (await store!.jobs.getById(second.id))?.status === "completed"
        ? true
        : undefined,
    );

    expect(completed).toEqual([first.id, second.id]);
  });
});
