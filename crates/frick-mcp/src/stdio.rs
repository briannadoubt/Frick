//! Newline-delimited JSON-RPC 2.0 transport over async byte streams.
//!
//! Ports `packages/mcp/src/stdio.ts`. Lines are read from `reader`, parsed,
//! dispatched through [`FrickMcpServer::handle`], and the (optional) response
//! is written back to `writer` as compact JSON + `\n`. A parse failure emits a
//! `-32700` "Parse error" envelope; a handler that returns `None`
//! (notification) produces no output.

use std::sync::Arc;

use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

use crate::config::FrickMcpOptions;
use crate::http::{HttpCall, ReqwestHttpCall};
use crate::server::FrickMcpServer;

/// Run the stdio JSON-RPC loop against real process stdio with the production
/// (reqwest) HTTP seam. Blocks until stdin reaches EOF.
///
/// This is `runFrickMcpStdio` (`stdio.ts:17-66`) wired to the standard
/// streams.
pub async fn run_frick_mcp_stdio(options: &FrickMcpOptions) -> std::io::Result<()> {
    let http: Arc<dyn HttpCall> = Arc::new(ReqwestHttpCall::new());
    let stdin = tokio::io::BufReader::new(tokio::io::stdin());
    let stdout = tokio::io::stdout();
    run_stdio_loop(options, http, stdin, stdout).await
}

/// The transport loop with injectable streams + HTTP seam (the testable core).
///
/// Mirrors `stdio.ts`: each non-empty trimmed line is parsed; on parse failure
/// a `{ id:null, code:-32700, "Parse error", data }` response is written; on
/// success the server handles it and any `Some(response)` is written. A handler
/// panic/`Err` is not possible here (dispatch is total), but to match the TS
/// `-32603` catch we keep dispatch infallible and never crash the loop.
pub async fn run_stdio_loop<R, W>(
    options: &FrickMcpOptions,
    http: Arc<dyn HttpCall>,
    reader: R,
    mut writer: W,
) -> std::io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let server = FrickMcpServer::new(options, http);
    let mut lines = reader.lines();

    while let Some(line) = lines.next_line().await? {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(message) => {
                if let Some(response) = server.handle(&message).await {
                    write_response(&mut writer, &response).await?;
                }
            }
            Err(error) => {
                let response = json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": { "code": -32700, "message": "Parse error", "data": error.to_string() },
                });
                write_response(&mut writer, &response).await?;
            }
        }
    }
    Ok(())
}

async fn write_response<W>(writer: &mut W, response: &Value) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let mut line = serde_json::to_string(response).unwrap_or_else(|_| "null".into());
    line.push('\n');
    writer.write_all(line.as_bytes()).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::MockRecordingHttp;

    async fn run_lines(input: &str) -> String {
        let options = FrickMcpOptions {
            endpoint: Some("http://127.0.0.1:4099".into()),
            ..FrickMcpOptions::default()
        };
        let http: Arc<dyn HttpCall> = Arc::new(MockRecordingHttp::default());
        let reader = tokio::io::BufReader::new(input.as_bytes());
        let mut output: Vec<u8> = Vec::new();
        run_stdio_loop(&options, http, reader, &mut output)
            .await
            .unwrap();
        String::from_utf8(output).unwrap()
    }

    #[tokio::test]
    async fn parse_error_emits_minus_32700() {
        let out = run_lines("{bad json}\n").await;
        let value: Value = serde_json::from_str(out.trim()).unwrap();
        assert_eq!(value["id"], Value::Null);
        assert_eq!(value["error"]["code"], -32700);
        assert_eq!(value["error"]["message"], "Parse error");
        assert!(value["error"]["data"].is_string());
    }

    #[tokio::test]
    async fn notification_produces_no_output() {
        let out =
            run_lines("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n").await;
        assert!(out.is_empty(), "expected no output, got {out:?}");
    }

    #[tokio::test]
    async fn blank_lines_are_skipped_and_requests_answered() {
        let input = "\n  \n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n";
        let out = run_lines(input).await;
        let value: Value = serde_json::from_str(out.trim()).unwrap();
        assert_eq!(value["id"], 1);
        assert_eq!(value["result"]["serverInfo"]["name"], "frick-mcp");
    }

    #[tokio::test]
    async fn multiple_lines_each_get_a_response() {
        let input = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n\
                     {\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"prompts/list\"}\n";
        let out = run_lines(input).await;
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2);
        let first: Value = serde_json::from_str(lines[0]).unwrap();
        let second: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(first["id"], 1);
        assert!(first.to_string().contains("frick_read_stream"));
        assert_eq!(second["id"], 2);
        assert!(second.to_string().contains("debug_frick_sync"));
    }
}
