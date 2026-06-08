#!/usr/bin/env node
/**
 * `frick` benchmark CLI (FR-96 / FR-97 / FR-98 / FR-100).
 *
 * Drives synthetic load against a Frick server and prints a single structured
 * JSON result to stdout so CI/tooling can consume it. Diagnostics go to stderr.
 *
 * Subcommands:
 *   load        synthetic load harness          (FR-96, default)
 *   latency     per-path latency suite          (FR-97)
 *   throughput  sustained throughput + growth   (FR-98)
 *   budget      perf-budget check + trend       (FR-100)
 *
 * Usage:
 *   pnpm load:harness [flags]            # load harness (default)
 *   pnpm bench:latency [flags]           # latency suite
 *   pnpm bench:throughput [flags]        # throughput + resource-growth suite
 *   pnpm bench:budget [flags]            # perf-budget check + trend tracking
 */
import {
  parseLatencyConfig,
  parseLoadConfig,
  parseThroughputConfig,
} from "./config.js";
import {
  DEFAULT_BUDGET,
  appendHistory,
  compareToBaseline,
  readHistory,
  runBudgetCheck,
} from "./budget.js";
import { runLoad } from "./harness.js";
import { runLatency } from "./latency.js";
import { runThroughput } from "./throughput.js";

const LOAD_HELP = `frick load harness (FR-96)

Usage: pnpm load:harness [flags]

  --users N                     synthetic users
  --appends-per-user N          stream appends per user
  --object-writes-per-user N    object upserts per user
  --seed N                      deterministic seed
  --no-subscribe                skip WS subscription
  --http-url URL --ws-url URL   drive an external server (both required)
  --pretty                      indent the JSON output
  --help                        print this help

Prints a single JSON result to stdout. Diagnostics go to stderr.`;

const LATENCY_HELP = `frick latency benchmark (FR-97)

Usage: pnpm bench:latency [flags]

Measures p50/p90/p99 latency across the core paths: HTTP request, WS append
round-trip, object-upsert -> delta fan-out, catch-up (subscribe -> page), and
reconnect.

  --iterations N                samples per path
  --catch-up-backlog N          seeded backlog events for the catch-up path
  --http-url URL --ws-url URL   drive an external server (both required)
  --pretty                      indent the JSON output
  --help                        print this help

Prints a single JSON result to stdout. Diagnostics go to stderr.`;

const THROUGHPUT_HELP = `frick throughput + resource-growth benchmark (FR-98)

Usage: pnpm bench:throughput [flags]

Drives a sustained append/upsert workload and reports ops/sec plus resource
growth (process memory, SQLite db size + row counts, idempotency cache rows).

  --connections N               concurrent WS connections
  --ops-per-connection N        ops issued per connection
  --upsert-ratio F              fraction of ops that are object upserts (0..1)
  --no-await-acks               pipeline ops instead of awaiting each ack
  --seed N                      deterministic seed
  --http-url URL --ws-url URL   drive an external server (growth omitted)
  --pretty                      indent the JSON output
  --help                        print this help

Prints a single JSON result to stdout. Diagnostics go to stderr.`;

const BUDGET_HELP = `frick performance-budget check + trend tracking (FR-100)

Usage: pnpm bench:budget [flags]

Runs the latency (FR-97) and throughput (FR-98) suites once each (only those a
budget references), judges the extracted metrics against the budget's declared
thresholds, and prints a single PASS/FAIL verdict as JSON. Exits non-zero on
FAIL (override with --no-fail to always exit 0 — useful for opt-in/non-blocking
CI). Records each verdict to an NDJSON history file for trend comparison and, if
that history already has an entry, reports per-metric deltas vs. the latest one.

  --history PATH                NDJSON trend-history file (default: bench/.perf-history.ndjson)
  --no-history                  do not append to the history file
  --no-fail                     always exit 0 even on a FAILED budget
  --meta key=value              attach metadata to the history entry (repeatable)
  --pretty                      indent the JSON output
  --help                        print this help

Uses the built-in default budget (loose, sane initial thresholds). Prints a
single JSON verdict to stdout. Diagnostics go to stderr.`;

const TOP_HELP = `frick benchmark CLI

Usage: pnpm load:harness [load|latency|throughput|budget] [flags]

Subcommands:
  load        synthetic load harness (FR-96, default)
  latency     per-path latency suite (FR-97)
  throughput  sustained throughput + resource-growth (FR-98)
  budget      perf-budget check + trend tracking (FR-100)

Run "<subcommand> --help" for subcommand flags.`;

const DEFAULT_HISTORY_PATH = "bench/.perf-history.ndjson";

type Subcommand = "load" | "latency" | "throughput" | "budget";

function resolveSubcommand(argv: readonly string[]): { command: Subcommand; rest: string[] } {
  const first = argv[0];
  if (
    first === "load" ||
    first === "latency" ||
    first === "throughput" ||
    first === "budget"
  ) {
    return { command: first, rest: argv.slice(1) };
  }
  // Back-compat: no subcommand defaults to the FR-96 load harness.
  return { command: "load", rest: [...argv] };
}

/** Pull the string value following `--flag` (or `--flag=value`) from argv. */
function flagValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === `--${name}`) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) return next;
    }
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return undefined;
}

/** Collect all `--meta key=value` pairs into a record. */
function collectMeta(argv: readonly string[]): Record<string, string> | undefined {
  const meta: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "--meta") continue;
    const pair = argv[i + 1];
    if (pair === undefined || pair.startsWith("--")) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    meta[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stderr.write(TOP_HELP + "\n");
    return 0;
  }

  const { command, rest } = resolveSubcommand(argv);
  const wantsHelp = rest.includes("--help") || rest.includes("-h");
  const pretty = rest.includes("--pretty");

  try {
    if (command === "latency") {
      if (wantsHelp) {
        process.stderr.write(LATENCY_HELP + "\n");
        return 0;
      }
      const config = parseLatencyConfig(rest);
      const result = await runLatency(config);
      process.stdout.write(JSON.stringify(result, null, pretty ? 2 : undefined) + "\n");
      return result.totalErrors > 0 ? 1 : 0;
    }

    if (command === "throughput") {
      if (wantsHelp) {
        process.stderr.write(THROUGHPUT_HELP + "\n");
        return 0;
      }
      const config = parseThroughputConfig(rest);
      const result = await runThroughput(config);
      process.stdout.write(JSON.stringify(result, null, pretty ? 2 : undefined) + "\n");
      return result.ops.errors > 0 ? 1 : 0;
    }

    if (command === "budget") {
      if (wantsHelp) {
        process.stderr.write(BUDGET_HELP + "\n");
        return 0;
      }
      const noFail = rest.includes("--no-fail");
      const noHistory = rest.includes("--no-history");
      const historyPath = flagValue(rest, "history") ?? DEFAULT_HISTORY_PATH;
      const meta = collectMeta(rest);

      const verdict = await runBudgetCheck(DEFAULT_BUDGET);

      // Compare against the latest recorded entry (the trend baseline) before
      // we append this run, then record this run for future comparisons.
      let comparison: ReturnType<typeof compareToBaseline> | undefined;
      if (!noHistory) {
        const history = await readHistory(historyPath);
        const baseline = history.length > 0 ? history[history.length - 1]! : null;
        comparison = compareToBaseline(verdict, baseline);
        await appendHistory(historyPath, verdict, meta);
      }

      const output = comparison ? { ...verdict, baselineComparison: comparison } : verdict;
      process.stdout.write(JSON.stringify(output, null, pretty ? 2 : undefined) + "\n");
      if (verdict.pass) return 0;
      return noFail ? 0 : 1;
    }

    // command === "load"
    if (wantsHelp) {
      process.stderr.write(LOAD_HELP + "\n");
      return 0;
    }
    const config = parseLoadConfig(rest);
    const result = await runLoad(config);
    process.stdout.write(JSON.stringify(result, null, pretty ? 2 : undefined) + "\n");
    return result.totals.errors > 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write(`bench (${command}): ${(error as Error).message}\n`);
    return 2;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`bench failed: ${(error as Error)?.stack ?? String(error)}\n`);
    process.exitCode = 1;
  },
);
