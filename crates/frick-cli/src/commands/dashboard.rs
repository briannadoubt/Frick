//! `frick dashboard` (ported from `apps/cli/src/commands/dashboard.ts`).
//!
//! Static server for the four dev-dashboard assets with hardened CSP headers.
//! Validates `--host`/`--port`/`--endpoint`, resolves assets relative to the
//! repo root (`apps/dev-dashboard`), emits the `{ok, command, url, …}` record,
//! then blocks forever.
//!
//! The port-validation and asset-missing paths are unit-testable; the long-lived
//! accept loop only starts once the record is emitted.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::argv::ParsedArgs;
use crate::errors::{CliError, EXIT_OK};
use crate::output::Output;
use crate::paths::repo_root;

const DEFAULT_DASHBOARD_HOST: &str = "127.0.0.1";
const DEFAULT_DASHBOARD_PORT: u16 = 4299;
const DEFAULT_FRICK_ENDPOINT: &str = "http://127.0.0.1:4099";

/// `dashboardCommand`.
pub async fn dashboard_command(parsed: &ParsedArgs, out: &mut Output<'_>) -> Result<i32, CliError> {
    let host = parsed
        .flag_str("host")
        .unwrap_or(DEFAULT_DASHBOARD_HOST)
        .to_string();
    let port = parse_port_flag(parsed.flag_str("port"))?;
    let endpoint = parsed
        .flag_str("endpoint")
        .map(ToString::to_string)
        .or_else(|| std::env::var("FRICK_DASHBOARD_ENDPOINT").ok())
        .unwrap_or_else(|| DEFAULT_FRICK_ENDPOINT.to_string());
    validate_endpoint(&endpoint)?;

    let root = resolve_dashboard_root()?;

    let bind_ip: IpAddr = host.parse().unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
    let listener = TcpListener::bind(SocketAddr::new(bind_ip, port))
        .await
        .map_err(|err| CliError::failure("cli.dashboard", format!("bind failed: {err}")))?;
    let actual_port = listener.local_addr().map_or(port, |addr| addr.port());

    let display_host = if host == "0.0.0.0" || host == "::" {
        "127.0.0.1"
    } else {
        host.as_str()
    };
    let url = format!(
        "http://{display_host}:{actual_port}/?endpoint={}",
        percent_encode(&endpoint)
    );

    out.emit(&json!({
        "ok": true,
        "command": "dashboard",
        "url": url,
        "host": host,
        "port": actual_port,
        "endpoint": endpoint,
    }));

    serve_forever(listener, root).await;
    Ok(EXIT_OK)
}

fn parse_port_flag(raw: Option<&str>) -> Result<u16, CliError> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_DASHBOARD_PORT);
    };
    match raw.parse::<u16>() {
        Ok(value) => Ok(value),
        _ => Err(CliError::usage(format!(
            "--port must be an integer in [0, 65535], got {}",
            serde_json::to_string(raw).unwrap_or_else(|_| format!("\"{raw}\""))
        ))),
    }
}

fn validate_endpoint(endpoint: &str) -> Result<(), CliError> {
    if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
        Ok(())
    } else {
        Err(CliError::usage(format!(
            "--endpoint must be an HTTP(S) URL, got {}",
            serde_json::to_string(endpoint).unwrap_or_else(|_| format!("\"{endpoint}\""))
        )))
    }
}

fn resolve_dashboard_root() -> Result<PathBuf, CliError> {
    let candidates = [repo_root().join("apps").join("dev-dashboard")];
    for candidate in candidates {
        if candidate.join("index.html").exists() {
            return Ok(candidate);
        }
    }
    Err(CliError::usage(
        "dashboard assets were not found; rebuild @fricken/cli before running `frick dashboard`",
    ))
}

/// Minimal percent-encoding for the endpoint query value (matches the
/// `URLSearchParams` output the TS produces, e.g. `http%3A%2F%2F127.0.0.1%3A4199`).
fn percent_encode(value: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
}

const SECURITY_HEADERS: &str = "content-security-policy: default-src 'self'; script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; frame-src http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\r\n\
x-frame-options: DENY\r\n\
x-content-type-options: nosniff\r\n\
referrer-policy: no-referrer\r\n\
cross-origin-opener-policy: same-origin\r\n\
cross-origin-resource-policy: same-origin\r\n\
permissions-policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()\r\n\
cache-control: no-store\r\n";

async fn serve_forever(listener: TcpListener, root: PathBuf) {
    loop {
        if let Ok((stream, _)) = listener.accept().await {
            let root = root.clone();
            tokio::spawn(async move {
                let _ = handle_connection(stream, &root).await;
            });
        }
    }
}

async fn handle_connection(mut stream: TcpStream, root: &Path) -> std::io::Result<()> {
    let mut buf = [0_u8; 4096];
    let n = stream.read(&mut buf).await?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    let path = target.split('?').next().unwrap_or("/");

    if method != "GET" && method != "HEAD" {
        let body = "method not allowed";
        let response = format!(
            "HTTP/1.1 405 Method Not Allowed\r\nallow: GET, HEAD\r\ncontent-type: text/plain; charset=utf-8\r\n{SECURITY_HEADERS}content-length: {}\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await?;
        return Ok(());
    }

    let file_name = match path {
        "/" | "/index.html" => Some("index.html"),
        "/dashboard.css" => Some("dashboard.css"),
        "/dashboard.js" => Some("dashboard.js"),
        _ => None,
    };
    let Some(file_name) = file_name else {
        let body = "not found";
        let response = format!(
            "HTTP/1.1 404 Not Found\r\ncontent-type: text/plain; charset=utf-8\r\n{SECURITY_HEADERS}content-length: {}\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await?;
        return Ok(());
    };

    let content_type = match file_name {
        "index.html" => "text/html; charset=utf-8",
        "dashboard.css" => "text/css; charset=utf-8",
        _ => "text/javascript; charset=utf-8",
    };
    let body = tokio::fs::read(root.join(file_name))
        .await
        .unwrap_or_default();
    let header = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\n{SECURITY_HEADERS}content-length: {}\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).await?;
    if method != "HEAD" {
        stream.write_all(&body).await?;
    }
    Ok(())
}
