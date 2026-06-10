/**
 * Extract the framework migration lists into JSON fixtures for the Rust
 * rewrite (FR-241, epic FR-236).
 *
 * Dumps both dialects' migration lists VERBATIM — the SQL text is the exact
 * template-literal string the server hashes, so these fixtures are the
 * byte-level source of truth the Rust `frick-store` crate embeds via
 * `include_str!`:
 *
 *   conformance/fixtures/migrations/sqlite.json
 *   conformance/fixtures/migrations/postgres.json
 *
 * Each entry is `{ id, schemaRevision, description, sql, checksum }` where
 * `checksum` is computed by the production TS checksum function
 * (`"sha256-" + hex(sha256(utf8(`${id}|${schemaRevision}|${sql}`)))`).
 *
 * Run from the repo root: pnpm fixtures:migrations
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FRAMEWORK_MIGRATIONS,
  computeMigrationChecksum,
  type FrameworkMigration,
} from "../apps/server/src/storage/migrations.js";
import { FRAMEWORK_MIGRATIONS_PG } from "../apps/server/src/storage/pg-framework-migrations.js";

const outDir = join(process.cwd(), "conformance", "fixtures", "migrations");

interface MigrationFixtureEntry {
  readonly id: string;
  readonly schemaRevision: number;
  readonly description: string;
  readonly sql: string;
  readonly checksum: string;
}

function toFixtureEntries(
  migrations: readonly FrameworkMigration[],
): MigrationFixtureEntry[] {
  return migrations.map((migration) => ({
    id: migration.id,
    schemaRevision: migration.schemaRevision,
    description: migration.description,
    sql: migration.sql,
    checksum: computeMigrationChecksum(migration),
  }));
}

mkdirSync(outDir, { recursive: true });

const targets: ReadonlyArray<readonly [string, readonly FrameworkMigration[]]> = [
  ["sqlite.json", FRAMEWORK_MIGRATIONS],
  ["postgres.json", FRAMEWORK_MIGRATIONS_PG],
];

for (const [filename, migrations] of targets) {
  const path = join(outDir, filename);
  writeFileSync(path, `${JSON.stringify(toFixtureEntries(migrations), null, 2)}\n`);
  console.log(`wrote ${migrations.length} migrations to ${path}`);
}
