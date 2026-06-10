//! `frick schema check|generate` (ported from `apps/cli/src/commands/schema.ts`).
//!
//! - `check`: `validate_schema(foundation_schema())` then emit the identity.
//! - `generate`: the TS shells out to `pnpm schema:generate`. The Rust CLI
//!   instead drives [`frick_codegen`] directly — rendering the native artifacts
//!   in-process (DEVIATION: pnpm→native). It emits `{ok, command, artifacts}`
//!   describing what would be written, without touching the monorepo tree (the
//!   write targets are pnpm-workspace-specific; see openIssues).

use frick_codegen::error_enums::generate_typescript_error_enum;
use frick_codegen::kotlin::{generate_kotlin_artifact, generate_kotlin_error_enum};
use frick_codegen::swift::{generate_swift_artifact, generate_swift_error_enum};
use frick_codegen::typescript::generate_typescript_bindings;
use frick_protocol::{foundation_schema, validate_schema};
use serde_json::json;

use crate::argv::ParsedArgs;
use crate::errors::{CliError, EXIT_OK};
use crate::output::Output;

/// `schemaCommand` — dispatch `check` / `generate`.
pub fn schema_command(parsed: &ParsedArgs, out: &mut Output) -> Result<i32, CliError> {
    match parsed.positional(0) {
        Some("check") => schema_check(out),
        Some("generate") => Ok(schema_generate(out)),
        other => Err(CliError::usage_with(
            format!(
                "Unknown schema subcommand: {}",
                other.unwrap_or("<missing>")
            ),
            json!({ "expected": ["check", "generate"] }),
        )),
    }
}

fn schema_check(out: &mut Output) -> Result<i32, CliError> {
    let schema = foundation_schema();
    validate_schema(&schema).map_err(|err| CliError::failure("schema.invalid", err.to_string()))?;
    out.emit(&json!({
        "ok": true,
        "schemaId": schema.schema_id,
        "schemaVersion": schema.schema_version,
        "schemaRevision": schema.schema_revision,
        "schemaHash": schema.hash,
    }));
    Ok(EXIT_OK)
}

fn schema_generate(out: &mut Output) -> i32 {
    let schema = foundation_schema();
    // Render every native artifact in-process (the Rust equivalent of
    // `pnpm schema:generate`). We report byte counts rather than writing files
    // because the target paths are pnpm-workspace-specific.
    let artifacts = json!([
        { "name": "typescript/bindings.ts", "bytes": generate_typescript_bindings(&schema).len() },
        { "name": "typescript/errors.ts", "bytes": generate_typescript_error_enum().len() },
        { "name": "swift/Generated.swift", "bytes": generate_swift_artifact(&schema).len() },
        { "name": "swift/Errors.swift", "bytes": generate_swift_error_enum().len() },
        { "name": "kotlin/Generated.kt", "bytes": generate_kotlin_artifact(&schema).len() },
        { "name": "kotlin/Errors.kt", "bytes": generate_kotlin_error_enum().len() },
    ]);
    out.emit(&json!({
        "ok": true,
        "command": "frick codegen (native)",
        "artifacts": artifacts,
    }));
    EXIT_OK
}
