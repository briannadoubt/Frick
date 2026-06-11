//! The `frick` operational CLI (FR-252), ported from `apps/cli`.
//!
//! Output is JSON Lines by default — every command emits exactly one JSON
//! record on stdout. `--pretty` / `--json=pretty` switches to indented JSON.
//! Errors go to stderr as `{ "error": { code, message, details? } }`. Exit
//! codes: 0 ok, 1 failure, 2 usage, 3 framework refused.
//!
//! [`run`] is importable so tests can drive it without spawning a process; it
//! returns the exit code and the binary's `main` maps it to `process::exit`.

pub mod argv;
pub mod commands;
pub mod context;
pub mod errors;
pub mod init_templates;
pub mod mcp_config;
pub mod output;
pub mod paths;
pub mod templates;

use serde_json::{Value, json};

use argv::parse_args;
use errors::{CliError, EXIT_OK, EXIT_USAGE};
use output::{Output, resolve_output_mode};

/// One command's help entry.
struct CommandSpec {
    name: &'static str,
    summary: &'static str,
    subcommands: &'static [&'static str],
}

const COMMANDS: &[CommandSpec] = &[
    CommandSpec {
        name: "schema",
        summary: "Validate, regenerate, or export the schema",
        subcommands: &["check", "generate", "export"],
    },
    CommandSpec {
        name: "lint",
        summary: "Lint the current schema or compare it to a previous snapshot",
        subcommands: &[],
    },
    CommandSpec {
        name: "migrate",
        summary: "Manage framework migrations",
        subcommands: &["status", "up"],
    },
    CommandSpec {
        name: "doctor",
        summary: "Composite health check (schema, db, migrations, config)",
        subcommands: &[],
    },
    CommandSpec {
        name: "inspect",
        summary: "Inspect runtime state from the local DB",
        subcommands: &["server", "db", "jobs", "diagnostics"],
    },
    CommandSpec {
        name: "reset",
        summary: "Drop framework tables (development only, requires --dev)",
        subcommands: &[],
    },
    CommandSpec {
        name: "tenants",
        summary: "Manage the tenants ledger",
        subcommands: &["list", "create", "set-push"],
    },
    CommandSpec {
        name: "verify",
        summary: "Drift-check the generated codegen artifacts against committed snapshots",
        subcommands: &[],
    },
    CommandSpec {
        name: "backup",
        summary: "Stream a framework database dump as NDJSON",
        subcommands: &[],
    },
    CommandSpec {
        name: "restore",
        summary: "Restore a framework database from NDJSON (requires --confirm yes)",
        subcommands: &[],
    },
    CommandSpec {
        name: "dev",
        summary: "Print or start a local Frick runtime profile",
        subcommands: &[],
    },
    CommandSpec {
        name: "deploy",
        summary: "Print, build, or start a standard Frick deployment profile",
        subcommands: &["image"],
    },
    CommandSpec {
        name: "init",
        summary: "Scaffold a new Frick application at the given directory",
        subcommands: &[],
    },
    CommandSpec {
        name: "scaffold",
        summary: "Add an object, stream, or projection stub to a scaffolded app",
        subcommands: &["object", "stream", "projection"],
    },
    CommandSpec {
        name: "dashboard",
        summary: "Serve Fricken Dashboard for a running Frick server",
        subcommands: &[],
    },
    CommandSpec {
        name: "mcp",
        summary: "Run a stdio MCP server for agent access to documented Frick runtime surfaces",
        subcommands: &[],
    },
];

fn help_record() -> Value {
    let commands: Vec<Value> = COMMANDS
        .iter()
        .map(|c| {
            let mut map = serde_json::Map::new();
            map.insert("name".to_string(), json!(c.name));
            map.insert("summary".to_string(), json!(c.summary));
            if !c.subcommands.is_empty() {
                map.insert("subcommands".to_string(), json!(c.subcommands));
            }
            Value::Object(map)
        })
        .collect();
    json!({ "commands": commands })
}

/// Run the CLI against `argv` (the args *after* the program name), writing
/// records to `stdout` and errors to `stderr`. Returns the process exit code.
pub async fn run(
    argv: &[String],
    stdout: &mut dyn std::io::Write,
    stderr: &mut dyn std::io::Write,
) -> i32 {
    let parsed = parse_args(argv);
    let mut out = Output {
        mode: resolve_output_mode(&parsed),
        stdout,
        stderr,
    };

    let command = parsed.positionals.first().cloned();

    // Top-level help: no command, `--help`, or literal `help`.
    let Some(command) = command.filter(|c| c != "help") else {
        out.emit(&help_record());
        return EXIT_OK;
    };
    if parsed.flag_bool_present("help") {
        out.emit(&help_record());
        return EXIT_OK;
    }

    // Re-parse the remainder so each handler sees its subcommand at
    // positionals[0] (TS: argv.slice(indexOf(command) + 1)).
    let child_index = argv.iter().position(|t| t == &command).map_or(0, |i| i + 1);
    let child_args: Vec<String> = argv[child_index.min(argv.len())..].to_vec();
    let child = parse_args(&child_args);

    let result: Result<i32, CliError> = match command.as_str() {
        "schema" => commands::schema::schema_command(&child, &mut out),
        "lint" => commands::lint::lint_command(&child, &mut out),
        "migrate" => commands::migrate::migrate_command(&child, &mut out).await,
        "doctor" => commands::doctor::doctor_command(&child, &mut out).await,
        "inspect" => commands::inspect::inspect_command(&child, &mut out).await,
        "reset" => commands::reset::reset_command(&child, &mut out).await,
        "tenants" => commands::tenants::tenants_command(&child, &mut out).await,
        "dev" => commands::dev::dev_command(&child, &mut out),
        "deploy" => commands::deploy::deploy_command(&child, &mut out),
        "init" => commands::init::init_command(&child, &mut out),
        "scaffold" => commands::scaffold::scaffold_command(&child, &mut out),
        "dashboard" => commands::dashboard::dashboard_command(&child, &mut out).await,
        "mcp" => commands::mcp::mcp_command(&child, &mut out).await,
        "verify" => commands::verify::verify_command(&child, &mut out),
        "backup" => commands::backup::backup_command(&child, &mut out).await,
        "restore" => commands::restore::restore_command(&child, &mut out).await,
        other => Err(unknown_command(other)),
    };

    match result {
        Ok(code) => code,
        Err(error) => {
            out.emit_error(&error);
            error.exit_code
        }
    }
}

/// Unknown command (`cli.unknown_command`, exit 2): the message + `available`
/// list match the TS `index.ts:104-114`.
fn unknown_command(command: &str) -> CliError {
    CliError {
        code: "cli.unknown_command".to_string(),
        message: format!("Unknown command: {command}"),
        details: Some(json!({
            "available": COMMANDS.iter().map(|c| c.name).collect::<Vec<_>>()
        })),
        exit_code: EXIT_USAGE,
    }
}

/// Map an unknown-command result to the usage exit code, for callers that want
/// the constant without inspecting the error.
#[must_use]
pub const fn usage_exit_code() -> i32 {
    EXIT_USAGE
}
