#!/usr/bin/env tsx
/**
 * Pre-publish verification runner.
 *
 * Runs every release gate sequentially. Each step emits a JSON Lines record
 * to stdout with shape: { step, status, durationMs, exitCode?, error? }.
 * Exits 0 if every step passes; non-zero with a summary record otherwise.
 *
 * Flags:
 *   --skip-mobile  Skip swift:test + android:build (useful in CI without those toolchains).
 */
import { spawnSync } from "node:child_process";

type StepResult = {
  step: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  exitCode?: number;
  error?: string;
};

type Step = {
  name: string;
  command: string;
  args: string[];
  mobile?: boolean;
};

const STEPS: Step[] = [
  { name: "test", command: "pnpm", args: ["test"] },
  { name: "typecheck", command: "pnpm", args: ["typecheck"] },
  { name: "verify:generated", command: "pnpm", args: ["verify:generated"] },
  { name: "swift:test", command: "pnpm", args: ["swift:test"], mobile: true },
  { name: "android:build", command: "pnpm", args: ["android:build"], mobile: true },
];

function emit(record: StepResult): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const skipMobile = argv.includes("--skip-mobile");

  const results: StepResult[] = [];
  for (const step of STEPS) {
    if (step.mobile && skipMobile) {
      const record: StepResult = { step: step.name, status: "skipped", durationMs: 0 };
      results.push(record);
      emit(record);
      continue;
    }

    const started = Date.now();
    const result = spawnSync(step.command, step.args, {
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    });
    const durationMs = Date.now() - started;

    if (result.error) {
      const record: StepResult = {
        step: step.name,
        status: "failed",
        durationMs,
        error: result.error.message,
      };
      results.push(record);
      emit(record);
      continue;
    }

    const exitCode = result.status ?? 1;
    const record: StepResult = {
      step: step.name,
      status: exitCode === 0 ? "passed" : "failed",
      durationMs,
      exitCode,
    };
    results.push(record);
    emit(record);
  }

  const failed = results.filter((r) => r.status === "failed");
  const summary = {
    summary: true,
    total: results.length,
    passed: results.filter((r) => r.status === "passed").length,
    failed: failed.length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failedSteps: failed.map((r) => r.step),
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);

  process.exit(failed.length === 0 ? 0 : 1);
}

main();
