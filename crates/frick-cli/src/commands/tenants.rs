//! `frick tenants list|create|set-push`
//! (ported from `apps/cli/src/commands/tenants.ts`).
//!
//! `list` / `create` go through `store.tenants()`. `set-push` wraps APNs / FCM /
//! Web Push credentials with `FRICK_PUSH_CRED_KEY` and stores them in
//! `tenant_settings`, using the `frick_server::push::credentials` helpers — the
//! same sealing the server's credential loader can decrypt.

use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use frick_server::push::credentials::{
    ApnsCredentials, FcmCredentials, ProcessCredentialEnv, WebPushCredentials,
    save_apns_credentials, save_fcm_credentials, save_web_push_credentials,
};
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

/// `tenantsCommand`.
pub async fn tenants_command(parsed: &ParsedArgs, out: &mut Output<'_>) -> Result<i32, CliError> {
    match parsed.positional(0) {
        Some("list") => tenants_list(parsed, out).await,
        Some("create") => tenants_create(parsed, out).await,
        Some("set-push") => tenants_set_push(parsed, out).await,
        other => Err(CliError::usage_with(
            format!(
                "Unknown tenants subcommand: {}",
                other.unwrap_or("<missing>")
            ),
            json!({ "expected": ["list", "create", "set-push"] }),
        )),
    }
}

async fn tenants_list(parsed: &ParsedArgs, out: &mut Output<'_>) -> Result<i32, CliError> {
    let config = load_config(&context_flags_from(parsed))?;
    let store = open_store(&config).await?;
    let include_archived = parsed.flag_bool_present("include-archived");
    let rows = store
        .tenants()
        .list(include_archived)
        .await
        .map_err(|err| CliError::failure("cli.store", err.to_string()))?;
    let rows: Vec<_> = rows
        .iter()
        .map(|row| {
            json!({
                "tenantId": row.tenant_id,
                "displayName": row.display_name,
                "createdAt": row.created_at,
                "archivedAt": row.archived_at,
            })
        })
        .collect();
    out.emit(&json!({ "tenants": rows }));
    Ok(EXIT_OK)
}

async fn tenants_create(parsed: &ParsedArgs, out: &mut Output<'_>) -> Result<i32, CliError> {
    let Some(tenant_id) = parsed.positional(1) else {
        return Err(CliError::usage(
            "frick tenants create requires a tenant id positional argument",
        ));
    };
    let display_name = parsed.flag_str("display-name");
    let config = load_config(&context_flags_from(parsed))?;
    let store = open_store(&config).await?;
    match store
        .tenants()
        .create(tenant_id, display_name, now_ms())
        .await
    {
        Ok(row) => {
            out.emit(&json!({
                "ok": true,
                "tenant": {
                    "tenantId": row.tenant_id,
                    "displayName": row.display_name,
                    "createdAt": row.created_at,
                    "archivedAt": row.archived_at,
                },
            }));
            Ok(EXIT_OK)
        }
        Err(err) => {
            let message = err.to_string();
            if message == frick_store::stores::tenant::tenant_already_exists_message(tenant_id) {
                Err(CliError::failure_with(
                    "tenants.exists",
                    message,
                    json!({ "tenantId": tenant_id }),
                ))
            } else {
                Err(CliError::failure("cli.store", message))
            }
        }
    }
}

fn require_flag<'a>(parsed: &'a ParsedArgs, key: &str) -> Result<&'a str, CliError> {
    match parsed.flag_str(key) {
        Some(value) if !value.is_empty() => Ok(value),
        _ => Err(CliError::usage(format!("Missing required --{key} flag"))),
    }
}

async fn tenants_set_push(parsed: &ParsedArgs, out: &mut Output<'_>) -> Result<i32, CliError> {
    let Some(tenant_id) = parsed.positional(1).map(ToString::to_string) else {
        return Err(CliError::usage(
            "frick tenants set-push requires a tenant id positional argument",
        ));
    };
    let platform = require_flag(parsed, "platform")?.to_string();
    let config = load_config(&context_flags_from(parsed))?;
    let store = open_store(&config).await?;
    let env = ProcessCredentialEnv;

    match platform.as_str() {
        "apns" => set_push_apns(parsed, &store, &tenant_id, &env, out).await,
        "fcm" => set_push_fcm(parsed, &store, &tenant_id, &env, out).await,
        "webpush" => set_push_webpush(parsed, &store, &tenant_id, &env, out).await,
        other => Err(CliError::usage_with(
            format!("Unsupported --platform: {other}"),
            json!({ "expected": ["apns", "fcm", "webpush"] }),
        )),
    }
}

fn cred_error(
    tenant_id: &str,
) -> impl Fn(frick_server::push::credentials::PushCredentialError) -> CliError + '_ {
    move |err| {
        CliError::failure_with(
            err.code.as_str(),
            err.message,
            json!({ "tenantId": tenant_id }),
        )
    }
}

async fn set_push_apns(
    parsed: &ParsedArgs,
    store: &frick_store::FrickStore,
    tenant_id: &str,
    env: &ProcessCredentialEnv,
    out: &mut Output<'_>,
) -> Result<i32, CliError> {
    let p8_path = require_flag(parsed, "p8")?;
    let creds = ApnsCredentials {
        key_id: require_flag(parsed, "key-id")?.to_string(),
        team_id: require_flag(parsed, "team-id")?.to_string(),
        bundle_id: require_flag(parsed, "bundle-id")?.to_string(),
        private_key_pem: read_file(p8_path)?,
        use_sandbox: parsed.flag_bool_present("sandbox"),
    };
    save_apns_credentials(store.tenant_settings(), tenant_id, &creds, env, now_ms())
        .await
        .map_err(cred_error(tenant_id))?;
    out.emit(&json!({ "ok": true, "tenantId": tenant_id, "platform": "apns" }));
    Ok(EXIT_OK)
}

async fn set_push_fcm(
    parsed: &ParsedArgs,
    store: &frick_store::FrickStore,
    tenant_id: &str,
    env: &ProcessCredentialEnv,
    out: &mut Output<'_>,
) -> Result<i32, CliError> {
    let path = require_flag(parsed, "service-account")?;
    let raw = read_file(path)?;
    let parsed_json: serde_json::Value = serde_json::from_str(&raw).map_err(|_| {
        CliError::failure_with(
            "tenants.setPush.invalidServiceAccount",
            "Service-account file is not valid JSON",
            json!({ "path": path }),
        )
    })?;
    let project_id = parsed_json.get("project_id").and_then(|v| v.as_str());
    let client_email = parsed_json.get("client_email").and_then(|v| v.as_str());
    let private_key = parsed_json.get("private_key").and_then(|v| v.as_str());
    let (Some(project_id), Some(client_email), Some(private_key)) =
        (project_id, client_email, private_key)
    else {
        return Err(CliError::failure_with(
            "tenants.setPush.invalidServiceAccount",
            "Service-account file missing project_id, client_email, or private_key",
            json!({ "path": path }),
        ));
    };
    let creds = FcmCredentials {
        project_id: project_id.to_string(),
        client_email: client_email.to_string(),
        private_key: private_key.to_string(),
        token_uri: parsed_json
            .get("token_uri")
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
    };
    save_fcm_credentials(store.tenant_settings(), tenant_id, &creds, env, now_ms())
        .await
        .map_err(cred_error(tenant_id))?;
    out.emit(&json!({ "ok": true, "tenantId": tenant_id, "platform": "fcm" }));
    Ok(EXIT_OK)
}

async fn set_push_webpush(
    parsed: &ParsedArgs,
    store: &frick_store::FrickStore,
    tenant_id: &str,
    env: &ProcessCredentialEnv,
    out: &mut Output<'_>,
) -> Result<i32, CliError> {
    let subject = require_flag(parsed, "subject")?.to_string();
    if !subject.starts_with("mailto:") && !subject.starts_with("https://") {
        return Err(CliError::failure_with(
            "tenants.setPush.invalidVapidSubject",
            "Web Push --subject must be a mailto: or https:// URI",
            json!({ "subject": subject }),
        ));
    }
    let public_key = require_flag(parsed, "public-key")?.to_string();
    let private_key_path = require_flag(parsed, "private-key")?;
    let creds = WebPushCredentials {
        subject,
        public_key,
        private_key: read_file(private_key_path)?,
    };
    save_web_push_credentials(store.tenant_settings(), tenant_id, &creds, env, now_ms())
        .await
        .map_err(cred_error(tenant_id))?;
    out.emit(&json!({ "ok": true, "tenantId": tenant_id, "platform": "webpush" }));
    Ok(EXIT_OK)
}

fn read_file(path: &str) -> Result<String, CliError> {
    fs::read_to_string(path)
        .map_err(|err| CliError::failure("cli.io", format!("Could not read {path}: {err}")))
}
