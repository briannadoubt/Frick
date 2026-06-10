//! Native port of `@fricken/mcp`'s `createMcpClientConfig` + endpoint
//! normalization (`packages/mcp/src/server.ts:194-260`).
//!
//! The `frick-mcp` Rust crate is an empty stub (FR-253 unimplemented), so the
//! CLI ports the client-config surface directly. `command` is always `"frick"`,
//! matching the TS (even when emitted by the standalone `frick-mcp` binary).

use serde_json::{Value, json};

/// `FrickMcpOptions` subset the CLI consumes.
#[derive(Debug, Clone, Default)]
pub struct McpClientOptions {
    /// Frick server endpoint (normalized — trailing slashes stripped).
    pub endpoint: String,
    /// Bearer token.
    pub token: Option<String>,
    /// `x-frick-tenant`.
    pub tenant_id: Option<String>,
    /// `x-frick-user`.
    pub user_id: Option<String>,
    /// Whether the write tool is advertised. `readonly = !allow_writes`.
    pub allow_writes: bool,
}

/// `normalizeEndpoint` — default `http://127.0.0.1:4099`, trailing `/` stripped.
#[must_use]
pub fn normalize_endpoint(endpoint: Option<&str>) -> String {
    let raw = endpoint.unwrap_or("http://127.0.0.1:4099");
    raw.trim_end_matches('/').to_string()
}

/// `createMcpClientConfig(options)`.
#[must_use]
pub fn create_mcp_client_config(options: &McpClientOptions) -> Value {
    let endpoint = normalize_endpoint(Some(&options.endpoint));
    let mut args: Vec<String> = vec![
        "mcp".to_string(),
        "--endpoint".to_string(),
        endpoint.clone(),
    ];
    if options.allow_writes {
        args.push("--allow-writes".to_string());
    }
    if let Some(tenant) = options.tenant_id.as_deref().filter(|s| !s.is_empty()) {
        args.push("--tenant".to_string());
        args.push(tenant.to_string());
    }
    if let Some(user) = options.user_id.as_deref().filter(|s| !s.is_empty()) {
        args.push("--user".to_string());
        args.push(user.to_string());
    }
    if let Some(token) = options.token.as_deref().filter(|s| !s.is_empty()) {
        args.push("--token".to_string());
        args.push(token.to_string());
    }
    json!({
        "ok": true,
        "transport": "stdio",
        "command": "frick",
        "args": args,
        "endpoint": endpoint,
        "readonly": !options.allow_writes,
    })
}
