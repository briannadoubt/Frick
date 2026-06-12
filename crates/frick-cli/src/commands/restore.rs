//! `frick restore` — restore a framework database from NDJSON (FR-262).
//!
//! Maps `internal/rust-rewrite/maps/08-cli.md` §1.4. Wraps
//! [`frick_store::FrickStore::restore_database_checked`], which validates the
//! dump header (schema-hash drift + migration parity) before inserting any rows.
//! The store is clock-free; the CLI injects the wall-clock bounds (`started_ms`
//! / `finished_ms`) for the report timestamps.
//!
//! Refusal gates (all before touching the store):
//!   - `--input <path>` is REQUIRED (usage error, exit 2, when missing);
//!   - `--confirm yes` is REQUIRED, else `cli.refused` (exit 3) with reason
//!     `missingConfirmation` — mirroring `frick reset`'s refusal shape;
//!   - production configs refuse unless `FRICK_RESTORE_ALLOW_PROD=1` (exit 3).
//!
//! Note the deliberate exit-code asymmetry: a *missing confirm* is a refusal
//! (exit 3), but a restore *refusal from the store* (schema-hash mismatch,
//! non-empty target, …) maps to a `cli.restore.<reason>` failure (exit 1).

use std::time::{SystemTime, UNIX_EPOCH};

use frick_store::{RestoreError, RestoreOptions};
use serde_json::json;

use crate::argv::ParsedArgs;
use crate::context::{context_flags_from, load_config, open_store};
use crate::errors::{CliError, EXIT_OK};
use crate::output::Output;

fn now_ms() -> i64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    i64::try_from(millis).unwrap_or(i64::MAX)
}

/// `restoreCommand`.
pub async fn restore_command(parsed: &ParsedArgs, out: &mut Output<'_>) -> Result<i32, CliError> {
    let Some(input_path) = parsed.flag_str("input") else {
        return Err(CliError::usage(
            "frick restore requires --input <path> (the NDJSON dump to restore)",
        ));
    };

    let config = load_config(&context_flags_from(parsed))?;

    // Refuse (exit 3) unless `--confirm yes` was passed.
    if parsed.flag_str("confirm") != Some("yes") {
        return Err(CliError::refused_with(
            "`frick restore` requires --confirm yes (destructive operation)",
            json!({ "reason": "missingConfirmation", "dbPath": config.db_path }),
        ));
    }

    // Refuse (exit 3) against a production-mode config unless explicitly allowed.
    if config.env.is_production() && std::env::var("FRICK_RESTORE_ALLOW_PROD").as_deref() != Ok("1")
    {
        return Err(CliError::refused_with(
            "Refusing to restore against a production-mode config without \
             FRICK_RESTORE_ALLOW_PROD=1",
            json!({ "env": config.env.as_str(), "dbPath": config.db_path }),
        ));
    }

    let contents = std::fs::read_to_string(input_path).map_err(|err| {
        CliError::failure(
            "cli.restore",
            format!("failed to read dump from \"{input_path}\": {err}"),
        )
    })?;
    let lines: Vec<String> = contents.lines().map(ToString::to_string).collect();

    let options = RestoreOptions {
        confirm: true,
        overwrite: parsed.flag_truthy("overwrite"),
        force_schema_drift: parsed.flag_truthy("force-schema-drift"),
    };

    let store = open_store(&config).await?;
    let started_ms = now_ms();
    let report = store
        .restore_database_checked(lines, options, started_ms, now_ms())
        .await
        .map_err(|err| match err {
            // Deliberate asymmetry: a store-side refusal is a failure (exit 1)
            // tagged with the structured reason, not a `cli.refused` (exit 3).
            RestoreError::Refused(refusal) => CliError::failure(
                format!("cli.restore.{}", refusal.reason()),
                refusal.message(),
            ),
            RestoreError::Store(store) => CliError::failure("cli.restore", store.to_string()),
        })?;

    // `RestoreReport` does not derive `Serialize`; build the wire shape by hand.
    let row_counts: serde_json::Map<String, serde_json::Value> = report
        .row_counts_by_type
        .iter()
        .map(|(k, v)| (k.clone(), json!(v)))
        .collect();
    let skipped: Vec<serde_json::Value> = report
        .skipped
        .iter()
        .map(|row| {
            json!({
                "type": row.r#type,
                "reason": row.reason,
                "line": row.line,
            })
        })
        .collect();
    out.emit(&json!({
        "ok": true,
        "dbPath": config.db_path,
        "rowCounts": serde_json::Value::Object(row_counts),
        "skipped": skipped,
        "schemaCompatibility": {
            "sourceHash": report.schema_compatibility.source_hash,
            "targetHash": report.schema_compatibility.target_hash,
            "matched": report.schema_compatibility.matched,
        },
        "startedAt": report.started_at,
        "finishedAt": report.finished_at,
    }));
    Ok(EXIT_OK)
}
