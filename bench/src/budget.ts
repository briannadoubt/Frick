import { performance } from "node:perf_hooks";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_LATENCY_CONFIG,
  runLatency,
  type LatencyConfig,
  type LatencyResult,
} from "./latency.js";
import {
  DEFAULT_THROUGHPUT_CONFIG,
  runThroughput,
  type ThroughputConfig,
  type ThroughputResult,
} from "./throughput.js";

/**
 * FR-100 — Performance budgets + CI trend tracking.
 *
 * Builds on the FR-97 latency suite and FR-98 throughput suite. A *budget* is a
 * declarative set of thresholds over named metrics extracted from those suites'
 * JSON results — e.g. a p99 latency ceiling per path, a minimum sustained
 * throughput, or a memory-growth ceiling. {@link runBudgetCheck} runs the
 * suites once, extracts each metric, compares it against its threshold, and
 * emits a single machine-readable PASS/FAIL verdict.
 *
 * For trend tracking, {@link appendHistory} records each verdict as one NDJSON
 * line to a history file, and {@link compareToBaseline} diffs a fresh verdict's
 * metric values against a stored baseline verdict, reporting per-metric deltas.
 *
 * Correctness of the framework lives in the regular test suites; this module
 * only measures + judges. Thresholds are intentionally initial/sane — the point
 * is the mechanism, not perfectly-tuned numbers.
 */

/** Comparison direction for a budget metric. */
export type BudgetComparison = "max" | "min";

/** A single declarative threshold over one extracted metric. */
export interface BudgetMetric {
  /** Stable id for the metric, e.g. `"latency.wsAppend.p99"`. */
  readonly id: string;
  /**
   * Which suite produces this metric. `runBudgetCheck` only runs the suites a
   * budget actually references.
   */
  readonly suite: "latency" | "throughput";
  /**
   * Dot-path into the suite's JSON result, e.g.
   * `"paths.wsAppend.latencyMs.p99"` (latency) or
   * `"throughputPerSec.total"` / `"resources.delta.rssBytes"` (throughput).
   */
  readonly path: string;
  /**
   * `max` ⇒ value must be ≤ threshold (ceilings: latency, memory growth).
   * `min` ⇒ value must be ≥ threshold (floors: throughput).
   */
  readonly comparison: BudgetComparison;
  /** The threshold the metric is judged against. */
  readonly threshold: number;
  /** Optional human-readable unit, surfaced in the verdict, e.g. `"ms"`. */
  readonly unit?: string;
}

/** A declarative performance budget: a named set of metric thresholds. */
export interface BudgetConfig {
  /** Human-readable budget name, surfaced in the verdict. */
  readonly name: string;
  /** The thresholds to enforce. */
  readonly metrics: readonly BudgetMetric[];
  /**
   * Per-suite config overrides used when running the suites for this budget.
   * Keep these small for CI determinism/speed.
   */
  readonly latency?: Partial<LatencyConfig>;
  readonly throughput?: Partial<ThroughputConfig>;
}

/** The verdict for a single metric. */
export interface MetricVerdict {
  readonly id: string;
  readonly suite: "latency" | "throughput";
  readonly path: string;
  readonly comparison: BudgetComparison;
  readonly threshold: number;
  readonly unit?: string;
  /** The extracted measured value, or `null` if the path was missing. */
  readonly value: number | null;
  readonly pass: boolean;
}

/** The overall machine-readable budget verdict. */
export interface BudgetVerdict {
  readonly schemaVersion: 1;
  readonly tool: "frick-budget-check";
  readonly budget: string;
  readonly startedAt: string;
  readonly env: {
    readonly node: string;
    readonly platform: string;
  };
  readonly totalDurationMs: number;
  /** `true` iff every metric passed. */
  readonly pass: boolean;
  readonly metrics: readonly MetricVerdict[];
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
  };
}

/** Options for {@link runBudgetCheck}, mainly for deterministic testing. */
export interface RunBudgetCheckOptions {
  /** Inject a latency result instead of running the suite (tests). */
  readonly latencyResult?: LatencyResult;
  /** Inject a throughput result instead of running the suite (tests). */
  readonly throughputResult?: ThroughputResult;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Read a dot-path out of a nested JSON object, returning the numeric value or
 * `null` if any segment is missing or the leaf isn't a finite number.
 */
export function extractMetric(source: unknown, path: string): number | null {
  let cur: unknown = source;
  for (const segment of path.split(".")) {
    if (cur === null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return typeof cur === "number" && Number.isFinite(cur) ? cur : null;
}

function judge(value: number | null, comparison: BudgetComparison, threshold: number): boolean {
  // A missing metric can never pass — fail closed.
  if (value === null) return false;
  return comparison === "max" ? value <= threshold : value >= threshold;
}

/**
 * Run the suites a budget references (once each) and judge every metric against
 * its threshold, returning a single PASS/FAIL verdict. Suites whose metrics the
 * budget never references are not run. Pass `latencyResult` / `throughputResult`
 * to inject pre-computed suite results (used by the fast tests).
 */
export async function runBudgetCheck(
  budget: BudgetConfig,
  options: RunBudgetCheckOptions = {},
): Promise<BudgetVerdict> {
  const startedAt = new Date().toISOString();
  const start = performance.now();

  const needsLatency = budget.metrics.some((m) => m.suite === "latency");
  const needsThroughput = budget.metrics.some((m) => m.suite === "throughput");

  let latencyResult: LatencyResult | undefined = options.latencyResult;
  let throughputResult: ThroughputResult | undefined = options.throughputResult;

  if (needsLatency && !latencyResult) {
    latencyResult = await runLatency({ ...DEFAULT_LATENCY_CONFIG, ...budget.latency });
  }
  if (needsThroughput && !throughputResult) {
    throughputResult = await runThroughput({ ...DEFAULT_THROUGHPUT_CONFIG, ...budget.throughput });
  }

  const metrics: MetricVerdict[] = budget.metrics.map((m) => {
    const source = m.suite === "latency" ? latencyResult : throughputResult;
    const raw = source ? extractMetric(source, m.path) : null;
    const value = raw === null ? null : round(raw);
    return {
      id: m.id,
      suite: m.suite,
      path: m.path,
      comparison: m.comparison,
      threshold: m.threshold,
      ...(m.unit !== undefined ? { unit: m.unit } : {}),
      value,
      pass: judge(value, m.comparison, m.threshold),
    };
  });

  const passed = metrics.filter((m) => m.pass).length;
  const failed = metrics.length - passed;

  return {
    schemaVersion: 1,
    tool: "frick-budget-check",
    budget: budget.name,
    startedAt,
    env: { node: process.version, platform: process.platform },
    totalDurationMs: round(performance.now() - start),
    pass: failed === 0,
    metrics,
    summary: { total: metrics.length, passed, failed },
  };
}

/** One recorded history entry: a verdict plus a record timestamp. */
export interface HistoryEntry {
  readonly recordedAt: string;
  readonly budget: string;
  readonly pass: boolean;
  /** Flat `id -> value` map for compact trend storage/diffing. */
  readonly metrics: Record<string, number | null>;
  /** Optional CI/run metadata (commit sha, run id, …). */
  readonly meta?: Record<string, string>;
}

/** Project a verdict down to a compact, trend-friendly history entry. */
export function toHistoryEntry(
  verdict: BudgetVerdict,
  meta?: Record<string, string>,
): HistoryEntry {
  const metrics: Record<string, number | null> = {};
  for (const m of verdict.metrics) metrics[m.id] = m.value;
  return {
    recordedAt: new Date().toISOString(),
    budget: verdict.budget,
    pass: verdict.pass,
    metrics,
    ...(meta !== undefined ? { meta } : {}),
  };
}

/**
 * Append a verdict to an NDJSON history file (one entry per line) for CI trend
 * tracking. Creates the parent directory and file if absent. Returns the entry
 * that was written.
 */
export async function appendHistory(
  filePath: string,
  verdict: BudgetVerdict,
  meta?: Record<string, string>,
): Promise<HistoryEntry> {
  const entry = toHistoryEntry(verdict, meta);
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

/** Parse an NDJSON history file into entries; missing file ⇒ empty list. */
export async function readHistory(filePath: string): Promise<HistoryEntry[]> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as HistoryEntry);
}

/** Per-metric delta of a fresh verdict vs. a baseline entry. */
export interface MetricDelta {
  readonly id: string;
  readonly baseline: number | null;
  readonly current: number | null;
  /** `current - baseline`, or `null` if either side is missing. */
  readonly delta: number | null;
  /** `delta / baseline` as a fraction, or `null` if not computable. */
  readonly pctChange: number | null;
}

/** The result of diffing a verdict against a stored baseline. */
export interface BaselineComparison {
  readonly budget: string;
  readonly baselineAt: string | null;
  readonly deltas: readonly MetricDelta[];
}

/**
 * Diff a fresh verdict's metric values against a baseline entry, reporting a
 * signed delta and percent-change per metric. With no baseline (e.g. an empty
 * history) every baseline value is `null` and deltas are `null` — the first run
 * just establishes the baseline. Judgement (pass/fail) is independent of this;
 * baseline comparison is purely informational trend data.
 */
export function compareToBaseline(
  verdict: BudgetVerdict,
  baseline: HistoryEntry | null,
): BaselineComparison {
  const baseMetrics = baseline?.metrics ?? {};
  const deltas: MetricDelta[] = verdict.metrics.map((m) => {
    const current = m.value;
    const baseValue = m.id in baseMetrics ? baseMetrics[m.id]! : null;
    const computable =
      typeof current === "number" && typeof baseValue === "number";
    const delta = computable ? round(current - baseValue) : null;
    const pctChange =
      computable && baseValue !== 0 ? round((current - baseValue) / baseValue) : null;
    return { id: m.id, baseline: baseValue, current, delta, pctChange };
  });
  return {
    budget: verdict.budget,
    baselineAt: baseline?.recordedAt ?? null,
    deltas,
  };
}

/**
 * The default/initial CI budget. Thresholds are deliberately loose, sane
 * starting points — generous enough not to flake on shared CI runners while
 * still catching gross regressions. Tune over time using the recorded trend
 * history. Suite configs are kept small for CI speed/determinism.
 */
export const DEFAULT_BUDGET: BudgetConfig = {
  name: "frick-default",
  latency: { iterations: 30, catchUpBacklog: 20 },
  throughput: { connections: 4, opsPerConnection: 100, upsertRatio: 0.2 },
  metrics: [
    // Latency ceilings (p99, in ms) across the hot paths.
    {
      id: "latency.httpRequest.p99",
      suite: "latency",
      path: "paths.httpRequest.latencyMs.p99",
      comparison: "max",
      threshold: 250,
      unit: "ms",
    },
    {
      id: "latency.wsAppend.p99",
      suite: "latency",
      path: "paths.wsAppend.latencyMs.p99",
      comparison: "max",
      threshold: 250,
      unit: "ms",
    },
    {
      id: "latency.objectFanout.p99",
      suite: "latency",
      path: "paths.objectFanout.latencyMs.p99",
      comparison: "max",
      threshold: 300,
      unit: "ms",
    },
    {
      id: "latency.catchUp.p99",
      suite: "latency",
      path: "paths.catchUp.latencyMs.p99",
      comparison: "max",
      threshold: 300,
      unit: "ms",
    },
    // Throughput floor (combined ops/sec).
    {
      id: "throughput.total.perSec",
      suite: "throughput",
      path: "throughputPerSec.total",
      comparison: "min",
      threshold: 200,
      unit: "ops/sec",
    },
    // Memory-growth ceiling over the sustained run.
    {
      id: "throughput.rssGrowth",
      suite: "throughput",
      path: "resources.delta.rssBytes",
      comparison: "max",
      threshold: 256 * 1024 * 1024,
      unit: "bytes",
    },
  ],
};
