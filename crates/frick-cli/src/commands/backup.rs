//! `frick backup` — stream a framework database dump as NDJSON (FR-262).
//!
//! Maps `internal/rust-rewrite/maps/08-cli.md` §1.4. Wraps
//! [`frick_store::FrickStore::dump_database_with`], which returns the dump as
//! NDJSON lines (a header line followed by `{type, row}` rows, no trailing
//! newline). The store is clock-free; the CLI injects the wall clock as `now_ms`.
//!
//! Tenant scoping (`--tenant-id`):
//!   - absent ⇒ `_default` (the default tenant);
//!   - `all` ⇒ the whole database (every tenant + framework infra);
//!   - any other id ⇒ that single tenant.
//!
//! Output:
//!   - WITH `--output <path>`: the NDJSON lines are written to the file (joined
//!     by `\n`, trailing newline), and a `{ok, dbPath, tenantId, output, rows}`
//!     summary record is emitted on stdout.
//!   - WITHOUT `--output`: the NDJSON lines are printed to stdout (one per line)
//!     so the dump stream stays clean, and the summary record goes to stderr.

use std::time::{SystemTime, UNIX_EPOCH};

use frick_store::DumpOptions;
use serde_json::json;

use crate::argv::ParsedArgs;
use crate::context::{context_flags_from, load_config, open_store};
use crate::errors::{CliError, EXIT_OK};
use crate::output::Output;

/// Current wall-clock instant in epoch milliseconds (`i64`). The store stays
/// clock-free; the CLI supplies `now_ms` for the dump header's `createdAt`.
fn now_ms() -> i64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    i64::try_from(millis).unwrap_or(i64::MAX)
}

/// `backupCommand`.
pub async fn backup_command(parsed: &ParsedArgs, out: &mut Output<'_>) -> Result<i32, CliError> {
    let config = load_config(&context_flags_from(parsed))?;
    let store = open_store(&config).await?;

    // `--tenant-id all` ⇒ whole DB (None); a concrete id ⇒ that tenant; absent ⇒
    // the `_default` tenant.
    let tenant_flag = parsed.flag_str("tenant-id").unwrap_or("_default");
    let tenant_id = if tenant_flag == "all" {
        None
    } else {
        Some(tenant_flag.to_string())
    };

    let options = DumpOptions {
        tenant_id: tenant_id.clone(),
        include_admin_audit: None,
        include_migrations: None,
    };
    let lines = store
        .dump_database_with(&options, now_ms())
        .await
        .map_err(|err| CliError::failure("cli.backup", err.to_string()))?;

    // `tenantId` in the summary echoes the resolved scope: "all" for a whole-DB
    // dump, otherwise the tenant id.
    let tenant_label = tenant_id.as_deref().unwrap_or("all");

    let Some(output_path) = parsed.flag_str("output") else {
        // No --output: emit the NDJSON stream to stdout (clean), summary to stderr.
        for line in &lines {
            let _ = writeln!(out.stdout, "{line}");
        }
        let _ = writeln!(
            out.stderr,
            "{}",
            json!({
                "ok": true,
                "dbPath": config.db_path,
                "tenantId": tenant_label,
                "rows": lines.len(),
            })
        );
        return Ok(EXIT_OK);
    };

    let mut body = lines.join("\n");
    body.push('\n');
    std::fs::write(output_path, body).map_err(|err| {
        CliError::failure(
            "cli.backup",
            format!("failed to write dump to \"{output_path}\": {err}"),
        )
    })?;
    out.emit(&json!({
        "ok": true,
        "dbPath": config.db_path,
        "tenantId": tenant_label,
        "output": output_path,
        "rows": lines.len(),
    }));
    Ok(EXIT_OK)
}
