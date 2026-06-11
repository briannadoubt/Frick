//! Black-box tests for the `frick` CLI — the Rust mirror of
//! `apps/cli/tests/cli.test.ts`. Each test drives [`frick_cli::run`] in-process
//! with captured stdout/stderr buffers and asserts the JSON record + exit code,
//! exactly the contract a downstream automation script would observe.

use base64::Engine as _;
use serde_json::{Value, json};
use tempfile::TempDir;

struct CliResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

async fn run_cli(args: &[&str]) -> CliResult {
    let owned: Vec<String> = args.iter().map(ToString::to_string).collect();
    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let exit_code = frick_cli::run(&owned, &mut stdout, &mut stderr).await;
    CliResult {
        exit_code,
        stdout: String::from_utf8(stdout).expect("utf8 stdout"),
        stderr: String::from_utf8(stderr).expect("utf8 stderr"),
    }
}

fn parse_first_json(text: &str) -> Value {
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .expect("a JSON line");
    serde_json::from_str(line).expect("valid JSON line")
}

fn parse_last_json(text: &str) -> Value {
    let line = text
        .lines()
        .rfind(|l| !l.trim().is_empty())
        .expect("a JSON line");
    serde_json::from_str(line).expect("valid JSON line")
}

fn db_path(dir: &TempDir) -> String {
    dir.path()
        .join("frick.sqlite")
        .to_string_lossy()
        .into_owned()
}

async fn migrate_up(db: &str) {
    let result = run_cli(&["migrate", "up", "--db-path", db, "--env", "development"]).await;
    assert_eq!(result.exit_code, 0, "migrate up: {}", result.stderr);
}

// ---- --help -----------------------------------------------------------------

#[tokio::test]
async fn help_lists_available_commands() {
    let result = run_cli(&["--help"]).await;
    assert_eq!(result.exit_code, 0);
    let body = parse_first_json(&result.stdout);
    let names: Vec<&str> = body["commands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    for expected in [
        "doctor",
        "migrate",
        "tenants",
        "schema",
        "reset",
        "inspect",
        "verify",
        "dev",
        "deploy",
        "dashboard",
        "mcp",
    ] {
        assert!(names.contains(&expected), "missing {expected}");
    }
}

#[tokio::test]
async fn no_command_emits_help() {
    let result = run_cli(&[]).await;
    assert_eq!(result.exit_code, 0);
    let body = parse_first_json(&result.stdout);
    assert!(body["commands"].is_array());
}

// ---- mcp --------------------------------------------------------------------

#[tokio::test]
async fn mcp_print_config() {
    let result = run_cli(&[
        "mcp",
        "--print-config",
        "--endpoint",
        "http://127.0.0.1:4199",
        "--tenant",
        "tenant-dev",
        "--user",
        "user-ada",
    ])
    .await;
    assert_eq!(result.exit_code, 0);
    let body = parse_first_json(&result.stdout);
    assert_eq!(body["ok"], true);
    assert_eq!(body["transport"], "stdio");
    assert_eq!(body["command"], "frick");
    assert_eq!(body["endpoint"], "http://127.0.0.1:4199");
    assert_eq!(body["readonly"], true);
    let args: Vec<&str> = body["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(args.contains(&"mcp"));
    assert!(args.contains(&"--endpoint"));
    assert!(args.contains(&"--tenant"));
    assert!(args.contains(&"tenant-dev"));
}

// ---- dashboard --------------------------------------------------------------

#[tokio::test]
async fn dashboard_rejects_invalid_port() {
    let result = run_cli(&["dashboard", "--port", "nope"]).await;
    assert_eq!(result.exit_code, 2);
    let err = parse_last_json(&result.stderr);
    assert_eq!(err["error"]["code"], "cli.usage");
    assert!(err["error"]["message"].as_str().unwrap().contains("--port"));
}

// ---- dev --------------------------------------------------------------------

#[tokio::test]
async fn dev_redpanda_plan() {
    let result = run_cli(&["dev", "--profile", "redpanda", "--dry-run"]).await;
    assert_eq!(result.exit_code, 0);
    let body = parse_first_json(&result.stdout);
    assert_eq!(body["ok"], true);
    assert_eq!(body["command"], "dev");
    assert_eq!(body["profile"], "redpanda");
    assert!(
        body["composeFile"]
            .as_str()
            .unwrap()
            .contains("ops/local/redpanda.compose.yaml")
    );
    assert_eq!(body["env"]["FRICK_PLATFORM_EVENTS_DRIVER"], "kafka");
    assert_eq!(
        body["env"]["FRICK_PLATFORM_EVENTS_KAFKA_BROKERS"],
        "127.0.0.1:19092"
    );
    assert_eq!(body["env"]["FRICK_OTEL_ENABLED"], "true");
    assert_eq!(
        body["env"]["FRICK_OTEL_EXPORTER_OTLP_ENDPOINT"],
        "http://127.0.0.1:4318"
    );
    let steps: Vec<&str> = body["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(steps.contains(&"docker compose up -d --wait redpanda otel-collector"));
    assert_eq!(body["started"], false);
}

#[tokio::test]
async fn dev_sqlite_plan() {
    let result = run_cli(&["dev", "--dry-run"]).await;
    assert_eq!(result.exit_code, 0);
    let body = parse_first_json(&result.stdout);
    assert_eq!(body["profile"], "sqlite");
    assert!(body.get("composeFile").is_none() || body["composeFile"].is_null());
    assert_eq!(body["env"]["FRICK_PLATFORM_EVENTS_DRIVER"], "sqlite");
}

#[tokio::test]
async fn dev_rejects_unknown_profile() {
    let result = run_cli(&["dev", "--profile", "nope", "--dry-run"]).await;
    assert_eq!(result.exit_code, 2);
    let err = parse_last_json(&result.stderr);
    assert_eq!(err["error"]["code"], "cli.usage");
    assert!(
        err["error"]["message"]
            .as_str()
            .unwrap()
            .contains("--profile")
    );
}

// ---- deploy -----------------------------------------------------------------

#[tokio::test]
async fn deploy_compose_plan() {
    let result = run_cli(&["deploy", "--profile", "compose", "--dry-run"]).await;
    assert_eq!(result.exit_code, 0);
    let body = parse_first_json(&result.stdout);
    assert_eq!(body["ok"], true);
    assert_eq!(body["command"], "deploy");
    assert_eq!(body["profile"], "compose");
    assert_eq!(body["composeFiles"].as_array().unwrap().len(), 1);
    assert!(
        body["composeFiles"][0]
            .as_str()
            .unwrap()
            .contains("ops/deploy/compose.yaml")
    );
    assert_eq!(body["env"]["FRICK_ENV"], "production");
    assert_eq!(
        body["env"]["FRICK_PLATFORM_EVENTS_KAFKA_BROKERS"],
        "redpanda:9092"
    );
    assert_eq!(
        body["env"]["FRICK_OTEL_EXPORTER_OTLP_ENDPOINT"],
        "http://otel-collector:4318"
    );
    assert_eq!(
        body["services"],
        serde_json::json!(["frick-server", "redpanda", "otel-collector"])
    );
    assert_eq!(body["started"], false);
}

#[tokio::test]
async fn deploy_lightweight_plan() {
    let result = run_cli(&["deploy", "--profile", "lightweight", "--dry-run"]).await;
    assert_eq!(result.exit_code, 0);
    let body = parse_first_json(&result.stdout);
    assert_eq!(body["profile"], "lightweight");
    assert!(
        body["composeFiles"][0]
            .as_str()
            .unwrap()
            .contains("ops/deploy/lightweight.compose.yaml")
    );
    assert_eq!(body["env"]["FRICK_PLATFORM_EVENTS_DRIVER"], "sqlite");
    assert_eq!(body["env"]["FRICK_OTEL_ENABLED"], "false");
    assert_eq!(body["services"], serde_json::json!(["frick-server"]));
}

#[tokio::test]
async fn deploy_image_plan() {
    let result = run_cli(&["deploy", "image", "--dry-run"]).await;
    assert_eq!(result.exit_code, 0);
    let body = parse_first_json(&result.stdout);
    assert_eq!(body["command"], "deploy");
    assert_eq!(body["action"], "image");
    assert_eq!(body["dryRun"], true);
    assert_eq!(body["built"], false);
    assert_eq!(body["tag"], "frick-server:latest");
    assert_eq!(body["push"], false);
    assert!(
        body["dockerfile"]
            .as_str()
            .unwrap()
            .contains("ops/deploy/server.Dockerfile")
    );
    let steps: Vec<&str> = body["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(
        steps.contains(&"docker build -f ops/deploy/server.Dockerfile -t frick-server:latest .")
    );
}

#[tokio::test]
async fn deploy_image_custom_inputs() {
    let result = run_cli(&[
        "deploy",
        "image",
        "--tag",
        "registry.example.com/frick/app:abc123",
        "--dockerfile",
        "ops/deploy/server.Dockerfile",
        "--context",
        ".",
        "--push",
        "--dry-run",
    ])
    .await;
    assert_eq!(result.exit_code, 0);
    let body = parse_first_json(&result.stdout);
    assert_eq!(body["tag"], "registry.example.com/frick/app:abc123");
    assert_eq!(body["push"], true);
    let steps: Vec<&str> = body["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(steps.contains(&"docker push registry.example.com/frick/app:abc123"));
}

#[tokio::test]
async fn deploy_rejects_unknown_action() {
    let result = run_cli(&["deploy", "unknown", "--dry-run"]).await;
    assert_eq!(result.exit_code, 2);
    let err = parse_last_json(&result.stderr);
    assert_eq!(err["error"]["code"], "cli.usage");
    assert!(
        err["error"]["message"]
            .as_str()
            .unwrap()
            .contains("deploy action")
    );
}

#[tokio::test]
async fn deploy_image_rejects_flag_without_value() {
    let result = run_cli(&["deploy", "image", "--tag", "--dry-run"]).await;
    assert_eq!(result.exit_code, 2);
    let err = parse_last_json(&result.stderr);
    assert_eq!(err["error"]["code"], "cli.usage");
    assert!(err["error"]["message"].as_str().unwrap().contains("--tag"));
}

#[tokio::test]
async fn deploy_image_rejects_extra_positionals() {
    let result = run_cli(&["deploy", "image", "extra", "--dry-run"]).await;
    assert_eq!(result.exit_code, 2);
    let err = parse_last_json(&result.stderr);
    assert_eq!(err["error"]["code"], "cli.usage");
    assert!(
        err["error"]["message"]
            .as_str()
            .unwrap()
            .contains("deploy image")
    );
}

// ---- schema -----------------------------------------------------------------

#[tokio::test]
async fn schema_check_emits_identity() {
    let result = run_cli(&["schema", "check"]).await;
    assert_eq!(result.exit_code, 0);
    let body = parse_first_json(&result.stdout);
    assert_eq!(body["ok"], true);
    assert!(body["schemaId"].is_string());
    assert!(body["schemaHash"].is_string());
}

#[tokio::test]
async fn schema_export_stdout_emits_loadable_schema() {
    let result = run_cli(&["schema", "export"]).await;
    assert_eq!(result.exit_code, 0, "{}", result.stderr);
    // Without --out the whole stdout is the pretty-printed schema document
    // itself (the on-disk `schema.json` shape), not a one-line summary record.
    let body: Value = serde_json::from_str(result.stdout.trim()).expect("schema JSON on stdout");
    assert!(body["schemaId"].is_string());
    // The schema document's identity hash lives under `hash` (not the
    // `schemaHash` alias used by the `--out` summary record).
    assert!(body["hash"].is_string());
    // It must carry the framework's primitive arrays (camelCase fields).
    assert!(body["objects"].is_array());
    assert!(body["projections"].is_array());

    // The emitted JSON round-trips: it parses back into a `FrickSchema` that
    // validates, and its identity matches the document the CLI printed.
    let schema: frick_protocol::FrickSchema =
        serde_json::from_str(result.stdout.trim()).expect("schema parses as FrickSchema");
    frick_protocol::validate_schema(&schema).expect("exported schema validates");
    assert_eq!(json!(schema.schema_id), body["schemaId"]);
}

#[tokio::test]
async fn schema_export_out_writes_file_and_summary() {
    let dir = TempDir::new().unwrap();
    let out = dir.path().join("schema.json");
    let result = run_cli(&["schema", "export", "--out", out.to_str().unwrap()]).await;
    assert_eq!(result.exit_code, 0, "{}", result.stderr);

    let body = parse_first_json(&result.stdout);
    assert_eq!(body["ok"], true);
    assert_eq!(body["out"], out.to_str().unwrap());
    assert!(body["schemaId"].is_string());
    assert!(body["schemaHash"].is_string());
    assert!(body["bytes"].as_u64().unwrap() > 0);

    // The written file is the schema document, whose identity matches the
    // summary record (the document keys the hash as `hash`; the summary aliases
    // it to `schemaHash`).
    let written = std::fs::read_to_string(&out).unwrap();
    let parsed: Value = serde_json::from_str(&written).unwrap();
    assert_eq!(parsed["schemaId"], body["schemaId"]);
    assert_eq!(parsed["hash"], body["schemaHash"]);
}

#[tokio::test]
async fn schema_generate_writes_native_artifacts() {
    use frick_cli::commands::schema::write_native_artifacts;
    use frick_cli::output::{Output, OutputMode};

    // The canonical client artifacts `frick schema generate` writes (FR-261).
    // We target a temp root so the committed files are never mutated, then
    // assert the bytes match the committed tree exactly (byte-identical
    // regeneration ⇒ clean `git diff`).
    const ARTIFACTS: &[&str] = &[
        "packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift",
        "apps/android/frick/src/main/java/dev/frick/client/FrickGenerated.kt",
        "packages/core/src/generated/bindings.ts",
        "packages/core/src/generated/errors.ts",
    ];
    let repo_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");

    let temp_root = TempDir::new().unwrap();
    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut out = Output {
        mode: OutputMode::Json,
        stdout: &mut stdout,
        stderr: &mut stderr,
    };
    let code = write_native_artifacts(temp_root.path(), &mut out).expect("generate writes");
    assert_eq!(code, 0);

    let body: Value = serde_json::from_str(String::from_utf8(stdout).unwrap().trim()).unwrap();
    assert_eq!(body["ok"], true);
    assert_eq!(body["command"], "frick schema generate");
    let written: Vec<String> = body["written"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert_eq!(written.len(), ARTIFACTS.len());

    for rel in ARTIFACTS {
        let generated = temp_root.path().join(rel);
        assert!(generated.exists(), "missing generated {rel}");
        // The swift file is the headline artifact; assert it carries the
        // generated marker, then prove byte-identity for every file.
        let bytes = std::fs::read(&generated).unwrap();
        let committed = std::fs::read(repo_root.join(rel)).unwrap();
        assert_eq!(bytes, committed, "{rel} drifted from the committed tree");
        assert!(
            written.iter().any(|p| p.replace('\\', "/").ends_with(rel)),
            "written list missing {rel}"
        );
    }

    // Spot-check the Swift artifact's content explicitly (the assignment's
    // named acceptance check), not just byte-equality.
    let swift = std::fs::read_to_string(
        temp_root
            .path()
            .join("packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift"),
    )
    .unwrap();
    assert!(swift.contains("Generated by @fricken/protocol"));
    assert!(swift.contains("public enum FrickSchema"));
    assert!(swift.ends_with('\n'));
}

// ---- verify -----------------------------------------------------------------

#[tokio::test]
async fn verify_clean_tree_exits_zero() {
    let result = run_cli(&["verify"]).await;
    assert_eq!(result.exit_code, 0, "{}", result.stderr);
    let body = parse_first_json(&result.stdout);
    assert_eq!(body["ok"], true);
    assert_eq!(body["command"], "frick verify (native)");
    let targets: Vec<&str> = body["targets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(targets.contains(&"swift"));
    assert!(targets.contains(&"kotlin"));
    assert!(targets.contains(&"typescript"));
}

/// Force the drift path (exit 1) deterministically by pointing the gate at a
/// temp fixture root whose snapshots are copied from the committed goldens with
/// one deliberately corrupted — so the real fixtures are never mutated.
#[tokio::test]
async fn verify_drift_exits_one() {
    use frick_cli::output::{Output, OutputMode};

    // The six golden snapshots `frick verify` compares, relative to the root.
    const FIXTURES: &[&str] = &[
        "conformance/fixtures/codegen/swift/foundation.swift",
        "conformance/fixtures/codegen/swift/error-enum.swift",
        "conformance/fixtures/codegen/kotlin/foundation.kt",
        "conformance/fixtures/codegen/kotlin/error-enum.kt",
        "conformance/fixtures/codegen/typescript/foundation-bindings.ts",
        "conformance/fixtures/codegen/typescript/errors.ts",
    ];
    // Resolve the committed goldens the same way the gate does (repo root).
    let repo_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");

    let temp_root = TempDir::new().unwrap();
    let corrupt = "conformance/fixtures/codegen/swift/foundation.swift";
    for fixture in FIXTURES {
        let dest = temp_root.path().join(fixture);
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        if *fixture == corrupt {
            // Deliberately wrong bytes ⇒ the generated swift artifact drifts.
            std::fs::write(&dest, "// drifted golden snapshot\n").unwrap();
        } else {
            std::fs::copy(repo_root.join(fixture), &dest).unwrap();
        }
    }

    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut out = Output {
        mode: OutputMode::Json,
        stdout: &mut stdout,
        stderr: &mut stderr,
    };
    let error = frick_cli::commands::verify::verify_with_fixture_root(temp_root.path(), &mut out)
        .expect_err("drift must return an error");
    assert_eq!(error.exit_code, 1);
    assert_eq!(error.code, "verify.drift");
    // The drift detail names the corrupted target (swift).
    let drift = error.details.expect("drift details")["drift"]
        .as_array()
        .expect("drift array")
        .iter()
        .map(|d| d["target"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert!(
        drift.contains(&"swift".to_string()),
        "drift targets: {drift:?}"
    );
}

// ---- migrate ----------------------------------------------------------------

#[tokio::test]
async fn migrate_status_fresh_all_pending() {
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    let result = run_cli(&[
        "migrate",
        "status",
        "--db-path",
        &db,
        "--env",
        "development",
    ])
    .await;
    assert_eq!(result.exit_code, 0);
    let body = parse_last_json(&result.stdout);
    assert_eq!(body["applied"].as_array().unwrap().len(), 0);
    assert!(!body["pending"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn migrate_up_then_status_applied() {
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    let up = run_cli(&["migrate", "up", "--db-path", &db, "--env", "development"]).await;
    assert_eq!(up.exit_code, 0);
    let up_body = parse_last_json(&up.stdout);
    assert!(!up_body["applied"].as_array().unwrap().is_empty());

    let status = run_cli(&[
        "migrate",
        "status",
        "--db-path",
        &db,
        "--env",
        "development",
    ])
    .await;
    assert_eq!(status.exit_code, 0);
    let body = parse_last_json(&status.stdout);
    assert!(!body["applied"].as_array().unwrap().is_empty());
    assert_eq!(body["pending"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn migrate_up_production_requires_confirm() {
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    let result = run_cli(&["migrate", "up", "--db-path", &db, "--env", "production"]).await;
    assert_eq!(result.exit_code, 3);
    let err = parse_last_json(&result.stderr);
    assert_eq!(err["error"]["code"], "cli.refused");
}

// ---- doctor -----------------------------------------------------------------

#[tokio::test]
async fn doctor_green_after_migrate() {
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    migrate_up(&db).await;
    let result = run_cli(&["doctor", "--db-path", &db, "--env", "development"]).await;
    assert_eq!(result.exit_code, 0);
    let body = parse_last_json(&result.stdout);
    assert_eq!(body["ok"], true);
    assert_eq!(body["schema"]["ok"], true);
    assert_eq!(body["db"]["ok"], true);
}

#[tokio::test]
async fn doctor_db_failure() {
    let result = run_cli(&[
        "doctor",
        "--db-path",
        "/this/path/does/not/exist/frick.sqlite",
        "--env",
        "development",
    ])
    .await;
    assert_eq!(result.exit_code, 1);
    let body = parse_last_json(&result.stdout);
    assert_eq!(body["ok"], false);
    assert_eq!(body["db"]["ok"], false);
}

// ---- reset ------------------------------------------------------------------

#[tokio::test]
async fn reset_dev_succeeds() {
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    migrate_up(&db).await;
    let result = run_cli(&["reset", "--dev", "--db-path", &db, "--env", "development"]).await;
    assert_eq!(result.exit_code, 0);
    let body = parse_last_json(&result.stdout);
    assert_eq!(body["ok"], true);
}

#[tokio::test]
async fn reset_refuses_without_dev() {
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    let result = run_cli(&["reset", "--db-path", &db, "--env", "development"]).await;
    assert_eq!(result.exit_code, 3);
    let err = parse_last_json(&result.stderr);
    assert_eq!(err["error"]["code"], "cli.refused");
}

#[tokio::test]
async fn reset_refuses_production() {
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    let result = run_cli(&["reset", "--dev", "--db-path", &db, "--env", "production"]).await;
    assert_eq!(result.exit_code, 3);
    let err = parse_last_json(&result.stderr);
    assert_eq!(err["error"]["code"], "cli.refused");
}

// ---- tenants ----------------------------------------------------------------

#[tokio::test]
async fn tenants_list_shows_default() {
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    migrate_up(&db).await;
    let result = run_cli(&["tenants", "list", "--db-path", &db, "--env", "development"]).await;
    assert_eq!(result.exit_code, 0);
    let body = parse_last_json(&result.stdout);
    let ids: Vec<&str> = body["tenants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["tenantId"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&"_default"));
}

#[tokio::test]
async fn tenants_create_inserts_row() {
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    migrate_up(&db).await;
    let created = run_cli(&[
        "tenants",
        "create",
        "tenant-x",
        "--display-name",
        "Tenant X",
        "--db-path",
        &db,
        "--env",
        "development",
    ])
    .await;
    assert_eq!(created.exit_code, 0);
    let body = parse_last_json(&created.stdout);
    assert_eq!(body["ok"], true);
    assert_eq!(body["tenant"]["tenantId"], "tenant-x");

    let list = run_cli(&["tenants", "list", "--db-path", &db, "--env", "development"]).await;
    let list_body = parse_last_json(&list.stdout);
    let ids: Vec<&str> = list_body["tenants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["tenantId"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&"tenant-x"));
}

#[tokio::test]
async fn tenants_create_duplicate_is_exists_error() {
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    migrate_up(&db).await;
    let _ = run_cli(&[
        "tenants",
        "create",
        "dup",
        "--db-path",
        &db,
        "--env",
        "development",
    ])
    .await;
    let again = run_cli(&[
        "tenants",
        "create",
        "dup",
        "--db-path",
        &db,
        "--env",
        "development",
    ])
    .await;
    assert_eq!(again.exit_code, 1);
    let err = parse_last_json(&again.stderr);
    assert_eq!(err["error"]["code"], "tenants.exists");
}

#[tokio::test]
async fn tenants_set_push_unsupported_platform() {
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    migrate_up(&db).await;
    let result = run_cli(&[
        "tenants",
        "set-push",
        "_default",
        "--platform",
        "carrier-pigeon",
        "--db-path",
        &db,
        "--env",
        "development",
    ])
    .await;
    assert_eq!(result.exit_code, 2);
    let err = parse_last_json(&result.stderr);
    assert_eq!(err["error"]["code"], "cli.usage");
}

#[tokio::test]
async fn tenants_set_push_webpush_round_trip() {
    use frick_server::push::credentials::{FixedCredentialEnv, load_web_push_credentials};
    use frick_store::{FrickStore, FrickStoreOptions};

    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    migrate_up(&db).await;

    let key = base64::engine::general_purpose::STANDARD.encode([7_u8; 32]);
    // SAFETY: single push test; no other test reads FRICK_PUSH_CRED_KEY.
    #[allow(unsafe_code)]
    unsafe {
        std::env::set_var("FRICK_PUSH_CRED_KEY", &key);
    }

    let pem = "-----BEGIN PRIVATE KEY-----\nMIGfake\n-----END PRIVATE KEY-----\n";
    let pem_path = dir.path().join("vapid-private.pem");
    std::fs::write(&pem_path, pem).unwrap();

    let result = run_cli(&[
        "tenants",
        "set-push",
        "_default",
        "--platform",
        "webpush",
        "--subject",
        "mailto:ops@example.com",
        "--public-key",
        "BJ-fake-vapid-public-key",
        "--private-key",
        pem_path.to_str().unwrap(),
        "--db-path",
        &db,
        "--env",
        "development",
    ])
    .await;
    assert_eq!(result.exit_code, 0, "{}", result.stderr);
    let body = parse_last_json(&result.stdout);
    assert_eq!(body["ok"], true);
    assert_eq!(body["platform"], "webpush");

    // The server credential loader must decrypt what the CLI wrote.
    let store = FrickStore::open(FrickStoreOptions {
        path: db.clone(),
        seed: false,
        idempotency_key_prune_interval_ms: Some(0),
        ..FrickStoreOptions::default()
    })
    .await
    .unwrap();
    let env = FixedCredentialEnv {
        primary: Some(key),
        previous: None,
    };
    let loaded = load_web_push_credentials(store.tenant_settings(), "_default", &env)
        .await
        .expect("decrypt webpush creds");
    assert_eq!(loaded.subject, "mailto:ops@example.com");
    assert_eq!(loaded.public_key, "BJ-fake-vapid-public-key");
    assert_eq!(loaded.private_key, pem);

    #[allow(unsafe_code)]
    unsafe {
        std::env::remove_var("FRICK_PUSH_CRED_KEY");
    }
}

#[tokio::test]
async fn tenants_set_push_webpush_bad_subject() {
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    migrate_up(&db).await;
    let pem_path = dir.path().join("bad.pem");
    std::fs::write(&pem_path, "fake").unwrap();
    let result = run_cli(&[
        "tenants",
        "set-push",
        "_default",
        "--platform",
        "webpush",
        "--subject",
        "ops@example.com",
        "--public-key",
        "BJ-fake",
        "--private-key",
        pem_path.to_str().unwrap(),
        "--db-path",
        &db,
        "--env",
        "development",
    ])
    .await;
    assert_eq!(result.exit_code, 1);
    let err = parse_last_json(&result.stderr);
    assert_eq!(err["error"]["code"], "tenants.setPush.invalidVapidSubject");
}

// ---- inspect ----------------------------------------------------------------

#[tokio::test]
async fn inspect_server_emits_identity() {
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    migrate_up(&db).await;
    let result = run_cli(&[
        "inspect",
        "server",
        "--db-path",
        &db,
        "--env",
        "development",
    ])
    .await;
    assert_eq!(result.exit_code, 0);
    let body = parse_last_json(&result.stdout);
    assert!(body["schemaId"].is_string());
    assert_eq!(body["env"], "development");
}

#[tokio::test]
async fn inspect_jobs_availability() {
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    migrate_up(&db).await;
    let result = run_cli(&["inspect", "jobs", "--db-path", &db, "--env", "development"]).await;
    assert_eq!(result.exit_code, 0);
    let body = parse_last_json(&result.stdout);
    assert!(body["available"].is_boolean());
}

#[tokio::test]
async fn inspect_db_shape() {
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    migrate_up(&db).await;
    let result = run_cli(&["inspect", "db", "--db-path", &db, "--env", "development"]).await;
    assert_eq!(result.exit_code, 0);
    let body = parse_last_json(&result.stdout);
    assert_eq!(body["ready"], true);
    assert!(body["applied"].as_u64().unwrap() > 0);
    assert!(body["idempotencyCache"]["capacity"].is_number());
}

#[tokio::test]
async fn inspect_diagnostics_malformed_probe_is_usage() {
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    migrate_up(&db).await;
    let result = run_cli(&[
        "inspect",
        "diagnostics",
        "not-a-valid-probe",
        "--db-path",
        &db,
        "--env",
        "development",
    ])
    .await;
    assert_eq!(result.exit_code, 2);
}

#[tokio::test]
async fn inspect_diagnostics_emits_snapshot() {
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    migrate_up(&db).await;
    let result = run_cli(&[
        "inspect",
        "diagnostics",
        "--db-path",
        &db,
        "--env",
        "development",
    ])
    .await;
    assert_eq!(result.exit_code, 0, "{}", result.stderr);
    let body = parse_first_json(&result.stdout);
    assert_eq!(body["source"], "cli");
    assert_eq!(body["env"], "development");
    assert!(body["diagnosticsVersion"].is_number());
    assert!(body["schema"]["schemaId"].is_string());
    // A fresh migrated DB is at the foundation revision ⇒ compatible.
    assert_eq!(body["compatibility"]["matched"], true);
    assert!(body["syncTiming"]["snapshotAt"].is_string());
    // `include_capabilities = false` from the CLI ⇒ no capabilities block.
    assert!(body.get("capabilities").is_none());
}

// ---- backup / restore -------------------------------------------------------

#[tokio::test]
async fn backup_to_file_then_restore_round_trip() {
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    migrate_up(&db).await;

    // A whole-DB dump to a file.
    let dump = dir.path().join("dump.ndjson");
    let result = run_cli(&[
        "backup",
        "--tenant-id",
        "all",
        "--output",
        dump.to_str().unwrap(),
        "--db-path",
        &db,
        "--env",
        "development",
    ])
    .await;
    assert_eq!(result.exit_code, 0, "{}", result.stderr);
    let body = parse_last_json(&result.stdout);
    assert_eq!(body["ok"], true);
    assert_eq!(body["tenantId"], "all");
    assert_eq!(body["output"], dump.to_str().unwrap());
    assert!(body["rows"].as_u64().unwrap() >= 1);

    let written = std::fs::read_to_string(&dump).unwrap();
    assert!(written.ends_with('\n'));
    let first: Value = serde_json::from_str(written.lines().next().unwrap()).unwrap();
    assert_eq!(first["type"], "header");

    // Restore the dump into a fresh, already-migrated DB.
    let dir2 = TempDir::new().unwrap();
    let db2 = db_path(&dir2);
    migrate_up(&db2).await;
    let result = run_cli(&[
        "restore",
        "--input",
        dump.to_str().unwrap(),
        "--confirm",
        "yes",
        "--overwrite",
        "--db-path",
        &db2,
        "--env",
        "development",
    ])
    .await;
    assert_eq!(result.exit_code, 0, "{}", result.stderr);
    let body = parse_last_json(&result.stdout);
    assert_eq!(body["ok"], true);
    assert_eq!(body["schemaCompatibility"]["matched"], true);
    assert!(body["rowCounts"].is_object());
    assert!(body["startedAt"].is_string());
    assert!(body["finishedAt"].is_string());
}

#[tokio::test]
async fn backup_stdout_stream_summary_to_stderr() {
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    migrate_up(&db).await;
    let result = run_cli(&["backup", "--db-path", &db, "--env", "development"]).await;
    assert_eq!(result.exit_code, 0, "{}", result.stderr);
    // Default tenant scope is `_default` (no --tenant-id given).
    let header: Value = serde_json::from_str(result.stdout.lines().next().unwrap()).unwrap();
    assert_eq!(header["type"], "header");
    // The summary lands on stderr so the NDJSON stream on stdout stays clean.
    let summary = parse_last_json(&result.stderr);
    assert_eq!(summary["ok"], true);
    assert_eq!(summary["tenantId"], "_default");
}

#[tokio::test]
async fn restore_requires_input() {
    let result = run_cli(&["restore", "--confirm", "yes"]).await;
    assert_eq!(result.exit_code, 2);
    let err = parse_last_json(&result.stderr);
    assert_eq!(err["error"]["code"], "cli.usage");
}

#[tokio::test]
async fn restore_refuses_without_confirm() {
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    migrate_up(&db).await;
    let dump = dir.path().join("dump.ndjson");
    std::fs::write(&dump, "{}\n").unwrap();
    let result = run_cli(&[
        "restore",
        "--input",
        dump.to_str().unwrap(),
        "--db-path",
        &db,
        "--env",
        "development",
    ])
    .await;
    assert_eq!(result.exit_code, 3);
    let err = parse_last_json(&result.stderr);
    assert_eq!(err["error"]["code"], "cli.refused");
    assert_eq!(err["error"]["details"]["reason"], "missingConfirmation");
}

#[tokio::test]
async fn restore_store_refusal_is_failure_exit_one() {
    // A dump with no header line is a store-side refusal (`missingHeader`),
    // which the CLI maps to a `cli.restore.<reason>` failure (exit 1) — the
    // deliberate asymmetry vs the missing-confirm refusal (exit 3).
    let dir = TempDir::new().unwrap();
    let db = db_path(&dir);
    migrate_up(&db).await;
    let dump = dir.path().join("dump.ndjson");
    std::fs::write(&dump, "{\"type\":\"objects\",\"row\":{}}\n").unwrap();
    let result = run_cli(&[
        "restore",
        "--input",
        dump.to_str().unwrap(),
        "--confirm",
        "yes",
        "--db-path",
        &db,
        "--env",
        "development",
    ])
    .await;
    assert_eq!(result.exit_code, 1, "{}", result.stdout);
    let err = parse_last_json(&result.stderr);
    assert_eq!(err["error"]["code"], "cli.restore.missingHeader");
}

// ---- lint -------------------------------------------------------------------

#[tokio::test]
async fn lint_clean_exits_zero() {
    let result = run_cli(&["lint"]).await;
    assert_eq!(result.exit_code, 0);
    let summary = parse_last_json(&result.stdout);
    assert_eq!(summary["ok"], true);
    assert_eq!(summary["breaking"], 0);
}

#[tokio::test]
async fn lint_against_drops_object_breaking() {
    let dir = TempDir::new().unwrap();
    let previous_path = dir.path().join("previous.json");
    let previous = serde_json::json!({
        "name": "frick-foundation",
        "schemaId": "frick-foundation",
        "schemaVersion": "0.1.0",
        "schemaRevision": 1,
        "minimumClientRevision": 1,
        "minimumServerRevision": 1,
        "protocol": "frick.realtime",
        "protocolVersion": 1,
        "compatibility": "greenfield-cutover",
        "hash": "frick-foundation-fake",
        "objects": [{
            "id": 9999,
            "name": "DroppedType",
            "fields": [{ "id": 1, "name": "value", "kind": "string", "required": true }],
            "indexes": []
        }],
        "streams": [], "events": [], "presences": [], "signals": [], "blobs": [], "jobs": [], "projections": []
    });
    std::fs::write(&previous_path, serde_json::to_string(&previous).unwrap()).unwrap();
    let result = run_cli(&["lint", "--against", previous_path.to_str().unwrap()]).await;
    assert_eq!(result.exit_code, 1);
    let lines: Vec<&str> = result
        .stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .collect();
    let findings: Vec<Value> = lines[..lines.len() - 1]
        .iter()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert!(findings.iter().any(|f| f["ruleId"] == "object.removed"));
    let summary: Value = serde_json::from_str(lines[lines.len() - 1]).unwrap();
    assert_eq!(summary["ok"], false);
    assert!(summary["breaking"].as_u64().unwrap() >= 1);
}

// ---- init / scaffold --------------------------------------------------------

#[tokio::test]
async fn init_creates_file_tree() {
    let dir = TempDir::new().unwrap();
    let app_dir = dir.path().join("app");
    let result = run_cli(&["init", app_dir.to_str().unwrap(), "--no-install"]).await;
    assert_eq!(result.exit_code, 0, "{}", result.stderr);
    let body = parse_last_json(&result.stdout);
    assert_eq!(body["ok"], true);
    assert_eq!(body["install"]["skipped"], true);
    let files = [
        "package.json",
        "tsconfig.json",
        "frick.config.json",
        "README.md",
        "src/schema.ts",
        "src/server.ts",
        "tests/smoke.test.ts",
    ];
    for rel in files {
        assert!(app_dir.join(rel).exists(), "missing {rel}");
    }
    let created: Vec<&str> = body["created"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    for rel in files {
        assert!(
            created.iter().any(|p| p.replace('\\', "/").ends_with(rel)),
            "created list missing {rel}"
        );
    }

    // Post-cutover server.ts is data only: no embedded TS server.
    let server = std::fs::read_to_string(app_dir.join("src/server.ts")).unwrap();
    assert!(!server.contains("createFrickServer"));
    assert!(!server.contains("@fricken/server"));
    assert!(!server.contains("app.listen"));
    assert!(server.contains("// frick:projections:imports"));
    assert!(server.contains("// frick:projections:register"));
    assert!(server.contains("export const app = {"));
    assert!(server.contains("schema,"));

    // smoke.test.ts validates the schema instead of booting a server.
    let smoke = std::fs::read_to_string(app_dir.join("tests/smoke.test.ts")).unwrap();
    assert!(smoke.contains("validateSchema"));
    assert!(smoke.contains("@fricken/protocol"));
    assert!(smoke.contains("schema.schemaId"));
    assert!(!smoke.contains("createFrickServer"));
    assert!(!smoke.contains("/health"));

    // No scaffolded file may reference the deleted @fricken/server package.
    for rel in files {
        let body = std::fs::read_to_string(app_dir.join(rel)).unwrap();
        assert!(
            !body.contains("@fricken/server"),
            "{rel} still references @fricken/server"
        );
    }
}

#[tokio::test]
async fn init_refuses_existing_file() {
    let dir = TempDir::new().unwrap();
    let app_dir = dir.path().join("app");
    std::fs::create_dir_all(&app_dir).unwrap();
    std::fs::write(app_dir.join("package.json"), "{}").unwrap();
    let result = run_cli(&["init", app_dir.to_str().unwrap(), "--no-install"]).await;
    assert_eq!(result.exit_code, 3);
    let err = parse_last_json(&result.stderr);
    assert_eq!(err["error"]["code"], "cli.refused");
}

#[tokio::test]
async fn init_emits_mcp_config() {
    let dir = TempDir::new().unwrap();
    let app_dir = dir.path().join("app");
    let result = run_cli(&[
        "init",
        app_dir.to_str().unwrap(),
        "--no-install",
        "--mcp",
        "--port",
        "4111",
    ])
    .await;
    assert_eq!(result.exit_code, 0, "{}", result.stderr);
    let body = parse_last_json(&result.stdout);
    assert_eq!(body["ok"], true);
    assert_eq!(body["mcp"]["endpoint"], "http://127.0.0.1:4111");
    assert_eq!(body["mcp"]["readonly"], true);
    assert_eq!(body["mcp"]["command"], "frick");
    assert_eq!(
        body["mcp"]["args"],
        serde_json::json!(["mcp", "--endpoint", "http://127.0.0.1:4111"])
    );
}

#[tokio::test]
async fn scaffold_object_adds_stub() {
    let dir = TempDir::new().unwrap();
    let app_dir = dir.path().join("app");
    run_cli(&["init", app_dir.to_str().unwrap(), "--no-install"]).await;
    let result = run_cli(&[
        "scaffold",
        "object",
        "Profile",
        "--directory",
        app_dir.to_str().unwrap(),
    ])
    .await;
    assert_eq!(result.exit_code, 0, "{}", result.stderr);
    let body = parse_last_json(&result.stdout);
    assert_eq!(body["ok"], true);
    assert_eq!(body["kind"], "object");
    assert_eq!(body["name"], "Profile");
    assert_eq!(body["id"], 1);
    let schema = std::fs::read_to_string(app_dir.join("src/schema.ts")).unwrap();
    assert!(schema.contains("// frick:objects:id 1 Profile"));
    assert!(schema.contains("name: \"Profile\""));
}

#[tokio::test]
async fn scaffold_object_duplicate_refused() {
    let dir = TempDir::new().unwrap();
    let app_dir = dir.path().join("app");
    run_cli(&["init", app_dir.to_str().unwrap(), "--no-install"]).await;
    run_cli(&[
        "scaffold",
        "object",
        "Profile",
        "--directory",
        app_dir.to_str().unwrap(),
    ])
    .await;
    let again = run_cli(&[
        "scaffold",
        "object",
        "Profile",
        "--directory",
        app_dir.to_str().unwrap(),
    ])
    .await;
    assert_eq!(again.exit_code, 3);
    let err = parse_last_json(&again.stderr);
    assert_eq!(err["error"]["code"], "cli.refused");
}

#[tokio::test]
async fn scaffold_projection_creates_file() {
    let dir = TempDir::new().unwrap();
    let app_dir = dir.path().join("app");
    run_cli(&["init", app_dir.to_str().unwrap(), "--no-install"]).await;
    let result = run_cli(&[
        "scaffold",
        "projection",
        "profile-index",
        "--directory",
        app_dir.to_str().unwrap(),
    ])
    .await;
    assert_eq!(result.exit_code, 0, "{}", result.stderr);
    assert!(app_dir.join("src/projections/profile-index.ts").exists());
    let server = std::fs::read_to_string(app_dir.join("src/server.ts")).unwrap();
    assert!(server.contains("createProfileIndexProjection"));
}

// ---- unknown command --------------------------------------------------------

#[tokio::test]
async fn unknown_command_exit_two() {
    let result = run_cli(&["nope"]).await;
    assert_eq!(result.exit_code, 2);
    let err = parse_last_json(&result.stderr);
    assert_eq!(err["error"]["code"], "cli.unknown_command");
}
