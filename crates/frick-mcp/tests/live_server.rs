//! End-to-end integration: boot a real `frick-server`, point the MCP HTTP
//! seam at it, and exercise the HTTP-calling tools (`frick_health`,
//! `frick_read_stream`) over the wire — the same path a real MCP client drives.
//!
//! This is the Rust analogue of the `packages/mcp` HTTP-call test, but against
//! a live server instead of an injected fetcher: it proves the fixed header set
//! and URL shapes are actually accepted by the Frick server.

use std::collections::BTreeMap;
use std::sync::Arc;

use frick_mcp::{FrickMcpOptions, FrickMcpServer, HttpCall, ReqwestHttpCall};
use frick_server::{create_frick_server, load_frick_config};
use serde_json::{Value, json};

/// Boot an in-memory server on an OS-assigned port and return its base URL plus
/// the running server handle (kept alive for the test's duration).
async fn boot_server() -> (String, frick_server::FrickServer) {
    let mut env = BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_HOST".to_string(), "127.0.0.1".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    let config = load_frick_config(&env).expect("config");
    let schema = frick_protocol::foundation_schema();
    let mut server = create_frick_server(config, schema).await.expect("boot");
    let port = server.listen().await.expect("listen");
    (format!("http://127.0.0.1:{port}"), server)
}

fn mcp_for(endpoint: &str, token: Option<&str>) -> FrickMcpServer {
    let http: Arc<dyn HttpCall> = Arc::new(ReqwestHttpCall::new());
    FrickMcpServer::new(
        &FrickMcpOptions {
            endpoint: Some(endpoint.to_string()),
            token: token.map(ToString::to_string),
            ..FrickMcpOptions::default()
        },
        http,
    )
}

async fn call_tool(server: &FrickMcpServer, name: &str, arguments: Value) -> Value {
    let response = server
        .handle(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": name, "arguments": arguments }
        }))
        .await
        .expect("response");
    response["result"].clone()
}

/// dev-login against the live server to obtain a session token for the
/// authenticated read.
async fn dev_login(endpoint: &str, user_id: &str) -> String {
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{endpoint}/auth/dev-login"))
        .json(&json!({ "userId": user_id }))
        .send()
        .await
        .expect("dev-login send");
    assert!(response.status().is_success(), "dev-login failed");
    let body: Value = response.json().await.expect("dev-login json");
    body["sessionToken"]
        .as_str()
        .expect("sessionToken")
        .to_string()
}

#[tokio::test]
async fn frick_health_reads_live_server() {
    let (endpoint, mut server) = boot_server().await;
    let mcp = mcp_for(&endpoint, None);

    let result = call_tool(&mcp, "frick_health", json!({})).await;
    assert_eq!(result["isError"], false);
    assert_eq!(result["structuredContent"]["ok"], true);
    assert_eq!(result["structuredContent"]["status"], "ok");
    // The pretty-printed text mirror is present.
    assert!(
        result["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("\"ok\": true")
    );

    server.close().await;
}

#[tokio::test]
async fn frick_ready_and_inspect_server_read_live_server() {
    let (endpoint, mut server) = boot_server().await;

    // /ready needs no auth.
    let unauthed = mcp_for(&endpoint, None);
    let ready = call_tool(&unauthed, "frick_ready", json!({})).await;
    assert_eq!(ready["structuredContent"]["status"], "ready");

    // /_frick/inspect/server is inspect-tier: a session token is required in
    // non-production. With a token the MCP relays the schema identity.
    let token = dev_login(&endpoint, "user-inspect").await;
    let authed = mcp_for(&endpoint, Some(&token));
    let inspect = call_tool(&authed, "frick_inspect_server", json!({})).await;
    assert_eq!(inspect["isError"], false);
    assert_eq!(inspect["structuredContent"]["schemaId"], "frick-foundation");

    // Without a token, the same tool relays the 401 as a wrapped envelope
    // rather than a JSON-RPC error.
    let denied = call_tool(&unauthed, "frick_inspect_server", json!({})).await;
    assert_eq!(denied["structuredContent"]["ok"], false);
    assert_eq!(denied["structuredContent"]["status"], 401);

    server.close().await;
}

#[tokio::test]
async fn frick_read_stream_round_trips_with_auth() {
    let (endpoint, mut server) = boot_server().await;
    let token = dev_login(&endpoint, "user-mcp").await;
    let mcp = mcp_for(&endpoint, Some(&token));

    // Reading an as-yet-unwritten stream returns the standard page envelope
    // (empty data) for an authenticated same-tenant principal.
    let result = call_tool(
        &mcp,
        "frick_read_stream",
        json!({ "stream": "feed", "key": "room-1", "limit": 10 }),
    )
    .await;
    assert_eq!(result["isError"], false);
    let page = &result["structuredContent"];
    assert_eq!(page["stream"], "feed");
    assert_eq!(page["key"], "room-1");
    assert_eq!(page["data"], json!([]));
    assert_eq!(page["hasMore"], false);

    server.close().await;
}

#[tokio::test]
async fn unauthenticated_read_stream_surfaces_non_2xx_envelope() {
    let (endpoint, mut server) = boot_server().await;
    // No token: the server rejects the read with 401; the MCP wraps it.
    let mcp = mcp_for(&endpoint, None);

    let result = call_tool(
        &mcp,
        "frick_read_stream",
        json!({ "stream": "feed", "key": "room-1" }),
    )
    .await;
    // The tool itself is not a JSON-RPC error; the wrapped body reports the
    // non-2xx status.
    assert_eq!(result["isError"], false);
    let sc = &result["structuredContent"];
    assert_eq!(sc["ok"], false);
    assert_eq!(sc["status"], 401);

    server.close().await;
}
