//! `frick-mcp` binary: a stdio JSON-RPC 2.0 MCP bridge to a running Frick
//! server (FR-253). Mirrors `packages/mcp/src/cli.ts`.

use std::process::ExitCode;

use frick_mcp::CliError;

#[tokio::main]
async fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match frick_mcp::run_cli(&argv).await {
        Ok(_) => ExitCode::SUCCESS,
        Err(CliError(message)) => {
            let envelope =
                serde_json::json!({ "error": { "code": "mcp.usage", "message": message } });
            eprintln!("{envelope}");
            ExitCode::from(2)
        }
    }
}
