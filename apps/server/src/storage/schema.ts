import type { DatabaseSync } from "node:sqlite";
import { runFrameworkMigrations } from "./migrations.js";

/**
 * Initialize the SQLite database for the Frick server.
 *
 * Tables are no longer created via inline `CREATE TABLE IF NOT EXISTS`
 * statements — the migration runner is now the single source of truth for
 * framework schema. This function applies pragmas, then delegates table
 * creation to `runFrameworkMigrations`.
 */
export function initializeStorage(db: DatabaseSync, supportedSchemaRevision: number): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
  `);
  runFrameworkMigrations(db, { supportedSchemaRevision });
}
