//! `frick inspect server|db|jobs|diagnostics`
//! (ported from `apps/cli/src/commands/inspect.ts`).
//!
//! Mirrors the `/_frick/inspect/*` routes but driven from the local DB. No HTTP.
//!
//! `diagnostics` depends on the TS `assembleDiagnosticsSnapshot`, which has no
//! Rust counterpart yet (FR-76/FR-77 not ported). It is stubbed with a clear
//! `cli.unsupported` failure — see openIssues. Cursor-probe validation still
//! happens first so a malformed probe returns the usage error (exit 2) the test
//! suite asserts.

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
    let _store = open_store(&config).await?;
    // Validate cursor probes first so a malformed probe is a usage error (the
    // TS contract: `stream:streamId`).
    for positional in parsed.positionals.iter().skip(1) {
        let sep = positional.find(':');
        let valid = match sep {
            Some(idx) => idx > 0 && idx != positional.len() - 1,
            None => false,
        };
        if !valid {
            return Err(CliError::usage(format!(
                "Invalid cursor probe \"{positional}\" — expected stream:streamId"
            )));
        }
    }
    let _ = out;
    Err(CliError::failure(
        "cli.unsupported",
        "frick inspect diagnostics is not yet available in the Rust CLI \
         (assembleDiagnosticsSnapshot is unported — FR-76/FR-77)",
    ))
}
