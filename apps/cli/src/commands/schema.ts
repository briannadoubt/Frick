/**
 * `frick schema check` — validate the foundation schema and emit its identity.
 * `frick schema generate` — convenience wrapper around `pnpm schema:generate`.
 */
import { spawn } from "node:child_process";
import { foundationSchema, validateSchema } from "@fricken/protocol";
import type { ParsedArgs } from "../argv.js";
import { CliUsageError, CliFailureError } from "../errors.js";
import { emit, type OutputOptions } from "../output.js";

export async function schemaCommand(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === "check") return schemaCheck(out);
  if (sub === "generate") return schemaGenerate(out);
  throw new CliUsageError(`Unknown schema subcommand: ${sub ?? "<missing>"}`, {
    expected: ["check", "generate"],
  });
}

function schemaCheck(out: OutputOptions): number {
  try {
    const validated = validateSchema(foundationSchema);
    emit(
      {
        ok: true,
        schemaId: validated.schemaId,
        schemaVersion: validated.schemaVersion,
        schemaRevision: validated.schemaRevision,
        schemaHash: validated.hash,
      },
      out,
    );
    return 0;
  } catch (error) {
    throw new CliFailureError(
      "schema.invalid",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function schemaGenerate(out: OutputOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["schema:generate"], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      emit({ ok: code === 0, command: "pnpm schema:generate", exitCode: code ?? -1 }, out);
      resolve(code ?? 1);
    });
  });
}
