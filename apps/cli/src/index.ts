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
  { name: "init", summary: "Scaffold a new Frick application at the given directory" },
  { name: "scaffold", summary: "Add an object, stream, or projection stub to a scaffolded app", subcommands: ["object", "stream", "projection"] },
  { name: "dashboard", summary: "Serve Fricken Dashboard for a running Frick server" },
  { name: "mcp", summary: "Run a stdio MCP server for agent access to documented Frick runtime surfaces" },
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
        return await (await import("./commands/schema.js")).schemaCommand(childParsed, out);
      case "lint":
        return await (await import("./commands/lint.js")).lintCommand(childParsed, out);
      case "migrate":
        return await (await import("./commands/migrate.js")).migrateCommand(childParsed, out);
      case "doctor":
        return await (await import("./commands/doctor.js")).doctorCommand(childParsed, out);
      case "inspect":
        return await (await import("./commands/inspect.js")).inspectCommand(childParsed, out);
      case "reset":
        return await (await import("./commands/reset.js")).resetCommand(childParsed, out);
      case "tenants":
        return await (await import("./commands/tenants.js")).tenantsCommand(childParsed, out);
      case "verify":
        return await (await import("./commands/verify.js")).verifyCommand(childParsed, out);
      case "backup":
        return await (await import("./commands/backup.js")).backupCommand(childParsed, out);
      case "restore":
        return await (await import("./commands/restore.js")).restoreCommand(childParsed, out);
      case "init":
        return await (await import("./commands/init.js")).initCommand(childParsed, out);
      case "scaffold":
        return await (await import("./commands/scaffold.js")).scaffoldCommand(childParsed, out);
      case "dashboard":
        return await (await import("./commands/dashboard.js")).dashboardCommand(childParsed, out);
      case "mcp":
        return await (await import("./commands/mcp.js")).mcpCommand(childParsed, out);
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
