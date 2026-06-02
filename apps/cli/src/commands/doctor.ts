/**
 * `frick doctor` — composite health check. Emits one JSON record describing
 * schema, DB, migrations, and config status; exits 0 if all green, 1 if any
 * check failed.
 *
 * "Green" rules:
 *   - schema: `validateSchema(foundationSchema)` succeeds.
 *   - db: `store.pingDatabase()` returns true.
 *   - migrations: `frick_migrations` is readable and no checksum drift; we
 *     surface counts but a drifted checksum is treated as fatal (the
 *     migration runner would throw — we catch and report).
 *   - config: no error thrown from `loadFrickConfig`.
 */
import { DatabaseSync } from "node:sqlite";
import { foundationSchema, validateSchema } from "@fricken/protocol";
import { computeMigrationChecksum, FRAMEWORK_MIGRATIONS, listAppliedMigrations } from "@fricken/server";
import type { ParsedArgs } from "../argv.js";
import { contextFlagsFrom, loadConfig } from "../context.js";
import { emit, type OutputOptions } from "../output.js";

interface CheckResult {
  ok: boolean;
  detail?: Record<string, unknown>;
  error?: string;
}

export async function doctorCommand(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const ctx = contextFlagsFrom(parsed.flags);

  let configCheck: CheckResult;
  let configEnv: string | undefined;
  let configDbPath: string | undefined;
  try {
    const config = loadConfig(ctx);
    configEnv = config.env;
    configDbPath = config.dbPath;
    configCheck = {
      ok: true,
      detail: {
        env: config.env,
        dbPath: config.dbPath,
        demoAuthEnabled: config.demoAuthEnabled,
        inspectionEnabled: config.inspectionEnabled,
        adminEnabled: config.adminEnabled,
      },
    };
  } catch (error) {
    configCheck = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const schemaCheck: CheckResult = (() => {
    try {
      const v = validateSchema(foundationSchema);
      return {
        ok: true,
        detail: {
          schemaId: v.schemaId,
          schemaRevision: v.schemaRevision,
          schemaHash: v.hash,
        },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })();

  let dbCheck: CheckResult = { ok: false, error: "not_evaluated" };
  let migrationsCheck: CheckResult = { ok: false, error: "not_evaluated" };

  if (configCheck.ok && configDbPath !== undefined) {
    // Don't go through openStore() — we don't want to mutate or initialise
    // the schema. Open the raw db handle so a missing DB file surfaces as a
    // db-check failure rather than a side-effecting init.
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(configDbPath);
      const row = db.prepare("SELECT 1 AS ok").get() as { ok?: number } | undefined;
      dbCheck = row?.ok === 1 ? { ok: true, detail: { dbPath: configDbPath } } : { ok: false, error: "ping_failed" };
    } catch (error) {
      dbCheck = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    if (dbCheck.ok && db) {
      try {
        const applied = listAppliedMigrations(db);
        const appliedById = new Map(applied.map((r) => [r.id, r] as const));
        const drift: Array<{ id: string; recorded: string; current: string }> = [];
        for (const migration of FRAMEWORK_MIGRATIONS) {
          const recorded = appliedById.get(migration.id);
          if (!recorded) continue;
          const current = computeMigrationChecksum(migration);
          if (recorded.checksum !== current) {
            drift.push({ id: migration.id, recorded: recorded.checksum, current });
          }
        }
        const pending = FRAMEWORK_MIGRATIONS.filter((m) => !appliedById.has(m.id)).map((m) => m.id);
        migrationsCheck = {
          ok: drift.length === 0,
          detail: {
            appliedCount: applied.length,
            expectedCount: FRAMEWORK_MIGRATIONS.length,
            pending,
            drift,
          },
          ...(drift.length > 0 ? { error: `checksum_drift:${drift.length}` } : {}),
        };
      } catch (error) {
        migrationsCheck = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    db?.close();
  }

  const ok = configCheck.ok && schemaCheck.ok && dbCheck.ok && migrationsCheck.ok;
  emit(
    {
      ok,
      env: configEnv,
      schema: schemaCheck,
      db: dbCheck,
      migrations: migrationsCheck,
      config: configCheck,
    },
    out,
  );
  return ok ? 0 : 1;
}
