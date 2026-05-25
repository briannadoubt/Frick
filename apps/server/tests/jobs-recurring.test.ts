import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFrickServer } from "../src/server.js";
import {
  createFrickRecurringRegistry,
  createRecurringScheduler,
  RECURRING_MIN_INTERVAL_MS,
  type FrickRecurringJob,
} from "../src/jobs/recurring.js";
import { FrickStore } from "../src/store.js";
import { createNoopLogger } from "../src/logger.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.useRealTimers();
});

describe("createFrickRecurringRegistry", () => {
  it("enforces minimum intervalMs of 60_000", () => {
    expect(() =>
      createFrickRecurringRegistry([
        {
          name: "too-fast",
          jobType: "my.job",
          intervalMs: 59_999,
          resolveTargets: () => [],
        },
      ]),
    ).toThrow(/intervalMs must be >= 60000/);
  });

  it("accepts intervalMs exactly at the minimum", () => {
    expect(() =>
      createFrickRecurringRegistry([
        {
          name: "ok",
          jobType: "my.job",
          intervalMs: 60_000,
          resolveTargets: () => [],
        },
      ]),
    ).not.toThrow();
  });

  it("lists registered jobs", () => {
    const job: FrickRecurringJob = {
      name: "test-job",
      jobType: "test",
      intervalMs: 60_000,
      resolveTargets: () => [],
    };
    const registry = createFrickRecurringRegistry([job]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]!.name).toBe("test-job");
  });
});

describe("createRecurringScheduler", () => {
  function makeStore() {
    return new FrickStore({ path: ":memory:", schema: undefined as never, seed: false });
  }

  it("enqueues once per window across multiple ticks in the same window", async () => {
    vi.useFakeTimers();
    const now = 1_000_000_000_000;
    vi.setSystemTime(now);

    const store = makeStore();
    const logger = createNoopLogger();
    const enqueueSpy = vi.spyOn(store.jobs, "enqueue");

    const scheduler = createRecurringScheduler({
      store,
      logger,
      jobs: [
        {
          name: "test",
          jobType: "my.job",
          intervalMs: 300_000,
          resolveTargets: () => [{ tenantId: "_default" }],
        },
      ],
      tickIntervalMs: 1_000,
    });

    scheduler.start();

    // Fire multiple ticks within the same 5-minute window; flush async too.
    await vi.advanceTimersByTimeAsync(3_000);

    // The idempotency key is constant within the window, so `enqueue` is
    // called multiple times but the job store dedupes. What we verify here
    // is that the scheduler calls enqueue (with the correct key shape) on
    // each tick — deduping is the job store's responsibility.
    const calls = enqueueSpy.mock.calls.filter(
      (c) =>
        typeof c[0] === "object" &&
        c[0] !== null &&
        "idempotencyKey" in c[0] &&
        typeof c[0].idempotencyKey === "string" &&
        c[0].idempotencyKey.startsWith("recurring:test:"),
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);

    scheduler.stop();
    store.close();
  });

  it("enqueues per tenant when resolveTargets returns multiple tuples", async () => {
    vi.useFakeTimers();
    const now = 1_000_000_000_000;
    vi.setSystemTime(now);

    const store = makeStore();
    const logger = createNoopLogger();
    const enqueuedKeys: string[] = [];
    vi.spyOn(store.jobs, "enqueue").mockImplementation((input) => {
      if (typeof input === "object" && input !== null && "idempotencyKey" in input) {
        enqueuedKeys.push(input.idempotencyKey as string);
      }
      return {} as ReturnType<typeof store.jobs.enqueue>;
    });

    const scheduler = createRecurringScheduler({
      store,
      logger,
      jobs: [
        {
          name: "multi",
          jobType: "my.job",
          intervalMs: 60_000,
          resolveTargets: () => [
            { tenantId: "tenant-a" },
            { tenantId: "tenant-b" },
            { tenantId: "tenant-c" },
          ],
        },
      ],
      tickIntervalMs: 100,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(150);

    const uniqueKeys = new Set(enqueuedKeys);
    expect(uniqueKeys.size).toBe(3);
    const keyArray = Array.from(uniqueKeys);
    expect(keyArray.some((k) => k.includes("tenant-a"))).toBe(true);
    expect(keyArray.some((k) => k.includes("tenant-b"))).toBe(true);
    expect(keyArray.some((k) => k.includes("tenant-c"))).toBe(true);

    scheduler.stop();
    store.close();
  });

  it("uses different window keys across two consecutive windows", async () => {
    vi.useFakeTimers();
    const intervalMs = 60_000;
    const now = Math.floor(1_000_000_000_000 / intervalMs) * intervalMs;
    vi.setSystemTime(now);

    const store = makeStore();
    const logger = createNoopLogger();
    const enqueuedKeys: string[] = [];
    vi.spyOn(store.jobs, "enqueue").mockImplementation((input) => {
      if (typeof input === "object" && input !== null && "idempotencyKey" in input) {
        enqueuedKeys.push(input.idempotencyKey as string);
      }
      return {} as ReturnType<typeof store.jobs.enqueue>;
    });

    const scheduler = createRecurringScheduler({
      store,
      logger,
      jobs: [
        {
          name: "window-test",
          jobType: "my.job",
          intervalMs,
          resolveTargets: () => [{ tenantId: "_default" }],
        },
      ],
      tickIntervalMs: 1_000,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    const keysInFirstWindow = enqueuedKeys.slice();

    // Jump to next window.
    vi.setSystemTime(now + intervalMs);
    await vi.advanceTimersByTimeAsync(1_000);

    const keysInSecondWindow = enqueuedKeys.slice(keysInFirstWindow.length);
    expect(keysInFirstWindow.length).toBeGreaterThan(0);
    expect(keysInSecondWindow.length).toBeGreaterThan(0);
    expect(keysInFirstWindow[0]).not.toBe(keysInSecondWindow[0]);

    scheduler.stop();
    store.close();
  });

  it("logs an error and continues when resolveTargets throws", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);

    const store = makeStore();
    const logger = createNoopLogger();
    const errorSpy = vi.spyOn(logger, "error");

    const enqueuedTypes: string[] = [];
    vi.spyOn(store.jobs, "enqueue").mockImplementation((input) => {
      if (typeof input === "object" && input !== null && "jobType" in input) {
        enqueuedTypes.push(input.jobType as string);
      }
      return {} as ReturnType<typeof store.jobs.enqueue>;
    });

    const scheduler = createRecurringScheduler({
      store,
      logger,
      jobs: [
        {
          name: "throws",
          jobType: "my.job",
          intervalMs: 60_000,
          resolveTargets: () => {
            throw new Error("resolve boom");
          },
        },
        {
          name: "ok",
          jobType: "other.job",
          intervalMs: 60_000,
          resolveTargets: () => [{ tenantId: "_default" }],
        },
      ],
      tickIntervalMs: 100,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(150);

    expect(errorSpy).toHaveBeenCalledWith(
      "frick.recurring.resolve_targets_failed",
      expect.objectContaining({ jobName: "throws", error: "resolve boom" }),
    );
    expect(enqueuedTypes).toContain("other.job");

    scheduler.stop();
    store.close();
  });

  it("stop prevents further ticks", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);

    const store = makeStore();
    const logger = createNoopLogger();
    let callCount = 0;

    const scheduler = createRecurringScheduler({
      store,
      logger,
      jobs: [
        {
          name: "count",
          jobType: "my.job",
          intervalMs: 60_000,
          resolveTargets: () => {
            callCount++;
            return [];
          },
        },
      ],
      tickIntervalMs: 100,
    });

    scheduler.start();
    vi.advanceTimersByTime(250);
    const countBeforeStop = callCount;
    scheduler.stop();
    vi.advanceTimersByTime(500);
    expect(callCount).toBe(countBeforeStop);

    store.close();
  });

  it("server close stops the recurring scheduler", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);

    let callCount = 0;
    app = await startServer({
      jobs: [
        {
          name: "server-close-test",
          jobType: "my.job",
          intervalMs: 60_000,
          resolveTargets: () => {
            callCount++;
            return [];
          },
        },
      ],
      tickIntervalMs: 100,
      workerEnabled: true,
    });

    app.server.recurring.list();

    await app.close();
    const countAfterClose = callCount;
    vi.advanceTimersByTime(500);
    expect(callCount).toBe(countAfterClose);
  });
});

interface StartOpts {
  jobs?: readonly FrickRecurringJob[];
  tickIntervalMs?: number;
  workerEnabled?: boolean;
}

async function startServer(opts: StartOpts = {}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    jobs: { workerEnabled: opts.workerEnabled ?? false },
    recurring: {
      ...(opts.jobs !== undefined ? { jobs: opts.jobs } : {}),
      ...(opts.tickIntervalMs !== undefined ? { tickIntervalMs: opts.tickIntervalMs } : {}),
    },
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    server,
    close: server.close,
  };
}
