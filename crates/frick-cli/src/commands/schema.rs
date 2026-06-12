//! `frick schema check|generate|export` (ported from
//! `apps/cli/src/commands/schema.ts`, extended with `export`, FR-261).
//!
//! - `check`: `validate_schema(foundation_schema())` then emit the identity.
//! - `generate`: the canonical native-artifact generator (FR-261). This is the
//!   Rust reimplementation of the retired `pnpm schema:generate`
//!   (`packages/protocol/scripts/generate-native-artifacts.ts`): it drives
//!   [`frick_codegen`] against the FOUNDATION schema and WRITES the four tracked
//!   client artifacts to their canonical repo paths, byte-identical to what the
//!   TS script emitted (so regenerating produces a clean `git diff`). It emits
//!   `{ok, command, written}`. The optional Ed25519 `schema-signature.json`
//!   (FR-45) was a no-op without a signing key and only ever wrote a gitignored
//!   file, so it is not reproduced here (see notes/openIssues).
//! - `export`: serialize the *active* schema (the foundation schema, or the
//!   `FRICK_SCHEMA_PATH`-loaded schema when that env var is set) to pretty JSON.
//!   This is the `schema.json` an app feeds the standalone `frick-server` via
//!   `FRICK_SCHEMA_PATH` — it closes the export gap noted in the `frick init`
//!   README. With `--out` the file is written and a summary record is emitted;
//!   without it, the JSON is printed on stdout.

use std::path::PathBuf;

use frick_codegen::error_enums::generate_typescript_error_enum;
use frick_codegen::kotlin::generate_kotlin_artifact;
use frick_codegen::swift::generate_swift_artifact;
use frick_codegen::typescript::generate_typescript_bindings;
use frick_protocol::{FrickSchema, foundation_schema, validate_schema};
use frick_server::standalone::{config_env, load_schema};
use serde_json::json;

use crate::argv::ParsedArgs;
use crate::errors::{CliError, EXIT_OK};
use crate::output::Output;
use crate::paths::repo_root;

/// `schemaCommand` — dispatch `check` / `generate` / `export`.
pub fn schema_command(parsed: &ParsedArgs, out: &mut Output) -> Result<i32, CliError> {
    match parsed.positional(0) {
        Some("check") => schema_check(out),
        Some("generate") => schema_generate(out),
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

/// The four tracked native client artifacts, keyed by their canonical
/// repo-relative path. Each value is the exact byte content the retired
/// `generate-native-artifacts.ts` wrote: `<generator output> + "\n"` for every
/// file (the trailing newline the TS appended uniformly with a template
/// literal). Pinning the same generators + the same trailing-newline rule keeps
/// `frick schema generate` byte-identical to the committed tree.
fn generated_artifacts(schema: &FrickSchema) -> [(&'static str, String); 4] {
    [
        (
            "packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift",
            format!("{}\n", generate_swift_artifact(schema)),
        ),
        (
            "apps/android/frick/src/main/java/dev/frick/client/FrickGenerated.kt",
            format!("{}\n", generate_kotlin_artifact(schema)),
        ),
        (
            "packages/core/src/generated/bindings.ts",
            format!("{}\n", generate_typescript_bindings(schema)),
        ),
        (
            "packages/core/src/generated/errors.ts",
            format!("{}\n", generate_typescript_error_enum()),
        ),
    ]
}

/// `frick schema generate` — the canonical native-artifact generator (FR-261).
/// Writes the four tracked client artifacts to the repo root and emits
/// `{ok, command, written}`.
fn schema_generate(out: &mut Output) -> Result<i32, CliError> {
    write_native_artifacts(&repo_root(), out)
}

/// Render the FOUNDATION schema's native artifacts and write each to
/// `root/<canonical path>`, creating parent directories as needed. Parameterised
/// by `root` so tests can target a temp tree without touching the committed
/// files. Emits the `{ok, command, written:[paths]}` summary.
pub fn write_native_artifacts(root: &std::path::Path, out: &mut Output) -> Result<i32, CliError> {
    let schema = foundation_schema();
    let mut written: Vec<String> = Vec::new();

    for (relative, content) in generated_artifacts(&schema) {
        let path: PathBuf = root.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| {
                CliError::failure(
                    "schema.generate.mkdir",
                    format!("failed to create {}: {err}", parent.display()),
                )
            })?;
        }
        std::fs::write(&path, content).map_err(|err| {
            CliError::failure(
                "schema.generate.write",
                format!("failed to write {}: {err}", path.display()),
            )
        })?;
        written.push(path.to_string_lossy().into_owned());
    }

    out.emit(&json!({
        "ok": true,
        "command": "frick schema generate",
        "written": written,
    }));
    Ok(EXIT_OK)
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
