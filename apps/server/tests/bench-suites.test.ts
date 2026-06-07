import { describe, expect, it } from "vitest";
import { runLatency } from "../../../bench/src/latency.js";
import { runThroughput } from "../../../bench/src/throughput.js";

/**
 * FR-97 / FR-98 — fast shape assertions for the benchmark suites.
 *
 * These are NOT real benchmarks: they run a tiny in-process config (a handful
 * of iterations) end-to-end and assert the machine-readable JSON result shape
 * — percentiles present, every path exercised, resource growth sampled — so
 * the result contract stays stable for FR-100's CI trend tracking. Kept well
 * under 2s. Real load numbers come from `pnpm bench:latency` /
 * `pnpm bench:throughput`.
 */

function expectLatencySummaryShape(summary: {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p99: number;
}): void {
  for (const key of ["count", "min", "max", "mean", "p50", "p90", "p99"] as const) {
    expect(typeof summary[key]).toBe("number");
    expect(Number.isFinite(summary[key])).toBe(true);
  }
  // Percentiles are monotonic within a sorted sample set.
  expect(summary.p50).toBeLessThanOrEqual(summary.p90);
  expect(summary.p90).toBeLessThanOrEqual(summary.p99);
  expect(summary.min).toBeLessThanOrEqual(summary.max);
}

describe("FR-97 latency benchmark suite", () => {
  it("emits a percentile result for every core path with no errors on a tiny run", async () => {
    const result = await runLatency({ iterations: 4, catchUpBacklog: 3 });

    expect(result.schemaVersion).toBe(1);
    expect(result.tool).toBe("frick-latency-bench");
    expect(result.env.inProcessServer).toBe(true);
    expect(Date.parse(result.startedAt)).not.toBeNaN();
    expect(result.config).toMatchObject({ iterations: 4, catchUpBacklog: 3 });
    expect(result.totalDurationMs).toBeGreaterThan(0);

    const paths = result.paths;
    for (const path of [
      paths.httpRequest,
      paths.wsAppend,
      paths.objectFanout,
      paths.catchUp,
      paths.reconnect,
    ]) {
      expect(path.errors).toBe(0);
      expect(path.count).toBe(4);
      expectLatencySummaryShape(path.latencyMs);
      expect(path.latencyMs.count).toBe(4);
    }

    expect(result.totalErrors).toBe(0);
  });
});

describe("FR-98 throughput + resource-growth benchmark suite", () => {
  it("emits throughput rates and sampled resource growth on a tiny run", async () => {
    const result = await runThroughput({
      connections: 2,
      opsPerConnection: 10,
      upsertRatio: 0.5,
      seed: 7,
    });

    expect(result.schemaVersion).toBe(1);
    expect(result.tool).toBe("frick-throughput-bench");
    expect(result.env.inProcessServer).toBe(true);
    expect(result.config).toMatchObject({ connections: 2, opsPerConnection: 10 });

    // 2 connections * 10 ops, all acked, no errors.
    expect(result.ops.errors).toBe(0);
    expect(result.ops.total).toBe(20);
    expect(result.ops.appends + result.ops.upserts).toBe(20);
    expect(result.ops.upserts).toBeGreaterThan(0);

    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.throughputPerSec.total).toBeGreaterThan(0);
    expect(result.throughputPerSec.appends).toBeGreaterThanOrEqual(0);
    expect(result.throughputPerSec.upserts).toBeGreaterThanOrEqual(0);

    // Resource growth is present because we spun the server up in-process.
    const resources = result.resources;
    expect(resources).toBeDefined();
    if (!resources) return;

    expect(typeof resources.before.memory.rss).toBe("number");
    expect(typeof resources.after.memory.rss).toBe("number");
    expect(typeof resources.delta.rssBytes).toBe("number");
    expect(typeof resources.delta.heapUsedBytes).toBe("number");
    expect(typeof resources.delta.dbBytes).toBe("number");
    expect(typeof resources.delta.idempotencyCacheRows).toBe("number");

    // Writes land durably: stream_events grows by the append count and the
    // objects table grows by the upsert count. The idempotency_keys table is
    // written on the stream-append path, so it grows by the append count too.
    expect(resources.delta.rowCounts.stream_events).toBe(result.ops.appends);
    expect(resources.delta.rowCounts.objects).toBe(result.ops.upserts);
    expect(resources.delta.idempotencyCacheRows).toBe(result.ops.appends);
    expect(resources.delta.idempotencyCacheRows).toBeGreaterThan(0);
    expect(resources.after.dbBytes).toBeGreaterThanOrEqual(resources.before.dbBytes);
  });
});
