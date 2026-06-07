import { afterEach, describe, expect, it } from "vitest";
import { FrickStore } from "../src/store.js";
import { createNoopLogger } from "../src/logger.js";
import { createFrickJobRegistry, type FrickJobHandler } from "../src/jobs/registry.js";
import { createFrickJobWorker, type FrickJobWorker } from "../src/jobs/worker.js";
import type {
  FrickJobTelemetryRun,
  FrickJobTelemetryResult,
  FrickTelemetryRuntime,
} from "../src/telemetry/runtime.js";

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

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value !== undefined && value !== null && value !== false) {
      return value as T;
    }
    await sleep(10);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("FrickJobWorker", () => {
  it("records OTel job run spans with tenant, type, attempt, and duration", async () => {
    store = new FrickStore({ path: ":memory:", seed: false });
    const registry = createFrickJobRegistry();
    const telemetry = new RecordingTelemetryRuntime();
    registry.register("TelemetryJob", async () => ({ status: "completed", result: { ok: true } }));
    worker = createFrickJobWorker({
      store,
      registry,
      logger: createNoopLogger(),
      pollIntervalMs: 10,
      workerId: "worker-telemetry",
      telemetry,
    });
    worker.start();
    const row = await store.jobs.enqueue({
      tenantId: "_default",
      jobType: "TelemetryJob",
      payload: { value: 42 },
    });

    await waitFor(() => store!.jobs.getById(row.id)?.status === "completed");

    expect(telemetry.jobs).toEqual([
      expect.objectContaining({
        input: {
          jobId: row.id,
          jobType: "TelemetryJob",
          tenantId: "_default",
          attemptCount: 1,
          workerId: "worker-telemetry",
        },
        result: expect.objectContaining({
          status: "completed",
          durationMs: expect.any(Number),
        }),
      }),
    ]);
  });

  it("records dead-lettered job spans with error metadata", async () => {
    store = new FrickStore({ path: ":memory:", seed: false });
    const registry = createFrickJobRegistry();
    const telemetry = new RecordingTelemetryRuntime();
    registry.register("BoomTelemetryJob", async () => {
      throw new Error("kaboom");
    });
    worker = createFrickJobWorker({
      store,
      registry,
      logger: createNoopLogger(),
      pollIntervalMs: 10,
      telemetry,
    });
    worker.start();
    const row = await store.jobs.enqueue({
      tenantId: "_default",
      jobType: "BoomTelemetryJob",
      payload: {},
      maxAttempts: 1,
    });

    await waitFor(() => store!.jobs.getById(row.id)?.status === "dead_lettered");

    expect(telemetry.jobs).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({
          jobId: row.id,
          jobType: "BoomTelemetryJob",
        }),
        result: expect.objectContaining({
          status: "dead_lettered",
          errorCode: "server.internal",
          retryable: true,
        }),
      }),
    ]);
  });

  it("keeps job completion alive when telemetry throws", async () => {
    store = new FrickStore({ path: ":memory:", seed: false });
    const registry = createFrickJobRegistry();
    registry.register("TelemetryThrowsJob", async () => ({ status: "completed" }));
    worker = createFrickJobWorker({
      store,
      registry,
      logger: createNoopLogger(),
      pollIntervalMs: 10,
      telemetry: new ThrowingTelemetryRuntime(),
    });
    worker.start();
    const row = await store.jobs.enqueue({
      tenantId: "_default",
      jobType: "TelemetryThrowsJob",
      payload: {},
    });

    await waitFor(() => store!.jobs.getById(row.id)?.status === "completed");
  });

  it("picks up a job, runs the handler, and marks it completed", async () => {
    store = new FrickStore({ path: ":memory:", seed: false });
    const registry = createFrickJobRegistry();
    let called = 0;
    registry.register("TestJob", async (ctx) => {
      called += 1;
      return { status: "completed", result: { gotPayload: ctx.payload } };
    });
    worker = createFrickJobWorker({
      store,
      registry,
      logger: createNoopLogger(),
      pollIntervalMs: 25,
    });
    worker.start();
    const row = await store.jobs.enqueue({
      tenantId: "_default",
      jobType: "TestJob",
      payload: { value: 42 },
    });

    await waitFor(() => store!.jobs.getById(row.id)?.status === "completed");
    expect(called).toBe(1);
  });

  it("dead-letters a handler that consistently throws once max_attempts is reached", async () => {
    store = new FrickStore({ path: ":memory:", seed: false });
    const registry = createFrickJobRegistry();
    registry.register("BoomJob", async () => {
      throw new Error("kaboom");
    });
    worker = createFrickJobWorker({
      store,
      registry,
      logger: createNoopLogger(),
      pollIntervalMs: 10,
    });
    worker.start();
    // Use max_attempts: 1 and available_at in the past so backoff doesn't
    // stall the test — one claim, one fail, one dead-letter.
    const row = await store.jobs.enqueue({
      tenantId: "_default",
      jobType: "BoomJob",
      payload: {},
      maxAttempts: 1,
    });
    await waitFor(() => store!.jobs.getById(row.id)?.status === "dead_lettered");
    const final = await store.jobs.getById(row.id)!;
    expect(final.lastErrorCode).toBe("server.internal");
    expect(final.lastErrorMessage).toContain("kaboom");
  });

  it("dead-letters immediately when no handler is registered", async () => {
    store = new FrickStore({ path: ":memory:", seed: false });
    const registry = createFrickJobRegistry();
    worker = createFrickJobWorker({
      store,
      registry,
      logger: createNoopLogger(),
      pollIntervalMs: 10,
    });
    worker.start();
    const row = await store.jobs.enqueue({
      tenantId: "_default",
      jobType: "MissingType",
      payload: {},
      maxAttempts: 5,
    });
    await waitFor(() => store!.jobs.getById(row.id)?.status === "dead_lettered");
    const final = await store.jobs.getById(row.id)!;
    expect(final.lastErrorCode).toBe("jobs.unknownHandler");
    // Non-retryable: dead-lettered on attempt 1 even though max_attempts = 5.
    expect(final.attemptCount).toBe(1);
  });

  it("stop() awaits an in-flight handler before resolving", async () => {
    store = new FrickStore({ path: ":memory:", seed: false });
    const registry = createFrickJobRegistry();
    let finished = false;
    const handler: FrickJobHandler = async () => {
      await sleep(150);
      finished = true;
      return { status: "completed" };
    };
    registry.register("SlowJob", handler);
    worker = createFrickJobWorker({
      store,
      registry,
      logger: createNoopLogger(),
      pollIntervalMs: 10,
      gracefulShutdownTimeoutMs: 2000,
    });
    worker.start();
    await store.jobs.enqueue({
      tenantId: "_default",
      jobType: "SlowJob",
      payload: {},
    });
    // Let the worker pick the job up.
    await waitFor(() => {
      const rows = store!.jobs.list({ status: "running" });
      return rows.length > 0 ? rows : undefined;
    });
    await worker.stop();
    expect(finished).toBe(true);
    worker = undefined;
  });
});

class RecordingTelemetryRuntime implements Partial<FrickTelemetryRuntime> {
  readonly jobs: Array<{
    input: FrickJobTelemetryRun;
    result?: FrickJobTelemetryResult;
  }> = [];

  startJobRun(input: FrickJobTelemetryRun) {
    const record: {
      input: FrickJobTelemetryRun;
      result?: FrickJobTelemetryResult;
    } = { input };
    this.jobs.push(record);
    return {
      end: (result: FrickJobTelemetryResult) => {
        record.result = result;
      },
    };
  }
}

class ThrowingTelemetryRuntime implements Partial<FrickTelemetryRuntime> {
  startJobRun() {
    return {
      end: () => {
        throw new Error("job telemetry failed");
      },
    };
  }
}
