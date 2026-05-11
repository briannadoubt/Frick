import { DatabaseSync } from "node:sqlite";
import { FRAMEWORK_TABLES } from "./migrations.js";

export interface ResetFrickDatabaseOptions {
  /** Path to the SQLite database, or an already-open `DatabaseSync` handle. */
  readonly db: string | DatabaseSync;
  /**
   * Environment marker. Anything other than `"development"` is treated as
   * production and the reset is rejected. Use `process.env.NODE_ENV` here.
   */
  readonly env: string | undefined;
  /**
   * Explicit confirmation flag. Even in development the caller must opt in,
   * so an accidental import in test setup can't wipe a real database.
   */
  readonly confirmDevReset: boolean;
}

/**
 * Error thrown when `resetFrickDatabase` refuses to run because the safety
 * gates aren't satisfied. Carries the reason so operators can act on it.
 */
export class FrickResetRefusedError extends Error {
  constructor(readonly reason: "production_env" | "missing_confirmation") {
    super(
      reason === "production_env"
        ? "Refusing to reset Frick database: env is not 'development'. Set env: 'development' explicitly to allow."
        : "Refusing to reset Frick database: confirmDevReset must be true.",
    );
    this.name = "FrickResetRefusedError";
  }
}

/**
 * Dev-only path that drops every framework-managed table (objects, stream
 * events, idempotency keys, presence, signals, sessions, accounts, jobs,
 * inbox, blob metadata + content, schema_versions, and the frick_migrations
 * ledger itself). Intentionally exposed as a separate exported function
 * rather than an HTTP route — operators must opt in by calling it directly.
 *
 * Safety gates:
 *   - `env` must equal `"development"` (raw string match, not parsed).
 *   - `confirmDevReset` must be `true`.
 *
 * Either failing gate throws `FrickResetRefusedError` before touching SQLite.
 */
export function resetFrickDatabase(options: ResetFrickDatabaseOptions): void {
  if (options.env !== "development") {
    throw new FrickResetRefusedError("production_env");
  }
  if (options.confirmDevReset !== true) {
    throw new FrickResetRefusedError("missing_confirmation");
  }

  const db = typeof options.db === "string" ? new DatabaseSync(options.db) : options.db;
  const ownsDb = typeof options.db === "string";

  try {
    // Drop in a transaction so a partial failure doesn't leave a half-wiped
    // database that the migration runner can't make sense of.
    db.exec("BEGIN IMMEDIATE");
    try {
      // Disable FK enforcement for the duration so the order of table drops
      // doesn't matter (blob_content references blob_metadata).
      db.exec("PRAGMA foreign_keys = OFF");
      for (const table of FRAMEWORK_TABLES) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure; we're already throwing.
      }
      throw error;
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}
