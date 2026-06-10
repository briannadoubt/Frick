# Frick Server — Storage Layer Map (for the Rust rewrite)

Scope: `apps/server/src/store.ts`, `apps/server/src/store-app-scoped.ts`,
`apps/server/src/storage/**`, plus the storage-backed subsystems
`apps/server/src/search/**`, `apps/server/src/backup/**`,
`apps/server/src/devtools/event-store.ts`, `apps/server/src/platform-events/sqlite.ts`,
`apps/server/src/analytics/summary.ts`.

All file:line citations refer to the repo at `/Users/bri/dev/Frick` as of 2026-06-10
(HEAD `9f8652d`). Every SQL statement below is quoted from source; column ORDER in
INSERTs and tuple ORDER in packed msgpack arrays are load-bearing.

---

## 1. Architecture overview

```
FrickStore (facade, store.ts)
 ├─ SqlDriver (async seam, storage/sql-driver.ts)
 │   ├─ SqliteSqlDriver  — wraps node:sqlite DatabaseSync (sync calls in async shells)
 │   └─ PgSqlDriver      — wraps pg.Pool; rewrites `?` → `$n` (storage/pg-sql-driver.ts)
 ├─ 20+ typed sub-stores (storage/*.ts), all written against SqlDriver
 ├─ BlobBytesDriver seam (sqlite table | filesystem | S3) for blob BYTES only
 ├─ Search adapter seam (SQLite FTS5 | Postgres tsvector)
 ├─ Migration runner (storage/migrations.ts SQLite, storage/pg-migrations.ts PG)
 └─ Maintenance timers (idempotency / devtools / platform-events / sessions / stream retention)
```

Two partitioning axes thread through nearly every table:

- `tenant_id TEXT NOT NULL DEFAULT '_default'` — constant `DEFAULT_TENANT_ID = "_default"`
  (`src/tenant.ts:18`).
- `app_id TEXT NOT NULL DEFAULT '_default'` — constant `DEFAULT_APP_ID = "_default"`
  (`src/app-id.ts:37`). App ids are validated by `normalizeAppId` (`src/app-id.ts:45-63`):
  trimmed, ≤ 64 chars, regex `^[A-Za-z0-9_.:-]+$`, empty/missing collapses to `_default`.
  `appId` is a namespacing axis, NOT a per-principal trust boundary (`src/app-id.ts:13-27`).

Durable vs cache distinction:

- **Durable source of truth**: every SQLite/PG table. Stream events are kept forever by
  default (retention is opt-in per stream type, FR-145).
- **In-process cache**: `BoundedIdempotencyCache` (pure LRU, `storage/idempotency-cache.ts`)
  fronting the durable `idempotency_keys` table. Eviction never affects correctness — a
  miss falls through to SQL (`storage/idempotency-cache.ts:1-15`).
- **Bounded rolling tables** (age + row-cap pruned): `idempotency_keys`,
  `devtools_events`, `platform_events`(+deliveries), expired `auth_sessions`.

---

## 2. SqlDriver — the async storage seam (`storage/sql-driver.ts`)

### 2.1 Interface (lines 31-90)

```ts
interface SqlDriver {
  readonly dialect: "sqlite" | "postgres";
  get<T>(sql, params?): Promise<T | undefined>;       // first row or undefined
  all<T>(sql, params?): Promise<T[]>;                 // all rows ([] if none)
  run(sql, params?): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
  exec(sql): Promise<void>;                           // multi-statement DDL, no params
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
  initializeSchema(schemaRevision: number): Promise<void>;
  close(): void | Promise<void>;
}
```

PLACEHOLDER convention: all store SQL uses `?` positional params (line 13-15). The
SQLite driver passes them through; the PG driver rewrites `?`→`$n`.

### 2.2 Parameter normalization — identical on both backends (lines 96-112)

`bindParams`: `boolean → 1|0` (flag columns are INTEGER, never BOOLEAN), `undefined → null`.
PG additionally converts `Uint8Array → Buffer` for BYTEA (`pg-sql-driver.ts:32-39`).
Bindable types: `null | number | bigint | string | Uint8Array`.

### 2.3 SQLite implementation (lines 118-201)

- Wraps `node:sqlite` `DatabaseSync`; everything actually runs synchronously inside
  async method shells. `rawDb` getter exposes the handle for the 6 raw-SQLite
  subsystems (line 127-130).
- `transaction()`: `BEGIN IMMEDIATE` … `COMMIT`, `ROLLBACK` on throw (rollback errors
  swallowed; original error rethrown). **Nested calls do NOT open a second BEGIN** —
  a `#txDepth` counter reuses the outer transaction (lines 161-192). There are no
  savepoints in the seam itself.
- `isSqliteSqlDriver(driver)` narrows by `dialect === "sqlite"` (line 208-210).

### 2.4 Factory `createSqlDriver(config)` (lines 235-256)

- `dbDriver: "postgres"` → requires `dbUrl` (else `FrickConfigError` with message
  `"FRICK_DB_DRIVER=postgres requires FRICK_DATABASE_URL (the Postgres connection string)."`),
  then builds `new PgPool({connectionString})` (connects lazily, so construction stays sync)
  and returns `PgSqlDriver`.
- `dbDriver: "sqlite"` (default) → `mkdirSync(dirname(dbPath), {recursive:true})` unless
  path is `":memory:"`, then `new DatabaseSync(dbPath)`.
- ⚠️ STALE DOCS: several comments (`sql-driver.ts:228-233`, `store.ts:147-149`) still say
  postgres "throws / is not yet implemented (FR-119)". The code DOES implement Postgres.
  Trust the code.

### 2.5 Postgres implementation (`storage/pg-sql-driver.ts`)

- Module-load side effect: `pg.types.setTypeParser(20, v => v === null ? null : Number(v))`
  — Postgres BIGINT (OID 20) decodes as JS number so `expires_at` etc. round-trip like
  SQLite numeric affinity (lines 26-28).
- `rewritePlaceholders(sql)` (lines 47-67): left-to-right `?`→`$1,$2,…`; `?` inside
  single-quoted string literals are left alone (tracks `'` toggling, handles `''` escape
  implicitly by double-toggle).
- `run()` (lines 107-121): `changes = result.rowCount ?? 0`; `lastInsertRowid` is taken
  from the first returned row's `id` column when the caller appended `RETURNING id`,
  otherwise `0`. (So PG callers needing generated keys must use `RETURNING id` — the
  stores already do.)
- `transaction()` (lines 128-158): checks out a `PoolClient`, builds a tx-scoped
  `PgSqlDriver` bound to that client (`txClient`), `BEGIN`/`COMMIT`/`ROLLBACK`, releases
  the client. Nested calls on a tx-bound driver reuse the outer tx (no savepoints).
- `initializeSchema` runs `runFrameworkMigrationsPostgres(pool, {supportedSchemaRevision,
  migrations: FRAMEWORK_MIGRATIONS_PG})`.
- `close()` is a no-op on tx-bound drivers; otherwise `pool.end()`.
- Helper `createPgSqlDriver({databaseUrl, supportedSchemaRevision, migrate?})`
  (lines 191-202) — connects, optionally migrates (default true), returns driver.

---

## 3. Database initialization

### 3.1 SQLite (`storage/schema.ts:12-18`)

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
```
then `runFrameworkMigrations(db, { supportedSchemaRevision })`. Note: `foreign_keys` is
NOT enabled — SQLite FK enforcement is off by default, so `blob_content`'s
`ON DELETE CASCADE` FK is only actually enforced on Postgres (see also restore.ts:310-313
comment). The dev-reset path temporarily toggles `PRAGMA foreign_keys` (reset.ts:65,78).

### 3.2 Postgres (`storage/pg-schema.ts:13-15`)

`initializeStoragePg(pool, supportedSchemaRevision)` → just runs the PG migration runner
(no pragma equivalents).

### 3.3 When it runs

- SQLite: synchronously inside the `FrickStore` constructor (`store.ts:467-471`), then
  `#recordSchema()`; `#schemaReady = true` immediately.
- Postgres: in `await store.initialize()` (`store.ts:622-637`), which the server awaits
  in `listen()` before accepting traffic (`server.ts:2781-2786`). Until then,
  `#schemaReady=false` makes all maintenance prunes no-op.

---

## 4. Migration framework

### 4.1 Model (`storage/migrations.ts:11-33`)

```ts
interface FrameworkMigration { id: string; schemaRevision: number; description: string; sql: string; }
interface AppliedMigrationRow { id; schemaRevision; appliedAt; checksum; durationMs; }
```
Migrations are **code-defined, append-only** (never edit an applied one).

### 4.2 Checksum (lines 83-86) — exact algorithm

```
checksum = "sha256-" + hex(SHA256(utf8(`${id}|${schemaRevision}|${sql}`)))
```
The SQL string is included verbatim (whitespace and comments matter!). A Rust rewrite
that re-emits these migrations MUST byte-preserve the SQL text of each migration
(including leading newline/indentation inside the template literal) or every existing
database will refuse to boot with `FrickMigrationChecksumError`. SQLite and PG checksums
differ (different SQL) — only the `id` is the cross-dialect identity (`pg-framework-migrations.ts:31-35`).

### 4.3 Ledger table (lines 1208-1218; PG: pg-migrations.ts:100-110)

```sql
CREATE TABLE IF NOT EXISTS frick_migrations (
  id TEXT PRIMARY KEY,
  schema_revision INTEGER NOT NULL,
  applied_at TEXT NOT NULL,          -- TIMESTAMPTZ on Postgres
  checksum TEXT NOT NULL,
  duration_ms INTEGER NOT NULL
);
```

### 4.4 Runner semantics (`runFrameworkMigrations`, lines 1160-1206; PG mirror pg-migrations.ts:38-92)

1. Ensure ledger table exists (the one bootstrap CREATE).
2. Load applied rows `ORDER BY schema_revision ASC, id ASC`.
3. For every applied row with an in-code definition: recompute checksum; mismatch →
   `FrickMigrationChecksumError` (refuse to boot).
4. `max(applied.schemaRevision) > supportedSchemaRevision` → `FrickMigrationRevisionError`
   (server rolled back against newer DB).
5. Apply not-yet-applied migrations **in declaration order**; a pending migration whose
   `schemaRevision > supported` also throws `FrickMigrationRevisionError`.
6. Each migration: `BEGIN IMMEDIATE` (PG: `BEGIN`) → exec `migration.sql` (multi-statement)
   → INSERT ledger row → `COMMIT`. Duration measured with `process.hrtime.bigint()`,
   integer ms. Failure → ROLLBACK (rollback error swallowed) → wrap in
   `FrickMigrationError("Failed to apply migration <id> (<description>): <cause>")`.

Errors (lines 36-76): `FrickMigrationError` (name `"FrickMigrationError"`),
`FrickMigrationChecksumError`, `FrickMigrationRevisionError` — message strings are at
lines 54-58 and 70-73.

`MigrationRunnerOptions` also accepts `migrations` and `appMigrations` overrides and a
`now()` clock (lines 1124-1144); `appMigrations` is currently unused plumbing.

### 4.5 The standalone Postgres runner — where it lives

- Definitions: `storage/pg-framework-migrations.ts` (`FRAMEWORK_MIGRATIONS_PG`, ids
  identical to SQLite, dialect-translated SQL).
- Runner: `storage/pg-migrations.ts` (`runFrameworkMigrationsPostgres`,
  `listAppliedMigrationsPostgres`).
- Entry points: `PgSqlDriver.initializeSchema` (server boot path, awaited from
  `FrickStore.initialize()` in `listen()`), `createPgSqlDriver({migrate})`, and
  `initializeStoragePg` (`pg-schema.ts`). Config doc (`config.ts:25`) describes this
  as the FR-22 standalone migration runner; it requires `FRICK_DATABASE_URL`.

Dialect translation rules (header comment `pg-framework-migrations.ts:9-29`):
`INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`;
`BLOB` → `BYTEA`; `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`; `COLLATE NOCASE` →
unique index on `LOWER(handle)` (app layer lower-cases handles); FTS5 → tsvector
generated column + GIN; `ifnull` → `COALESCE`; `strftime(...)` → `to_char(NOW() AT TIME
ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`; `BEGIN IMMEDIATE` → `BEGIN`;
copy-and-rename rebuilds preserved for PK changes.

### 4.6 Migration list (both dialects, all `schemaRevision: 1`)

| id | effect |
|---|---|
| `0001_initial_foundation_tables` | schema_versions, objects, stream_events, idempotency_keys, presence_leases, signal_outbox, blob_metadata, blob_content, jobs, auth_sessions (+`auth_sessions_by_user` idx), auth_accounts |
| `0002_idempotency_keys_created_at` | idx on idempotency_keys(created_at) |
| `0003_tenant_boundary` | add tenant_id everywhere; rebuild objects/stream_events/presence_leases/auth_accounts/idempotency_keys (PK changes); per-tenant handle uniqueness; tenant indexes |
| `0004_tenants_ledger` | tenants table + backfill `('_default','Default Tenant', now)` |
| `0005_admin_audit_log` | admin_audit_log + 2 idx |
| `0006_jobs_lifecycle` | 11 new jobs columns; `available_at` backfill `= created_at` where epoch default; `queued`→`ready`; `running`→`ready` + attempt_count+1; status/idempotency indexes |
| `0007_push_registrations` | push_device_registrations + partial unique idx (WHERE revoked_at IS NULL) |
| `0008_blob_derivatives` | blob_derivatives + processor idx |
| `0009_search_indexes` | search_indexes; SQLite: FTS5 `search_index_fts` (content='search_indexes', content_rowid='rowid', tokenize='unicode61') + ai/ad/au triggers; PG: `text_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED` + GIN idx + (tenant_id,index_name) idx |
| `0010_tenant_settings` | tenant_settings KV |
| `0011_devtools_event_log` | devtools_events + 2 idx |
| `0012_audit_chain` | admin_audit_log + previous_hash/entry_hash (nullable) + chain idx |
| `0013_auth_session_token_digests` | rebuild auth_sessions with `session_token_digest` PK; **drops all existing sessions** (SQL cannot hash) |
| `0014_platform_events` | platform_events + platform_event_deliveries; partial unique idx `(ifnull(tenant_id,''), idempotency_key) WHERE idempotency_key IS NOT NULL` (PG: `COALESCE`) |
| `0015_analytics_aggregates` | analytics_aggregate_buckets + analytics_recent_events |
| `0016_password_reset_tokens` | auth_password_reset_tokens |
| `0017_sharing` | invitations + grants |
| `0018_refresh_tokens` | auth_refresh_tokens |
| `0019_service_principals` | service_principals |
| `0020_saml_seen_assertions` | auth_saml_seen_assertions |
| `0021_app_boundary` | additive `app_id` column on objects, stream_events, presence_leases, signal_outbox, blob_metadata, blob_content, jobs, auth_sessions, auth_accounts, idempotency_keys + `(app_id, tenant_id, …)` sibling indexes |
| `0022_jobs_idempotency_app_scope` | drop+recreate jobs idempotency unique idx scoped `(app_id, tenant_id, job_type, idempotency_key)` |
| `0023_app_scoped_idempotency_presence_keys` | rebuild idempotency_keys and presence_leases so PKs include app_id |
| `0024_refresh_token_family` | `family_id TEXT` (nullable) + idx on auth_refresh_tokens |

`FRAMEWORK_TABLES` (migrations.ts:1086-1117) is the canonical 30-name list used by
dev-reset (includes `frick_migrations` itself and `search_index_fts`).
`FRAMEWORK_TABLES_PG` (pg-framework-migrations.ts:833-863) is identical minus
`search_index_fts` (no FTS5 shadow table on PG).

---

## 5. Effective table schemas (post-all-migrations, SQLite spelling)

Types: TEXT timestamps are ISO-8601 `new Date().toISOString()` (`YYYY-MM-DDTHH:mm:ss.sssZ`,
lexicographic = chronological) unless noted. `expires_at` on presence/signal tables is
**INTEGER epoch milliseconds** (PG: BIGINT). All `packed` columns are msgpack BLOBs (§6).

```
schema_versions   schema_hash TEXT PK | manifest BLOB NOT NULL | created_at TEXT NOT NULL
                  -- manifest = msgpack(encode(FrickSchema object)); written INSERT OR IGNORE
                  -- (PG: ON CONFLICT (schema_hash) DO NOTHING). store.ts:1603-1620.

objects           tenant_id TEXT NN DEFAULT '_default' | object_type TEXT NN | object_id TEXT NN
                  | version INTEGER NN | packed BLOB NN | updated_at TEXT NN
                  | app_id TEXT NN DEFAULT '_default'
                  PK (tenant_id, object_type, object_id)        ← app_id NOT in PK
                  idx_objects_app_tenant (app_id, tenant_id, object_type, object_id)

stream_events     tenant_id | stream_type | stream_id | sequence INTEGER NN | event_id TEXT NN
                  | event_type TEXT NN | packed BLOB NN | replica_id TEXT NULL | request_id TEXT NULL
                  | created_at TEXT NN | app_id
                  PK (tenant_id, stream_type, stream_id, sequence)   ← app_id NOT in PK
                  UNIQUE idx_stream_events_tenant_event_id (tenant_id, event_id)
                  idx_stream_events_app_tenant (app_id, tenant_id, stream_type, stream_id, sequence)
                  idx_stream_events_app_tenant_event_id (app_id, tenant_id, event_id)

idempotency_keys  app_id | tenant_id | replica_id TEXT NN | request_id TEXT NN
                  | result_event_id TEXT NN | created_at TEXT NN
                  PK (app_id, tenant_id, replica_id, request_id)     ← app_id IS in PK (0023)
                  idx_idempotency_keys_created_at (created_at)
                  idx_idempotency_keys_app_tenant (app_id, tenant_id, replica_id, request_id)

presence_leases   app_id | tenant_id | presence_type | presence_key | packed BLOB NN
                  | expires_at INTEGER NN (epoch ms)
                  PK (app_id, tenant_id, presence_type, presence_key)  ← app_id IS in PK (0023)
                  idx_presence_leases_app_tenant (same cols)

signal_outbox     id INTEGER PK AUTOINCREMENT | signal_type | signal_key | packed BLOB NN
                  | expires_at INTEGER NN (epoch ms) | tenant_id | app_id
                  idx_signal_outbox_tenant (tenant_id, signal_type, signal_key, expires_at)
                  idx_signal_outbox_app_tenant (app_id, tenant_id, signal_type, signal_key, expires_at)

blob_metadata     blob_id TEXT PK | owner_id TEXT NN | content_hash TEXT NN | byte_length INTEGER NN
                  | mime_type TEXT NN | storage_key TEXT NULL | created_at TEXT NN | tenant_id | app_id
                  idx_blob_metadata_tenant (tenant_id, blob_id)
                  idx_blob_metadata_tenant_owner (tenant_id, owner_id, created_at DESC)
                  idx_blob_metadata_app_tenant / _owner (app_id-prefixed siblings)

blob_content      blob_id TEXT PK | content BLOB NN | updated_at TEXT NN | tenant_id | app_id
                  FK blob_id → blob_metadata(blob_id) ON DELETE CASCADE  (enforced on PG only)
                  idx_blob_content_tenant, idx_blob_content_app_tenant

jobs              id INTEGER PK AUTOINCREMENT | job_type | packed BLOB NN | status TEXT NN
                  | created_at | tenant_id | available_at TEXT NN DEFAULT '1970-01-01T00:00:00.000Z'
                  | max_attempts INTEGER NN DEFAULT 5 | attempt_count INTEGER NN DEFAULT 0
                  | claimed_at | claimed_by | completed_at | failed_at | dead_lettered_at
                  | idempotency_key | last_error_code | last_error_message | app_id
                  idx_jobs_tenant (tenant_id, job_type, status, id)
                  idx_jobs_status_available_at (tenant_id, status, available_at)
                  UNIQUE idx_jobs_idempotency_key (app_id, tenant_id, job_type, idempotency_key)
                    WHERE idempotency_key IS NOT NULL                      (rescoped by 0022)
                  idx_jobs_app_tenant, idx_jobs_app_tenant_status_available_at

auth_sessions     session_token_digest TEXT PK | tenant_id | user_id | device_id | replica_id
                  | expires_at TEXT | created_at | last_seen_at | app_id
                  idx_auth_sessions_tenant_user (tenant_id, user_id, expires_at DESC)
                  idx_auth_sessions_app_tenant_user (app_id, tenant_id, user_id, expires_at DESC)
                  -- 0001's auth_sessions_by_user idx died with the 0013 rebuild.

auth_accounts     user_id TEXT PK | handle TEXT NN COLLATE NOCASE | display_name TEXT NN
                  | password_salt TEXT NN | password_hash TEXT NN | created_at | tenant_id | app_id
                  UNIQUE idx_auth_accounts_tenant_handle (tenant_id, handle COLLATE NOCASE)
                    -- PG: UNIQUE ON (tenant_id, LOWER(handle))
                  idx_auth_accounts_app_tenant_handle (app_id, tenant_id, handle COLLATE NOCASE)

tenants           tenant_id TEXT PK NN | display_name TEXT NULL | created_at TEXT NN | archived_at TEXT NULL
                  seed row: ('_default', 'Default Tenant', now)

admin_audit_log   id INTEGER PK AUTOINCREMENT | occurred_at | admin_token_fingerprint TEXT NN
                  | action TEXT NN | target TEXT NULL | outcome TEXT NN | detail TEXT NULL
                  | previous_hash TEXT NULL | entry_hash TEXT NULL
                  idx (occurred_at DESC), (action, occurred_at DESC), (id, entry_hash)

push_device_registrations
                  registration_id TEXT PK NN | tenant_id DEFAULT '_default' | user_id | device_id
                  | platform | token | environment TEXT NN DEFAULT 'production'
                  | created_at | last_seen_at | revoked_at NULL
                  UNIQUE (tenant_id,user_id,device_id,platform) WHERE revoked_at IS NULL
                  idx (tenant_id,user_id) WHERE revoked_at IS NULL

blob_derivatives  parent_blob_id | derivative_id | tenant_id DEFAULT '_default' | processor_id
                  | mime_type | byte_length INTEGER | content_hash | storage_key TEXT NN
                  | content BLOB NULL | metadata TEXT NULL (JSON) | created_at
                  PK (tenant_id, parent_blob_id, derivative_id)
                  idx_blob_derivatives_processor (tenant_id, processor_id, created_at DESC)
                  -- NO app_id column. Bytes stored INLINE in `content`.

search_indexes    index_name | tenant_id DEFAULT '_default' | doc_id | text TEXT NN | fields TEXT NN (JSON)
                  PK (tenant_id, index_name, doc_id)
                  SQLite companion: search_index_fts (FTS5 contentless-companion) + 3 triggers
                  PG extra column: text_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED

tenant_settings   tenant_id | setting_key | setting_value TEXT NN (JSON) | updated_at
                  PK (tenant_id, setting_key). Known keys: "limits", "retentionMs".

devtools_events   id INTEGER PK AUTOINCREMENT | occurred_at | kind TEXT NN | tenant_id TEXT NULL
                  | fields TEXT NN (JSON)
                  idx (kind, occurred_at DESC), (tenant_id, occurred_at DESC)

platform_events   id INTEGER PK AUTOINCREMENT | event_id TEXT NN UNIQUE | schema_version INTEGER NN
                  | accepted_at | occurred_at | family | name | source
                  | tenant_id NULL | account_id NULL | subject_id NULL | trace_id NULL
                  | idempotency_key NULL | payload TEXT NN (JSON) | attributes TEXT NN (JSON)
                  UNIQUE (ifnull(tenant_id,''), idempotency_key) WHERE idempotency_key IS NOT NULL
                  idx (family, occurred_at DESC), (tenant_id, occurred_at DESC)

platform_event_deliveries
                  consumer | event_id | status TEXT NN | attempt_count INTEGER NN DEFAULT 0
                  | available_at TEXT NN | claimed_at NULL | acked_at NULL | dead_lettered_at NULL
                  | last_error NULL
                  PK (consumer, event_id)
                  idx (consumer, status, available_at), (event_id)
                  status values: 'pending' | 'retry' | 'claimed' | 'acked' | 'dead_lettered'

analytics_aggregate_buckets
                  bucket_start TEXT | bucket_ms INTEGER | tenant_id TEXT NN ('' for null tenant)
                  | metric_kind ('event'|'route'|'subject') | metric_key | count INTEGER NN
                  PK (bucket_start, bucket_ms, tenant_id, metric_kind, metric_key)
                  idx (tenant_id, metric_kind, bucket_start DESC, count DESC)

analytics_recent_events
                  event_id TEXT PK | occurred_at | accepted_at | processed_at
                  | tenant_id NULL | account_id NULL | subject_id NULL | trace_id NULL
                  | name TEXT NN | properties TEXT NN (JSON) | context TEXT NN (JSON)
                  idx (tenant_id, occurred_at DESC), (name, occurred_at DESC)

auth_password_reset_tokens
                  token_hash TEXT PK | tenant_id | user_id | created_at | expires_at | consumed_at NULL
                  idx (tenant_id, user_id, expires_at DESC)

invitations       id TEXT PK NN | tenant_id | owner_user_id | record_type | record_id | permission
                  | token | created_at | expires_at | redeemed_at NULL | redeemed_by_user_id NULL
                  UNIQUE idx_invitations_token (token)
                  idx (tenant_id, owner_user_id, created_at DESC), (tenant_id, record_type, record_id)

grants            id TEXT PK NN | tenant_id | owner_user_id | record_type | record_id
                  | grantee_user_id | permission | created_at | revoked_at NULL
                  idx owner / grantee / (tenant_id, record_type, record_id, grantee_user_id)

auth_refresh_tokens
                  token_hash TEXT PK | tenant_id | user_id | device_id | replica_id
                  | created_at | expires_at | revoked_at NULL | family_id TEXT NULL
                  idx (tenant_id, user_id, expires_at DESC), (family_id)

service_principals
                  id TEXT PK NN | key_id TEXT NN UNIQUE | key_hash TEXT NN
                  | tenant_id DEFAULT '_default' | name TEXT NN | scopes TEXT NN DEFAULT '[]' (JSON array)
                  | created_at | revoked_at NULL
                  idx (tenant_id, created_at DESC)

auth_saml_seen_assertions
                  provider_id | assertion_id | seen_at | expires_at
                  PK (provider_id, assertion_id)
                  idx (expires_at)
```

Tables WITHOUT `app_id`: tenants, admin_audit_log, push_device_registrations,
blob_derivatives, search_indexes, tenant_settings, devtools_events, platform_events(+
deliveries), analytics_*, auth_password_reset_tokens, invitations, grants,
auth_refresh_tokens, service_principals, auth_saml_seen_assertions, frick_migrations,
schema_versions.

---

## 6. Packed BLOB format (msgpack)

All `packed` columns are `Buffer.from(encode(tuple))` using `@msgpack/msgpack` `encode`.
The tuples are ARRAYS (not maps), defined in `packages/protocol/src/codec.ts` and
`schema.ts:183-184`:

```ts
type PackedField  = [fieldId: number, value: unknown];
type PackedRecord = [typeId: number, recordId: string, fields: PackedField[]];        // objects.packed
type PackedStreamEvent   = [streamTypeId, streamKey, sequence, eventId, eventTypeId, PackedField[]]; // stream_events.packed
type PackedPresenceRecord = [presenceTypeId, presenceKey, PackedField[]];             // presence_leases.packed
type PackedSignalEnvelope = [signalTypeId, signalKey, PackedField[]];                 // signal_outbox.packed
```

- `packFields` (`codec.ts:149-154`) iterates `Object.entries(value)` — **field order in
  the packed array is the JS insertion order of the input object**, mapped to numeric
  field ids via the schema. Unknown field names throw inside `fieldByName`.
- Objects: `withoutRecordId` strips the `id` key before packing (`object-store.ts:266-269`);
  unpack re-injects it FIRST: `value = { id: packed[1], ...fields }` (`codec.ts:69`).
- `jobs.packed` is different: raw `encode(payload)` of the arbitrary job payload —
  no schema field-id packing (`job-store.ts:161`). On `complete(jobId, result)` the
  payload is **overwritten** with `encode(result)` (`job-store.ts:259-269`).
- `schema_versions.manifest` = `encode(schema)` — msgpack of the entire FrickSchema
  object (a map; key order = the validated schema object's property insertion order).

---

## 7. FrickStore facade (`store.ts`)

### 7.1 Constants / defaults (lines 55, 113-135 and devtools/platform modules)

| constant | value |
|---|---|
| `DEFAULT_IDEMPOTENCY_CACHE_CAPACITY` | 10_000 |
| `DEFAULT_IDEMPOTENCY_KEY_RETENTION_MS` | 24h |
| `DEFAULT_IDEMPOTENCY_KEY_MAX_ROWS` | 100_000 |
| `DEFAULT_IDEMPOTENCY_KEY_PRUNE_INTERVAL_MS` | 15 min |
| `DEFAULT_IDEMPOTENCY_REPLAY_WINDOW_MS` | 24h (lookup-time bound, independent of pruning) |
| `DEFAULT_EXPIRED_SESSION_PRUNE_INTERVAL_MS` | 15 min |
| `DEFAULT_EXPIRED_SESSION_RETENTION_GRACE_MS` | 0 |
| `DEFAULT_STREAM_RETENTION_PRUNE_INTERVAL_MS` | 15 min |
| `DEFAULT_DEVTOOLS_EVENTS_RETENTION_MS` | 1h (`devtools/event-store.ts:58`) |
| `DEFAULT_DEVTOOLS_EVENTS_MAX_ROWS` | 10_000 |
| `DEFAULT_DEVTOOLS_EVENTS_PRUNE_INTERVAL_MS` | 60 s |
| `DEFAULT_PLATFORM_EVENTS_RETENTION_MS` | 7 d (`platform-events/sqlite.ts:17`) |
| `DEFAULT_PLATFORM_EVENTS_MAX_ROWS` | 1_000_000 |
| `DEFAULT_PLATFORM_EVENTS_PRUNE_INTERVAL_MS` | 15 min |
| `DEFAULT_PLATFORM_EVENTS_CLAIM_TIMEOUT_MS` | 5 min |

Interval `0` disables a timer (one-shot prune at construction still runs). All timers
are `unref()`ed. `close()` clears timers and calls `sqlDriver.close()` (PG `end()` is
fire-and-forget, `store.ts:639-668`).

### 7.2 Construction (lines 452-613)

Order: validate schema → `createSqlDriver` → (SQLite only) `initializeStorage` +
`#recordSchema` → build idempotency cache → instantiate sub-stores (objects, streams,
presence, signals, blobs(+bytes driver), blobDerivatives, blobProcessors, jobs,
sessions, accounts(+hasher), passwordResetTokens, refreshTokens, samlAssertions,
servicePrincipals, tenants, invitations, grants, tenantSettings, adminAudit,
pushRegistrations, devtoolsEvents, platformEvents, analyticsEvents) → projections /
perAppRegistries → search adapter (default: SQLite FTS5 via `rawDb` on sqlite dialect,
PG tsvector adapter otherwise, lines 531-535) → schedule the five maintenance loops.
`options.seed` is accepted but ignored (`void options.seed`, line 538).

### 7.3 Write-notification funnel (lines 315-358, 1283-1311)

`FrickStoreWriteEvent` =
`{kind:"objectUpsert", tenantId, appId?, objectType, objectId, object}` |
`{kind:"objectDelete", tenantId, appId?, objectType, objectId}` |
`{kind:"streamAppend", tenantId, event: StoredEvent}`.
Single listener (`setWriteListener`), set by the sync gateway; listener throws are
swallowed + logged (`frick.store.write_listener_failed`). The store is the ONLY
emission point (FR-114).

Every facade write does: store write → re-read stored row → notify projections
(per-app registry if configured, else shared) → notify search indexes (failures logged
`frick.search.project_failed` / `frick.search.upsert_failed`, swallowed) → fire write
listener. Stream appends only notify when `result.created === true` (line 1189).
Object deletes only notify when a row actually existed (line 1117).

### 7.4 `prune()` — idempotency-key retention (lines 737-833)

Raw-SQLite path (uses `this.db`). Steps, inside a single `BEGIN IMMEDIATE`:
1. Read per-tenant overrides:
   `SELECT tenant_id, setting_value FROM tenant_settings WHERE setting_key = 'retentionMs'`
   — JSON-parsed; non-finite/negative ignored.
2. For each override tenant: `DELETE FROM idempotency_keys WHERE tenant_id = ? AND created_at < ?`.
3. Remaining tenants get the global cutoff (with `tenant_id NOT IN (…)` when overrides
   exist).
4. Cap pass: if `COUNT(*) > maxRows`, delete the oldest `overflow` rows
   `ORDER BY created_at ASC, rowid ASC`.
5. If anything was pruned, **rebuild** `idempotencyCache` AND `streams` (a new
   `StreamStore` sharing the fresh cache) so stale LRU entries can't outlive retention
   (lines 822-830). Hence `streams`/`idempotencyCache` are non-readonly fields.

Returns `{prunedByAge, prunedByCap}`. `#safePrune` catches and `console.warn`s
(`[frick] idempotency_keys prune failed: …`).

Other helpers: `idempotencyKeyRowCount()`, `pingDatabase()` (`SELECT 1 AS ok`),
`listAppliedMigrations()` (through the seam), `sqlDriver` getter + `rawDatabase()`
(backup/restore escape hatches), `db` getter (throws on PG, lines 422-430).

### 7.5 Schema identity recording (lines 1603-1620)

SQLite: `INSERT OR IGNORE INTO schema_versions (schema_hash, manifest, created_at)
VALUES (?, ?, ?)` with `(schema.hash, Buffer.from(encode(schema)), now)`. PG:
`INSERT … ON CONFLICT (schema_hash) DO NOTHING`.

### 7.6 Tenant/app-scoped facades

Every legacy method has positional overloads; the no-tenant form targets
`DEFAULT_TENANT_ID`, omitted `appId` defaults to `DEFAULT_APP_ID`. Method list with
exact dispatch rules: `upsertObject` (4/6-arg, lines 953-1018),
`upsertObjectWithPolicy` (lines 1045-1093), `objectMergePolicy`, `deleteObject`,
`readObject`, `listObjects`, `listObjectsForUser` (filters via
`isObjectVisibleToUser`, which currently always returns true — lines 1160-1182),
`appendEvent`, `readEvents`, `readEventsBefore`, `streamHead`, `setPresence`,
`readPresence`, `clearPresence`, `enqueueSignal` (default ttl 30_000 ms, line 1425-1427),
`drainSignals`, `createBlobMetadata`, `readBlobMetadata`, `listBlobMetadata`,
`writeBlobContent`, `readBlobContent`, `hasUser`, `createAccountUser`,
`verifyAccountPassword`, `verifyDummyPassword`, `createSession`, `readActiveSession`,
`readAnySession`, `deleteSession`, `deleteSessionsForUser`, `deleteAccount`,
`enqueueJob`, `nextJob`, `forApp`.

### 7.7 `forApp` / app-scoped proxy (`store-app-scoped.ts`)

`store.forApp(appId)` returns `this` for `undefined`/`_default`; otherwise a `Proxy`
that injects the appId default (never overrides an explicit one) into:
`upsertObject` (6-arg form only), `appendEvent`, `setPresence` (6-arg form),
`clearPresence` (4-arg form), `enqueueSignal` (6-arg form), and `jobs.enqueue`
(structured-input form only). All other properties delegate, with functions bound to
the real store so `#private` access works (lines 116-122).

---

## 8. Core data-plane stores

### 8.1 ObjectStore (`storage/object-store.ts`)

- `upsert(tenantId, type, id, value, version, appId=_default)` — unconditional write
  (lastWriteWins), NOT in a transaction.
- `upsertWithPolicy(args)` — entire read+write inside `sql.transaction` (BEGIN
  IMMEDIATE). Policy `versionPrecondition`:
  - `expectedVersion === undefined` ⇒ create-only; existing row ⇒
    `FrickObjectVersionConflictError`; next version = 1.
  - else `previousVersion !== expectedVersion` ⇒ conflict; next = expectedVersion + 1.
  - `lastWriteWins`: next = previousVersion + 1.
  Returns `{previousVersion, nextVersion, created}` (previous 0 for fresh insert).
- Write path `#writeRowTx` (lines 213-257): **cross-app guard** — SELECT owner's app_id
  by PK (no app filter); if exists with different app_id, throw
  `FrickCrossAppAccessError`. Then:
  ```sql
  INSERT INTO objects (app_id, tenant_id, object_type, object_id, version, packed, updated_at)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(tenant_id, object_type, object_id) DO UPDATE SET
    app_id = excluded.app_id, version = excluded.version,
    packed = excluded.packed, updated_at = excluded.updated_at
  ```
- `read`/`readVersion`/`delete`/`list` all filter `app_id = ? AND tenant_id = ?`;
  `list` orders `object_id ASC`.
- Errors (`storage/object-errors.ts`):
  - `FrickObjectVersionConflictError`: `code = "storage.conflict"`, fields tenantId,
    objectType, objectId, expectedVersion (undefined ⇒ "create" in message),
    actualVersion. Message: `Version conflict on <type>/<id>: expected <X>, actual <Y>`.
    HTTP layer maps to 409.
  - `FrickCrossAppAccessError`: `code = "storage.crossAppDenied"`, `reason = "appMismatch"`,
    fields requestedAppId/ownerAppId/tenantId/objectType/objectId. Message:
    `Cross-app access denied on <type>/<id>: app '<a>' may not write a row owned by app '<b>'`. 409.

### 8.2 StreamStore (`storage/stream-store.ts`)

`append(input)` flow (lines 155-230):
1. Cache key: `` `${appId}|${tenantId}|${replicaId}|${requestId}` ``. Cache hit within
   replay window ⇒ `{event, created:false}`.
2. Durable lookup `readIdempotentEvent`: SELECT from idempotency_keys by full app-scoped
   key; `Date.parse(created_at)` outside `replayWindowMs` ⇒ treated as NOT seen
   (unparseable timestamps fail closed, lines 143-153). Hit re-reads the event by
   `(app_id, tenant_id, event_id)` and re-primes the cache.
3. `nextSequence`: `SELECT COALESCE(MAX(sequence), 0) + 1 … WHERE tenant_id=? AND
   stream_type=? AND stream_id=?` — **deliberately NOT app-filtered** because the PK
   excludes app_id; two apps share one sequence space per (tenant, stream, streamId)
   (lines 394-411). ⚠️ The read-then-insert is NOT wrapped in a transaction; on SQLite
   a concurrent in-process append interleaving at the await could mint a duplicate
   sequence and fail on the PK (no retry logic present).
4. `eventId = "event-" + randomUUID()`.
5. INSERT into stream_events with column order
   `(app_id, tenant_id, stream_type, stream_id, sequence, event_id, event_type, packed,
   replica_id, request_id, created_at)`; `packed = encode(packStreamEvent(schema, wireEvent))`.
6. UPSERT idempotency row:
   ```sql
   INSERT INTO idempotency_keys (app_id, tenant_id, replica_id, request_id, result_event_id, created_at)
   VALUES (?,?,?,?,?,?)
   ON CONFLICT(app_id, tenant_id, replica_id, request_id)
   DO UPDATE SET result_event_id = excluded.result_event_id, created_at = excluded.created_at
   ```
   (upsert, not insert: a beyond-window replay mints a fresh event but the stale row may
   still exist, lines 205-217).
7. Cache `{event, createdAtMs: Date.parse(createdAt)}`; return `{event, created:true}`.

Reads: `read` (after-cursor, `sequence > ?`, optional limit clamped ≥1),
`readBefore` (`sequence < before` clamped to `[1,500]`, non-finite/≤0 `before` ⇒
`Number.MAX_SAFE_INTEGER`, fetched DESC then `.reverse()`), `head` (`COALESCE(MAX…)`+
COUNT), `listAllByStreamType` (`ORDER BY stream_id ASC, sequence ASC`), `listAll`
(`stream_type, stream_id, sequence ASC`). All app+tenant-filtered.

`StoredEvent = StreamEventInput & {tenantId, appId}` — i.e. `{stream, streamId,
sequence, eventId, event, payload, tenantId, appId}`.

Retention `pruneRetention(policies)` (lines 431-480): per stream type;
optional `tenantId`/`appId` scope clauses; `maxAgeMs` ⇒ DELETE by `created_at <
cutoffISO`; `maxEvents` ⇒ correlated-subquery DELETE keeping newest N per
(tenant, stream, streamId):
`sequence <= (SELECT MAX(s2.sequence) … ) - ?`. Returns `{prunedByAge, prunedByCount}`.
Default (no policy) = keep forever.

### 8.3 BoundedIdempotencyCache (`storage/idempotency-cache.ts`)

Classic LRU on a `Map` (insertion-order recency): `get` re-inserts; `set` deletes then
inserts then evicts oldest while size > capacity, counting `evictions`. Capacity must be
finite > 0 (floored). Cached value type `CachedIdempotentEvent = {event, createdAtMs}`.

### 8.4 PresenceStore (`storage/presence-store.ts`)

- `set`: UPSERT with `ON CONFLICT(app_id, tenant_id, presence_type, presence_key)`,
  `expires_at = Date.now() + ttlMs` (INTEGER epoch ms).
- `read`: returns undefined AND **lazily deletes** the row when
  `Number(expires_at) <= Date.now()` (lines 68-71).
- `clear`: DELETE by full app-scoped key.

### 8.5 SignalStore (`storage/signal-store.ts`)

- `enqueue`: plain INSERT, `expires_at = Date.now() + ttlMs`.
- `drain`: **single atomic statement** (server-storage-4):
  ```sql
  DELETE FROM signal_outbox
   WHERE app_id=? AND tenant_id=? AND signal_type=? AND signal_key=? AND expires_at > ?
   RETURNING id, packed
  ```
  then re-sorts rows by `id ASC` in app code (RETURNING order is unspecified on both
  dialects) and unpacks values. Expired rows are never drained (and are left in place —
  no expired-signal GC exists).

### 8.6 BlobStore + bytes drivers (`storage/blob-store.ts`, `storage/blob-bytes-driver.ts`)

Split: **metadata always in SQL** (`blob_metadata`); **bytes via pluggable
`BlobBytesDriver`** (`FrickBlobDriver = "sqlite" | "filesystem" | "s3"`, env:
`FRICK_BLOB_DRIVER`, `FRICK_BLOB_STORAGE_PATH`, `FRICK_BLOB_S3_BUCKET/_REGION/_ENDPOINT/_PREFIX`).

`BlobMetadataInput = {blobId, ownerId, contentHash, byteLength, mimeType, storageKey?}`;
`BlobMetadata` adds `{tenantId, appId, createdAt}` (storageKey omitted when NULL).

- `create`: cross-app guard (`SELECT app_id FROM blob_metadata WHERE blob_id = ?`,
  different app ⇒ `FrickCrossAppAccessError` with objectType `"blob_metadata"`), then
  UPSERT `ON CONFLICT(blob_id) DO UPDATE SET` every column including `created_at`
  (re-create refreshes createdAt).
- `read`/`list` (owner-filtered optional; `ORDER BY created_at DESC, blob_id ASC`),
  `totalBytesForOwner` (`COALESCE(SUM(byte_length),0)` — quota check FR-56),
  `deleteMetadata` (caller must delete bytes separately for fs/S3 drivers),
  `listAllOldestFirst` / `listOldestFirstPage` (keyset cursor
  `(created_at > ? OR (created_at = ? AND blob_id > ?))`, `ORDER BY created_at ASC,
  blob_id ASC LIMIT ?` — orphan GC FR-57), `listAppIdsWithBlobs`
  (`SELECT DISTINCT app_id … ORDER BY app_id ASC`).
- bytes pass-throughs: `writeContent`/`readContent`/`deleteContent`/`hasContent`.

`SqlBlobBytesDriver` (default; portable across dialects):
```sql
INSERT INTO blob_content (app_id, blob_id, content, updated_at, tenant_id)
VALUES (?,?,?,?,?)
ON CONFLICT (blob_id) DO UPDATE SET app_id=excluded.app_id, content=excluded.content,
  updated_at=excluded.updated_at, tenant_id=excluded.tenant_id
```
reads/deletes/exists filter `(app_id, tenant_id, blob_id)`.

`FilesystemBlobBytesDriver`: path = `<root>/<tenantSeg>/<aa>/<blobSeg>` (default app) or
`<root>/<appSeg>/<tenantSeg>/<aa>/<blobSeg>` (non-default app), where
`encodeSegment(id)` (lines 557-565) = sanitized readable prefix (lowercased, runs of
`[^a-z0-9_-]` → `-`, trim `-`, max 40 chars) + `.` + first **32 hex chars** of
SHA-256(id); hash-only when prefix empty. `<aa>` = first 2 chars of blobSeg. Write =
temp file `<target>.<pid>.<rand>.tmp` (mode 0o600) + `renameSync` (atomic); errors wrap
in `FrickBlobStorageError`. Construction fail-fast validates root is a creatable,
writable directory. Missing file on read ⇒ `undefined` (ENOENT only).

`S3BlobBytesDriver`: key = `[prefix?, appSeg?, tenantSeg, aa, blobSeg].join("/")`
(empty parts filtered; prefix normalized by splitting on `/` and trimming). Built via
`createS3BlobBytesDriver` (lazy `@aws-sdk/client-s3` import; `forcePathStyle` defaults
to `Boolean(endpoint)`). Missing keys: `NoSuchKey`/`NotFound` names or HTTP 404 map to
absent. The driver is injected pre-built into `StoreOptions.blobS3Driver` because the
store constructor is synchronous.

`BlobDerivativeStore` (`storage/blob-derivative-store.ts`): derivatives store bytes
INLINE in `blob_derivatives.content`; canonical storage key helper
`derivativeStorageKey(parent, deriv) = "derivative/<parent>/<deriv>"` (lines 60-65).
`record` = UPSERT on `(tenant_id, parent_blob_id, derivative_id)` (re-running a
processor overwrites); `listForParent` (`ORDER BY derivative_id ASC`); `deleteForParent`
returns count; `read` returns `{row, bytes}` (NULL content ⇒ empty buffer); corrupt
`metadata` JSON is silently dropped. No app_id axis.

### 8.7 JobStore (`storage/job-store.ts`)

States: `ready | running | completed | dead_lettered` (no `failed` state — synthetic
`failed` count = rows with `last_error_code IS NOT NULL`). Backoff:
`jobBackoffMs(attempt) = min(60_000 * 2^(max(1,attempt)-1), 300_000)`.

- `enqueue` (structured or legacy 3-arg): when `idempotencyKey` set, pre-check
  `findByIdempotencyKey(app, tenant, jobType, key)` — an existing row in ANY state is
  returned as-is (completed jobs dedupe too). Insert:
  ```sql
  INSERT INTO jobs (app_id, tenant_id, job_type, packed, status, created_at,
                    available_at, max_attempts, attempt_count, idempotency_key)
  VALUES (?,?,?,?, 'ready', ?,?,?, 0, ?) RETURNING id
  ```
  defaults: `availableAt = now`, `maxAttempts = 5`. Then re-reads via `getById`.
- `claim(workerId, jobType?, limit=10, appId?)` — single statement:
  ```sql
  UPDATE jobs SET status='running', claimed_at=?, claimed_by=?, attempt_count=attempt_count+1
   WHERE id IN (SELECT id FROM jobs
                 WHERE status='ready' AND available_at <= ? [AND job_type=?] [AND app_id=?]
                 ORDER BY available_at ASC, id ASC LIMIT ?
                 [FOR UPDATE SKIP LOCKED])    -- postgres only
   RETURNING *
  ```
  Param order: `[now, workerId, now, jobType?, appId?, limit]`. SQLite needs no lock
  clause (single-writer).
- `complete(jobId, result?)`: sets completed (+`packed = encode(result)` when result
  given) guarded by `status != 'dead_lettered'`; idempotent.
- `fail(jobId, errorCode, errorMessage, retryable)`: retryable AND
  `attemptCount < maxAttempts` ⇒ back to `ready` with `available_at = now + backoff(attemptCount)`,
  clears claimed_at/claimed_by, records failed_at + last_error_*; else `dead_lettered`
  (sets both dead_lettered_at and failed_at).
- `list(filter)` `ORDER BY id DESC LIMIT ?` (default 100); `getById(jobId, tenantId?,
  appId?)`; `countsByStatus()`; legacy `next(tenantId, type, appId)` = claim 1 with
  workerId `legacy:<tenantId>` returning `{id, name: jobType, value: payload}`.
- Row mapping `mapRow` (lines 438-460): numbers via `Number(...)`, nullable columns
  become absent (not null) properties; `app_id ?? DEFAULT_APP_ID`.

---

## 9. Auth / identity stores

### 9.1 Password hashing (`storage/password-hasher.ts`)

Self-describing stored format, dispatch on tag before first `$`:

- `argon2$<PHC>` — Argon2id via `@node-rs/argon2`; defaults `memoryCost=19456 (KiB),
  timeCost=2, parallelism=1` (lines 76-80). PHC example
  `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`. `needsRehash` parses the PHC params
  and requires exact `m/t/p` match AND variant `argon2id` (lines 247-259).
- `scrypt$<N>$<r>$<p>$<keylen>$<saltB64url>$<digestB64url>` — defaults
  `N=16384, r=8, p=1, keylen=32`, salt = 16 random bytes, `maxmem = 256 MiB`
  (lines 71, 95-103). Verify = constant-time compare (length check then
  `timingSafeEqual`).
- `legacy-scrypt$<salt>$<digestB64url>` — reconstructed by
  `toStoredHash(password_hash, password_salt)` when `password_hash` contains no `$`
  (lines 334-341). Legacy verify reproduces the original bug-compatible call:
  `scryptSync(password, saltSTRING, 32)` — the salt is used as a UTF-8 string, NOT
  base64-decoded (lines 155-163). Always `needsRehash = true`.
- Factory `createPasswordHasher(id: "argon2" | "scrypt" = "argon2")`.
- `ScryptPasswordHasher.needsRehash` returns false for argon2 hashes (never downgrade).

### 9.2 AccountStore (`storage/account-store.ts`)

- `create`: hash password, INSERT `(user_id, tenant_id, handle, display_name,
  password_salt='', password_hash, created_at)`. Constraint errors (regex
  `/constraint/i` on message) → `Error("Handle is already taken")`.
- `readByIdentity(tenantId, identity)`: identity matches `LOWER(handle) = LOWER(?)` OR
  `user_id = ?`.
- `verifyPassword`: reconstruct stored hash via `toStoredHash`; on success, if
  `needsRehash` then transparently re-hash and UPDATE (failures swallowed — lazy
  migration, lines 136-148).
- `verifyDummyPassword(password)`: constant-work fake verify against a once-per-process
  hash of `"frick-constant-work-dummy-verify-secret"`; always returns `false`
  (anti-enumeration, lines 36-38, 162-172).
- `setPassword`, `list` (`ORDER BY created_at ASC, handle ASC LIMIT ?`, default 100),
  `move(fromTenant, userId, toTenant)` → `"moved" | "notFound" | "conflict"` (clash on
  LOWER(handle) or user_id in target tenant; constraint race also → conflict),
  `delete(tenantId, userId)`.
- `StoredAccount = {tenantId, userId, handle, displayName, createdAt}` (no hash exposed).

### 9.3 SessionStore (`storage/session-store.ts`)

- Token digest: `sha256 hex (utf8 token)` (lines 167-169) — column
  `session_token_digest`; the raw token is never stored.
- `create` inserts `(digest, tenant_id, user_id, device_id, replica_id, expires_at,
  created_at=now, last_seen_at=now)`. ⚠️ Does NOT stamp app_id (column default
  `_default` applies).
- `readActive`: returns undefined when `Date.parse(expires_at) <= now`; otherwise
  bumps `last_seen_at` (write-on-read) and returns the row with the bumped value.
- `readAny` (expiry-agnostic, for "expired" vs "unknown" error codes), `delete`,
  `deleteForUser(userId, tenantId?)` (returns count), `pruneExpired(cutoffIso)` —
  `DELETE … WHERE expires_at <= ?`.

### 9.4 PasswordResetTokenStore (`storage/password-reset-store.ts`)

- Token: `randomBytes(32).toString("base64url")`; stored hash = SHA-256 **base64url**.
- `issue({tenantId, userId, ttlMinutes=60})`: in one transaction, mark every prior
  unconsumed token for (tenant,user) consumed, then INSERT the new row
  (single-outstanding-token, auth-core-8).
- `consume(token)`: transactional SELECT → reject if missing / `consumed_at !== null` /
  `expires_at < nowISO` (string compare) → UPDATE consumed_at → return
  `{tenantId, userId}`.
- `purgeExpired()` deletes by `expires_at < now`.

### 9.5 RefreshTokenStore (`storage/refresh-token-store.ts`)

- Token: `randomBytes(32).toString("base64url")`; hash = SHA-256 **base64url**;
  `family_id = randomBytes(16).toString("base64url")` seeded at `issue` (default TTL
  30 days = `30*24*60*60` s).
- `readActive`: undefined when unknown, `revoked_at !== null`, or expired.
- `rotate(token, ttl?)` — single transaction: row missing ⇒ undefined; **already
  revoked ⇒ reuse signal**: revoke the ENTIRE family
  (`UPDATE … SET revoked_at=? WHERE family_id=? AND revoked_at IS NULL`; tokens with
  NULL family fall back to single-token revocation) and return undefined; expired ⇒
  undefined; else revoke presented token, INSERT fresh token inheriting
  tenant/user/device/replica/family.
- `revoke(token)` (idempotent), `revokeForUser(userId, tenantId?)`,
  `purgeExpired()` (`DELETE WHERE expires_at < now`).

### 9.6 SamlAssertionStore (`storage/saml-assertion-store.ts`)

- `markSeen({providerId, assertionId, expiresAt})`: plain INSERT; PK conflict (any
  throw) ⇒ `false` = replay. On winning insert, opportunistically `purgeExpired()`
  (best-effort, failure swallowed). Single-use enforced by PK under concurrency.
- `hasSeen`, `purgeExpired` (`expires_at < now`).

### 9.7 ServicePrincipalStore (`storage/service-principal-store.ts`)

- Issue: `id = "sp_" + randomBytes(12).base64url`, `keyId = "sk_" + randomBytes(6).base64url`,
  `secret = randomBytes(32).base64url`, presented bearer `apiKey = keyId + "." + secret`.
  Stored `key_hash = sha256 base64url(apiKey)` (the FULL key incl. prefix). Scopes
  normalized: trim, drop empties, dedupe, **sort**; stored as JSON array text.
- `authenticate(apiKey)`: parse keyId before first `.` (must be at index > 0); lookup by
  `key_id`; reject revoked; constant-time compare of hashes (`timingSafeEqual` on equal
  lengths). Returns record without hash.
- `list` (`ORDER BY created_at DESC, id DESC`), `get`, `revoke` (idempotent,
  tenant-scoped).

### 9.8 AdminAuditStore — hash-chained audit log (`storage/admin-audit-store.ts`)

- Canonical JSON for hashing (FIXED key order, lines 72-88):
  `JSON.stringify({occurred_at, admin_token_fingerprint, action, target, outcome, detail})`
  with `target`/`detail` as literal `null` when absent.
- `entry_hash = sha256hex( utf8(previousHash) || utf8(canonicalJson) )` — two
  sequential `update()` calls (line 90-92). Genesis `previousHash = ""`.
- `record()` is serialized through an in-process promise-chain mutex (`#recordTail`,
  lines 104-137) AND wrapped in a transaction; on Postgres it additionally takes
  `LOCK TABLE admin_audit_log IN SHARE ROW EXCLUSIVE MODE` for cross-process
  serialization (lines 154-157). Previous row chosen by `ORDER BY id DESC LIMIT 1`
  (AUTOINCREMENT order, not occurred_at). INSERT uses `RETURNING id`.
- `list({since?, action?, limit})`: `occurred_at >= ?`, exact action, limit default 100
  capped 1000, `ORDER BY occurred_at DESC, id DESC`.
- `verifyChain()`: scan `ORDER BY id ASC`; rows with NULL entry_hash (pre-0012) are
  the implicit genesis prefix and are skipped; first hashed row chains from its own
  recorded previous_hash (or ""); afterwards stored previous_hash must equal prior
  entry_hash and re-derived hash must match (constant-time compares). Returns
  `{valid}` or `{valid:false, brokenAt:id}`.
- `outcome ∈ "allow" | "deny" | "error"`. `admin_token_fingerprint` = truncated
  SHA-256 hex, 12 chars (produced by callers; documented line 23).

### 9.9 TenantStore / TenantSettingsStore / InvitationStore / GrantStore / PushRegistrationStore

- **TenantStore**: `list(includeArchived=false)` (`ORDER BY created_at ASC, tenant_id ASC`),
  `get`, `create` (non-archived exists ⇒ `TenantAlreadyExistsError`; archived ⇒ revive:
  clear archived_at + refresh display_name keeping original createdAt), `archive`
  (idempotent soft delete), `ensure` (`INSERT … ON CONFLICT DO NOTHING`, for implicit
  tenant creation).
- **TenantSettingsStore**: JSON-encoded values; `get` returns undefined on malformed
  JSON; `set` upserts with `updated_at`; `delete`; `list` returns object skipping
  malformed rows (`ORDER BY setting_key ASC`).
- **InvitationStore**: `create` (caller supplies id/token/timestamps);
  `getByToken`/`getById`; `redeem({token, tenantId, redeemerUserId, now})` returns a
  discriminated `RedeemOutcome` kind ∈ `ok | notFound | expired | alreadyRedeemed |
  tenantMismatch`; redemption UPDATE guarded `AND redeemed_at IS NULL`. ⚠️ The
  validate-then-update is NOT in a transaction here; routes wrap redeem+grant in a
  wrapping transaction (comment lines 88-91).
- **GrantStore**: `isEmptyAsync()` — `SELECT EXISTS(SELECT 1 FROM grants) AS present`
  (integer on SQLite, boolean on PG — treated truthy); `create`; `getById`;
  `list({tenantId, principalUserId, recordType?, recordId?, includeRevoked?})` —
  principal must be owner OR grantee, `ORDER BY created_at DESC, id ASC`;
  `revoke` (idempotent, returns updated row); `hasActiveGrantFor` (permission
  satisfaction checked in JS via `frickSharingPermissionSatisfies`);
  `hasActiveGrantForRecordId` (record-id-only cascade for streams/projections,
  requires "read").
- **PushRegistrationStore**: platforms `"apns" | "fcm" | "webPush" | "test"`,
  environments `"production" | "sandbox"` (default `production`).
  `register`: refresh active row in place (stable registration_id) else INSERT new
  `registration_id = "push-" + randomUUID()`; tombstones (revoked rows) are kept.
  `revoke` (tenant-scoped, returns true only on active→revoked transition), `getById`,
  `listByUser` (active only, `ORDER BY created_at ASC`), `touch`.

---

## 10. DevTools event store (`devtools/event-store.ts`)

- `record`: JSON.stringify(fields ?? {}) with try/catch fallback `"{}"`; INSERT failures
  swallowed entirely (never break the request path).
- `list({kind?, tenantId?, sinceId?, limit})`: `ORDER BY id DESC`, limit default 200
  capped 1000. `getById`. `summary(windowMs)`: counts by kind since cutoff.
- `prune()`: age sweep then cap sweep, **deliberately NOT in a transaction**
  (lines 187-193 explain the seam's BEGIN IMMEDIATE would collide with other users of
  the shared connection); cap pass deletes oldest by `id ASC`.

---

## 11. Platform event pipeline (SQL adapter, `platform-events/sqlite.ts`)

Despite the name it runs on BOTH dialects via the seam. `adapter = "sqlite"`.

- `publish`: idempotency pre-check by `(tenant_id, idempotency_key)` (NULL tenant uses
  `tenant_id IS NULL` branch — split into two queries because `IS ?` isn't portable,
  lines 410-429); `event_id = randomUUID()`; INSERT 14 columns `RETURNING id`;
  unique-violation race re-checks idempotency and returns `duplicate: true` receipt.
  Receipt = `{id: event_id, sequence: Number(rowid/identity), acceptedAt, duplicate}`.
- `claim(consumer, {batchSize=100 (max 1000), availableAt?})` — one transaction:
  1. Materialize deliveries for unseen events:
     `INSERT INTO platform_event_deliveries (consumer, event_id, status, attempt_count,
     available_at) SELECT ?, event_id, 'pending', 0, accepted_at FROM platform_events
     WHERE true ON CONFLICT (consumer, event_id) DO NOTHING`.
  2. Select eligible: status IN ('pending','retry') AND available_at <= now, OR stale
     'claimed' rows (claimed_at NULL or <= now − claimTimeoutMs [default 5 min]);
     `ORDER BY e.id ASC LIMIT ?`; PG adds `FOR UPDATE OF d SKIP LOCKED`.
  3. UPDATE selected to 'claimed', attempt_count+1, claimed_at=now.
  4. Re-select joined rows; return `{event: envelope, consumer, attempt, claimedAt}`.
- `ack`/`retry`/`deadLetter` use optimistic guards:
  `WHERE consumer=? AND event_id=? AND status='claimed' AND attempt_count=? AND claimed_at=?`
  — the (attempt, claimedAt) pair acts as a claim token, so a stale worker can't ack a
  re-claimed delivery. retry sets status='retry', available_at, claimed_at=NULL,
  last_error.
- `health()`: retained/unclaimed counts + per-consumer pending/claimed/deadLettered with
  `lag = pending + claimed`.
- `prune()`: transactional; deletes deliveries for aged events first, then events
  (`occurred_at < cutoff`); cap pass deletes oldest by `id ASC` (deliveries first, then
  events). Consumer name: trimmed, empty throws.

---

## 12. Analytics aggregate store (`analytics/summary.ts`)

- Constants: window default 24h, min 60 s, max 30 d; bucket = 1h
  (`ANALYTICS_AGGREGATE_BUCKET_MS`); family literal `"analytics.user_event"`; result
  limit default 10, clamp [1,100].
- `recordPlatformEvent(envelope)`: skip non-family events; reject unparseable
  occurredAt (`AnalyticsEventValidationError`); transaction: INSERT into
  analytics_recent_events `ON CONFLICT (event_id) DO NOTHING` (0 changes ⇒ duplicate);
  then increment buckets (`event` by name, `route` by `properties.path || context.path`,
  `subject` by subjectId) via UPSERT `count = count + 1`. `tenant_id` key uses `""` for
  null tenants. `bucket_start = ISO(floor(occurredAtMs / bucketMs) * bucketMs)`.
- `summary()`: totals (COUNT, DISTINCT subject_id/tenant_id), topEvents, topRoutes
  (the one dialect-split predicate: SQLite `json_type/json_extract` vs PG
  `jsonb_typeof/->>`, lines 274-289, only for `name = 'screen.viewed'`), recentEvents
  (`ORDER BY occurred_at DESC, event_id DESC`). Admin scope = no tenant filter.

---

## 13. Search

### 13.1 Registry & adapter seam (`search/types.ts`)

`FrickSearchIndexDefinition {name, source, project(input) -> doc|null}`;
`source ∈ {kind:"stream",type} | {kind:"object",type} | {kind:"projection",name}`.
`FrickSearchDoc {docId, text, fields?}` (fields: string|number values).
`FrickSearchAdapter {id, registerIndex, upsert, delete, query, rebuild}` — all
tenant-scoped. Registry rejects duplicate names. `DEFAULT_SEARCH_LIMIT=50`,
`MAX_SEARCH_LIMIT=200`.

### 13.2 Reserved source fields (`search/source-fields.ts`)

Injected into every doc's fields at index time: `__frickSourceKind`,
`__frickSourceType`, `__frickSourceId`, `__frickSourceEventId` (stream only). Prefix
`__frickSource` is reserved; `stripSearchSourceFields` removes them from hits.

### 13.3 SQLite adapter (`search/sqlite-fts.ts` + `storage/search-store.ts`)

id `"sqlite-fts5"`. Uses the RAW DatabaseSync handle (synchronous). Upsert =
`INSERT … ON CONFLICT(tenant_id, index_name, doc_id) DO UPDATE SET text, fields`; the
FTS5 companion stays in sync via the 0009 triggers. Query: empty/whitespace `q` ⇒
`{hits:[], total:0}` (FTS5 MATCH throws on empty); filter entries become
`json_extract(si.fields, '$.<key>') = ?` clauses; total computed first via COUNT over
the same join; hits `SELECT doc_id, fields, bm25(search_index_fts) AS score … ORDER BY
score ASC LIMIT ?` — **bm25: lower = more relevant**. `rebuild` clears
`(tenant, index)` then re-projects from an AsyncIterable. fields JSON parsed
defensively (non-string/number values dropped).

### 13.4 Postgres adapter (`search/pg-fts.ts`)

id `"postgres-tsvector"`. Config `'simple'` must match the generated column. Filters:
`(fields::jsonb ->> ?) = ?` with values stringified. Score `ts_rank` — **higher = more
relevant**, `ORDER BY score DESC, doc_id ASC`. Same empty-q shortcut, same rebuild.

---

## 14. Backup (dump) and restore

### 14.1 Dump (`backup/dump.ts`)

`dumpFrickDatabase(store, {tenantId?, includeAdminAudit?, includeMigrations?})` →
`AsyncIterable<string>` of NDJSON lines (no trailing newline per yield).

Header line: `{"type":"header","row":{frickFormat:1, createdAt, schemaId,
schemaVersion, schemaRevision, schemaHash, appliedMigrations: string[] (ids),
tenantId: "<tenant>"|"all"}}`.

Then `{type:<tableName>, row:{…}}` per row, tables in the FIXED `TABLE_ORDER`
(lines 58-116) with deterministic ORDER BY per table: tenants, auth_accounts,
auth_sessions, objects, stream_events, presence_leases, signal_outbox, blob_metadata,
blob_content, blob_derivatives, search_indexes, idempotency_keys, tenant_settings,
jobs, push_device_registrations, platform_events, platform_event_deliveries,
analytics_aggregate_buckets, analytics_recent_events, admin_audit_log,
frick_migrations.

⚠️ NOT dumped at all: schema_versions, devtools_events, auth_password_reset_tokens,
invitations, grants, auth_refresh_tokens, service_principals,
auth_saml_seen_assertions.

Scoping: `tenantId` omitted/"all" ⇒ whole DB (admin audit + migrations included by
default); per-tenant dumps filter `tenant_id = ?`, still include the chosen tenant's
ledger row, and select deliveries via JOIN on platform_events tenant. Tables that don't
exist are skipped (`sqlite_master` / `information_schema` probe).

Row encoding (`encodeRow`, lines 208-224): Buffer/Uint8Array values are dropped and
re-emitted as `<column>_base64` (standard base64); bigint → `Number(...)`; everything
else passes through JSON.

### 14.2 Restore (`backup/restore.ts`)

`restoreFrickDatabase({target, source, confirm:"yes", overwrite?, forceSchemaDrift?})`.

Refusals (`FrickRestoreRefusedError.reason`): `missingConfirmation` (confirm must be
literal `"yes"`), `missingHeader`, `schemaHashMismatch` (unless
`forceSchemaDrift:true`), `missingMigrations` (target must have applied AT LEAST every
migration id in the header), `targetNotEmpty` (unless `overwrite:true`),
`tenantScopeMismatch` (per-row check for tenant-scoped dumps; deliveries checked via
their parent event's tenant).

Mechanics: `overwrite` ⇒ `truncateScope` (children before parents per
`TRUNCATE_ALL_TABLES`; per-tenant deletes deliveries via subquery then tenant-scoped
DELETEs then the tenants row). All inserts run in ONE transaction; each row is wrapped
in `SAVEPOINT frick_restore_row` / `ROLLBACK TO` / `RELEASE` so a bad row is skipped
(recorded in `report.skipped` with reason + line). Columns are whitelisted against live
table introspection (`PRAGMA table_info(<table>)` / information_schema) — unknown or
duplicate columns reject the row; `*_base64` keys are decoded to Buffers; identifiers
double-quote-escaped. Unknown `type` values are skipped (`unknownTableType`). Report:
`{rowCountsByType, skipped[], schemaCompatibility{sourceHash,targetHash,matched},
startedAt, finishedAt}`. The line reader buffers and splits on `\n`, skipping empty
lines.

### 14.3 Dev reset (`storage/reset.ts`)

`resetFrickDatabase({db: path|DatabaseSync, env, confirmDevReset})`: requires
`env === "development"` (exact string) AND `confirmDevReset === true`, else
`FrickResetRefusedError("production_env" | "missing_confirmation")`. Inside
`BEGIN IMMEDIATE`: `PRAGMA foreign_keys = OFF`, `DROP TABLE IF EXISTS <t>` for all
`FRAMEWORK_TABLES` (including the ledger), COMMIT, finally `PRAGMA foreign_keys = ON`.
Closes the handle only if it opened it. SQLite-only.

---

## 15. Hash / token algorithm summary

| use | algorithm | encoding |
|---|---|---|
| migration checksum | SHA-256 of `id\|rev\|sql` | `"sha256-" + hex` |
| session token digest | SHA-256(token) | hex |
| refresh token hash | SHA-256(token) | base64url |
| password-reset token hash | SHA-256(token) | base64url |
| service-principal key hash | SHA-256(full `keyId.secret`) | base64url |
| admin audit entry hash | SHA-256(prevHash ∥ canonicalJSON) | hex |
| admin token fingerprint | SHA-256(admin token), truncated | hex, 12 chars |
| blob path/key segment | SHA-256(id) first 32 hex chars + readable prefix | `<prefix>.<hex32>` |
| passwords | Argon2id (default) / scrypt / legacy scrypt | self-describing string (§9.1) |
| stream event id | `"event-" + randomUUID()` | — |
| platform event id | `randomUUID()` | — |
| push registration id | `"push-" + randomUUID()` | — |
| service principal ids | `"sp_"+12B b64url`, `"sk_"+6B b64url`, secret 32B b64url | — |
| tokens (refresh/reset/invite) | `randomBytes(32)` | base64url |

---

## 16. Surprises / gotchas checklist for the Rust port

1. **Migration SQL text is hashed verbatim** — re-creating the migrations in Rust must
   preserve the exact strings (including whitespace/comments) or compute-and-record a
   compatible ledger; otherwise checksum drift aborts boot on existing databases.
2. **`objects` / `stream_events` / `blob_metadata` / `blob_content` PKs exclude
   `app_id`**; isolation is enforced by read filters + explicit cross-app write guards
   (SELECT-then-reject). `idempotency_keys` and `presence_leases` PKs DO include app_id
   (migration 0023). Stream sequences are shared across apps per (tenant, stream, id).
3. **StreamStore.append is not transactional** (max-sequence read and INSERT are
   separate statements); SQLite's effective single-writer behavior + the PK make
   collisions error rather than corrupt. A Rust impl with real concurrency must
   serialize or retry.
4. **`FrickStore.prune` rebuilds the StreamStore + LRU** after any deletion so the
   in-memory cache can't outlive durable retention.
5. **Replay window enforced at lookup time** (`Date.parse(created_at)`), independent of
   row pruning; beyond-window replays mint a NEW event and UPSERT the idempotency row.
6. **SQLite FK enforcement is never turned on** at runtime — `blob_content`'s
   ON DELETE CASCADE is decorative on SQLite, real on Postgres. GC paths delete bytes
   explicitly.
7. **bm25 vs ts_rank**: SQLite search scores ascending (lower better), PG descending
   (higher better) — the route layer passes scores through untranslated.
8. **Boolean params bind as 0/1, undefined as NULL** on both backends; PG parses BIGINT
   as JS number (type parser OID 20).
9. **Legacy scrypt verify uses the salt as a string**, not decoded bytes —
   bug-compatible behavior that must be reproduced to keep old credentials verifying.
10. **`jobs.packed` is overwritten with the result on completion**; job idempotency
    dedupe returns rows in ANY state (completed included).
11. **Audit chain orders by `id`** (insertion order) not `occurred_at`; record() is
    mutexed in-process + `LOCK TABLE … SHARE ROW EXCLUSIVE` on PG; NULL-hash prefix rows
    are skipped by verification.
12. **Dump format omits several auth/security tables** (refresh tokens, grants,
    invitations, service principals, reset tokens, SAML replay rows, devtools events,
    schema_versions) — restoring a dump silently loses those.
13. **Migration 0013 intentionally drops all sessions** (token → digest rebuild).
14. **DevTools prune intentionally avoids transactions**; platform-events prune uses one.
15. **Stale comments claim Postgres is unimplemented** (`sql-driver.ts`, `store.ts`
    StoreOptions docs); it is implemented and selected via `dbDriver:"postgres"` +
    `dbUrl`. The raw-SQLite-only subsystems are: devtools/event-store (now actually on
    the seam), platform-events, backup dump/restore (seam-based, dialect-aware),
    analytics, compliance erase, and anything using `store.db` (throws on PG).
16. **Nested transactions are flattened** on both drivers (no savepoints in the seam);
    restore.ts issues its own SAVEPOINT statements via `exec` inside the single outer
    transaction.
17. **`SELECT *` row mapping relies on column names**, not positions — Rust can use any
    column order but must keep names identical (snake_case as listed in §5).
18. **`ensure` tenants uses bare `ON CONFLICT DO NOTHING`** (no conflict target);
    tenants.create revives archived rows rather than failing.
19. **Empty search query short-circuits** before reaching FTS5/tsquery.
20. **`tenant_settings.retentionMs`** (JSON number) overrides the global idempotency
    retention per tenant inside `FrickStore.prune` — read with `setting_key = 'retentionMs'`.
