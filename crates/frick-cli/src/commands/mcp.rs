//! `frick mcp` (ported from `apps/cli/src/commands/mcp.ts`).
//!
//! `--print-config` emits `createMcpClientConfig(options)` and exits 0.
//! Otherwise it runs the `frick-mcp` stdio JSON-RPC bridge (FR-253) on the
//! process stdio and blocks until stdin closes. `--readonly` wins over
//! `--allow-writes`.

use crate::argv::ParsedArgs;
use crate::errors::{CliError, EXIT_OK};
use crate::mcp_config::{McpClientOptions, create_mcp_client_config, normalize_endpoint};
use crate::output::Output;

const DEFAULT_FRICK_ENDPOINT: &str = "http://127.0.0.1:4099";

/// `mcpCommand`.
pub async fn mcp_command(parsed: &ParsedArgs, out: &mut Output<'_>) -> Result<i32, CliError> {
    let options = read_options(parsed)?;
    if parsed.flag_truthy("print-config") {
        out.emit(&create_mcp_client_config(&options));
        return Ok(EXIT_OK);
    }
    // Run the stdio bridge over the real frick-mcp server; blocks until stdin
    // closes (the TS `runFrickMcpStdio` likewise runs until the transport ends).
    let mcp_options = frick_mcp::FrickMcpOptions {
        endpoint: Some(options.endpoint.clone()),
        token: options.token.clone(),
        tenant_id: options.tenant_id.clone(),
        user_id: options.user_id.clone(),
        allow_writes: options.allow_writes,
    };
    frick_mcp::run_frick_mcp_stdio(&mcp_options)
        .await
        .map_err(|err| CliError::failure("cli.mcp.io", err.to_string()))?;
    Ok(EXIT_OK)
}

fn read_options(parsed: &ParsedArgs) -> Result<McpClientOptions, CliError> {
    let endpoint_raw = parsed
        .flag_str("endpoint")
        .map(ToString::to_string)
        .or_else(|| std::env::var("FRICK_ENDPOINT").ok())
        .unwrap_or_else(|| DEFAULT_FRICK_ENDPOINT.to_string());
    validate_endpoint(&endpoint_raw)?;
    let endpoint = normalize_endpoint(Some(&endpoint_raw));

    // `--readonly` wins over `--allow-writes`.
    let allow_writes = parsed.flag_truthy("allow-writes") && !parsed.flag_truthy("readonly");

    Ok(McpClientOptions {
        endpoint,
        token: parsed.flag_str("token").map(ToString::to_string),
        tenant_id: parsed.flag_str("tenant").map(ToString::to_string),
        user_id: parsed.flag_str("user").map(ToString::to_string),
        allow_writes,
    })
}

fn validate_endpoint(endpoint: &str) -> Result<(), CliError> {
    let ok = endpoint.starts_with("http://") || endpoint.starts_with("https://");
    if ok {
        Ok(())
    } else {
        Err(CliError::usage(format!(
            "--endpoint must be an HTTP(S) URL, got {}",
            serde_json::to_string(endpoint).unwrap_or_else(|_| format!("\"{endpoint}\""))
        )))
    }
}
