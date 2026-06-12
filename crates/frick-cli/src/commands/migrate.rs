//! `frick migrate status|up` (ported from `apps/cli/src/commands/migrate.ts`).
//!
//! DEVIATION: the TS opens a raw `node:sqlite` handle; the Rust CLI opens the
//! same SQLite database through [`frick_store::SqlDriver`] and drives the
//! framework migration runner directly. `SqlDriver::open_sqlite` creates parent
//! directories unless the path is `:memory:` — matching the TS `mkdirSync`.

use frick_protocol::foundation_schema;
use frick_store::SqlDriver;
use frick_store::migrations::{
    FRAMEWORK_MIGRATIONS, MigrationRunnerOptions, list_applied_migrations, run_framework_migrations,
};
use serde_json::json;

use crate::argv::ParsedArgs;
use crate::context::{context_flags_from, load_config};
use crate::errors::{CliError, EXIT_OK};
use crate::output::Output;

/// `migrateCommand`.
pub async fn migrate_command(parsed: &ParsedArgs, out: &mut Output<'_>) -> Result<i32, CliError> {
    match parsed.positional(0) {
        Some("status") => migrate_status(parsed, out).await,
        Some("up") => migrate_up(parsed, out).await,
        other => Err(CliError::usage_with(
            format!(
                "Unknown migrate subcommand: {}",
                other.unwrap_or("<missing>")
            ),
            json!({ "expected": ["status", "up"] }),
        )),
    }
}

fn open_driver(path: &str) -> Result<SqlDriver, CliError> {
    SqlDriver::open_sqlite(path).map_err(|err| CliError::failure("cli.store", err.to_string()))
}

async fn migrate_status(parsed: &ParsedArgs, out: &mut Output<'_>) -> Result<i32, CliError> {
    let config = load_config(&context_flags_from(parsed))?;
    let driver = open_driver(&config.db_path)?;
    let applied = list_applied_migrations(&driver)
        .await
        .map_err(|err| CliError::failure("cli.store", err.to_string()))?;
    let applied_ids: std::collections::HashSet<&str> =
        applied.iter().map(|row| row.id.as_str()).collect();
    let pending: Vec<_> = FRAMEWORK_MIGRATIONS
        .iter()
        .filter(|m| !applied_ids.contains(m.id.as_str()))
        .map(|m| {
            json!({
                "id": m.id,
                "schemaRevision": m.schema_revision,
                "description": m.description,
            })
        })
        .collect();
    let applied_json: Vec<_> = applied
        .iter()
        .map(|row| {
            json!({
                "id": row.id,
                "schemaRevision": row.schema_revision,
                "appliedAt": row.applied_at,
                "checksum": row.checksum,
                "durationMs": row.duration_ms,
            })
        })
        .collect();
    out.emit(&json!({
        "dbPath": config.db_path,
        "env": config.env.as_str(),
        "applied": applied_json,
        "pending": pending,
    }));
    driver.close().await;
    Ok(EXIT_OK)
}

async fn migrate_up(parsed: &ParsedArgs, out: &mut Output<'_>) -> Result<i32, CliError> {
    let config = load_config(&context_flags_from(parsed))?;
    if config.env.is_production() && !parsed.flag_bool_present("confirm-prod") {
        return Err(CliError::refused_with(
            "Refusing to run migrations against a production-mode config without --confirm-prod",
            json!({ "env": config.env.as_str(), "dbPath": config.db_path }),
        ));
    }
    let driver = open_driver(&config.db_path)?;
    let result = run_framework_migrations(
        &driver,
        foundation_schema().schema_revision,
        MigrationRunnerOptions::default(),
    )
    .await
    .map_err(|err| CliError::failure("cli.migrate", err.to_string()))?;
    let applied: Vec<_> = result
        .applied
        .iter()
        .map(|row| {
            json!({
                "id": row.id,
                "schemaRevision": row.schema_revision,
                "appliedAt": row.applied_at,
                "durationMs": row.duration_ms,
            })
        })
        .collect();
    let already_applied: Vec<_> = result
        .already_applied
        .iter()
        .map(|row| row.id.clone())
        .collect();
    out.emit(&json!({
        "dbPath": config.db_path,
        "env": config.env.as_str(),
        "applied": applied,
        "alreadyApplied": already_applied,
    }));
    driver.close().await;
    Ok(EXIT_OK)
}
