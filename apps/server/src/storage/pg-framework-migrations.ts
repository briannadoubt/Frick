import type { FrameworkMigration } from "./migrations.js";

/**
 * Postgres-dialect equivalents of the framework migrations defined in
 * `migrations.ts`. The migration IDs and `schemaRevision` values are
 * intentionally identical to their SQLite siblings so the `frick_migrations`
 * ledger rows are comparable across drivers.
 *
 * SQL dialect differences from SQLite:
 *   - `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
 *   - `BLOB` columns → `BYTEA`
 *   - `INSERT OR IGNORE` → `INSERT ... ON CONFLICT DO NOTHING`
 *   - `COLLATE NOCASE` on TEXT → handled via a functional index on `LOWER(col)`
 *     plus a `CHECK (col = LOWER(col))` constraint on inserts (enforced by
 *     the application layer which already normalises handles to lower-case).
 *     The UNIQUE INDEX therefore uses `LOWER(handle)`.
 *   - `CREATE VIRTUAL TABLE ... USING fts5` → `tsvector` generated column +
 *     GIN index on `search_indexes` (the FTS5 shadow table model is replaced
 *     by Postgres's native full-text search; the triggers are not needed
 *     because the tsvector column is `GENERATED ALWAYS AS`).
 *   - `ifnull(col, '')` → `COALESCE(col, '')`
 *   - `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` → `NOW()`
 *   - `BEGIN IMMEDIATE` → `BEGIN` (Postgres has no IMMEDIATE mode; every
 *     transaction on a row-locked table is effectively serialised).
 *   - Copy-and-rename table rebuilds (SQLite's only way to change PKs) →
 *     Postgres `ALTER TABLE ... ADD PRIMARY KEY` or `DROP CONSTRAINT` /
 *     `ADD CONSTRAINT` where the column set allows it. Where the PK must
 *     genuinely change shape (e.g. adding tenant_id), the copy-and-rename
 *     idiom is preserved for safety and cross-dialect symmetry.
 *
 * New entries here must be added in sync with new entries in `migrations.ts`.
 * The migration IDs MUST match — the shared `computeMigrationChecksum` uses
 * the ID + schemaRevision + SQL, so Postgres and SQLite checksums will differ
 * (different SQL), but the ledger ID is the stable identifier used for
 * "already applied?" checks.
 */
export const FRAMEWORK_MIGRATIONS_PG: readonly FrameworkMigration[] = [
  {
    id: "0001_initial_foundation_tables",
    schemaRevision: 1,
    description: "Create initial foundation tables (objects, streams, blobs, sessions, accounts).",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_versions (
        schema_hash TEXT PRIMARY KEY,
        manifest BYTEA NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS objects (
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        packed BYTEA NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (object_type, object_id)
      );

      CREATE TABLE IF NOT EXISTS stream_events (
        stream_type TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        packed BYTEA NOT NULL,
        replica_id TEXT,
        request_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (stream_type, stream_id, sequence),
        UNIQUE (event_id)
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
        packed BYTEA NOT NULL,
        expires_at BIGINT NOT NULL,
        PRIMARY KEY (presence_type, presence_key)
      );

      CREATE TABLE IF NOT EXISTS signal_outbox (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        signal_type TEXT NOT NULL,
        signal_key TEXT NOT NULL,
        packed BYTEA NOT NULL,
        expires_at BIGINT NOT NULL
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
        content BYTEA NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (blob_id) REFERENCES blob_metadata(blob_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        job_type TEXT NOT NULL,
        packed BYTEA NOT NULL,
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
        handle TEXT NOT NULL,
        display_name TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (handle)
      );
    `,
  },
  {
    id: "0002_idempotency_keys_created_at",
    schemaRevision: 1,
    description: "Index idempotency_keys.created_at for retention pruning",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
        ON idempotency_keys (created_at);
    `,
  },
  {
    id: "0003_tenant_boundary",
    schemaRevision: 1,
    description:
      "Add tenant_id columns to framework tables, rescope handle uniqueness, and rescope idempotency keys per-tenant",
    sql: `
      -- objects: rebuild so the primary key includes tenant_id.
      CREATE TABLE objects_new (
        tenant_id TEXT NOT NULL DEFAULT '_default',
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        packed BYTEA NOT NULL,
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
        packed BYTEA NOT NULL,
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
        packed BYTEA NOT NULL,
        expires_at BIGINT NOT NULL,
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

      ALTER TABLE jobs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '_default';
      CREATE INDEX IF NOT EXISTS idx_jobs_tenant
        ON jobs (tenant_id, job_type, status, id);

      ALTER TABLE auth_sessions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '_default';
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_tenant_user
        ON auth_sessions (tenant_id, user_id, expires_at DESC);

      -- auth_accounts: rebuild to rescope handle uniqueness per tenant.
      -- SQLite used COLLATE NOCASE; in Postgres we index on LOWER(handle)
      -- for case-insensitive per-tenant uniqueness. Application code is
      -- responsible for normalising handles to lower-case on write.
      CREATE TABLE auth_accounts_new (
        user_id TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
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
        ON auth_accounts (tenant_id, LOWER(handle));

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

      INSERT INTO tenants (tenant_id, display_name, created_at)
      VALUES ('_default', 'Default Tenant', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      ON CONFLICT DO NOTHING;
    `,
  },
  {
    id: "0005_admin_audit_log",
    schemaRevision: 1,
    description: "Create admin_audit_log for admin-scope mutation auditing.",
    sql: `
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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

      UPDATE jobs SET available_at = created_at WHERE available_at = '1970-01-01T00:00:00.000Z';

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
        content BYTEA,
        metadata TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, parent_blob_id, derivative_id)
      );
      CREATE INDEX idx_blob_derivatives_processor
        ON blob_derivatives (tenant_id, processor_id, created_at DESC);
    `,
  },
  {
    id: "0009_search_indexes",
    schemaRevision: 1,
    description:
      "Create search_indexes + tsvector search column for the Postgres full-text search adapter.",
    sql: `
      CREATE TABLE IF NOT EXISTS search_indexes (
        index_name TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT '_default',
        doc_id TEXT NOT NULL,
        text TEXT NOT NULL,
        fields TEXT NOT NULL,
        text_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
        PRIMARY KEY (tenant_id, index_name, doc_id)
      );

      CREATE INDEX IF NOT EXISTS idx_search_indexes_tsv
        ON search_indexes USING GIN (text_tsv);
      CREATE INDEX IF NOT EXISTS idx_search_indexes_tenant_name
        ON search_indexes (tenant_id, index_name);
    `,
  },
  {
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
    id: "0011_devtools_event_log",
    schemaRevision: 1,
    description: "Create devtools_events table for the developer-console event feed.",
    sql: `
      CREATE TABLE IF NOT EXISTS devtools_events (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
  {
    id: "0013_auth_session_token_digests",
    schemaRevision: 1,
    description: "Replace raw auth session bearer tokens with SHA-256 token digests.",
    sql: `
      CREATE TABLE auth_sessions_new (
        session_token_digest TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT '_default',
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        replica_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      DROP TABLE auth_sessions;
      ALTER TABLE auth_sessions_new RENAME TO auth_sessions;

      CREATE INDEX idx_auth_sessions_tenant_user
        ON auth_sessions (tenant_id, user_id, expires_at DESC);
    `,
  },
  {
    id: "0014_platform_events",
    schemaRevision: 1,
    description: "Create platform event pipeline tables.",
    sql: `
      CREATE TABLE IF NOT EXISTS platform_events (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL,
        accepted_at TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        family TEXT NOT NULL,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        tenant_id TEXT,
        account_id TEXT,
        subject_id TEXT,
        trace_id TEXT,
        idempotency_key TEXT,
        payload TEXT NOT NULL,
        attributes TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_platform_events_tenant_idempotency
        ON platform_events (COALESCE(tenant_id, ''), idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX idx_platform_events_family_at ON platform_events (family, occurred_at DESC);
      CREATE INDEX idx_platform_events_tenant_at ON platform_events (tenant_id, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS platform_event_deliveries (
        consumer TEXT NOT NULL,
        event_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        claimed_at TEXT,
        acked_at TEXT,
        dead_lettered_at TEXT,
        last_error TEXT,
        PRIMARY KEY (consumer, event_id)
      );
      CREATE INDEX idx_platform_event_deliveries_status_available
        ON platform_event_deliveries (consumer, status, available_at);
      CREATE INDEX idx_platform_event_deliveries_event
        ON platform_event_deliveries (event_id);
    `,
  },
  {
    id: "0015_analytics_aggregates",
    schemaRevision: 1,
    description: "Create product analytics aggregate tables.",
    sql: `
      CREATE TABLE IF NOT EXISTS analytics_aggregate_buckets (
        bucket_start TEXT NOT NULL,
        bucket_ms INTEGER NOT NULL,
        tenant_id TEXT NOT NULL,
        metric_kind TEXT NOT NULL,
        metric_key TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (bucket_start, bucket_ms, tenant_id, metric_kind, metric_key)
      );
      CREATE INDEX idx_analytics_buckets_lookup
        ON analytics_aggregate_buckets (tenant_id, metric_kind, bucket_start DESC, count DESC);

      CREATE TABLE IF NOT EXISTS analytics_recent_events (
        event_id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        tenant_id TEXT,
        account_id TEXT,
        subject_id TEXT,
        trace_id TEXT,
        name TEXT NOT NULL,
        properties TEXT NOT NULL,
        context TEXT NOT NULL
      );
      CREATE INDEX idx_analytics_recent_tenant_at
        ON analytics_recent_events (tenant_id, occurred_at DESC);
      CREATE INDEX idx_analytics_recent_name_at
        ON analytics_recent_events (name, occurred_at DESC);
    `,
  },
  {
    id: "0016_password_reset_tokens",
    schemaRevision: 1,
    description: "Single-use email password-reset tokens (hashed) with expiry.",
    sql: `
      CREATE TABLE IF NOT EXISTS auth_password_reset_tokens (
        token_hash TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_by_user
        ON auth_password_reset_tokens (tenant_id, user_id, expires_at DESC);
    `,
  },
  {
    id: "0017_sharing",
    schemaRevision: 1,
    description: "Create invitations and grants tables for cross-user sharing.",
    sql: `
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        record_type TEXT NOT NULL,
        record_id TEXT NOT NULL,
        permission TEXT NOT NULL,
        token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        redeemed_at TEXT,
        redeemed_by_user_id TEXT
      );
      CREATE UNIQUE INDEX idx_invitations_token ON invitations (token);
      CREATE INDEX idx_invitations_owner
        ON invitations (tenant_id, owner_user_id, created_at DESC);
      CREATE INDEX idx_invitations_record
        ON invitations (tenant_id, record_type, record_id);

      CREATE TABLE IF NOT EXISTS grants (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        record_type TEXT NOT NULL,
        record_id TEXT NOT NULL,
        grantee_user_id TEXT NOT NULL,
        permission TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX idx_grants_owner
        ON grants (tenant_id, owner_user_id, created_at DESC);
      CREATE INDEX idx_grants_grantee
        ON grants (tenant_id, grantee_user_id, created_at DESC);
      CREATE INDEX idx_grants_record
        ON grants (tenant_id, record_type, record_id, grantee_user_id);
    `,
  },
  {
    // FR-33: opt-in refresh tokens for the refresh/access-token split. See the
    // SQLite migration for the full rationale.
    id: "0018_refresh_tokens",
    schemaRevision: 1,
    description: "Opt-in refresh tokens (hashed) for the refresh/access-token split (FR-33).",
    sql: `
      CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        replica_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_by_user
        ON auth_refresh_tokens (tenant_id, user_id, expires_at DESC);
    `,
  },
  {
    // FR-46: service principals (machine identities). See the SQLite migration
    // for the full rationale. Only the SHA-256 hash of the API key is stored.
    id: "0019_service_principals",
    schemaRevision: 1,
    description: "Create service_principals table for machine identities (FR-46).",
    sql: `
      CREATE TABLE IF NOT EXISTS service_principals (
        id TEXT PRIMARY KEY NOT NULL,
        key_id TEXT NOT NULL UNIQUE,
        key_hash TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT '_default',
        name TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_service_principals_tenant
        ON service_principals (tenant_id, created_at DESC);
    `,
  },
];

/** Names of all framework tables the Postgres runner manages. Used by dev-reset. */
export const FRAMEWORK_TABLES_PG: readonly string[] = [
  "frick_migrations",
  "schema_versions",
  "objects",
  "stream_events",
  "idempotency_keys",
  "presence_leases",
  "signal_outbox",
  "blob_content",
  "blob_metadata",
  "jobs",
  "auth_sessions",
  "auth_accounts",
  "tenants",
  "admin_audit_log",
  "push_device_registrations",
  "blob_derivatives",
  "search_indexes",
  "tenant_settings",
  "devtools_events",
  "platform_events",
  "platform_event_deliveries",
  "analytics_aggregate_buckets",
  "analytics_recent_events",
  "auth_password_reset_tokens",
  "invitations",
  "grants",
  "auth_refresh_tokens",
  "service_principals",
];
