//! `frick reset --dev` (ported from `apps/cli/src/commands/reset.ts`).
//!
//! Refuses (exit 3) unless `--dev` is passed AND `env == development`. Probes
//! each framework table to build `tablesDropped`, then drops them.
//!
//! DEVIATION: the TS calls `resetFrickDatabase` (`apps/server/src/storage/
//! reset.ts`), which has no Rust crate counterpart yet. The drop is
//! reimplemented inline here against the same `FRAMEWORK_TABLES` list, matching
//! the TS drop semantics (single transaction, FK enforcement off — `SqlDriver`
//! already opens SQLite with `foreign_keys = OFF`).

use std::fmt::Write as _;

use frick_store::SqlDriver;
use frick_store::driver::SqlValue;
use serde_json::json;

use crate::argv::ParsedArgs;
use crate::context::{context_flags_from, load_config};
use crate::errors::{CliError, EXIT_OK};
use crate::output::Output;

/// The framework-managed tables, byte-identical to the TS `FRAMEWORK_TABLES`
/// (`apps/server/src/storage/migrations.ts:1086`).
const FRAMEWORK_TABLES: &[&str] = &[
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
    "search_index_fts",
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
    "auth_saml_seen_assertions",
];

/// `resetCommand`.
pub async fn reset_command(parsed: &ParsedArgs, out: &mut Output<'_>) -> Result<i32, CliError> {
    let config = load_config(&context_flags_from(parsed))?;
    if !parsed.flag_bool_present("dev") {
        return Err(CliError::refused_with(
            "`frick reset` requires --dev (development-only)",
            json!({ "env": config.env.as_str() }),
        ));
    }
    if config.env.as_str() != "development" {
        return Err(CliError::refused_with(
            format!(
                "Refusing to reset: env is '{}', expected 'development'",
                config.env.as_str()
            ),
            json!({ "env": config.env.as_str(), "dbPath": config.db_path }),
        ));
    }

    let driver = SqlDriver::open_sqlite(&config.db_path)
        .map_err(|err| CliError::failure("cli.store", err.to_string()))?;

    let mut tables_dropped: Vec<&str> = Vec::new();
    for table in FRAMEWORK_TABLES {
        let probe = format!("SELECT 1 FROM {table} LIMIT 1");
        if driver.get(&probe, &[] as &[SqlValue]).await.is_ok() {
            tables_dropped.push(table);
        }
    }

    let mut drop_sql = String::from("BEGIN IMMEDIATE;\nPRAGMA foreign_keys = OFF;\n");
    for table in FRAMEWORK_TABLES {
        let _ = writeln!(drop_sql, "DROP TABLE IF EXISTS {table};");
    }
    drop_sql.push_str("COMMIT;\n");
    driver
        .exec(&drop_sql)
        .await
        .map_err(|err| CliError::failure("cli.reset", err.to_string()))?;

    out.emit(&json!({
        "ok": true,
        "dbPath": config.db_path,
        "env": config.env.as_str(),
        "tablesDropped": tables_dropped,
    }));
    driver.close().await;
    Ok(EXIT_OK)
}
