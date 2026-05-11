/**
 * `frick verify` — execs `pnpm verify:generated`, which regenerates schema
 * + fixtures and asserts there is no diff against checked-in artifacts.
 */
import { spawn } from "node:child_process";
import type { ParsedArgs } from "../argv.js";
import { emit, type OutputOptions } from "../output.js";

export async function verifyCommand(_parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["verify:generated"], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      emit({ ok: code === 0, command: "pnpm verify:generated", exitCode: code ?? -1 }, out);
      resolve(code ?? 1);
    });
  });
}
