//! Integration test for `GET /_frick/inspect/diagnostics` (FR-76, FR-262).
//!
//! Boots a real server over a loopback socket with the public/auth/dataplane +
//! inspect routers merged (the same wiring `boot::listen` lands), logs in to get
//! an inspect-tier session, and asserts the diagnostics snapshot shape: the
//! version stamp, schema identity, the required `recentErrors` / `caches` /
//! `syncTiming` fields, and the live-server-only `source`/`env`/`capabilities`
//! block. Also covers the auth gate (no bearer → 401) and a cursor-probe query
//! degrading gracefully.

use std::sync::Arc;

use frick_protocol::FrickSchema;
use frick_server::config::load_frick_config;
use frick_server::http::{AppState, public_router};
use frick_server::routes::inspect::inspect_router;
use frick_server::{FrickConfig, create_frick_server, routes};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn test_config() -> FrickConfig {
    let mut env = std::collections::BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    load_frick_config(&env).unwrap()
}

fn test_schema() -> FrickSchema {
    frick_protocol::foundation_schema()
}

struct TestServer {
    port: u16,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
}

impl TestServer {
    async fn boot() -> Self {
        let server = create_frick_server(test_config(), test_schema())
            .await
            .unwrap();
        let state: AppState = Arc::clone(&server.state);
        std::mem::forget(server);

        let router = public_router(Arc::clone(&state))
            .merge(frick_server::auth_routes::auth_router(Arc::clone(&state)))
            .merge(routes::dataplane_router(Arc::clone(&state)))
            .merge(inspect_router(state));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let join = tokio::spawn(async move {
            let serve = axum::serve(listener, router);
            let _ = serve
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });
        Self {
            port,
            shutdown: Some(shutdown_tx),
            join: Some(join),
        }
    }

    async fn close(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
    }

    async fn login(&self, user_id: &str) -> String {
        let body = format!(r#"{{"userId":"{user_id}"}}"#);
        let response = self.request("POST", "/auth/dev-login", &[], &body).await;
        extract_json_string(&response.body, "sessionToken")
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: &str,
    ) -> HttpResponse {
        let mut stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{}", self.port))
            .await
            .unwrap();
        let mut header_block = String::new();
        for (name, value) in headers {
            header_block.push_str(name);
            header_block.push_str(": ");
            header_block.push_str(value);
            header_block.push_str("\r\n");
        }
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n{header_block}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).await.unwrap();
        HttpResponse::parse(&raw)
    }
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

struct HttpResponse {
    status: u16,
    body: String,
}

impl HttpResponse {
    fn parse(raw: &str) -> Self {
        let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((raw, ""));
        let status_line = head.split("\r\n").next().unwrap_or("");
        let status = status_line
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse::<u16>().ok())
            .unwrap_or(0);
        Self {
            status,
            body: body.to_string(),
        }
    }
}

fn extract_json_string(body: &str, key: &str) -> String {
    let needle = format!("\"{key}\":\"");
    let start = body.find(&needle).expect("key present") + needle.len();
    let rest = &body[start..];
    let end = rest.find('"').expect("closing quote");
    rest[..end].to_string()
}

/// The diagnostics snapshot: version 1, schema identity, the required fields,
/// and the live-server `source`/`env`/`capabilities` block.
#[tokio::test]
async fn diagnostics_snapshot_shape() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-inspector").await;

    let response = server
        .request(
            "GET",
            "/_frick/inspect/diagnostics",
            &[("Authorization", &bearer(&token))],
            "",
        )
        .await;
    assert_eq!(response.status, 200, "body: {}", response.body);

    let snapshot: serde_json::Value = serde_json::from_str(&response.body)
        .unwrap_or_else(|e| panic!("body is not JSON ({e}): {}", response.body));

    // Version stamp + source.
    assert_eq!(snapshot["diagnosticsVersion"], serde_json::json!(1));
    assert_eq!(snapshot["source"], serde_json::json!("server"));
    assert_eq!(snapshot["env"], serde_json::json!("test"));

    // Schema identity (the foundation schema).
    let schema = test_schema();
    assert_eq!(
        snapshot["schema"]["schemaId"],
        serde_json::json!(schema.schema_id)
    );
    assert_eq!(
        snapshot["schema"]["schemaVersion"],
        serde_json::json!(schema.schema_version)
    );
    assert_eq!(
        snapshot["schema"]["schemaRevision"],
        serde_json::json!(schema.schema_revision)
    );
    assert_eq!(
        snapshot["schema"]["schemaHash"],
        serde_json::json!(schema.hash)
    );

    // Required fields are always present.
    assert!(snapshot["recentErrors"].is_array(), "recentErrors missing");
    assert!(snapshot["caches"].is_array(), "caches missing");
    assert_eq!(
        snapshot["caches"][0]["name"],
        serde_json::json!("idempotency")
    );
    assert!(
        snapshot["syncTiming"]["snapshotAt"].is_string(),
        "syncTiming.snapshotAt missing"
    );
    assert!(
        snapshot["syncTiming"]["startedAt"].is_string(),
        "syncTiming.startedAt missing"
    );

    // Compatibility: the boot migrations match the foundation revision.
    assert_eq!(
        snapshot["compatibility"]["matched"],
        serde_json::json!(true),
        "body: {}",
        response.body
    );

    // Capabilities block (live server includes it).
    let caps = &snapshot["capabilities"];
    assert!(
        caps["transports"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("websocket")),
        "capabilities.transports missing websocket: {}",
        response.body
    );
    assert!(caps["limits"].is_object(), "capabilities.limits missing");

    server.close().await;
}

/// A cursor-probe query is parsed and degrades gracefully: an unknown stream
/// contributes nothing but the snapshot still returns 200 with a `cursors`
/// array.
#[tokio::test]
async fn diagnostics_with_cursor_probe_query() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-inspector").await;

    let response = server
        .request(
            "GET",
            "/_frick/inspect/diagnostics?cursor=messages:room-1&tenantId=_default",
            &[("Authorization", &bearer(&token))],
            "",
        )
        .await;
    assert_eq!(response.status, 200, "body: {}", response.body);
    let snapshot: serde_json::Value = serde_json::from_str(&response.body).unwrap();
    assert!(snapshot["cursors"].is_array(), "cursors missing");

    server.close().await;
}

/// The diagnostics route is gated by the inspect-tier auth like its siblings:
/// no bearer → 401.
#[tokio::test]
async fn diagnostics_requires_auth() {
    let mut server = TestServer::boot().await;
    let unauth = server
        .request("GET", "/_frick/inspect/diagnostics", &[], "")
        .await;
    assert_eq!(unauth.status, 401, "body: {}", unauth.body);
    assert!(
        unauth.body.contains("auth.unauthenticated"),
        "body: {}",
        unauth.body
    );
    server.close().await;
}
