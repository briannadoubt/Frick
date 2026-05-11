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
  {
    // Admin audit log: who-did-what-when for admin-scope mutations. The table
    // is intentionally global (not tenant-scoped) — admin actions span all
    // tenants and the global scope itself, so audit rows must be queryable as
    // one stream. The fingerprint column stores a truncated SHA-256 of the
    // admin token, never the raw token.
    id: "0005_admin_audit_log",
    schemaRevision: 1,
    description: "Create admin_audit_log for admin-scope mutation auditing.",
    sql: `
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        admin_token_fingerprint TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        outcome TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_admin_audit_log_occurred_at
        ON admin_audit_log (occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action
        ON admin_audit_log (action, occurred_at DESC);
    `,
  },
  {
    // Jobs lifecycle: the foundation `jobs` table shipped with just
    // (id, job_type, packed, status, created_at, tenant_id). The framework's
    // background worker needs claim/retry/dead-letter columns, an idempotency
    // key, an `available_at` timestamp so callers can defer execution, and a
    // bounded retry policy via `max_attempts` / `attempt_count`. We also need
    // `last_error_code` / `last_error_message` so operators can debug failures
    // without consulting external logs.
    //
    // Existing rows wrote status = 'queued'; the new state machine uses
    // 'ready' / 'running' / 'completed' / 'dead_lettered'. Backfill 'queued'
    // → 'ready' so any in-flight queued rows survive the upgrade. 'running'
    // rows from a crashed previous run are also rewound to 'ready' so the
    // worker can re-claim them — at-least-once semantics, plus `attempt_count`
    // is incremented to reflect the prior crashed attempt.
    id: "0006_jobs_lifecycle",
    schemaRevision: 1,
    description:
      "Extend jobs table with claim/retry/dead-letter lifecycle columns and supporting indexes.",
    sql: `
      ALTER TABLE jobs ADD COLUMN available_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
      ALTER TABLE jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 5;
      ALTER TABLE jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE jobs ADD COLUMN claimed_at TEXT;
      ALTER TABLE jobs ADD COLUMN claimed_by TEXT;
      ALTER TABLE jobs ADD COLUMN completed_at TEXT;
      ALTER TABLE jobs ADD COLUMN failed_at TEXT;
      ALTER TABLE jobs ADD COLUMN dead_lettered_at TEXT;
      ALTER TABLE jobs ADD COLUMN idempotency_key TEXT;
      ALTER TABLE jobs ADD COLUMN last_error_code TEXT;
      ALTER TABLE jobs ADD COLUMN last_error_message TEXT;

      -- Backfill the available_at default to the row's created_at so legacy
      -- rows become immediately claimable rather than sitting at the epoch.
      UPDATE jobs SET available_at = created_at WHERE available_at = '1970-01-01T00:00:00.000Z';

      -- Rewind legacy 'queued'/'running' rows into the new 'ready' state.
      UPDATE jobs SET status = 'ready' WHERE status = 'queued';
      UPDATE jobs SET status = 'ready', attempt_count = attempt_count + 1 WHERE status = 'running';

      CREATE INDEX IF NOT EXISTS idx_jobs_status_available_at
        ON jobs (tenant_id, status, available_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency_key
        ON jobs (tenant_id, job_type, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `,
  },
  {
    // Push device registrations: one row per (tenantId, userId, deviceId,
    // platform) pair. `revoked_at` is the soft-delete marker — partial indexes
    // ensure uniqueness only over active rows so a revoke-then-re-register
    // flow doesn't collide with the now-tombstoned row.
    id: "0007_push_registrations",
    schemaRevision: 1,
    description: "Create push_device_registrations for the notification framework.",
    sql: `
      CREATE TABLE IF NOT EXISTS push_device_registrations (
        registration_id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT '_default',
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        token TEXT NOT NULL,
        environment TEXT NOT NULL DEFAULT 'production',
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_push_device_registrations_tenant_user_device_platform
        ON push_device_registrations (tenant_id, user_id, device_id, platform) WHERE revoked_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_push_device_registrations_tenant_user
        ON push_device_registrations (tenant_id, user_id) WHERE revoked_at IS NULL;
    `,
  },
  {
    // Blob derivatives: child blobs produced by the blob processor pipeline
    // (thumbnails, transcoded variants, extracted-metadata sidecars). The
    // primary key is (tenant_id, parent_blob_id, derivative_id) so two
    // tenants can produce derivatives with the same local id, and so a
    // processor can emit multiple derivatives per parent without colliding.
    //
    // `storage_key` points into the same blob_content table as the parent
    // (we reuse the existing path-resolution helper). `metadata` is JSON for
    // structured per-derivative annotations (image dimensions, exif, etc.).
    id: "0008_blob_derivatives",
    schemaRevision: 1,
    description: "Create blob_derivatives table for blob processor pipeline outputs.",
    sql: `
      CREATE TABLE IF NOT EXISTS blob_derivatives (
        parent_blob_id TEXT NOT NULL,
        derivative_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT '_default',
        processor_id TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        content BLOB,
        metadata TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, parent_blob_id, derivative_id)
      );
      CREATE INDEX idx_blob_derivatives_processor
        ON blob_derivatives (tenant_id, processor_id, created_at DESC);
    `,
  },
  {
    // Search indexes: a single canonical table `search_indexes` storing one
    // row per `(tenant_id, index_name, doc_id)` plus an FTS5 virtual table
    // mirroring the `text` column. Triggers keep the FTS table in lockstep
    // with the canonical rows so the adapter only writes to one place.
    //
    // `content='search_indexes'` + `content_rowid='rowid'` configures FTS5 in
    // contentless-companion mode: the FTS table doesn't own the text itself
    // (saves space) and joins back to `search_indexes.rowid` on read. The
    // triggers populate FTS via the `INSERT INTO fts (rowid, text) VALUES ...`
    // and `INSERT INTO fts (fts, rowid, text) VALUES ('delete', ...)` idioms
    // that contentless FTS5 supports.
    //
    // Schema revision stays at 1: no wire-protocol shape change.
    id: "0009_search_indexes",
    schemaRevision: 1,
    description: "Create search_indexes + search_index_fts for the SQLite FTS5 adapter.",
    sql: `
      CREATE TABLE IF NOT EXISTS search_indexes (
        index_name TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT '_default',
        doc_id TEXT NOT NULL,
        text TEXT NOT NULL,
        fields TEXT NOT NULL,
        PRIMARY KEY (tenant_id, index_name, doc_id)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS search_index_fts USING fts5(
        text,
        content='search_indexes',
        content_rowid='rowid',
        tokenize='unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS search_indexes_ai AFTER INSERT ON search_indexes BEGIN
        INSERT INTO search_index_fts (rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS search_indexes_ad AFTER DELETE ON search_indexes BEGIN
        INSERT INTO search_index_fts (search_index_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS search_indexes_au AFTER UPDATE ON search_indexes BEGIN
        INSERT INTO search_index_fts (search_index_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        INSERT INTO search_index_fts (rowid, text) VALUES (new.rowid, new.text);
      END;
    `,
  },
  {
<<<<<<< HEAD
    // Per-tenant settings: a small key/value table for runtime config knobs
    // applied on a per-tenant basis. Values are JSON-encoded so the table
    // shape stays uniform across knob types (numbers, strings, structured
    // objects). The primary key is (tenant_id, setting_key) so each tenant
    // gets its own namespace.
    //
    // Known keys at the time of this migration:
    //   "limits"      — partial FrickLimits overrides (merged over defaults)
    //   "retentionMs" — per-tenant override for idempotency_keys retention
    //
    // Schema revision stays at 1: this is server-side runtime config and
    // never crosses the wire.
    id: "0010_tenant_settings",
    schemaRevision: 1,
    description: "Create tenant_settings table for per-tenant runtime config knobs.",
    sql: `
      CREATE TABLE IF NOT EXISTS tenant_settings (
        tenant_id TEXT NOT NULL,
        setting_key TEXT NOT NULL,
        setting_value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, setting_key)
      );
    `,
  },
  {
    // DevTools event log: a queryable feed of meaningful framework events
    // (HTTP requests, WS lifecycle, job lifecycle) intended for an external
    // developer console. Distinct from the unstructured stderr request log
    // and the per-counter metrics module — this is a durable, time-ordered
    // record an operator can scrub through. Retention is bounded by both
    // age and row count (see DevToolsEventStore.prune), so the table never
    // grows without limit. `tenant_id` is nullable so framework-wide events
    // (e.g. a request from an unauthenticated principal) can still be
    // recorded; the per-tenant index uses that column directly.
    id: "0011_devtools_event_log",
    schemaRevision: 1,
    description: "Create devtools_events table for the developer-console event feed.",
    sql: `
      CREATE TABLE IF NOT EXISTS devtools_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        tenant_id TEXT,
        fields TEXT NOT NULL
      );
      CREATE INDEX idx_devtools_events_kind_at ON devtools_events (kind, occurred_at DESC);
      CREATE INDEX idx_devtools_events_tenant_at ON devtools_events (tenant_id, occurred_at DESC);
    `,
  },
  {
    // Hash-chained audit log: previously `admin_audit_log` rows were mutable
    // from the SQLite layer, so a sufficiently-privileged operator could
    // rewrite history without leaving a trace. Adding a hash chain
    // (`entry_hash = sha256(previous_hash || canonical_row_json)`) means any
    // post-hoc tamper breaks the chain and is detectable via
    // `AdminAuditStore.verifyChain()`. Columns are nullable so the migration
    // is additive: existing rows have NULL entry_hash and are treated as the
    // pre-chain prefix. New inserts always populate both columns.
    id: "0012_audit_chain",
    schemaRevision: 1,
    description:
      "Add hash-chain columns to admin_audit_log so tampering with audit rows is detectable.",
    sql: `
      ALTER TABLE admin_audit_log ADD COLUMN previous_hash TEXT;
      ALTER TABLE admin_audit_log ADD COLUMN entry_hash TEXT;
      CREATE INDEX idx_admin_audit_log_chain ON admin_audit_log (id, entry_hash);
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
  "admin_audit_log",
  "push_device_registrations",
  "blob_derivatives",
  "search_indexes",
  "search_index_fts",
  "tenant_settings",
  "devtools_events",
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
