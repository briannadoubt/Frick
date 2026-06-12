//! Framework migration runner (FR-241), ported from
//! `apps/server/src/storage/migrations.ts` + `apps/server/src/storage/schema.ts`.
//!
//! The migration definitions are NOT re-typed by hand: the SQL text is hashed
//! verbatim into the `frick_migrations` ledger, so any byte drift would brick
//! every existing database at boot. Instead the list is embedded from the
//! conformance fixture (`conformance/fixtures/migrations/sqlite.json`)
//! extracted from the TS source of truth by `scripts/extract-migrations.ts`
//! (`pnpm fixtures:migrations`).
//!
//! Error message strings mirror the TS error classes
//! (`FrickMigrationError` / `FrickMigrationChecksumError` /
//! `FrickMigrationRevisionError`) character for character.

use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Instant;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::driver::{SqlDialect, SqlDriver, SqlValue};
use crate::error::StoreError;

/// The embedded SQLite migration fixture (see module docs).
const SQLITE_MIGRATIONS_JSON: &str =
    include_str!("../../../conformance/fixtures/migrations/sqlite.json");

/// The embedded Postgres migration fixture. Same shape as the SQLite fixture
/// (`scripts/extract-migrations.ts`), dialect-translated SQL (FR-242). Ids and
/// `schemaRevision` are identical to the SQLite siblings — the ledger id is the
/// cross-dialect identity — but the checksums differ because the SQL differs.
const POSTGRES_MIGRATIONS_JSON: &str =
    include_str!("../../../conformance/fixtures/migrations/postgres.json");

/// A single framework migration. Mirrors the TS `FrameworkMigration`
/// interface: migrations are append-only code-defined data — never edit an
/// applied one in place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameworkMigration {
    /// Stable identifier. Must never be reused or renamed.
    pub id: String,
    /// The `FrickSchema.schemaRevision` this migration upgrades the database
    /// to. The runner refuses to boot if the database records a revision
    /// newer than the supported revision.
    pub schema_revision: i64,
    /// Human-readable description, surfaced in errors and logs.
    pub description: String,
    /// SQL executed inside a transaction. May contain multiple statements.
    pub sql: String,
}

/// Row format for the `frick_migrations` ledger table (TS
/// `AppliedMigrationRow`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedMigrationRow {
    pub id: String,
    pub schema_revision: i64,
    pub applied_at: String,
    pub checksum: String,
    pub duration_ms: i64,
}

/// One fixture entry as emitted by `scripts/extract-migrations.ts`. The
/// `checksum` field is the TS-computed value; loading re-verifies it against
/// [`compute_migration_checksum`] so a corrupted fixture fails loudly.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MigrationFixtureEntry {
    id: String,
    #[serde(rename = "schemaRevision")]
    schema_revision: i64,
    description: String,
    sql: String,
    checksum: String,
}

fn parse_migration_fixture(json: &str) -> Result<Vec<FrameworkMigration>, String> {
    let entries: Vec<MigrationFixtureEntry> =
        serde_json::from_str(json).map_err(|err| format!("invalid migration fixture: {err}"))?;
    let mut migrations = Vec::with_capacity(entries.len());
    for entry in entries {
        let migration = FrameworkMigration {
            id: entry.id,
            schema_revision: entry.schema_revision,
            description: entry.description,
            sql: entry.sql,
        };
        let computed = compute_migration_checksum(&migration);
        if computed != entry.checksum {
            return Err(format!(
                "migration fixture checksum mismatch for {}: fixture says {} but recomputed {}",
                migration.id, entry.checksum, computed
            ));
        }
        migrations.push(migration);
    }
    Ok(migrations)
}

/// The framework migrations bundled with this build, byte-identical to the TS
/// `FRAMEWORK_MIGRATIONS` list (embedded from the conformance fixture and
/// checksum-verified at first use).
pub static FRAMEWORK_MIGRATIONS: LazyLock<Vec<FrameworkMigration>> = LazyLock::new(|| {
    parse_migration_fixture(SQLITE_MIGRATIONS_JSON)
        .expect("conformance/fixtures/migrations/sqlite.json is valid and checksum-consistent")
});

/// The Postgres-dialect framework migrations, byte-identical to the TS
/// `FRAMEWORK_MIGRATIONS_PG` list (embedded from the conformance fixture and
/// checksum-verified at first use). Same ids/order as [`FRAMEWORK_MIGRATIONS`].
pub static FRAMEWORK_MIGRATIONS_PG: LazyLock<Vec<FrameworkMigration>> = LazyLock::new(|| {
    parse_migration_fixture(POSTGRES_MIGRATIONS_JSON)
        .expect("conformance/fixtures/migrations/postgres.json is valid and checksum-consistent")
});

/// Compute the canonical checksum for a migration — the exact TS algorithm:
/// `"sha256-" + hex(sha256(utf8(`${id}|${schemaRevision}|${sql}`)))`.
#[must_use]
pub fn compute_migration_checksum(migration: &FrameworkMigration) -> String {
    let payload = format!(
        "{}|{}|{}",
        migration.id, migration.schema_revision, migration.sql
    );
    let digest = Sha256::digest(payload.as_bytes());
    format!("sha256-{}", hex::encode(digest))
}

/// Result of a [`run_framework_migrations`] call (TS `MigrationRunResult`).
#[derive(Debug, Clone, Default)]
pub struct MigrationRunResult {
    pub applied: Vec<AppliedMigrationRow>,
    pub already_applied: Vec<AppliedMigrationRow>,
}

/// Runner options (TS `MigrationRunnerOptions` minus the
/// `supportedSchemaRevision` field, which is a positional parameter here, and
/// minus `appMigrations`, which is unused plumbing in the TS source).
#[derive(Default)]
pub struct MigrationRunnerOptions<'a> {
    /// Migrations to apply. Defaults to [`FRAMEWORK_MIGRATIONS`]. Provided
    /// for tests and as a future extension point.
    pub migrations: Option<&'a [FrameworkMigration]>,
    /// Override the timestamp source for ledger `applied_at` values, as epoch
    /// milliseconds (mirrors the TS `now?: () => Date` option). The value is
    /// rendered as an ISO-8601 UTC string with millisecond precision and a
    /// trailing `Z` — exactly the JS `Date#toISOString` format. Defaults to
    /// the system clock, matching the TS default; per the rewrite's clock
    /// rule this runner is a facade-boundary entry point.
    pub now_ms: Option<&'a (dyn Fn() -> i64 + Send + Sync)>,
}

/// Run framework migrations against the given driver. Mirrors the TS
/// `runFrameworkMigrations` behavior, in order:
///
/// 1. Ensure `frick_migrations` exists (the one bootstrap CREATE).
/// 2. Load applied rows (`ORDER BY schema_revision ASC, id ASC`).
/// 3. Verify every applied row with an in-code definition still has a
///    matching checksum. Mismatch → [`StoreError::MigrationChecksum`].
/// 4. Verify `max(applied.schema_revision) <= supported_schema_revision`.
///    Otherwise → [`StoreError::MigrationRevision`].
/// 5. Apply not-yet-applied migrations in declaration order (a pending
///    migration with `schema_revision > supported` also fails the revision
///    guard), each inside a transaction wrapping both the SQL and the ledger
///    insert.
pub async fn run_framework_migrations(
    driver: &SqlDriver,
    supported_schema_revision: i64,
    options: MigrationRunnerOptions<'_>,
) -> Result<MigrationRunResult, StoreError> {
    let migrations: &[FrameworkMigration] =
        options.migrations.unwrap_or_else(|| &FRAMEWORK_MIGRATIONS);
    let now_ms: &(dyn Fn() -> i64 + Send + Sync) = options.now_ms.unwrap_or(&system_now_ms);

    ensure_migrations_table(driver).await?;

    let applied_rows = load_applied_migrations(driver).await?;
    let applied_by_id: HashMap<&str, &AppliedMigrationRow> = applied_rows
        .iter()
        .map(|row| (row.id.as_str(), row))
        .collect();

    for migration in migrations {
        let Some(recorded) = applied_by_id.get(migration.id.as_str()) else {
            continue;
        };
        let current_checksum = compute_migration_checksum(migration);
        if recorded.checksum != current_checksum {
            return Err(checksum_error(
                &migration.id,
                &recorded.checksum,
                &current_checksum,
            ));
        }
    }

    let max_applied_revision = applied_rows
        .iter()
        .fold(0_i64, |max, row| max.max(row.schema_revision));
    if max_applied_revision > supported_schema_revision {
        return Err(revision_error(
            max_applied_revision,
            supported_schema_revision,
        ));
    }

    let mut already_applied = Vec::new();
    let mut newly_applied = Vec::new();

    for migration in migrations {
        if let Some(recorded) = applied_by_id.get(migration.id.as_str()) {
            already_applied.push((*recorded).clone());
            continue;
        }
        if migration.schema_revision > supported_schema_revision {
            return Err(revision_error(
                migration.schema_revision,
                supported_schema_revision,
            ));
        }
        let applied = apply_migration(driver, migration, now_ms).await?;
        newly_applied.push(applied);
    }

    Ok(MigrationRunResult {
        applied: newly_applied,
        already_applied,
    })
}

/// Initialize the database, dispatching on dialect.
///
/// - SQLite (`storage/schema.ts` `initializeStorage`): apply WAL/synchronous
///   pragmas, then delegate table creation to the migration runner.
/// - Postgres (`storage/pg-schema.ts` `initializeStoragePg`): no pragma
///   equivalents, just run the PG migration runner.
pub async fn initialize_schema(
    driver: &SqlDriver,
    supported_schema_revision: i64,
) -> Result<(), StoreError> {
    match driver.dialect() {
        SqlDialect::Sqlite => {
            driver
                .exec(
                    "
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
  ",
                )
                .await?;
            run_framework_migrations(
                driver,
                supported_schema_revision,
                MigrationRunnerOptions::default(),
            )
            .await?;
        }
        SqlDialect::Postgres => {
            run_framework_migrations_postgres(
                driver,
                supported_schema_revision,
                MigrationRunnerOptions::default(),
            )
            .await?;
        }
    }
    Ok(())
}

/// Read the applied migration ledger (TS `listAppliedMigrations`). Exposed
/// for tests and operations tooling.
pub async fn list_applied_migrations(
    driver: &SqlDriver,
) -> Result<Vec<AppliedMigrationRow>, StoreError> {
    ensure_migrations_table(driver).await?;
    load_applied_migrations(driver).await
}

/// Run framework migrations against a Postgres driver. The Postgres mirror of
/// [`run_framework_migrations`] (`storage/pg-migrations.ts`
/// `runFrameworkMigrationsPostgres`): identical ledger/checksum/revision
/// semantics and the same exact error strings, only the SQL dialect differs
/// (`BEGIN` not `BEGIN IMMEDIATE`; TIMESTAMPTZ `applied_at` ledger column).
///
/// Defaults the migration list to [`FRAMEWORK_MIGRATIONS_PG`].
pub async fn run_framework_migrations_postgres(
    driver: &SqlDriver,
    supported_schema_revision: i64,
    options: MigrationRunnerOptions<'_>,
) -> Result<MigrationRunResult, StoreError> {
    let migrations: &[FrameworkMigration] = options
        .migrations
        .unwrap_or_else(|| &FRAMEWORK_MIGRATIONS_PG);
    let now_ms: &(dyn Fn() -> i64 + Send + Sync) = options.now_ms.unwrap_or(&system_now_ms);

    ensure_migrations_table_pg(driver).await?;

    let applied_rows = load_applied_migrations_pg(driver).await?;
    let applied_by_id: HashMap<&str, &AppliedMigrationRow> = applied_rows
        .iter()
        .map(|row| (row.id.as_str(), row))
        .collect();

    for migration in migrations {
        let Some(recorded) = applied_by_id.get(migration.id.as_str()) else {
            continue;
        };
        let current_checksum = compute_migration_checksum(migration);
        if recorded.checksum != current_checksum {
            return Err(checksum_error(
                &migration.id,
                &recorded.checksum,
                &current_checksum,
            ));
        }
    }

    let max_applied_revision = applied_rows
        .iter()
        .fold(0_i64, |max, row| max.max(row.schema_revision));
    if max_applied_revision > supported_schema_revision {
        return Err(revision_error(
            max_applied_revision,
            supported_schema_revision,
        ));
    }

    let mut already_applied = Vec::new();
    let mut newly_applied = Vec::new();

    for migration in migrations {
        if let Some(recorded) = applied_by_id.get(migration.id.as_str()) {
            already_applied.push((*recorded).clone());
            continue;
        }
        if migration.schema_revision > supported_schema_revision {
            return Err(revision_error(
                migration.schema_revision,
                supported_schema_revision,
            ));
        }
        let applied = apply_migration_pg(driver, migration, now_ms).await?;
        newly_applied.push(applied);
    }

    Ok(MigrationRunResult {
        applied: newly_applied,
        already_applied,
    })
}

/// Read the applied migration ledger from Postgres (TS
/// `listAppliedMigrationsPostgres`). Exposed for tests and operations tooling.
pub async fn list_applied_migrations_postgres(
    driver: &SqlDriver,
) -> Result<Vec<AppliedMigrationRow>, StoreError> {
    ensure_migrations_table_pg(driver).await?;
    load_applied_migrations_pg(driver).await
}

/// `FrickMigrationChecksumError` — exact TS message (migrations.ts:54-58).
fn checksum_error(migration_id: &str, recorded: &str, current: &str) -> StoreError {
    StoreError::MigrationChecksum(format!(
        "Migration {migration_id} checksum drift detected: \
database recorded {recorded} but current definition is {current}. \
Refusing to boot — restore the original migration or roll the database forward with a new migration."
    ))
}

/// `FrickMigrationRevisionError` — exact TS message (migrations.ts:70-73).
fn revision_error(database_revision: i64, supported_revision: i64) -> StoreError {
    StoreError::MigrationRevision(format!(
        "Database schema revision {database_revision} is newer than the server's supported revision \
{supported_revision}. Refusing to boot — upgrade the server or restore a compatible database."
    ))
}

async fn ensure_migrations_table(driver: &SqlDriver) -> Result<(), StoreError> {
    driver
        .exec(
            "
    CREATE TABLE IF NOT EXISTS frick_migrations (
      id TEXT PRIMARY KEY,
      schema_revision INTEGER NOT NULL,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL,
      duration_ms INTEGER NOT NULL
    );
  ",
        )
        .await
}

async fn load_applied_migrations(
    driver: &SqlDriver,
) -> Result<Vec<AppliedMigrationRow>, StoreError> {
    let rows = driver
        .all(
            "SELECT id, schema_revision, applied_at, checksum, duration_ms
        FROM frick_migrations
        ORDER BY schema_revision ASC, id ASC",
            &[],
        )
        .await?;
    rows.iter()
        .map(|row| {
            Ok(AppliedMigrationRow {
                id: required_text(row.text("id"), "frick_migrations.id")?,
                schema_revision: required_i64(
                    row.i64("schema_revision"),
                    "frick_migrations.schema_revision",
                )?,
                applied_at: required_text(row.text("applied_at"), "frick_migrations.applied_at")?,
                checksum: required_text(row.text("checksum"), "frick_migrations.checksum")?,
                duration_ms: required_i64(row.i64("duration_ms"), "frick_migrations.duration_ms")?,
            })
        })
        .collect()
}

fn required_text(value: Option<&str>, column: &str) -> Result<String, StoreError> {
    value
        .map(ToString::to_string)
        .ok_or_else(|| StoreError::driver(format!("{column} is not TEXT")))
}

fn required_i64(value: Option<i64>, column: &str) -> Result<i64, StoreError> {
    value.ok_or_else(|| StoreError::driver(format!("{column} is not INTEGER")))
}

/// Apply one migration: `BEGIN IMMEDIATE` → exec the migration SQL → INSERT
/// the ledger row → `COMMIT`, with the duration measured monotonically as
/// integer milliseconds (TS uses `process.hrtime.bigint()` truncated to ms).
/// Failure → `ROLLBACK` (rollback error swallowed) → the cause wrapped in the
/// exact TS `FrickMigrationError` message.
async fn apply_migration(
    driver: &SqlDriver,
    migration: &FrameworkMigration,
    now_ms: &(dyn Fn() -> i64 + Send + Sync),
) -> Result<AppliedMigrationRow, StoreError> {
    let checksum = compute_migration_checksum(migration);
    let start = Instant::now();
    let applied_at = epoch_ms_to_iso8601(now_ms());

    // Wrap SQL execution + ledger insert in a single transaction so either
    // both commit or neither does — partial migrations would corrupt the
    // ledger. (Like the TS source, this drives BEGIN/COMMIT/ROLLBACK
    // directly rather than through the seam's transaction helper.)
    driver.exec("BEGIN IMMEDIATE").await?;
    let outcome: Result<i64, StoreError> = async {
        driver.exec(&migration.sql).await?;
        let duration_ms = elapsed_ms(start);
        driver
            .run(
                "INSERT INTO frick_migrations (id, schema_revision, applied_at, checksum, duration_ms)
        VALUES (?, ?, ?, ?, ?)",
                &[
                    SqlValue::from(migration.id.clone()),
                    SqlValue::from(migration.schema_revision),
                    SqlValue::from(applied_at.clone()),
                    SqlValue::from(checksum.clone()),
                    SqlValue::from(duration_ms),
                ],
            )
            .await?;
        driver.exec("COMMIT").await?;
        Ok(duration_ms)
    }
    .await;

    match outcome {
        Ok(duration_ms) => Ok(AppliedMigrationRow {
            id: migration.id.clone(),
            schema_revision: migration.schema_revision,
            applied_at,
            checksum,
            duration_ms,
        }),
        Err(error) => {
            // The transaction may already have aborted on the SQLite side;
            // swallow the rollback error so we surface the original cause.
            let _ = driver.exec("ROLLBACK").await;
            Err(StoreError::Migration(format!(
                "Failed to apply migration {} ({}): {error}",
                migration.id, migration.description
            )))
        }
    }
}

/// Postgres ledger DDL (TS `ensureMigrationsTablePg`): same shape as the SQLite
/// ledger, but `applied_at` is `TIMESTAMPTZ`.
async fn ensure_migrations_table_pg(driver: &SqlDriver) -> Result<(), StoreError> {
    driver
        .exec(
            "
    CREATE TABLE IF NOT EXISTS frick_migrations (
      id TEXT PRIMARY KEY,
      schema_revision INTEGER NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL,
      checksum TEXT NOT NULL,
      duration_ms INTEGER NOT NULL
    );
  ",
        )
        .await
}

/// Load the Postgres ledger. `applied_at` is rendered back to the JS
/// `Date#toISOString` string shape via `to_char(... AT TIME ZONE 'UTC', …)` so
/// the [`AppliedMigrationRow::applied_at`] field matches the SQLite arm and the
/// TS `appliedAt: row.applied_at.toISOString()`.
async fn load_applied_migrations_pg(
    driver: &SqlDriver,
) -> Result<Vec<AppliedMigrationRow>, StoreError> {
    let rows = driver
        .all(
            "SELECT id, schema_revision,
                to_char(applied_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS applied_at,
                checksum, duration_ms
        FROM frick_migrations
        ORDER BY schema_revision ASC, id ASC",
            &[],
        )
        .await?;
    rows.iter()
        .map(|row| {
            Ok(AppliedMigrationRow {
                id: required_text(row.text("id"), "frick_migrations.id")?,
                schema_revision: required_i64(
                    row.i64("schema_revision"),
                    "frick_migrations.schema_revision",
                )?,
                applied_at: required_text(row.text("applied_at"), "frick_migrations.applied_at")?,
                checksum: required_text(row.text("checksum"), "frick_migrations.checksum")?,
                duration_ms: required_i64(row.i64("duration_ms"), "frick_migrations.duration_ms")?,
            })
        })
        .collect()
}

/// Apply one migration on Postgres: `BEGIN` → exec the migration SQL → INSERT
/// the ledger row → `COMMIT`, the Postgres mirror of [`apply_migration`].
///
/// Unlike the SQLite path (single shared connection), Postgres pools its
/// connections, so this drives the whole unit through the seam's
/// [`SqlDriver::transaction`] helper — which checks out a single pooled client
/// and binds every statement to it — rather than issuing bare `BEGIN`/`COMMIT`
/// (each of which would otherwise land on a different pooled connection).
/// Rollback-on-failure and the exact `FrickMigrationError` wrap are preserved.
async fn apply_migration_pg(
    driver: &SqlDriver,
    migration: &FrameworkMigration,
    now_ms: &(dyn Fn() -> i64 + Send + Sync),
) -> Result<AppliedMigrationRow, StoreError> {
    let checksum = compute_migration_checksum(migration);
    let start = Instant::now();
    let applied_at = epoch_ms_to_iso8601(now_ms());

    let sql = migration.sql.clone();
    let ledger_id = migration.id.clone();
    let ledger_revision = migration.schema_revision;
    let ledger_applied_at = applied_at.clone();
    let ledger_checksum = checksum.clone();

    let outcome = driver
        .transaction(move |tx| {
            Box::pin(async move {
                tx.exec(&sql).await?;
                let duration_ms = elapsed_ms(start);
                tx.run(
                    "INSERT INTO frick_migrations (id, schema_revision, applied_at, checksum, duration_ms)
        VALUES (?, ?, to_timestamp(?, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), ?, ?)",
                    &[
                        SqlValue::from(ledger_id),
                        SqlValue::from(ledger_revision),
                        SqlValue::from(ledger_applied_at),
                        SqlValue::from(ledger_checksum),
                        SqlValue::from(duration_ms),
                    ],
                )
                .await?;
                Ok(duration_ms)
            })
        })
        .await;

    match outcome {
        Ok(duration_ms) => Ok(AppliedMigrationRow {
            id: migration.id.clone(),
            schema_revision: migration.schema_revision,
            applied_at,
            checksum,
            duration_ms,
        }),
        Err(error) => Err(StoreError::Migration(format!(
            "Failed to apply migration {} ({}): {error}",
            migration.id, migration.description
        ))),
    }
}

fn system_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

fn elapsed_ms(start: Instant) -> i64 {
    i64::try_from(start.elapsed().as_millis()).unwrap_or(i64::MAX)
}

/// Render epoch milliseconds as the JS `Date#toISOString` format:
/// `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC, millisecond precision, trailing `Z`).
/// Like `toISOString`, only dates whose year fits in four digits are
/// representable here (JS switches to the expanded ±YYYYYY form outside
/// 0..=9999; no Frick timestamp legitimately leaves that range).
fn epoch_ms_to_iso8601(epoch_ms: i64) -> String {
    let millis = epoch_ms.rem_euclid(1000);
    let total_seconds = epoch_ms.div_euclid(1000);
    let days = total_seconds.div_euclid(86_400);
    let seconds_of_day = total_seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hours = seconds_of_day / 3600;
    let minutes = (seconds_of_day / 60) % 60;
    let seconds = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z")
}

/// Days-since-epoch → (year, month, day) in the proleptic Gregorian calendar
/// (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let year_of_era = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (
        if month <= 2 {
            year_of_era + 1
        } else {
            year_of_era
        },
        month,
        day,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXPECTED_MIGRATION_IDS: [&str; 24] = [
        "0001_initial_foundation_tables",
        "0002_idempotency_keys_created_at",
        "0003_tenant_boundary",
        "0004_tenants_ledger",
        "0005_admin_audit_log",
        "0006_jobs_lifecycle",
        "0007_push_registrations",
        "0008_blob_derivatives",
        "0009_search_indexes",
        "0010_tenant_settings",
        "0011_devtools_event_log",
        "0012_audit_chain",
        "0013_auth_session_token_digests",
        "0014_platform_events",
        "0015_analytics_aggregates",
        "0016_password_reset_tokens",
        "0017_sharing",
        "0018_refresh_tokens",
        "0019_service_principals",
        "0020_saml_seen_assertions",
        "0021_app_boundary",
        "0022_jobs_idempotency_app_scope",
        "0023_app_scoped_idempotency_presence_keys",
        "0024_refresh_token_family",
    ];

    /// Mirrors `FOUNDATION_TABLES` in `apps/server/tests/migrations.test.ts`.
    const FOUNDATION_TABLES: [&str; 15] = [
        "schema_versions",
        "objects",
        "stream_events",
        "idempotency_keys",
        "presence_leases",
        "signal_outbox",
        "blob_metadata",
        "blob_content",
        "jobs",
        "auth_sessions",
        "auth_accounts",
        "platform_events",
        "platform_event_deliveries",
        "analytics_aggregate_buckets",
        "analytics_recent_events",
    ];

    fn memory_driver() -> SqlDriver {
        SqlDriver::open_sqlite(":memory:").expect("open :memory: sqlite")
    }

    async fn list_tables(driver: &SqlDriver) -> Vec<String> {
        driver
            .all(
                "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
                &[],
            )
            .await
            .expect("list tables")
            .iter()
            .map(|row| row.text("name").expect("table name").to_string())
            .collect()
    }

    fn fixture_entries(json: &str) -> Vec<MigrationFixtureEntry> {
        serde_json::from_str(json).expect("fixture parses")
    }

    #[test]
    fn sqlite_fixture_checksums_match_rust_recomputation() {
        let entries = fixture_entries(SQLITE_MIGRATIONS_JSON);
        assert_eq!(entries.len(), 24);
        for entry in &entries {
            let migration = FrameworkMigration {
                id: entry.id.clone(),
                schema_revision: entry.schema_revision,
                description: entry.description.clone(),
                sql: entry.sql.clone(),
            };
            assert_eq!(
                compute_migration_checksum(&migration),
                entry.checksum,
                "checksum drift for {}",
                entry.id
            );
        }
        // The embedded list re-verifies on load too.
        let ids: Vec<&str> = FRAMEWORK_MIGRATIONS.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, EXPECTED_MIGRATION_IDS);
    }

    #[test]
    fn postgres_fixture_parses_and_checksums_match() {
        let entries = fixture_entries(POSTGRES_MIGRATIONS_JSON);
        assert_eq!(entries.len(), 24);
        let ids: Vec<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(
            ids, EXPECTED_MIGRATION_IDS,
            "PG ids are the cross-dialect identity"
        );
        for entry in &entries {
            let migration = FrameworkMigration {
                id: entry.id.clone(),
                schema_revision: entry.schema_revision,
                description: entry.description.clone(),
                sql: entry.sql.clone(),
            };
            assert_eq!(
                compute_migration_checksum(&migration),
                entry.checksum,
                "checksum drift for {}",
                entry.id
            );
        }

        // The embedded PG list re-verifies on load (same algorithm) and keeps
        // the cross-dialect id identity.
        let pg_ids: Vec<&str> = FRAMEWORK_MIGRATIONS_PG
            .iter()
            .map(|m| m.id.as_str())
            .collect();
        assert_eq!(pg_ids, EXPECTED_MIGRATION_IDS);
        for migration in FRAMEWORK_MIGRATIONS_PG.iter() {
            let computed = compute_migration_checksum(migration);
            assert!(computed.starts_with("sha256-"));
            assert_eq!(computed.len(), "sha256-".len() + 64);
        }

        // Ids align by position with the SQLite list (cross-dialect identity),
        // but some migrations carry dialect-translated SQL (BYTEA/IDENTITY/…),
        // so at least one checksum must differ — proving these are real PG
        // definitions, not the SQLite list reused.
        let mut any_translated = false;
        for (pg, sqlite) in FRAMEWORK_MIGRATIONS_PG
            .iter()
            .zip(FRAMEWORK_MIGRATIONS.iter())
        {
            assert_eq!(pg.id, sqlite.id, "ids align by position");
            if compute_migration_checksum(pg) != compute_migration_checksum(sqlite) {
                any_translated = true;
            }
        }
        assert!(
            any_translated,
            "PG migrations must include dialect-translated SQL"
        );
    }

    #[test]
    fn checksum_algorithm_matches_known_vector() {
        // sha256("a|1|b") — pins the exact `${id}|${schemaRevision}|${sql}`
        // payload layout and the "sha256-" + hex envelope.
        let migration = FrameworkMigration {
            id: "a".to_string(),
            schema_revision: 1,
            description: "vector".to_string(),
            sql: "b".to_string(),
        };
        assert_eq!(
            compute_migration_checksum(&migration),
            "sha256-a1bdd42948a58a8bf1dec4d724b40905f64fa23385d0ac9d4197c9315810e9de"
        );
    }

    #[tokio::test]
    async fn applies_the_initial_migrations_on_a_fresh_database() {
        let driver = memory_driver();
        let result = run_framework_migrations(&driver, 1, MigrationRunnerOptions::default())
            .await
            .expect("migrations apply");

        let applied_ids: Vec<&str> = result.applied.iter().map(|row| row.id.as_str()).collect();
        assert_eq!(applied_ids, EXPECTED_MIGRATION_IDS);
        assert!(result.already_applied.is_empty());
        assert_eq!(result.applied[0].schema_revision, 1);
        assert!(result.applied[0].checksum.starts_with("sha256-"));
        assert_eq!(result.applied[0].checksum.len(), "sha256-".len() + 64);
        assert!(result.applied[0].duration_ms >= 0);

        let ledger = list_applied_migrations(&driver)
            .await
            .expect("ledger reads");
        let ledger_ids: Vec<&str> = ledger.iter().map(|row| row.id.as_str()).collect();
        assert_eq!(ledger_ids, EXPECTED_MIGRATION_IDS);

        let tables = list_tables(&driver).await;
        for table in FOUNDATION_TABLES {
            assert!(
                tables.iter().any(|name| name == table),
                "missing table {table}"
            );
        }
        assert!(tables.iter().any(|name| name == "frick_migrations"));
    }

    #[tokio::test]
    async fn is_idempotent_across_repeated_runs() {
        let driver = memory_driver();
        let first = run_framework_migrations(&driver, 1, MigrationRunnerOptions::default())
            .await
            .expect("first run");
        let second = run_framework_migrations(&driver, 1, MigrationRunnerOptions::default())
            .await
            .expect("second run");

        assert_eq!(first.applied.len(), 24);
        assert_eq!(second.applied.len(), 0);
        assert_eq!(second.already_applied.len(), 24);
        assert_eq!(
            list_applied_migrations(&driver)
                .await
                .expect("ledger")
                .len(),
            24
        );
    }

    #[tokio::test]
    async fn refuses_to_boot_when_a_recorded_checksum_has_drifted() {
        let driver = memory_driver();
        run_framework_migrations(&driver, 1, MigrationRunnerOptions::default())
            .await
            .expect("initial run");

        // Simulate someone editing the on-disk migration after it was applied.
        driver
            .run(
                "UPDATE frick_migrations SET checksum = ? WHERE id = ?",
                &[
                    SqlValue::from("sha256-deadbeef"),
                    SqlValue::from("0001_initial_foundation_tables"),
                ],
            )
            .await
            .expect("tamper ledger");

        let error = run_framework_migrations(&driver, 1, MigrationRunnerOptions::default())
            .await
            .expect_err("checksum drift must refuse to boot");
        let current = compute_migration_checksum(&FRAMEWORK_MIGRATIONS[0]);
        match error {
            StoreError::MigrationChecksum(message) => assert_eq!(
                message,
                format!(
                    "Migration 0001_initial_foundation_tables checksum drift detected: \
database recorded sha256-deadbeef but current definition is {current}. \
Refusing to boot — restore the original migration or roll the database forward with a new migration."
                )
            ),
            other => panic!("expected MigrationChecksum, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn refuses_to_boot_when_the_database_records_a_future_revision() {
        let driver = memory_driver();
        run_framework_migrations(&driver, 1, MigrationRunnerOptions::default())
            .await
            .expect("initial run");

        // Pre-seed a row claiming the database is at a far-future revision.
        driver
            .run(
                "INSERT INTO frick_migrations (id, schema_revision, applied_at, checksum, duration_ms)
        VALUES (?, ?, ?, ?, ?)",
                &[
                    SqlValue::from("9999_future_migration"),
                    SqlValue::from(99_i64),
                    SqlValue::from("2026-06-10T00:00:00.000Z"),
                    SqlValue::from("sha256-future"),
                    SqlValue::from(0_i64),
                ],
            )
            .await
            .expect("seed future row");

        let error = run_framework_migrations(&driver, 1, MigrationRunnerOptions::default())
            .await
            .expect_err("future revision must refuse to boot");
        match error {
            StoreError::MigrationRevision(message) => assert_eq!(
                message,
                "Database schema revision 99 is newer than the server's supported revision \
1. Refusing to boot — upgrade the server or restore a compatible database."
            ),
            other => panic!("expected MigrationRevision, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn refuses_a_pending_migration_above_the_supported_revision() {
        let driver = memory_driver();
        let pending = vec![FrameworkMigration {
            id: "9001_future_pending".to_string(),
            schema_revision: 2,
            description: "pending future".to_string(),
            sql: "CREATE TABLE pending_future (id INTEGER PRIMARY KEY);".to_string(),
        }];

        let error = run_framework_migrations(
            &driver,
            1,
            MigrationRunnerOptions {
                migrations: Some(&pending),
                now_ms: None,
            },
        )
        .await
        .expect_err("pending migration above supported revision must fail");
        match error {
            StoreError::MigrationRevision(message) => assert_eq!(
                message,
                "Database schema revision 2 is newer than the server's supported revision \
1. Refusing to boot — upgrade the server or restore a compatible database."
            ),
            other => panic!("expected MigrationRevision, got {other:?}"),
        }
        assert!(
            list_applied_migrations(&driver)
                .await
                .expect("ledger")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn rolls_back_the_ledger_insert_if_the_migration_sql_fails() {
        let driver = memory_driver();
        let broken = vec![FrameworkMigration {
            id: "0001_initial_foundation_tables".to_string(),
            schema_revision: 1,
            description: "broken".to_string(),
            sql: "CREATE TABLE foo (id INTEGER); SELECT this_is_not_valid_sql;".to_string(),
        }];

        let error = run_framework_migrations(
            &driver,
            1,
            MigrationRunnerOptions {
                migrations: Some(&broken),
                now_ms: None,
            },
        )
        .await
        .expect_err("broken SQL must fail");
        match error {
            StoreError::Migration(message) => assert!(
                message.starts_with(
                    "Failed to apply migration 0001_initial_foundation_tables (broken): "
                ),
                "unexpected message: {message}"
            ),
            other => panic!("expected Migration, got {other:?}"),
        }

        // The migrations ledger exists (bootstrap CREATE) but holds no rows.
        assert!(
            list_applied_migrations(&driver)
                .await
                .expect("ledger")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn supports_an_explicit_migrations_override() {
        let driver = memory_driver();
        let mut extended: Vec<FrameworkMigration> = FRAMEWORK_MIGRATIONS.clone();
        extended.push(FrameworkMigration {
            id: "9000_test_extra".to_string(),
            schema_revision: 1,
            description: "test extra".to_string(),
            sql: "CREATE TABLE test_extra (id INTEGER PRIMARY KEY);".to_string(),
        });

        let result = run_framework_migrations(
            &driver,
            1,
            MigrationRunnerOptions {
                migrations: Some(&extended),
                now_ms: None,
            },
        )
        .await
        .expect("extended run");

        let applied_ids: Vec<&str> = result.applied.iter().map(|row| row.id.as_str()).collect();
        let mut expected: Vec<&str> = EXPECTED_MIGRATION_IDS.to_vec();
        expected.push("9000_test_extra");
        assert_eq!(applied_ids, expected);
        assert!(
            list_tables(&driver)
                .await
                .iter()
                .any(|name| name == "test_extra")
        );
    }

    #[tokio::test]
    async fn ledger_rows_carry_applied_at_and_duration_ms() {
        let driver = memory_driver();
        let clock = || 1_700_000_000_123_i64;
        run_framework_migrations(
            &driver,
            1,
            MigrationRunnerOptions {
                migrations: None,
                now_ms: Some(&clock),
            },
        )
        .await
        .expect("migrations apply");

        let rows = driver
            .all(
                "SELECT id, applied_at, duration_ms FROM frick_migrations ORDER BY id ASC",
                &[],
            )
            .await
            .expect("ledger rows");
        assert_eq!(rows.len(), 24);
        for row in &rows {
            assert_eq!(
                row.text("applied_at"),
                Some("2023-11-14T22:13:20.123Z"),
                "clock override flows into applied_at"
            );
            assert!(row.i64("duration_ms").expect("duration_ms present") >= 0);
        }
    }

    #[tokio::test]
    async fn initialize_schema_applies_pragmas_and_migrations() {
        let driver = memory_driver();
        initialize_schema(&driver, 1)
            .await
            .expect("initialize_schema");

        let tables = list_tables(&driver).await;
        for table in FOUNDATION_TABLES {
            assert!(
                tables.iter().any(|name| name == table),
                "missing table {table}"
            );
        }
        // Idempotent: a second boot is a no-op.
        initialize_schema(&driver, 1)
            .await
            .expect("second initialize_schema");
        assert_eq!(
            list_applied_migrations(&driver)
                .await
                .expect("ledger")
                .len(),
            24
        );
    }

    #[test]
    fn iso8601_matches_js_to_iso_string() {
        assert_eq!(epoch_ms_to_iso8601(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(epoch_ms_to_iso8601(1), "1970-01-01T00:00:00.001Z");
        assert_eq!(
            epoch_ms_to_iso8601(1_700_000_000_123),
            "2023-11-14T22:13:20.123Z"
        );
        // Leap day + end-of-year boundaries.
        assert_eq!(
            epoch_ms_to_iso8601(1_582_934_400_000),
            "2020-02-29T00:00:00.000Z"
        );
        assert_eq!(
            epoch_ms_to_iso8601(1_767_225_599_999),
            "2025-12-31T23:59:59.999Z"
        );
        // Today's facade clock shape (2026-06-10).
        assert_eq!(
            epoch_ms_to_iso8601(1_780_531_200_000),
            "2026-06-04T00:00:00.000Z"
        );
    }
}
