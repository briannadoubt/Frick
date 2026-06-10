//! `frick init <directory>` (ported from `apps/cli/src/commands/init.ts`).
//!
//! Scaffolds the TS-template project (`package.json`, `tsconfig.json`,
//! `frick.config.json`, `src/schema.ts`, `src/server.ts`,
//! `tests/smoke.test.ts`). Refuses (exit 3) to overwrite any existing file.
//!
//! DEVIATIONS:
//!  - `pnpm install` is never spawned (the Rust CLI has no pnpm dependency); we
//!    treat `--install` as a no-op and report it. `--no-install` reports
//!    `{skipped: true}` exactly like the TS.
//!  - `--agents` agent-kit installation is unported (no Rust `@fricken/agent-kit`
//!    counterpart) — passing `--agents` yields a `cli.unsupported` failure. See
//!    openIssues.
//!  - Rust-app scaffolding is a follow-up; the TS template is ported verbatim
//!    for parity.

use std::fs;
use std::path::{Path, PathBuf};

use frick_protocol::schema::FrickSchema;
use frick_protocol::validate_schema;
use serde_json::{Value, json};

use crate::argv::{FlagValue, ParsedArgs};
use crate::errors::{CliError, EXIT_FAILURE, EXIT_OK};
use crate::mcp_config::{McpClientOptions, create_mcp_client_config};
use crate::output::Output;
use crate::templates::{
    TemplateVariables, render_frick_config_json, render_package_json, render_schema_ts,
    render_server_ts, render_smoke_test_ts, render_tsconfig_json,
};

#[allow(clippy::struct_excessive_bools)]
struct InitOptions {
    directory: PathBuf,
    app_name: String,
    port: u32,
    version: String,
    install: bool,
    skip_schema_check: bool,
    agents: bool,
    mcp: bool,
}

fn read_options(parsed: &ParsedArgs) -> Result<InitOptions, CliError> {
    let Some(directory) = parsed.positional(0) else {
        return Err(CliError::usage_with(
            "frick init requires a target <directory>",
            json!({
                "usage": "frick init <directory> [--name <name>] [--port <port>] [--version <ver>] [--no-install] [--agents all|codex,claude,cursor] [--mcp]"
            }),
        ));
    };
    let resolved = resolve_dir(directory);

    let app_name = match parsed.flag_str("name") {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => resolved
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
    };

    let mut port: u32 = 4099;
    if let Some(port_flag) = parsed.flag_str("port") {
        match port_flag.parse::<u16>() {
            Ok(value) => port = u32::from(value),
            _ => {
                return Err(CliError::usage(format!(
                    "--port must be an integer in [0, 65535], got {port_flag}"
                )));
            }
        }
    }

    let version = match parsed.flag_str("version") {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => "0.1.0".to_string(),
    };

    // `--no-install` (bool) or `--install=false` ⇒ skip install.
    let no_install = parsed.flag_bool_present("no-install");
    let install_false = matches!(parsed.flags.get("install"), Some(FlagValue::Bool(false)))
        || parsed.flag_str("install") == Some("false");
    let install = !(no_install || install_false);

    let skip_schema_check = parsed.flag_bool_present("skip-schema-check");
    let agents = agents_requested(parsed.flags.get("agents"));
    let mcp = parsed.flag_bool_present("mcp") || parsed.flag_str("mcp") == Some("true");

    Ok(InitOptions {
        directory: resolved,
        app_name,
        port,
        version,
        install,
        skip_schema_check,
        agents,
        mcp,
    })
}

fn resolve_dir(directory: &str) -> PathBuf {
    let path = Path::new(directory);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

/// Whether `--agents` requests any harness (mirrors `parseAgentsFlag`'s
/// non-`undefined` result).
fn agents_requested(flag: Option<&FlagValue>) -> bool {
    match flag {
        None => false,
        Some(FlagValue::Bool(value)) => *value,
        Some(FlagValue::Str(value)) => !matches!(value.as_str(), "false" | "none"),
    }
}

fn write_file_fresh(path: &Path, body: &str, created: &mut Vec<String>) -> Result<(), CliError> {
    if path.exists() {
        return Err(CliError::refused_with(
            format!("Refusing to overwrite existing file: {}", path.display()),
            json!({ "path": path.to_string_lossy() }),
        ));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| CliError::failure("cli.io", format!("mkdir failed: {err}")))?;
    }
    fs::write(path, body)
        .map_err(|err| CliError::failure("cli.io", format!("write failed: {err}")))?;
    created.push(path.to_string_lossy().into_owned());
    Ok(())
}

fn schema_check_in_process(app_name: &str) -> (bool, Option<String>) {
    let schema = FrickSchema {
        name: app_name.to_string(),
        schema_id: app_name.to_string(),
        schema_version: "0.1.0".to_string(),
        schema_revision: 1,
        minimum_client_revision: 1,
        minimum_server_revision: 1,
        protocol: "frick.realtime".to_string(),
        protocol_version: 1,
        compatibility: "greenfield-cutover".to_string(),
        hash: "scaffold".to_string(),
        objects: Vec::new(),
        streams: Vec::new(),
        events: Vec::new(),
        presences: Vec::new(),
        signals: Vec::new(),
        blobs: Vec::new(),
        jobs: Vec::new(),
        projections: Vec::new(),
    };
    match validate_schema(&schema) {
        Ok(()) => (true, None),
        Err(err) => (false, Some(err.to_string())),
    }
}

/// `initCommand`.
pub fn init_command(parsed: &ParsedArgs, out: &mut Output) -> Result<i32, CliError> {
    let opts = read_options(parsed)?;
    if opts.agents {
        return Err(CliError::failure(
            "cli.unsupported",
            "frick init --agents (agent-kit installation) is not yet available in the Rust CLI \
             (no Rust @fricken/agent-kit counterpart)",
        ));
    }

    let vars = TemplateVariables {
        app_name: opts.app_name.clone(),
        port: opts.port,
        version: opts.version.clone(),
    };
    let mut created: Vec<String> = Vec::new();

    let dir = &opts.directory;
    write_file_fresh(
        &dir.join("package.json"),
        &render_package_json(&vars),
        &mut created,
    )?;
    write_file_fresh(
        &dir.join("tsconfig.json"),
        &render_tsconfig_json(&vars),
        &mut created,
    )?;
    write_file_fresh(
        &dir.join("frick.config.json"),
        &render_frick_config_json(&vars),
        &mut created,
    )?;
    write_file_fresh(
        &dir.join("src").join("schema.ts"),
        &render_schema_ts(&vars),
        &mut created,
    )?;
    write_file_fresh(
        &dir.join("src").join("server.ts"),
        &render_server_ts(&vars),
        &mut created,
    )?;
    write_file_fresh(
        &dir.join("tests").join("smoke.test.ts"),
        &render_smoke_test_ts(&vars),
        &mut created,
    )?;

    let (schema_ok, schema_error) = if opts.skip_schema_check {
        (true, None)
    } else {
        schema_check_in_process(&opts.app_name)
    };

    let mcp_config: Option<Value> = if opts.mcp {
        Some(create_mcp_client_config(&McpClientOptions {
            endpoint: format!("http://127.0.0.1:{}", opts.port),
            ..McpClientOptions::default()
        }))
    } else {
        None
    };

    // `--install` would run `pnpm install` in TS; the Rust CLI does not shell
    // out to pnpm. Report the same `{skipped}` shape either way.
    let install_record = if opts.install {
        json!({ "skipped": true, "reason": "pnpm install not run by the Rust CLI" })
    } else {
        json!({ "skipped": true })
    };

    let schema_record = if opts.skip_schema_check {
        json!({ "ok": true, "skipped": true })
    } else if schema_ok {
        json!({ "ok": true, "schemaId": opts.app_name, "schemaHash": "scaffold" })
    } else {
        json!({ "ok": false, "error": schema_error })
    };

    let ok = schema_ok;
    let mut record = serde_json::Map::new();
    record.insert("ok".to_string(), json!(ok));
    record.insert(
        "directory".to_string(),
        json!(opts.directory.to_string_lossy()),
    );
    record.insert("appName".to_string(), json!(opts.app_name));
    record.insert("port".to_string(), json!(opts.port));
    record.insert("version".to_string(), json!(opts.version));
    record.insert("created".to_string(), json!(created));
    if let Some(mcp) = mcp_config {
        record.insert("mcp".to_string(), mcp);
    }
    record.insert("install".to_string(), install_record);
    record.insert("schemaCheck".to_string(), schema_record);
    out.emit(&Value::Object(record));

    Ok(if ok { EXIT_OK } else { EXIT_FAILURE })
}
