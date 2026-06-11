//! `frick inspect server|db|jobs|diagnostics`
//! (ported from `apps/cli/src/commands/inspect.ts`).
//!
//! Mirrors the `/_frick/inspect/*` routes but driven from the local DB. No HTTP.
//!
//! `diagnostics` drives the clock-free `frick_server::assemble_diagnostics_snapshot`
//! over the local DB (the same assembler the `/_frick/inspect/diagnostics` route
//! uses). The CLI is the time boundary: it stamps `snapshotAt` from the wall
//! clock and feeds the stores, which stay clock-free. Cursor-probe validation
//! still happens first so a malformed probe returns the usage error (exit 2) the
//! test suite asserts.

use std::time::{SystemTime, UNIX_EPOCH};

use frick_server::standalone::{config_env, load_schema};
use frick_server::{AssembleDiagnosticsOptions, DiagnosticsCursorProbe};
use frick_store::facade::DEFAULT_IDEMPOTENCY_CACHE_CAPACITY;
use serde_json::json;

use crate::argv::ParsedArgs;
use crate::context::{context_flags_from, load_config, open_store};
use crate::errors::{CliError, EXIT_OK};
use crate::output::Output;

/// `inspectCommand`.
pub async fn inspect_command(parsed: &ParsedArgs, out: &mut Output<'_>) -> Result<i32, CliError> {
    match parsed.positional(0) {
        Some("server") => inspect_server(parsed, out).await,
        Some("db") => inspect_db(parsed, out).await,
        Some("jobs") => inspect_jobs(parsed, out).await,
        Some("diagnostics") => inspect_diagnostics(parsed, out).await,
        other => Err(CliError::usage_with(
            format!(
                "Unknown inspect subcommand: {}",
                other.unwrap_or("<missing>")
            ),
            json!({ "expected": ["server", "db", "jobs", "diagnostics"] }),
        )),
    }
}

async fn inspect_server(parsed: &ParsedArgs, out: &mut Output<'_>) -> Result<i32, CliError> {
    let config = load_config(&context_flags_from(parsed))?;
    let store = open_store(&config).await?;
    let schema = store.schema();
    out.emit(&json!({
        "schemaId": schema.schema_id,
        "schemaVersion": schema.schema_version,
        "schemaRevision": schema.schema_revision,
        "schemaHash": schema.hash,
        "env": config.env.as_str(),
        "demoAuthEnabled": config.demo_auth_enabled,
        "inspectionEnabled": config.inspection_enabled,
        "dbPath": config.db_path,
    }));
    Ok(EXIT_OK)
}

async fn inspect_db(parsed: &ParsedArgs, out: &mut Output<'_>) -> Result<i32, CliError> {
    let config = load_config(&context_flags_from(parsed))?;
    let store = open_store(&config).await?;
    let applied = store
        .list_applied_migrations()
        .await
        .map_err(|err| CliError::failure("cli.store", err.to_string()))?;
    let ready = store.ping_database().await;
    let key_rows = store
        .idempotency_key_row_count()
        .await
        .map_err(|err| CliError::failure("cli.store", err.to_string()))?;

    let mut record = serde_json::Map::new();
    record.insert("ready".to_string(), json!(ready));
    record.insert("applied".to_string(), json!(applied.len()));
    if let Some(last) = applied.last() {
        record.insert(
            "lastApplied".to_string(),
            json!({
                "id": last.id,
                "schemaRevision": last.schema_revision,
                "appliedAt": last.applied_at,
            }),
        );
    }
    // The freshly-opened, read-only CLI store performs no appends, so the
    // in-process idempotency front-cache is empty (size 0, no evictions). The
    // store does not expose live cache stats; capacity is the configured
    // default. See openIssues.
    record.insert(
        "idempotencyCache".to_string(),
        json!({
            "size": 0,
            "capacity": DEFAULT_IDEMPOTENCY_CACHE_CAPACITY,
            "evictions": 0,
        }),
    );
    record.insert("idempotencyKeyRows".to_string(), json!(key_rows));
    out.emit(&serde_json::Value::Object(record));
    Ok(EXIT_OK)
}

/// Jobs operator surface is not wired (no `countsByStatus`); emit the graceful
/// "unavailable" record and exit 0, exactly like the TS duck-type path.
async fn inspect_jobs(parsed: &ParsedArgs, out: &mut Output<'_>) -> Result<i32, CliError> {
    let config = load_config(&context_flags_from(parsed))?;
    let _store = open_store(&config).await?;
    out.emit(&json!({
        "available": false,
        "reason": "jobs framework not detected",
    }));
    Ok(EXIT_OK)
}

async fn inspect_diagnostics(parsed: &ParsedArgs, out: &mut Output<'_>) -> Result<i32, CliError> {
    let config = load_config(&context_flags_from(parsed))?;
    let store = open_store(&config).await?;

    // Validate cursor probes first so a malformed probe is a usage error (the
    // TS contract: `stream:streamId`).
    let tenant_id = parsed.flag_str("tenant-id").map(ToString::to_string);
    let mut cursors: Vec<DiagnosticsCursorProbe> = Vec::new();
    for positional in parsed.positionals.iter().skip(1) {
        let sep = positional.find(':');
        let valid = match sep {
            Some(idx) => idx > 0 && idx != positional.len() - 1,
            None => false,
        };
        let Some(idx) = sep.filter(|_| valid) else {
            return Err(CliError::usage(format!(
                "Invalid cursor probe \"{positional}\" — expected stream:streamId"
            )));
        };
        cursors.push(DiagnosticsCursorProbe {
            tenant_id: tenant_id.clone(),
            stream: positional[..idx].to_string(),
            stream_id: positional[idx + 1..].to_string(),
        });
    }

    // Resolve the active schema the same way `schema export` does
    // (`FRICK_SCHEMA_PATH`-aware), so the CLI and standalone server agree.
    let schema =
        load_schema(&config_env()).map_err(|err| CliError::failure("schema.invalid", err))?;

    let opts = AssembleDiagnosticsOptions {
        source: Some("cli".to_string()),
        env: Some(config.env.as_str().to_string()),
        cursors,
        snapshot_at: now_iso(),
        include_capabilities: false,
        ..AssembleDiagnosticsOptions::default()
    };

    let snapshot = frick_server::assemble_diagnostics_snapshot(&store, &schema, &opts).await;
    out.emit(&snapshot);
    Ok(EXIT_OK)
}

/// Current wall-clock instant as an ISO-8601 UTC millisecond string. The CLI is
/// the time boundary: the clock-free assembler receives this as `snapshotAt`.
fn now_iso() -> String {
    let total_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    frick_server::boot::iso_from_epoch_ms(total_ms)
}
