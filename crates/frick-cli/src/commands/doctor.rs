//! `frick doctor` (ported from `apps/cli/src/commands/doctor.ts`).
//!
//! Composite check: one JSON record `{ok, env, schema, db, migrations, config}`,
//! exit 0 only when all four sub-checks are green.
//!
//! The db check deliberately opens the database *without* creating parent
//! directories (TS uses a raw `DatabaseSync`), so a missing DB file surfaces as
//! a failure rather than a side-effecting init.

use std::collections::HashMap;
use std::path::Path;

use frick_protocol::{foundation_schema, validate_schema};
use frick_store::SqlDriver;
use frick_store::migrations::{
    AppliedMigrationRow, FRAMEWORK_MIGRATIONS, compute_migration_checksum, list_applied_migrations,
};
use serde_json::{Value, json};

use crate::argv::ParsedArgs;
use crate::context::{context_flags_from, load_config};
use crate::errors::{CliError, EXIT_FAILURE, EXIT_OK};
use crate::output::Output;

/// One sub-check result (`CheckResult` in TS): `{ok, detail?, error?}`.
struct Check {
    ok: bool,
    detail: Option<Value>,
    error: Option<String>,
}

impl Check {
    fn ok(detail: Value) -> Self {
        Self {
            ok: true,
            detail: Some(detail),
            error: None,
        }
    }
    fn err(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            detail: None,
            error: Some(error.into()),
        }
    }
    fn err_with(error: impl Into<String>, detail: Value) -> Self {
        Self {
            ok: false,
            detail: Some(detail),
            error: Some(error.into()),
        }
    }
    fn to_value(&self) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("ok".to_string(), Value::Bool(self.ok));
        if let Some(detail) = &self.detail {
            map.insert("detail".to_string(), detail.clone());
        }
        if let Some(error) = &self.error {
            map.insert("error".to_string(), Value::String(error.clone()));
        }
        Value::Object(map)
    }
}

/// `doctorCommand`.
pub async fn doctor_command(parsed: &ParsedArgs, out: &mut Output<'_>) -> Result<i32, CliError> {
    let ctx = context_flags_from(parsed);

    let mut config_env: Option<&'static str> = None;
    let mut config_db_path: Option<String> = None;
    let config_check = match load_config(&ctx) {
        Ok(config) => {
            config_env = Some(config.env.as_str());
            config_db_path = Some(config.db_path.clone());
            Check::ok(json!({
                "env": config.env.as_str(),
                "dbPath": config.db_path,
                "demoAuthEnabled": config.demo_auth_enabled,
                "inspectionEnabled": config.inspection_enabled,
                "adminEnabled": config.admin_enabled(),
            }))
        }
        Err(err) => Check::err(err.message),
    };

    let schema_check = {
        let schema = foundation_schema();
        match validate_schema(&schema) {
            Ok(()) => Check::ok(json!({
                "schemaId": schema.schema_id,
                "schemaRevision": schema.schema_revision,
                "schemaHash": schema.hash,
            })),
            Err(err) => Check::err(err.to_string()),
        }
    };

    let mut db_check = Check::err("not_evaluated");
    let mut migrations_check = Check::err("not_evaluated");

    if config_check.ok
        && let Some(db_path) = &config_db_path
    {
        let (db, db_result) = open_raw(db_path).await;
        db_check = db_result;

        if db_check.ok
            && let Some(driver) = &db
        {
            migrations_check = match list_applied_migrations(driver).await {
                Ok(applied) => migrations_status(&applied),
                Err(err) => Check::err(err.to_string()),
            };
        }
        if let Some(driver) = db {
            driver.close().await;
        }
    }

    let ok = config_check.ok && schema_check.ok && db_check.ok && migrations_check.ok;
    out.emit(&json!({
        "ok": ok,
        "env": config_env,
        "schema": schema_check.to_value(),
        "db": db_check.to_value(),
        "migrations": migrations_check.to_value(),
        "config": config_check.to_value(),
    }));
    Ok(if ok { EXIT_OK } else { EXIT_FAILURE })
}

/// Open the DB the way the TS raw probe does: never create parent directories,
/// run `SELECT 1`. A missing parent directory ⇒ db-check failure.
async fn open_raw(db_path: &str) -> (Option<SqlDriver>, Check) {
    if db_path != ":memory:"
        && let Some(parent) = Path::new(db_path).parent()
        && !parent.as_os_str().is_empty()
        && !parent.exists()
    {
        return (
            None,
            Check::err(format!("unable to open database file: {db_path}")),
        );
    }
    match SqlDriver::open_sqlite(db_path) {
        Ok(driver) => match driver.get("SELECT 1 AS ok", &[]).await {
            Ok(Some(row)) if row.i64("ok") == Some(1) => {
                (Some(driver), Check::ok(json!({ "dbPath": db_path })))
            }
            Ok(_) => (Some(driver), Check::err("ping_failed")),
            Err(err) => (Some(driver), Check::err(err.to_string())),
        },
        Err(err) => (None, Check::err(err.to_string())),
    }
}

fn migrations_status(applied: &[AppliedMigrationRow]) -> Check {
    let applied_by_id: HashMap<&str, &AppliedMigrationRow> =
        applied.iter().map(|row| (row.id.as_str(), row)).collect();
    let mut drift = Vec::new();
    for migration in FRAMEWORK_MIGRATIONS.iter() {
        let Some(recorded) = applied_by_id.get(migration.id.as_str()) else {
            continue;
        };
        let current = compute_migration_checksum(migration);
        if recorded.checksum != current {
            drift.push(json!({
                "id": migration.id,
                "recorded": recorded.checksum,
                "current": current,
            }));
        }
    }
    let pending: Vec<_> = FRAMEWORK_MIGRATIONS
        .iter()
        .filter(|m| !applied_by_id.contains_key(m.id.as_str()))
        .map(|m| m.id.clone())
        .collect();
    let detail = json!({
        "appliedCount": applied.len(),
        "expectedCount": FRAMEWORK_MIGRATIONS.len(),
        "pending": pending,
        "drift": drift,
    });
    if drift.is_empty() {
        Check::ok(detail)
    } else {
        Check::err_with(format!("checksum_drift:{}", drift.len()), detail)
    }
}
