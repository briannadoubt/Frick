import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * A single framework migration. Migrations are defined as code (not loaded from
 * .sql files on disk) so we can compute deterministic checksums and avoid any
 * file IO at server startup. Each migration's `sql` is executed exactly once
 * inside a SQLite transaction by the runner, then recorded in the
 * `frick_migrations` table along with its checksum and execution duration.
 */
export interface FrameworkMigration {
  /** Stable identifier for this migration. Must never be reused or renamed. */
  readonly id: string;
  /**
   * The `FrickSchema.schemaRevision` this migration upgrades the database to.
   * The runner refuses to boot if the database records a revision newer than
   * the current schema's revision.
   */
  readonly schemaRevision: number;
  /** Human-readable description, surfaced in errors and logs. */
  readonly description: string;
  /** SQL executed inside a transaction. May contain multiple statements. */
  readonly sql: string;
}

/** Row format for the `frick_migrations` ledger table. */
export interface AppliedMigrationRow {
  readonly id: string;
  readonly schemaRevision: number;
  readonly appliedAt: string;
  readonly checksum: string;
  readonly durationMs: number;
}

/** Base error for migration runner failures. */
export class FrickMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrickMigrationError";
  }
}

/**
 * Thrown when a migration's recorded checksum no longer matches the in-code
 * definition. This catches the case where someone edits an already-applied
 * migration in place — the only safe response is to refuse to boot.
 */
export class FrickMigrationChecksumError extends FrickMigrationError {
  constructor(
    readonly migrationId: string,
    readonly recordedChecksum: string,
    readonly currentChecksum: string,
  ) {
    super(
      `Migration ${migrationId} checksum drift detected: ` +
        `database recorded ${recordedChecksum} but current definition is ${currentChecksum}. ` +
        `Refusing to boot — restore the original migration or roll the database forward with a new migration.`,
    );
    this.name = "FrickMigrationChecksumError";
  }
}

/**
 * Thrown when the database records a schema revision newer than what the
 * server currently supports. Surfaces the "rolled the server back into an
 * older binary against a newer database" case.
 */
export class FrickMigrationRevisionError extends FrickMigrationError {
  constructor(readonly databaseRevision: number, readonly supportedRevision: number) {
    super(
      `Database schema revision ${databaseRevision} is newer than the server's supported revision ` +
        `${supportedRevision}. Refusing to boot — upgrade the server or restore a compatible database.`,
    );
    this.name = "FrickMigrationRevisionError";
  }
}

/**
 * Compute the canonical checksum for a migration. The checksum is a stable
 * SHA-256 of `${id}|${schemaRevision}|${sql}`. We include the schemaRevision
 * so re-bucketing a migration to a different revision is detected as drift.
 */
export function computeMigrationChecksum(migration: FrameworkMigration): string {
  const payload = `${migration.id}|${migration.schemaRevision}|${migration.sql}`;
  return `sha256-${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

/**
 * The framework migrations bundled with this server build. The runner applies
 * any entries here that aren't already present in `frick_migrations` (in
 * declaration order) inside a transaction. New entries are append-only — never
 * mutate an applied migration in place.
 */
export const FRAMEWORK_MIGRATIONS: readonly FrameworkMigration[] = [
  {
    id: "0001_initial_foundation_tables",
    schemaRevision: 1,
    description: "Create initial foundation tables (objects, streams, blobs, sessions, accounts).",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_versions (
        schema_hash TEXT PRIMARY KEY,
        manifest BLOB NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS objects (
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        packed BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (object_type, object_id)
      );

      CREATE TABLE IF NOT EXISTS stream_events (
        stream_type TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        packed BLOB NOT NULL,
        replica_id TEXT,
        request_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (stream_type, stream_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        replica_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        result_event_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (replica_id, request_id)
      );

      CREATE TABLE IF NOT EXISTS presence_leases (
        presence_type TEXT NOT NULL,
        presence_key TEXT NOT NULL,
        packed BLOB NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (presence_type, presence_key)
      );

      CREATE TABLE IF NOT EXISTS signal_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_type TEXT NOT NULL,
        signal_key TEXT NOT NULL,
        packed BLOB NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS blob_metadata (
        blob_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        storage_key TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS blob_content (
        blob_id TEXT PRIMARY KEY,
        content BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (blob_id) REFERENCES blob_metadata(blob_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS conversation_inbox (
        conversation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        title TEXT,
        kind TEXT NOT NULL,
        last_sequence INTEGER NOT NULL,
        last_message_body TEXT,
        last_message_at TEXT,
        last_message_sender_id TEXT,
        read_sequence INTEGER NOT NULL,
        unread_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS conversation_inbox_by_user
        ON conversation_inbox (user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_type TEXT NOT NULL,
        packed BLOB NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        session_token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        replica_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS auth_sessions_by_user
        ON auth_sessions (user_id, expires_at DESC);

      CREATE TABLE IF NOT EXISTS auth_accounts (
        user_id TEXT PRIMARY KEY,
        handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    // Additive: the initial migration already gave `idempotency_keys` a TEXT
    // `created_at` column (ISO-8601 timestamps), which sort lexicographically
    // by time and so are usable directly for range pruning. All this migration
    // does is add an index on that column so the retention DELETE in
    // `FrickStore.prune` can use a range scan instead of a full table scan as
    // the table grows. Schema revision stays at 1 — no shape change.
    id: "0002_idempotency_keys_created_at",
    schemaRevision: 1,
    description: "Index idempotency_keys.created_at for retention pruning",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
        ON idempotency_keys (created_at);
    `,
  },
  {
    // Tenant boundary: every framework-managed table gains a non-null
    // `tenant_id` column defaulting to '_default', so legacy single-tenant
    // rows are mapped to the implicit default tenant. Parallel
    // `(tenant_id, …)` indexes replace, in spirit, the per-content-key
    // indexes for queries that now filter by tenant.
    //
    // `auth_accounts.handle` was globally UNIQUE; per-tenant uniqueness is
    // achieved by rebuilding the table without the old constraint and adding
    // a compound `UNIQUE (tenant_id, handle)` index. SQLite cannot ALTER an
    // existing UNIQUE constraint in place — the copy-and-rename below is the
    // standard idiom.
    //
    // `idempotency_keys.PRIMARY KEY` was `(replica_id, request_id)`; under
    // the tenant boundary it becomes `(tenant_id, replica_id, request_id)`,
    // also via copy-and-rename.
    //
    // The `frick_migrations` and `schema_versions` tables are framework-
    // infrastructure shared across all tenants and intentionally NOT tenant-
    // scoped.
    //
    // Schema revision stays at 1: the wire protocol is unchanged.
    id: "0003_tenant_boundary",
    schemaRevision: 1,
    description:
      "Add tenant_id columns to framework tables, rescope handle uniqueness, and rescope idempotency keys per-tenant",
    sql: `
      -- objects: rebuild so the primary key includes tenant_id. Two tenants
      -- writing the same (object_type, object_id) must not collide.
      CREATE TABLE objects_new (
        tenant_id TEXT NOT NULL DEFAULT '_default',
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        packed BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, object_type, object_id)
      );
      INSERT INTO objects_new
        (tenant_id, object_type, object_id, version, packed, updated_at)
        SELECT '_default', object_type, object_id, version, packed, updated_at FROM objects;
      DROP TABLE objects;
      ALTER TABLE objects_new RENAME TO objects;

      -- stream_events: rebuild so the primary key and event_id uniqueness
      -- are tenant-scoped.
      CREATE TABLE stream_events_new (
        tenant_id TEXT NOT NULL DEFAULT '_default',
        stream_type TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        packed BLOB NOT NULL,
        replica_id TEXT,
        request_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, stream_type, stream_id, sequence)
      );
      INSERT INTO stream_events_new
        (tenant_id, stream_type, stream_id, sequence, event_id, event_type, packed, replica_id, request_id, created_at)
        SELECT '_default', stream_type, stream_id, sequence, event_id, event_type, packed, replica_id, request_id, created_at FROM stream_events;
      DROP TABLE stream_events;
      ALTER TABLE stream_events_new RENAME TO stream_events;
      CREATE UNIQUE INDEX idx_stream_events_tenant_event_id
        ON stream_events (tenant_id, event_id);

      -- presence_leases: rebuild so the primary key includes tenant_id.
      CREATE TABLE presence_leases_new (
        tenant_id TEXT NOT NULL DEFAULT '_default',
        presence_type TEXT NOT NULL,
        presence_key TEXT NOT NULL,
        packed BLOB NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, presence_type, presence_key)
      );
      INSERT INTO presence_leases_new
        (tenant_id, presence_type, presence_key, packed, expires_at)
        SELECT '_default', presence_type, presence_key, packed, expires_at FROM presence_leases;
      DROP TABLE presence_leases;
      ALTER TABLE presence_leases_new RENAME TO presence_leases;

      ALTER TABLE signal_outbox ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '_default';
      CREATE INDEX IF NOT EXISTS idx_signal_outbox_tenant
        ON signal_outbox (tenant_id, signal_type, signal_key, expires_at);

      ALTER TABLE blob_metadata ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '_default';
      CREATE INDEX IF NOT EXISTS idx_blob_metadata_tenant
        ON blob_metadata (tenant_id, blob_id);
      CREATE INDEX IF NOT EXISTS idx_blob_metadata_tenant_owner
        ON blob_metadata (tenant_id, owner_id, created_at DESC);

      ALTER TABLE blob_content ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '_default';
      CREATE INDEX IF NOT EXISTS idx_blob_content_tenant
        ON blob_content (tenant_id, blob_id);

      -- conversation_inbox: rebuild so the primary key is tenant-scoped.
      CREATE TABLE conversation_inbox_new (
        tenant_id TEXT NOT NULL DEFAULT '_default',
        conversation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        title TEXT,
        kind TEXT NOT NULL,
        last_sequence INTEGER NOT NULL,
        last_message_body TEXT,
        last_message_at TEXT,
        last_message_sender_id TEXT,
        read_sequence INTEGER NOT NULL,
        unread_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, conversation_id, user_id)
      );
      INSERT INTO conversation_inbox_new
        (tenant_id, conversation_id, user_id, title, kind, last_sequence,
         last_message_body, last_message_at, last_message_sender_id,
         read_sequence, unread_count, updated_at)
        SELECT '_default', conversation_id, user_id, title, kind, last_sequence,
               last_message_body, last_message_at, last_message_sender_id,
               read_sequence, unread_count, updated_at FROM conversation_inbox;
      DROP TABLE conversation_inbox;
      ALTER TABLE conversation_inbox_new RENAME TO conversation_inbox;
      CREATE INDEX idx_conversation_inbox_tenant_user
        ON conversation_inbox (tenant_id, user_id, updated_at DESC);

      ALTER TABLE jobs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '_default';
      CREATE INDEX IF NOT EXISTS idx_jobs_tenant
        ON jobs (tenant_id, job_type, status, id);

      ALTER TABLE auth_sessions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '_default';
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_tenant_user
        ON auth_sessions (tenant_id, user_id, expires_at DESC);

      -- auth_accounts: rebuild to rescope handle uniqueness per tenant. The
      -- user_id PK stays global so two tenants must still pick distinct
      -- user ids (server.ts derives user-id from handle, which is tenant-
      -- scoped, so this only collides if an app deliberately reuses ids
      -- across tenants).
      CREATE TABLE auth_accounts_new (
        user_id TEXT PRIMARY KEY,
        handle TEXT NOT NULL COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT '_default'
      );
      INSERT INTO auth_accounts_new
        (user_id, handle, display_name, password_salt, password_hash, created_at, tenant_id)
        SELECT user_id, handle, display_name, password_salt, password_hash, created_at, '_default'
          FROM auth_accounts;
      DROP TABLE auth_accounts;
      ALTER TABLE auth_accounts_new RENAME TO auth_accounts;
      CREATE UNIQUE INDEX idx_auth_accounts_tenant_handle
        ON auth_accounts (tenant_id, handle COLLATE NOCASE);

      -- idempotency_keys: rebuild so the primary key includes tenant_id.
      CREATE TABLE idempotency_keys_new (
        tenant_id TEXT NOT NULL DEFAULT '_default',
        replica_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        result_event_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, replica_id, request_id)
      );
      INSERT INTO idempotency_keys_new
        (tenant_id, replica_id, request_id, result_event_id, created_at)
        SELECT '_default', replica_id, request_id, result_event_id, created_at
          FROM idempotency_keys;
      DROP TABLE idempotency_keys;
      ALTER TABLE idempotency_keys_new RENAME TO idempotency_keys;
      CREATE INDEX idx_idempotency_keys_created_at
        ON idempotency_keys (created_at);
    `,
  },
  {
    // Tenants ledger: tenants were emergent strings before this migration —
    // any session referencing a tenant id implicitly created one. The ledger
    // makes them explicit so the server can list them and admins can refuse
    // traffic for unknown tenants. `INSERT OR IGNORE` covers the
    // already-present `_default` case so the migration stays idempotent on
    // databases that somehow already have the row.
    id: "0004_tenants_ledger",
    schemaRevision: 1,
    description: "Create explicit tenants ledger and backfill the default tenant.",
    sql: `
      CREATE TABLE IF NOT EXISTS tenants (
        tenant_id TEXT PRIMARY KEY NOT NULL,
        display_name TEXT,
        created_at TEXT NOT NULL,
        archived_at TEXT
      );

      INSERT OR IGNORE INTO tenants (tenant_id, display_name, created_at)
      VALUES ('_default', 'Default Tenant', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `,
  },
];

/** Names of all framework tables (and indexes) the runner manages. Used by the
 * dev-reset path. The `frick_migrations` ledger itself is included so a reset
 * starts the next boot from a clean slate. */
export const FRAMEWORK_TABLES: readonly string[] = [
  "frick_migrations",
  "schema_versions",
  "objects",
  "stream_events",
  "idempotency_keys",
  "presence_leases",
  "signal_outbox",
  "blob_content",
  "blob_metadata",
  "conversation_inbox",
  "jobs",
  "auth_sessions",
  "auth_accounts",
  "tenants",
];

export interface MigrationRunResult {
  readonly applied: AppliedMigrationRow[];
  readonly alreadyApplied: AppliedMigrationRow[];
}

export interface MigrationRunnerOptions {
  /**
   * The maximum `schemaRevision` this server supports. Typically the schema's
   * own `schemaRevision`. The runner refuses to boot if the database records a
   * higher value.
   */
  readonly supportedSchemaRevision: number;
  /**
   * Framework migrations to apply. Defaults to `FRAMEWORK_MIGRATIONS`. Provided
   * for tests and as a future extension point.
   */
  readonly migrations?: readonly FrameworkMigration[];
  /**
   * App-level migrations. The first slice ships with framework migrations
   * only — this parameter exists so future app migration registries can plug
   * in without changing the runner's public surface.
   */
  readonly appMigrations?: readonly FrameworkMigration[];
  /** Override the timestamp source (mostly for deterministic tests). */
  readonly now?: () => Date;
}

/**
 * Run framework migrations against the given database.
 *
 * Behavior, in order:
 *   1. Ensure `frick_migrations` exists (the one inline CREATE that bootstraps
 *      the runner itself).
 *   2. Load applied rows.
 *   3. Verify every applied row that has a matching in-code definition still
 *      has a matching checksum. Mismatch → `FrickMigrationChecksumError`.
 *   4. Verify `max(applied.schemaRevision) <= supportedSchemaRevision`.
 *      Otherwise → `FrickMigrationRevisionError`.
 *   5. Apply any in-code migrations not yet in the applied set, each inside
 *      a transaction that wraps both the SQL and the ledger insert.
 */
export function runFrameworkMigrations(
  db: DatabaseSync,
  options: MigrationRunnerOptions,
): MigrationRunResult {
  const migrations = options.migrations ?? FRAMEWORK_MIGRATIONS;
  const now = options.now ?? (() => new Date());

  ensureMigrationsTable(db);

  const appliedRows = loadAppliedMigrations(db);
  const appliedById = new Map(appliedRows.map((row) => [row.id, row] as const));

  for (const migration of migrations) {
    const recorded = appliedById.get(migration.id);
    if (!recorded) continue;
    const currentChecksum = computeMigrationChecksum(migration);
    if (recorded.checksum !== currentChecksum) {
      throw new FrickMigrationChecksumError(migration.id, recorded.checksum, currentChecksum);
    }
  }

  const maxAppliedRevision = appliedRows.reduce(
    (max, row) => Math.max(max, row.schemaRevision),
    0,
  );
  if (maxAppliedRevision > options.supportedSchemaRevision) {
    throw new FrickMigrationRevisionError(maxAppliedRevision, options.supportedSchemaRevision);
  }

  const alreadyApplied: AppliedMigrationRow[] = [];
  const newlyApplied: AppliedMigrationRow[] = [];

  for (const migration of migrations) {
    const recorded = appliedById.get(migration.id);
    if (recorded) {
      alreadyApplied.push(recorded);
      continue;
    }
    if (migration.schemaRevision > options.supportedSchemaRevision) {
      throw new FrickMigrationRevisionError(migration.schemaRevision, options.supportedSchemaRevision);
    }
    const applied = applyMigration(db, migration, now);
    newlyApplied.push(applied);
  }

  return { applied: newlyApplied, alreadyApplied };
}

function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS frick_migrations (
      id TEXT PRIMARY KEY,
      schema_revision INTEGER NOT NULL,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL,
      duration_ms INTEGER NOT NULL
    );
  `);
}

function loadAppliedMigrations(db: DatabaseSync): AppliedMigrationRow[] {
  const rows = db
    .prepare(
      `SELECT id, schema_revision, applied_at, checksum, duration_ms
        FROM frick_migrations
        ORDER BY schema_revision ASC, id ASC`,
    )
    .all() as Array<{
      id: string;
      schema_revision: number;
      applied_at: string;
      checksum: string;
      duration_ms: number;
    }>;
  return rows.map((row) => ({
    id: row.id,
    schemaRevision: row.schema_revision,
    appliedAt: row.applied_at,
    checksum: row.checksum,
    durationMs: row.duration_ms,
  }));
}

function applyMigration(
  db: DatabaseSync,
  migration: FrameworkMigration,
  now: () => Date,
): AppliedMigrationRow {
  const checksum = computeMigrationChecksum(migration);
  const start = process.hrtime.bigint();
  const appliedAt = now().toISOString();

  // Wrap SQL execution + ledger insert in a single transaction so either both
  // commit or neither does — partial migrations would corrupt the ledger.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(migration.sql);
    const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
    db.prepare(
      `INSERT INTO frick_migrations (id, schema_revision, applied_at, checksum, duration_ms)
        VALUES (?, ?, ?, ?, ?)`,
    ).run(migration.id, migration.schemaRevision, appliedAt, checksum, durationMs);
    db.exec("COMMIT");
    return {
      id: migration.id,
      schemaRevision: migration.schemaRevision,
      appliedAt,
      checksum,
      durationMs,
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction may already have aborted on the SQLite side; swallow
      // the rollback error so we surface the original cause.
    }
    throw new FrickMigrationError(
      `Failed to apply migration ${migration.id} (${migration.description}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Read the applied migration ledger. Exposed for tests and operations tooling. */
export function listAppliedMigrations(db: DatabaseSync): AppliedMigrationRow[] {
  ensureMigrationsTable(db);
  return loadAppliedMigrations(db);
}
