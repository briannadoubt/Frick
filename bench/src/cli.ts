#!/usr/bin/env node
/**
 * `frick` load harness CLI (FR-96).
 *
 * Drives synthetic load against a Frick server and prints a single structured
 * JSON result to stdout so CI/tooling can consume it. Diagnostics go to stderr.
 *
 * Usage:
 *   pnpm load:harness [flags]
 *
 * Flags (all optional; env fallbacks in parens):
 *   --users N                     synthetic users          (FRICK_LOAD_USERS)
 *   --appends-per-user N          stream appends per user  (FRICK_LOAD_APPENDS_PER_USER)
 *   --object-writes-per-user N    object upserts per user  (FRICK_LOAD_OBJECT_WRITES_PER_USER)
 *   --seed N                      deterministic seed       (FRICK_LOAD_SEED)
 *   --no-subscribe                skip WS subscription     (FRICK_LOAD_SUBSCRIBE=0)
 *   --http-url URL --ws-url URL   drive an external server (FRICK_LOAD_HTTP_URL / _WS_URL)
 *   --pretty                      indent the JSON output
 *   --help                        print this help to stderr
 */
import { parseLoadConfig } from "./config.js";
import { runLoad } from "./harness.js";

const HELP = `frick load harness (FR-96)

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

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write(HELP + "\n");
    return 0;
  }
  const pretty = argv.includes("--pretty");

  let config;
  try {
    config = parseLoadConfig(argv);
  } catch (error) {
    process.stderr.write(`load harness: ${(error as Error).message}\n`);
    return 2;
  }

  const result = await runLoad(config);
  process.stdout.write(JSON.stringify(result, null, pretty ? 2 : undefined) + "\n");
  return result.totals.errors > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`load harness failed: ${(error as Error)?.stack ?? String(error)}\n`);
    process.exitCode = 1;
  },
);
