//! `frick deploy [image] [--profile compose|lightweight] [--dry-run]`
//! (ported from `apps/cli/src/commands/deploy.ts`).
//!
//! Emits the exact plan JSON from the TS. DEVIATION: actually running
//! `docker compose` / `docker build` / `docker push` is not wired — non-dry-run
//! invocations emit the plan with `started`/`built`/`pushed: false`. See
//! openIssues.

use serde_json::{Value, json};

use crate::argv::{FlagValue, ParsedArgs};
use crate::errors::{CliError, EXIT_OK};
use crate::output::Output;
use crate::paths::{relative_repo_path, resolve_input_path, resolve_repo_path};

const COMPOSE_BROKERS: &str = "redpanda:9092";
const COMPOSE_OTLP_ENDPOINT: &str = "http://otel-collector:4318";
const DEFAULT_SERVER_IMAGE: &str = "frick-server:latest";

/// `deployCommand`.
pub fn deploy_command(parsed: &ParsedArgs, out: &mut Output) -> Result<i32, CliError> {
    match parsed.positional(0) {
        Some("image") => {
            if parsed.positionals.len() > 1 {
                return Err(CliError::usage(
                    "deploy image does not accept extra positional arguments",
                ));
            }
            deploy_image_command(parsed, out)
        }
        Some(action) => Err(CliError::usage(format!("Unknown deploy action: {action}"))),
        None => {
            let profile = parse_profile(parsed.flag_str("profile").unwrap_or("compose"))?;
            let dry_run = parsed.flag_truthy("dry-run");
            let plan = create_deploy_plan(profile, dry_run);
            // Non-dry-run docker compose is not wired; emit the plan unchanged.
            out.emit(&plan);
            Ok(EXIT_OK)
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DeployProfile {
    Compose,
    Lightweight,
}

fn parse_profile(value: &str) -> Result<DeployProfile, CliError> {
    match value {
        "compose" => Ok(DeployProfile::Compose),
        "lightweight" => Ok(DeployProfile::Lightweight),
        other => Err(CliError::usage(format!(
            "--profile must be one of compose, lightweight, got {}",
            serde_json::to_string(other).unwrap_or_else(|_| format!("\"{other}\""))
        ))),
    }
}

fn create_deploy_plan(profile: DeployProfile, dry_run: bool) -> Value {
    match profile {
        DeployProfile::Lightweight => {
            let compose_file = resolve_repo_path("ops/deploy/lightweight.compose.yaml");
            json!({
                "ok": true,
                "command": "deploy",
                "profile": "lightweight",
                "dryRun": dry_run,
                "started": false,
                "composeFiles": [compose_file],
                "env": {
                    "FRICK_ENV": "production",
                    "FRICK_HOST": "0.0.0.0",
                    "FRICK_PORT": "4099",
                    "FRICK_DB_PATH": "/var/lib/frick/frick.sqlite",
                    "FRICK_PLATFORM_EVENTS_DRIVER": "sqlite",
                    "FRICK_OTEL_ENABLED": "false",
                },
                "services": ["frick-server"],
                "steps": [
                    "set FRICK_SERVER_IMAGE to a built Frick app/runtime image",
                    "docker compose -f ops/deploy/lightweight.compose.yaml up -d --wait",
                ],
            })
        }
        DeployProfile::Compose => {
            let compose_file = resolve_repo_path("ops/deploy/compose.yaml");
            json!({
                "ok": true,
                "command": "deploy",
                "profile": "compose",
                "dryRun": dry_run,
                "started": false,
                "composeFiles": [compose_file],
                "env": {
                    "FRICK_ENV": "production",
                    "FRICK_HOST": "0.0.0.0",
                    "FRICK_PORT": "4099",
                    "FRICK_DB_PATH": "/var/lib/frick/frick.sqlite",
                    "FRICK_PLATFORM_EVENTS_DRIVER": "kafka",
                    "FRICK_PLATFORM_EVENTS_KAFKA_BROKERS": COMPOSE_BROKERS,
                    "FRICK_PLATFORM_EVENTS_TOPIC": "frick.platform.events",
                    "FRICK_OTEL_ENABLED": "true",
                    "FRICK_OTEL_EXPORTER_OTLP_ENDPOINT": COMPOSE_OTLP_ENDPOINT,
                    "FRICK_OTEL_SERVICE_NAME": "frick-server",
                },
                "services": ["frick-server", "redpanda", "otel-collector"],
                "steps": [
                    "set FRICK_SERVER_IMAGE to a built Frick app/runtime image",
                    "set FRICK_ADMIN_TOKEN to enable production dashboard/admin APIs",
                    "docker compose -f ops/deploy/compose.yaml up -d --wait",
                ],
            })
        }
    }
}

fn deploy_image_command(parsed: &ParsedArgs, out: &mut Output) -> Result<i32, CliError> {
    let dry_run = parsed.flag_truthy("dry-run");
    let tag = match optional_string_flag(parsed, "tag")? {
        Some(value) => validate_image_tag(&value)?,
        None => DEFAULT_SERVER_IMAGE.to_string(),
    };
    let dockerfile_input = optional_string_flag(parsed, "dockerfile")?;
    let context_input = optional_string_flag(parsed, "context")?;
    let push = parsed.flag_truthy("push");

    let dockerfile = match dockerfile_input {
        None => resolve_repo_path("ops/deploy/server.Dockerfile"),
        Some(value) => resolve_input_path(&value),
    };
    let context = match context_input {
        None => resolve_repo_path("."),
        Some(value) => resolve_input_path(&value),
    };

    let mut steps = vec![format!(
        "docker build -f {} -t {} {}",
        relative_repo_path(&dockerfile),
        tag,
        relative_repo_path(&context)
    )];
    if push {
        steps.push(format!("docker push {tag}"));
    }
    steps.push(format!(
        "FRICK_SERVER_IMAGE={tag} frick deploy --profile compose"
    ));

    let plan = json!({
        "ok": true,
        "command": "deploy",
        "action": "image",
        "dryRun": dry_run,
        "built": false,
        "pushed": false,
        "push": push,
        "tag": tag,
        "dockerfile": dockerfile,
        "context": context,
        "steps": steps,
    });
    // Non-dry-run docker build/push is not wired; emit the plan unchanged.
    out.emit(&plan);
    Ok(EXIT_OK)
}

/// `validate_image_tag` — trim and reject empty.
fn validate_image_tag(value: &str) -> Result<String, CliError> {
    let tag = value.trim().to_string();
    if tag.is_empty() {
        return Err(CliError::usage("--tag must not be empty"));
    }
    Ok(tag)
}

/// `optionalStringFlag` — a present flag must carry a non-empty value
/// (`--tag --dry-run` ⇒ usage error).
fn optional_string_flag(parsed: &ParsedArgs, key: &str) -> Result<Option<String>, CliError> {
    match parsed.flags.get(key) {
        None => Ok(None),
        Some(FlagValue::Bool(_)) => Err(CliError::usage(format!("--{key} requires a value"))),
        Some(FlagValue::Str(value)) => {
            if value.trim().is_empty() {
                Err(CliError::usage(format!("--{key} must not be empty")))
            } else {
                Ok(Some(value.clone()))
            }
        }
    }
}
