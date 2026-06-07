/**
 * `frick inspect <server|db|jobs|diagnostics>` — mirror the `/_frick/inspect/*`
 * HTTP routes, but driven directly from a local DB. No HTTP server is started.
 *
 * The shapes mirror `server.ts`'s inspection handlers so an operator can
 * diff CLI output against the running server's output without surprises.
 *
 * `diagnostics` emits the full structured diagnostics snapshot (FR-76/FR-77):
 * schema identity + compatibility, cursors, recent errors, cache metadata, and
 * sync timing, assembled from the local store.
 */
import { assembleDiagnosticsSnapshot, type DiagnosticsCursorProbe } from "@fricken/server";
import type { ParsedArgs } from "../argv.js";
import { CliUsageError } from "../errors.js";
import { contextFlagsFrom, loadConfig, openStore } from "../context.js";
import { emit, type OutputOptions } from "../output.js";

export async function inspectCommand(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === "server") return inspectServer(parsed, out);
  if (sub === "db") return inspectDb(parsed, out);
  if (sub === "jobs") return inspectJobs(parsed, out);
  if (sub === "diagnostics") return inspectDiagnostics(parsed, out);
  throw new CliUsageError(`Unknown inspect subcommand: ${sub ?? "<missing>"}`, {
    expected: ["server", "db", "jobs", "diagnostics"],
  });
}

function inspectServer(parsed: ParsedArgs, out: OutputOptions): number {
  const config = loadConfig(contextFlagsFrom(parsed.flags));
  const store = openStore(config);
  try {
    emit(
      {
        schemaId: store.schema.schemaId,
        schemaVersion: store.schema.schemaVersion,
        schemaRevision: store.schema.schemaRevision,
        schemaHash: store.schema.hash,
        env: config.env,
        demoAuthEnabled: config.demoAuthEnabled,
        inspectionEnabled: config.inspectionEnabled,
        dbPath: config.dbPath,
      },
      out,
    );
    return 0;
  } finally {
    store.close();
  }
}

async function inspectDb(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const config = loadConfig(contextFlagsFrom(parsed.flags));
  const store = openStore(config);
  try {
    const applied = await store.listAppliedMigrations();
    const last = applied[applied.length - 1];
    emit(
      {
        ready: store.pingDatabase(),
        applied: applied.length,
        ...(last
          ? {
              lastApplied: {
                id: last.id,
                schemaRevision: last.schemaRevision,
                appliedAt: last.appliedAt,
              },
            }
          : {}),
        idempotencyCache: {
          size: store.idempotencyCache.size,
          capacity: store.idempotencyCache.capacity,
          evictions: store.idempotencyCache.evictions,
        },
        idempotencyKeyRows: store.idempotencyKeyRowCount(),
      },
      out,
    );
    return 0;
  } finally {
    store.close();
  }
}

/**
 * `frick inspect diagnostics` — emit the full structured diagnostics snapshot
 * (FR-76 model) assembled from the local store. Optional positional args after
 * `diagnostics` probe specific stream cursors in `stream:streamId` form, e.g.
 * `frick inspect diagnostics chat:room-1`.
 */
async function inspectDiagnostics(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const config = loadConfig(contextFlagsFrom(parsed.flags));
  const store = openStore(config);
  try {
    const tenantId = typeof parsed.flags["tenant-id"] === "string" ? parsed.flags["tenant-id"] : undefined;
    const cursors: DiagnosticsCursorProbe[] = [];
    for (const positional of parsed.positionals.slice(1)) {
      const sep = positional.indexOf(":");
      if (sep <= 0 || sep === positional.length - 1) {
        throw new CliUsageError(`Invalid cursor probe "${positional}" — expected stream:streamId`);
      }
      cursors.push({
        stream: positional.slice(0, sep),
        streamId: positional.slice(sep + 1),
        ...(tenantId !== undefined ? { tenantId } : {}),
      });
    }
    const snapshot = await assembleDiagnosticsSnapshot(store, {
      ...(config.env !== undefined ? { env: config.env } : {}),
      ...(cursors.length > 0 ? { cursors } : {}),
    });
    emit(snapshot, out);
    return 0;
  } finally {
    store.close();
  }
}

/**
 * Jobs framework isn't fully wired in the operator surface yet (no
 * countsByStatus on `JobStore` today). Emit a graceful "unavailable" record
 * — exit 0 so scripts that just probe presence don't fail.
 */
function inspectJobs(parsed: ParsedArgs, out: OutputOptions): number {
  const config = loadConfig(contextFlagsFrom(parsed.flags));
  const store = openStore(config);
  try {
    const jobs = store.jobs as unknown as { countsByStatus?: () => unknown };
    if (typeof jobs.countsByStatus === "function") {
      emit({ available: true, counts: jobs.countsByStatus() }, out);
    } else {
      emit({ available: false, reason: "jobs framework not detected" }, out);
    }
    return 0;
  } finally {
    store.close();
  }
}
