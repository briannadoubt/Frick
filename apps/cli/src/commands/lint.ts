/**
 * `frick lint [--against <path-to-previous-schema.json>]`
 *
 * - Without `--against`: runs the single-schema linter on the foundation
 *   schema and emits a JSON Lines summary.
 * - With `--against <path>`: loads the previous-schema snapshot from disk
 *   and runs a change-lint against the current foundation schema. Each
 *   finding is emitted as its own JSON Lines record, followed by a summary
 *   record. Exit code is 1 when any finding has severity=breaking.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  foundationSchema,
  lintSchema,
  lintSchemaChange,
  type FrickLintResult,
  type FrickSchema,
} from "@frick/protocol";
import type { ParsedArgs } from "../argv.js";
import { requireString } from "../argv.js";
import { CliFailureError } from "../errors.js";
import { emit, type OutputOptions } from "../output.js";

export async function lintCommand(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const against = requireString(parsed.flags, "against");
  if (against === undefined) {
    return lintCurrent(out);
  }
  return lintChange(against, out);
}

function lintCurrent(out: OutputOptions): number {
  const result = lintSchema(foundationSchema);
  emitResult(result, out);
  return result.breakingCount > 0 ? 1 : 0;
}

async function lintChange(againstPath: string, out: OutputOptions): Promise<number> {
  let previous: FrickSchema;
  try {
    const raw = await readFile(resolve(againstPath), "utf8");
    previous = JSON.parse(raw) as FrickSchema;
  } catch (error) {
    throw new CliFailureError(
      "lint.previous_unreadable",
      `Could not read previous schema from ${againstPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = lintSchemaChange(foundationSchema, previous);
  emitResult(result, out);
  return result.breakingCount > 0 ? 1 : 0;
}

function emitResult(result: FrickLintResult, out: OutputOptions): void {
  for (const finding of result.findings) {
    emit(finding, out);
  }
  emit(
    {
      ok: result.breakingCount === 0,
      findings: result.findings.length,
      breaking: result.breakingCount,
    },
    out,
  );
}
