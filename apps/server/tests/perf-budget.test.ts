import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendHistory,
  compareToBaseline,
  extractMetric,
  readHistory,
  runBudgetCheck,
  type BudgetConfig,
  type LatencyResult,
  type ThroughputResult,
} from "../../../bench/src/index.js";

/**
 * FR-100 — fast assertions for the performance-budget checker + trend tracking.
 *
 * These do NOT run the real benchmark suites: a tiny, deterministic pair of
 * pre-computed suite results is injected so the checker is judged purely on its
 * thresholds. We assert the verdict JSON shape, that an obviously-too-strict
 * budget FAILS and a loose one PASSES, and that the NDJSON history + baseline
 * delta machinery round-trips. Kept well under 2s (no server, no I/O beyond a
 * temp file). Real numbers come from `pnpm bench:budget`.
 */

// A fixed latency result: p99 = 5ms on every path.
const FIXED_LATENCY = {
  schemaVersion: 1,
  tool: "frick-latency-bench",
  startedAt: "2026-06-07T00:00:00.000Z",
  config: { iterations: 1, catchUpBacklog: 1 },
  env: { node: "v24.0.0", platform: "linux", inProcessServer: true },
  totalDurationMs: 1,
  paths: {
    httpRequest: latPath(5),
    wsAppend: latPath(5),
    objectFanout: latPath(5),
    catchUp: latPath(5),
    reconnect: latPath(5),
  },
  totalErrors: 0,
} satisfies LatencyResult;

// A fixed throughput result: 1000 ops/sec, 10MB rss growth.
const FIXED_THROUGHPUT = {
  schemaVersion: 1,
  tool: "frick-throughput-bench",
  startedAt: "2026-06-07T00:00:00.000Z",
  config: { connections: 1, opsPerConnection: 1, upsertRatio: 0.2, awaitAcks: true, seed: 1 },
  env: { node: "v24.0.0", platform: "linux", inProcessServer: true },
  durationMs: 1,
  ops: { appends: 800, upserts: 200, total: 1000, errors: 0 },
  throughputPerSec: { appends: 800, upserts: 200, total: 1000 },
  resources: {
    before: snap(0),
    after: snap(10 * 1024 * 1024),
    delta: {
      rssBytes: 10 * 1024 * 1024,
      heapUsedBytes: 0,
      dbBytes: 0,
      rowCounts: { stream_events: 800, objects: 200, idempotency_keys: 800 },
      idempotencyCacheRows: 800,
    },
  },
} satisfies ThroughputResult;

function latPath(p99: number) {
  return {
    count: 1,
    errors: 0,
    latencyMs: { count: 1, min: p99, max: p99, mean: p99, p50: p99, p90: p99, p99 },
  };
}

function snap(rss: number) {
  return {
    memory: { rss, heapUsed: 0, external: 0 },
    dbBytes: 0,
    rowCounts: { stream_events: 0, objects: 0, idempotency_keys: 0 },
    idempotencyCacheRows: 0,
  };
}

const LOOSE_BUDGET: BudgetConfig = {
  name: "loose",
  metrics: [
    { id: "lat.p99", suite: "latency", path: "paths.wsAppend.latencyMs.p99", comparison: "max", threshold: 1000, unit: "ms" },
    { id: "tput.total", suite: "throughput", path: "throughputPerSec.total", comparison: "min", threshold: 100, unit: "ops/sec" },
  ],
};

const STRICT_BUDGET: BudgetConfig = {
  name: "strict",
  metrics: [
    // p99 is 5ms; demand <= 1ms — impossible.
    { id: "lat.p99", suite: "latency", path: "paths.wsAppend.latencyMs.p99", comparison: "max", threshold: 1, unit: "ms" },
    // 1000 ops/sec; demand >= 1e9 — impossible.
    { id: "tput.total", suite: "throughput", path: "throughputPerSec.total", comparison: "min", threshold: 1_000_000_000, unit: "ops/sec" },
  ],
};

const inject = { latencyResult: FIXED_LATENCY, throughputResult: FIXED_THROUGHPUT };

describe("FR-100 performance budget checker", () => {
  it("emits a well-shaped verdict and PASSES a loose budget", async () => {
    const verdict = await runBudgetCheck(LOOSE_BUDGET, inject);

    expect(verdict.schemaVersion).toBe(1);
    expect(verdict.tool).toBe("frick-budget-check");
    expect(verdict.budget).toBe("loose");
    expect(Date.parse(verdict.startedAt)).not.toBeNaN();
    expect(typeof verdict.env.node).toBe("string");
    expect(verdict.totalDurationMs).toBeGreaterThanOrEqual(0);

    expect(verdict.pass).toBe(true);
    expect(verdict.summary).toEqual({ total: 2, passed: 2, failed: 0 });
    expect(verdict.metrics).toHaveLength(2);
    for (const m of verdict.metrics) {
      expect(m.pass).toBe(true);
      expect(typeof m.value).toBe("number");
      expect(["max", "min"]).toContain(m.comparison);
    }
    // The wsAppend p99 was extracted as 5ms.
    expect(verdict.metrics.find((m) => m.id === "lat.p99")?.value).toBe(5);
  });

  it("FAILS an obviously-too-strict budget, with per-metric verdicts", async () => {
    const verdict = await runBudgetCheck(STRICT_BUDGET, inject);

    expect(verdict.pass).toBe(false);
    expect(verdict.summary).toEqual({ total: 2, passed: 0, failed: 2 });
    for (const m of verdict.metrics) expect(m.pass).toBe(false);
  });

  it("fails closed when a metric path is missing", async () => {
    const verdict = await runBudgetCheck(
      {
        name: "missing",
        metrics: [
          { id: "nope", suite: "latency", path: "paths.nonexistent.latencyMs.p99", comparison: "max", threshold: 1000 },
        ],
      },
      inject,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.metrics[0]!.value).toBeNull();
    expect(verdict.metrics[0]!.pass).toBe(false);
  });

  it("only runs the suites a budget references (no injection needed for unreferenced suites)", async () => {
    // Latency-only budget with only a throughput result injected must still
    // judge correctly because it never touches the throughput suite... and the
    // latency suite is injected. Here we inject only latency.
    const verdict = await runBudgetCheck(
      {
        name: "latency-only",
        metrics: [
          { id: "lat", suite: "latency", path: "paths.httpRequest.latencyMs.p99", comparison: "max", threshold: 1000 },
        ],
      },
      { latencyResult: FIXED_LATENCY },
    );
    expect(verdict.pass).toBe(true);
  });

  it("extractMetric reads dot-paths and returns null for non-numeric/missing", () => {
    expect(extractMetric({ a: { b: 7 } }, "a.b")).toBe(7);
    expect(extractMetric({ a: { b: 7 } }, "a.c")).toBeNull();
    expect(extractMetric({ a: { b: "x" } }, "a.b")).toBeNull();
    expect(extractMetric(null, "a")).toBeNull();
  });
});

describe("FR-100 trend tracking", () => {
  let dir: string;
  let historyPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "frick-perf-"));
    historyPath = join(dir, "nested", "history.ndjson");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends NDJSON entries (creating parent dirs) and reads them back", async () => {
    const v1 = await runBudgetCheck(LOOSE_BUDGET, inject);
    const entry = await appendHistory(historyPath, v1, { commit: "abc123" });

    expect(entry.budget).toBe("loose");
    expect(entry.pass).toBe(true);
    expect(entry.metrics["lat.p99"]).toBe(5);
    expect(entry.meta).toEqual({ commit: "abc123" });

    const v2 = await runBudgetCheck(LOOSE_BUDGET, inject);
    await appendHistory(historyPath, v2);

    const history = await readHistory(historyPath);
    expect(history).toHaveLength(2);

    // The file is genuine NDJSON: one JSON object per non-empty line.
    const raw = await readFile(historyPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("readHistory returns [] for a missing file", async () => {
    expect(await readHistory(join(dir, "does-not-exist.ndjson"))).toEqual([]);
  });

  it("compareToBaseline reports per-metric deltas and pctChange", () => {
    const baseline = {
      recordedAt: "2026-06-01T00:00:00.000Z",
      budget: "loose",
      pass: true,
      metrics: { "lat.p99": 4, "tput.total": 1250 },
    };

    const verdict = {
      schemaVersion: 1 as const,
      tool: "frick-budget-check" as const,
      budget: "loose",
      startedAt: "2026-06-07T00:00:00.000Z",
      env: { node: "v24", platform: "linux" },
      totalDurationMs: 1,
      pass: true,
      metrics: [
        { id: "lat.p99", suite: "latency" as const, path: "p", comparison: "max" as const, threshold: 1000, value: 5, pass: true },
        { id: "tput.total", suite: "throughput" as const, path: "p", comparison: "min" as const, threshold: 100, value: 1000, pass: true },
      ],
      summary: { total: 2, passed: 2, failed: 0 },
    };

    const cmp = compareToBaseline(verdict, baseline);
    expect(cmp.baselineAt).toBe("2026-06-01T00:00:00.000Z");

    const lat = cmp.deltas.find((d) => d.id === "lat.p99")!;
    expect(lat.baseline).toBe(4);
    expect(lat.current).toBe(5);
    expect(lat.delta).toBe(1); // got 1ms slower
    expect(lat.pctChange).toBe(0.25);

    const tput = cmp.deltas.find((d) => d.id === "tput.total")!;
    expect(tput.delta).toBe(-250); // 250 ops/sec slower
    expect(tput.pctChange).toBe(-0.2);
  });

  it("compareToBaseline yields null deltas when there is no baseline", () => {
    const verdict = {
      schemaVersion: 1 as const,
      tool: "frick-budget-check" as const,
      budget: "loose",
      startedAt: "2026-06-07T00:00:00.000Z",
      env: { node: "v24", platform: "linux" },
      totalDurationMs: 1,
      pass: true,
      metrics: [
        { id: "lat.p99", suite: "latency" as const, path: "p", comparison: "max" as const, threshold: 1000, value: 5, pass: true },
      ],
      summary: { total: 1, passed: 1, failed: 0 },
    };
    const cmp = compareToBaseline(verdict, null);
    expect(cmp.baselineAt).toBeNull();
    expect(cmp.deltas[0]!.baseline).toBeNull();
    expect(cmp.deltas[0]!.delta).toBeNull();
    expect(cmp.deltas[0]!.pctChange).toBeNull();
  });
});
