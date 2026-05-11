#!/usr/bin/env node
/**
 * `frick` — operational CLI. Thin wrapper around the framework's module
 * functions (config loading, migration runner, tenant store, dev reset).
 *
 * Output is JSON Lines by default — every command emits exactly one JSON
 * record on stdout. `--pretty` switches to indented JSON. Errors go to
 * stderr as `{ error: { code, message, details? } }`. Exit codes:
 *   0 ok, 1 failure, 2 usage, 3 framework refused.
 */
import { parseArgs } from "./argv.js";
import { emit, emitError, resolveOutputMode, type OutputOptions } from "./output.js";
import { toErrorShape, EXIT_USAGE } from "./errors.js";
import { lintCommand } from "./commands/lint.js";
import { schemaCommand } from "./commands/schema.js";
import { migrateCommand } from "./commands/migrate.js";
import { doctorCommand } from "./commands/doctor.js";
import { inspectCommand } from "./commands/inspect.js";
import { resetCommand } from "./commands/reset.js";
import { tenantsCommand } from "./commands/tenants.js";
import { verifyCommand } from "./commands/verify.js";
import { backupCommand } from "./commands/backup.js";
import { restoreCommand } from "./commands/restore.js";

interface CommandSpec {
  name: string;
  summary: string;
  subcommands?: string[];
}

const COMMANDS: readonly CommandSpec[] = [
  { name: "schema", summary: "Validate or regenerate the schema", subcommands: ["check", "generate"] },
  { name: "lint", summary: "Lint the current schema or compare it to a previous snapshot" },
  { name: "migrate", summary: "Manage framework migrations", subcommands: ["status", "up"] },
  { name: "doctor", summary: "Composite health check (schema, db, migrations, config)" },
  { name: "inspect", summary: "Inspect runtime state from the local DB", subcommands: ["server", "db", "jobs"] },
  { name: "reset", summary: "Drop framework tables (development only, requires --dev)" },
  { name: "tenants", summary: "Manage the tenants ledger", subcommands: ["list", "create"] },
  { name: "verify", summary: "Run `pnpm verify:generated` end-to-end" },
  { name: "backup", summary: "Stream a framework database dump as NDJSON" },
  { name: "restore", summary: "Restore a framework database from NDJSON (requires --confirm yes)" },
];

export interface RunOptions {
  argv: readonly string[];
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export async function run(opts: RunOptions): Promise<number> {
  const parsed = parseArgs(opts.argv);
  const out: OutputOptions = {
    mode: resolveOutputMode(parsed.flags),
    stdout: opts.stdout,
    stderr: opts.stderr,
  };

  // Top-level --help (no command, or `--help`/`-h` before command).
  const command = parsed.positionals[0];
  if (!command || parsed.flags.help === true || command === "help") {
    emit({ commands: COMMANDS }, out);
    return 0;
  }

  // Discard the top-level positional and re-parse the remainder so each
  // command handler sees its own subcommand at positionals[0].
  const childArgs = opts.argv.slice(opts.argv.indexOf(command) + 1);
  const childParsed = parseArgs(childArgs);

  try {
    switch (command) {
      case "schema":
        return await schemaCommand(childParsed, out);
      case "lint":
        return await lintCommand(childParsed, out);
      case "migrate":
        return await migrateCommand(childParsed, out);
      case "doctor":
        return await doctorCommand(childParsed, out);
      case "inspect":
        return await inspectCommand(childParsed, out);
      case "reset":
        return await resetCommand(childParsed, out);
      case "tenants":
        return await tenantsCommand(childParsed, out);
      case "verify":
        return await verifyCommand(childParsed, out);
      case "backup":
        return await backupCommand(childParsed, out);
      case "restore":
        return await restoreCommand(childParsed, out);
      default: {
        emitError(
          {
            code: "cli.unknown_command",
            message: `Unknown command: ${command}`,
            details: { available: COMMANDS.map((c) => c.name) },
          },
          out,
        );
        return EXIT_USAGE;
      }
    }
  } catch (error) {
    const shape = toErrorShape(error);
    emitError(
      {
        code: shape.code,
        message: shape.message,
        ...(shape.details ? { details: shape.details } : {}),
      },
      out,
    );
    return shape.exitCode;
  }
}

// CLI entry — only run when invoked directly, not when imported by tests.
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("/index.ts") ||
    process.argv[1].endsWith("/index.js") ||
    process.argv[1].endsWith("frick"));

if (invokedDirectly) {
  const code = await run({
    argv: process.argv.slice(2),
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exit(code);
}
