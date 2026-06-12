//! `frick dev [--profile sqlite|redpanda] [--dry-run]`
//! (ported from `apps/cli/src/commands/dev.ts`).
//!
//! The sqlite profile and `--dry-run` emit the plan with `started: false`. The
//! plan JSON is byte-for-byte the TS plan. DEVIATION: actually spawning
//! `docker compose` for a live redpanda profile is not wired — a non-dry-run
//! redpanda invocation emits the plan with `started: false` and notes it (the
//! task marks docker spawning optional). See openIssues.

use serde_json::{Value, json};

use crate::argv::ParsedArgs;
use crate::errors::{CliError, EXIT_OK};
use crate::output::Output;
use crate::paths::resolve_repo_path;

const DEFAULT_BROKERS: &str = "127.0.0.1:19092";
const DEFAULT_OTLP_ENDPOINT: &str = "http://127.0.0.1:4318";

/// `devCommand`.
pub fn dev_command(parsed: &ParsedArgs, out: &mut Output) -> Result<i32, CliError> {
    let profile = parse_profile(parsed.flag_str("profile").unwrap_or("sqlite"))?;
    let plan = create_dev_plan(profile);
    // Both the sqlite profile and `--dry-run` short-circuit to plan-only.
    out.emit(&plan);
    Ok(EXIT_OK)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DevProfile {
    Sqlite,
    Redpanda,
}

fn parse_profile(value: &str) -> Result<DevProfile, CliError> {
    match value {
        "sqlite" => Ok(DevProfile::Sqlite),
        "redpanda" => Ok(DevProfile::Redpanda),
        other => Err(CliError::usage(format!(
            "--profile must be one of sqlite, redpanda, got {}",
            serde_json::to_string(other).unwrap_or_else(|_| format!("\"{other}\""))
        ))),
    }
}

fn create_dev_plan(profile: DevProfile) -> Value {
    match profile {
        DevProfile::Sqlite => json!({
            "ok": true,
            "command": "dev",
            "profile": "sqlite",
            "started": false,
            "env": { "FRICK_PLATFORM_EVENTS_DRIVER": "sqlite" },
            "steps": ["pnpm server", "pnpm web", "pnpm cli dashboard"],
        }),
        DevProfile::Redpanda => {
            let compose_file = resolve_repo_path("ops/local/redpanda.compose.yaml");
            json!({
                "ok": true,
                "command": "dev",
                "profile": "redpanda",
                "started": false,
                "composeFile": compose_file,
                "env": {
                    "FRICK_PLATFORM_EVENTS_DRIVER": "kafka",
                    "FRICK_PLATFORM_EVENTS_KAFKA_BROKERS": DEFAULT_BROKERS,
                    "FRICK_PLATFORM_EVENTS_TOPIC": "frick.platform.events",
                    "FRICK_OTEL_ENABLED": "true",
                    "FRICK_OTEL_EXPORTER_OTLP_ENDPOINT": DEFAULT_OTLP_ENDPOINT,
                    "FRICK_OTEL_SERVICE_NAME": "frick-server",
                    "FRICK_TEST_KAFKA_BROKERS": DEFAULT_BROKERS,
                },
                "steps": [
                    "docker compose up -d --wait redpanda otel-collector",
                    format!(
                        "FRICK_PLATFORM_EVENTS_KAFKA_BROKERS={DEFAULT_BROKERS} FRICK_OTEL_ENABLED=true FRICK_OTEL_EXPORTER_OTLP_ENDPOINT={DEFAULT_OTLP_ENDPOINT} pnpm server"
                    ),
                    "pnpm web",
                    "pnpm cli dashboard",
                    format!(
                        "FRICK_TEST_KAFKA_BROKERS={DEFAULT_BROKERS} pnpm --filter @fricken/server exec vitest run tests/platform-events-kafka.test.ts"
                    ),
                ],
            })
        }
    }
}
