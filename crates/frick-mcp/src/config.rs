//! MCP client config and option types.
//!
//! Ports `FrickMcpOptions` and `createMcpClientConfig`
//! (`packages/mcp/src/server.ts:26-33, 245-260`).

use serde_json::{Value, json};

/// Default Frick endpoint when none is supplied
/// (`server.ts:194-196`).
pub const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:4099";

/// Options that configure a [`crate::server::FrickMcpServer`]. Mirrors the TS
/// `FrickMcpOptions` (minus the `fetcher`, which is the injected HTTP seam).
#[derive(Debug, Clone, Default)]
pub struct FrickMcpOptions {
    /// Frick server endpoint. Normalized (trailing slashes stripped) at
    /// construction; `None` → [`DEFAULT_ENDPOINT`].
    pub endpoint: Option<String>,
    /// Bearer session token.
    pub token: Option<String>,
    /// `x-frick-tenant` value.
    pub tenant_id: Option<String>,
    /// `x-frick-user` value.
    pub user_id: Option<String>,
    /// When true, the write tool `frick_append_event` is listed and callable.
    pub allow_writes: bool,
}

/// Strip trailing slashes from an endpoint, defaulting when absent
/// (`normalizeEndpoint`, `server.ts:194-196`).
#[must_use]
pub fn normalize_endpoint(endpoint: Option<&str>) -> String {
    let raw = endpoint.unwrap_or(DEFAULT_ENDPOINT);
    let trimmed = raw.trim_end_matches('/');
    if trimmed.is_empty() {
        // `"/".replace(/\/+$/, "")` is the empty string in TS; preserve that.
        String::new()
    } else {
        trimmed.to_string()
    }
}

/// `createMcpClientConfig` (`server.ts:245-260`). Note: the `command` is always
/// `"frick"` (not `frick-mcp`), even when emitted by the standalone binary.
#[must_use]
pub fn create_mcp_client_config(options: &FrickMcpOptions) -> Value {
    let endpoint = normalize_endpoint(options.endpoint.as_deref());
    let mut args: Vec<Value> = vec![
        Value::String("mcp".into()),
        Value::String("--endpoint".into()),
        Value::String(endpoint.clone()),
    ];
    if options.allow_writes {
        args.push(Value::String("--allow-writes".into()));
    }
    if let Some(tenant) = non_empty(options.tenant_id.as_deref()) {
        args.push(Value::String("--tenant".into()));
        args.push(Value::String(tenant.into()));
    }
    if let Some(user) = non_empty(options.user_id.as_deref()) {
        args.push(Value::String("--user".into()));
        args.push(Value::String(user.into()));
    }
    if let Some(token) = non_empty(options.token.as_deref()) {
        args.push(Value::String("--token".into()));
        args.push(Value::String(token.into()));
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

/// JS truthiness for strings: a present, non-empty value (the TS guard is
/// `if (options.token)` etc., so empty strings are dropped).
fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_trailing_slashes() {
        assert_eq!(normalize_endpoint(None), DEFAULT_ENDPOINT);
        assert_eq!(
            normalize_endpoint(Some("http://x:1/")),
            "http://x:1".to_string()
        );
        assert_eq!(
            normalize_endpoint(Some("http://x:1///")),
            "http://x:1".to_string()
        );
    }

    #[test]
    fn config_default_is_readonly() {
        let cfg = create_mcp_client_config(&FrickMcpOptions::default());
        assert_eq!(cfg["command"], "frick");
        assert_eq!(cfg["transport"], "stdio");
        assert_eq!(cfg["readonly"], true);
        assert_eq!(cfg["args"], json!(["mcp", "--endpoint", DEFAULT_ENDPOINT]));
    }

    #[test]
    fn config_appends_flags_in_order() {
        let options = FrickMcpOptions {
            endpoint: Some("http://h:9/".into()),
            token: Some("tok".into()),
            tenant_id: Some("t".into()),
            user_id: Some("u".into()),
            allow_writes: true,
        };
        let cfg = create_mcp_client_config(&options);
        assert_eq!(cfg["readonly"], false);
        assert_eq!(
            cfg["args"],
            json!([
                "mcp",
                "--endpoint",
                "http://h:9",
                "--allow-writes",
                "--tenant",
                "t",
                "--user",
                "u",
                "--token",
                "tok"
            ])
        );
    }
}
