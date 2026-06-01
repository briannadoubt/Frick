/**
 * `frick migrate status` — list applied vs pending framework migrations.
 * `frick migrate up`     — apply pending framework migrations.
 *
 * Both subcommands open a `FrickStore` (which initialises the bootstrap
 * tables and `frick_migrations` ledger) and inspect / drive the migration
 * runner.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { FRAMEWORK_MIGRATIONS, listAppliedMigrations, runFrameworkMigrations } from "@frick/server";
import { foundationSchema } from "@frick/protocol";
import type { ParsedArgs } from "../argv.js";
import { CliUsageError, CliRefusedError } from "../errors.js";
import { contextFlagsFrom, loadConfig } from "../context.js";
import { emit, type OutputOptions } from "../output.js";

export async function migrateCommand(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === "status") return migrateStatus(parsed, out);
  if (sub === "up") return migrateUp(parsed, out);
  throw new CliUsageError(`Unknown migrate subcommand: ${sub ?? "<missing>"}`, {
    expected: ["status", "up"],
  });
}

function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  return new DatabaseSync(path);
}

function migrateStatus(parsed: ParsedArgs, out: OutputOptions): number {
  const config = loadConfig(contextFlagsFrom(parsed.flags));
  const db = openDb(config.dbPath);
  try {
    const applied = listAppliedMigrations(db);
    const appliedIds = new Set(applied.map((r) => r.id));
    const pending = FRAMEWORK_MIGRATIONS.filter((m) => !appliedIds.has(m.id)).map((m) => ({
      id: m.id,
      schemaRevision: m.schemaRevision,
      description: m.description,
    }));
    emit(
      {
        dbPath: config.dbPath,
        env: config.env,
        applied: applied.map((r) => ({
          id: r.id,
          schemaRevision: r.schemaRevision,
          appliedAt: r.appliedAt,
          checksum: r.checksum,
          durationMs: r.durationMs,
        })),
        pending,
      },
      out,
    );
    return 0;
  } finally {
    db.close();
  }
}

function migrateUp(parsed: ParsedArgs, out: OutputOptions): number {
  const config = loadConfig(contextFlagsFrom(parsed.flags));
  if (config.env === "production" && parsed.flags["confirm-prod"] !== true) {
    throw new CliRefusedError(
      "Refusing to run migrations against a production-mode config without --confirm-prod",
      { env: config.env, dbPath: config.dbPath },
    );
  }
  const db = openDb(config.dbPath);
  try {
    const result = runFrameworkMigrations(db, {
      supportedSchemaRevision: foundationSchema.schemaRevision,
    });
    emit(
      {
        dbPath: config.dbPath,
        env: config.env,
        applied: result.applied.map((r) => ({
          id: r.id,
          schemaRevision: r.schemaRevision,
          appliedAt: r.appliedAt,
          durationMs: r.durationMs,
        })),
        alreadyApplied: result.alreadyApplied.map((r) => r.id),
      },
      out,
    );
    return 0;
  } finally {
    db.close();
  }
}
