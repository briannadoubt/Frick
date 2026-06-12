//! Frick MCP server (FR-253): a hand-rolled stdio JSON-RPC 2.0 bridge to a
//! running Frick server. Ported from `packages/mcp`.
//!
//! Zero MCP SDK: the transport ([`stdio`]) reads newline-delimited JSON-RPC
//! 2.0 from stdin, the dispatch core ([`server::FrickMcpServer::handle`]) is a
//! pure async `request value -> response value` function with an injectable
//! HTTP seam ([`http::HttpCall`]), and the HTTP-calling tools forward to a
//! running Frick server with the fixed wire-compat header set.
//!
//! Public entry points (mirroring `packages/mcp/src/index.ts`):
//! - [`run_frick_mcp_stdio`] — run the stdio loop on real process stdio.
//! - [`create_mcp_client_config`] — emit the `frick mcp` client config JSON.
//! - [`run_cli`] — the `frick-mcp` binary body (parse argv, print-config or
//!   run the loop).

pub mod cli;
pub mod config;
pub mod http;
pub mod server;
pub mod stdio;

pub use cli::{CliError, ParsedArgs, parse as parse_args};
pub use config::{DEFAULT_ENDPOINT, FrickMcpOptions, create_mcp_client_config, normalize_endpoint};
pub use http::{HttpCall, HttpMethod, HttpRequest, HttpResponse, ReqwestHttpCall};
pub use server::{DEFAULT_MCP_PROTOCOL_VERSION, FrickMcpServer};
pub use stdio::{run_frick_mcp_stdio, run_stdio_loop};

/// How the `frick-mcp` binary should exit (`cli.ts:60-72`).
#[derive(Debug)]
pub enum CliOutcome {
    /// `--print-config` was requested: this JSON line was written to stdout;
    /// exit 0.
    PrintedConfig,
    /// The stdio loop ran to EOF; exit 0.
    Served,
}

/// The body of the `frick-mcp` binary. Parses argv (already stripped of the
/// program name), then either prints the client config and returns, or runs
/// the stdio bridge until stdin EOF.
///
/// On a usage error it writes `{ "error": { "code":"mcp.usage", "message" } }`
/// to stderr and returns `Err` — `main` maps that to exit code 2.
pub async fn run_cli(argv: &[String]) -> Result<CliOutcome, CliError> {
    let parsed = cli::parse(argv)?;
    let options = parsed.to_options();
    if parsed.print_config {
        let config = create_mcp_client_config(&options);
        let line = serde_json::to_string(&config).unwrap_or_else(|_| "null".into());
        println!("{line}");
        Ok(CliOutcome::PrintedConfig)
    } else {
        // IO error on stdin/stdout terminates the loop; surface it as a usage
        // error message (it is not a JSON-RPC condition).
        run_frick_mcp_stdio(&options)
            .await
            .map_err(|error| CliError(error.to_string()))?;
        Ok(CliOutcome::Served)
    }
}
