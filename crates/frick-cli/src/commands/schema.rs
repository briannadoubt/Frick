//! `frick schema check|generate|export` (ported from
//! `apps/cli/src/commands/schema.ts`, extended with `export`, FR-261).
//!
//! - `check`: `validate_schema(foundation_schema())` then emit the identity.
//! - `generate`: the TS shells out to `pnpm schema:generate`. The Rust CLI
//!   instead drives [`frick_codegen`] directly — rendering the native artifacts
//!   in-process (DEVIATION: pnpm→native). It emits `{ok, command, artifacts}`
//!   describing what would be written, without touching the monorepo tree (the
//!   write targets are pnpm-workspace-specific; see openIssues).
//! - `export`: serialize the *active* schema (the foundation schema, or the
//!   `FRICK_SCHEMA_PATH`-loaded schema when that env var is set) to pretty JSON.
//!   This is the `schema.json` an app feeds the standalone `frick-server` via
//!   `FRICK_SCHEMA_PATH` — it closes the export gap noted in the `frick init`
//!   README. With `--out` the file is written and a summary record is emitted;
//!   without it, the JSON is printed on stdout.

use frick_codegen::error_enums::generate_typescript_error_enum;
use frick_codegen::kotlin::{generate_kotlin_artifact, generate_kotlin_error_enum};
use frick_codegen::swift::{generate_swift_artifact, generate_swift_error_enum};
use frick_codegen::typescript::generate_typescript_bindings;
use frick_protocol::{FrickSchema, foundation_schema, validate_schema};
use frick_server::standalone::{config_env, load_schema};
use serde_json::json;

use crate::argv::ParsedArgs;
use crate::errors::{CliError, EXIT_OK};
use crate::output::Output;

/// `schemaCommand` — dispatch `check` / `generate` / `export`.
pub fn schema_command(parsed: &ParsedArgs, out: &mut Output) -> Result<i32, CliError> {
    match parsed.positional(0) {
        Some("check") => schema_check(out),
        Some("generate") => Ok(schema_generate(out)),
        Some("export") => schema_export(parsed, out),
        other => Err(CliError::usage_with(
            format!(
                "Unknown schema subcommand: {}",
                other.unwrap_or("<missing>")
            ),
            json!({ "expected": ["check", "generate", "export"] }),
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

/// Resolve the *active* schema the same way the standalone server does: the
/// `FRICK_SCHEMA_PATH`-loaded schema when that env var is set, otherwise the
/// empty foundation schema. Reuses [`frick_server::standalone::load_schema`] so
/// `frick schema export` and the server agree on what "active" means.
fn active_schema() -> Result<FrickSchema, CliError> {
    load_schema(&config_env()).map_err(|err| CliError::failure("schema.invalid", err))
}

fn schema_export(parsed: &ParsedArgs, out: &mut Output) -> Result<i32, CliError> {
    let schema = active_schema()?;
    // Pretty JSON is the on-disk `schema.json` shape: `FrickSchema` serializes
    // camelCase, so the output round-trips back through `load_schema`.
    let json_text = serde_json::to_string_pretty(&schema)
        .map_err(|err| CliError::failure("schema.export.serialize", err.to_string()))?;

    let Some(out_path) = parsed.flag_str("out") else {
        // Without --out, emit the schema JSON itself on stdout (not wrapped in a
        // summary record), so `frick schema export > schema.json` produces a
        // file the server can load directly.
        let _ = writeln!(out.stdout, "{json_text}");
        return Ok(EXIT_OK);
    };

    std::fs::write(out_path, format!("{json_text}\n")).map_err(|err| {
        CliError::failure(
            "schema.export.write",
            format!("failed to write schema to \"{out_path}\": {err}"),
        )
    })?;
    out.emit(&json!({
        "ok": true,
        "out": out_path,
        "schemaId": schema.schema_id,
        "schemaHash": schema.hash,
        "bytes": json_text.len() + 1,
    }));
    Ok(EXIT_OK)
}
