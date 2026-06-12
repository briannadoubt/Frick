//! `frick lint [--against <prev-schema.json>]`
//! (ported from `apps/cli/src/commands/lint.ts`).
//!
//! Without `--against`: `lint_schema(foundation)`. With `--against <path>`:
//! read the previous schema JSON and `lint_schema_change(current, previous)`.
//! Each finding is emitted as its own JSON line, followed by a summary record
//! `{ok, findings, breaking}`. Exit 1 iff `breaking > 0`.

use std::fs;

use frick_protocol::foundation_schema;
use frick_protocol::schema::FrickSchema;
use frick_schema::{FrickLintResult, lint_schema, lint_schema_change};
use serde_json::json;

use crate::argv::ParsedArgs;
use crate::errors::{CliError, EXIT_FAILURE, EXIT_OK};
use crate::output::Output;

/// `lintCommand`.
pub fn lint_command(parsed: &ParsedArgs, out: &mut Output) -> Result<i32, CliError> {
    match parsed.flag_str("against") {
        None => Ok(lint_current(out)),
        Some(path) => lint_change(path, out),
    }
}

fn lint_current(out: &mut Output) -> i32 {
    let result = lint_schema(&foundation_schema());
    emit_result(&result, out);
    exit_for(&result)
}

fn lint_change(against_path: &str, out: &mut Output) -> Result<i32, CliError> {
    let raw = fs::read_to_string(against_path).map_err(|err| {
        CliError::failure(
            "lint.previous_unreadable",
            format!("Could not read previous schema from {against_path}: {err}"),
        )
    })?;
    let previous: FrickSchema = serde_json::from_str(&raw).map_err(|err| {
        CliError::failure(
            "lint.previous_unreadable",
            format!("Could not read previous schema from {against_path}: {err}"),
        )
    })?;
    let result = lint_schema_change(&foundation_schema(), &previous);
    emit_result(&result, out);
    Ok(exit_for(&result))
}

fn emit_result(result: &FrickLintResult, out: &mut Output) {
    for finding in &result.findings {
        out.emit(&serde_json::to_value(finding).expect("finding is serializable"));
    }
    out.emit(&json!({
        "ok": result.breaking_count == 0,
        "findings": result.findings.len(),
        "breaking": result.breaking_count,
    }));
}

fn exit_for(result: &FrickLintResult) -> i32 {
    if result.breaking_count > 0 {
        EXIT_FAILURE
    } else {
        EXIT_OK
    }
}
