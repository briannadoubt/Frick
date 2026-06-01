/**
 * `frick reset --dev` — wipe framework tables. Refuses unless `env ===
 * "development"` and `--dev` is passed. Returns the number of tables
 * dropped (post-condition: 0 framework rows remain).
 */
import { DatabaseSync } from "node:sqlite";
import { FRAMEWORK_TABLES, resetFrickDatabase, FrickResetRefusedError } from "@frick/server";
import type { ParsedArgs } from "../argv.js";
import { CliRefusedError } from "../errors.js";
import { contextFlagsFrom, loadConfig } from "../context.js";
import { emit, type OutputOptions } from "../output.js";

export async function resetCommand(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const config = loadConfig(contextFlagsFrom(parsed.flags));
  if (parsed.flags.dev !== true) {
    throw new CliRefusedError("`frick reset` requires --dev (development-only)", {
      env: config.env,
    });
  }
  if (config.env !== "development") {
    throw new CliRefusedError(
      `Refusing to reset: env is '${config.env}', expected 'development'`,
      { env: config.env, dbPath: config.dbPath },
    );
  }

  // Open with FK pragma off via the reset helper; we just need to count
  // rows beforehand for the report. The reset helper opens its own handle
  // when given a path, so we use a separate read-only probe.
  const probe = new DatabaseSync(config.dbPath);
  const tablesDropped: string[] = [];
  try {
    for (const table of FRAMEWORK_TABLES) {
      try {
        probe.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
        tablesDropped.push(table);
      } catch {
        // Table doesn't exist — fine, the reset will be a no-op for it.
      }
    }
  } finally {
    probe.close();
  }

  try {
    resetFrickDatabase({ db: config.dbPath, env: "development", confirmDevReset: true });
  } catch (error) {
    if (error instanceof FrickResetRefusedError) {
      throw new CliRefusedError(error.message, { reason: error.reason });
    }
    throw error;
  }

  emit(
    {
      ok: true,
      dbPath: config.dbPath,
      env: config.env,
      tablesDropped,
    },
    out,
  );
  return 0;
}
