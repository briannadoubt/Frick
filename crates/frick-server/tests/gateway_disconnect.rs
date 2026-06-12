//! Integration tests for the live WebSocket disconnect on session revocation
//! (FR-278). These boot a full [`FrickServer`] (so the gateway router is merged
//! AND the hub is attached to `AppState`), open a real authenticated WebSocket,
//! then revoke the session over HTTP (logout / admin `sessions/revoke`) and
//! assert the socket is live-closed with a policy-violation close.
//!
//! Coverage:
//!   - a logged-out session's live WS is closed;
//!   - the admin `sessions/revoke` `disconnected` count reflects the real
//!     number of closed connections;
//!   - inspect requires admin-token auth in production.

use std::time::Duration;

use frick_protocol::frame::HelloPayload;
use frick_protocol::{FrickFrame, FrickSchema, decode_frame, encode_frame};
use frick_schema::SchemaBuilder;
use frick_schema::builder::field;
use frick_server::config::load_frick_config;
use frick_server::{FrickConfig, FrickServer, create_frick_server};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message as TungMessage;

const ADMIN_TOKEN: &str = "0123456789012345678901234567890123"; // 34 chars (>=32)

fn test_schema() -> FrickSchema {
    SchemaBuilder::new("disconnect-test", "disconnect-test")
        .hash("disconnect-test-hash")
        .object("Note", 1, |o| o.field(field::string("body", 1)))
        .build()
        .expect("test schema validates")
}

fn test_config(admin_token: Option<&str>) -> FrickConfig {
    let mut env = std::collections::BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    if let Some(token) = admin_token {
        env.insert("FRICK_ADMIN_TOKEN".to_string(), token.to_string());
    }
    load_frick_config(&env).unwrap()
}

/// Boot a full server (gateway merged + attached) and start listening.
async fn boot(admin_token: Option<&str>) -> (FrickServer, u16) {
    let mut server = create_frick_server(test_config(admin_token), test_schema())
        .await
        .unwrap();
    let port = server.listen().await.unwrap();
    (server, port)
}

/// Dev-login over the HTTP surface, returning the session token.
async fn dev_login(port: u16, user_id: &str) -> String {
    let body = format!(r#"{{"userId":"{user_id}"}}"#);
    let response = http_request(port, "POST", "/auth/dev-login", &[], Some(&body)).await;
    extract_json_string(&response.1, "sessionToken")
}

/// Open an authenticated WebSocket: connect, Hello with the token, drain the
/// HelloAck + Schema frames. Returns the live socket.
async fn open_authenticated_ws(
    port: u16,
    token: &str,
    schema: &FrickSchema,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let url = format!("ws://127.0.0.1:{port}/_frick/sync");
    let (mut socket, _response) = tokio_tungstenite::connect_async(&url).await.unwrap();

    let hello = FrickFrame::Hello(Box::new(HelloPayload {
        replica_id: "replica-1".into(),
        device_id: "device-1".into(),
        schema_hash: schema.hash.clone(),
        known_cursors: std::iter::empty::<(String, i64)>().collect(),
        session_token: Some(token.to_string()),
        client_capabilities: None,
    }));
    socket
        .send(TungMessage::Binary(encode_frame(&hello).unwrap()))
        .await
        .unwrap();

    // HelloAck then Schema.
    let ack = next_frame(&mut socket).await;
    assert!(matches!(ack, FrickFrame::HelloAck(_)), "got {ack:?}");
    let schema_frame = next_frame(&mut socket).await;
    assert!(
        matches!(schema_frame, FrickFrame::Schema(_)),
        "got {schema_frame:?}"
    );
    socket
}

/// Drain frames until a Close arrives (skipping server pings), returning its
/// code. Panics if the socket ends or times out without a Close.
async fn wait_for_close(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> u16 {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("a close within timeout")
            .expect("a message")
            .expect("an ok message");
        match message {
            TungMessage::Close(Some(frame)) => return frame.code.into(),
            TungMessage::Close(None) => panic!("close with no frame"),
            // Server heartbeat pings / data frames before the close: ignore.
            TungMessage::Binary(_) | TungMessage::Ping(_) | TungMessage::Pong(_) => {}
            other => panic!("unexpected ws message before close: {other:?}"),
        }
    }
}

/// Read the next decoded frame off the socket, skipping server pings.
async fn next_frame(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> FrickFrame {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("frame within timeout")
            .expect("a message")
            .expect("an ok message");
        match message {
            TungMessage::Binary(bytes) => {
                let frame = decode_frame(&bytes).unwrap();
                if matches!(frame, FrickFrame::Ping(_)) {
                    continue;
                }
                return frame;
            }
            TungMessage::Ping(_) | TungMessage::Pong(_) => {}
            TungMessage::Close(frame) => panic!("socket closed early: {frame:?}"),
            other => panic!("unexpected ws message {other:?}"),
        }
    }
}

/// 1008 policy-violation, the gateway's revoke close code (`gateway::close`).
const POLICY_VIOLATION: u16 = 1008;

/// A logged-out session's live WebSocket is closed (1008).
#[tokio::test]
async fn logout_closes_the_live_websocket() {
    let schema = test_schema();
    let (mut server, port) = boot(None).await;
    let token = dev_login(port, "user-logout").await;
    let mut socket = open_authenticated_ws(port, &token, &schema).await;

    // Log out over HTTP with the bearer header.
    let bearer = format!("Bearer {token}");
    let logout = http_request(
        port,
        "POST",
        "/auth/logout",
        &[("Authorization", &bearer)],
        None,
    )
    .await;
    assert_eq!(logout.0, 200, "logout body: {}", logout.1);

    // The socket is live-closed with a policy-violation code.
    let code = wait_for_close(&mut socket).await;
    assert_eq!(code, POLICY_VIOLATION, "logout should 1008 the socket");

    server.close().await;
}

/// The admin `sessions/revoke` reports the real number of closed connections,
/// and the targeted socket is live-closed.
#[tokio::test]
async fn admin_revoke_disconnects_live_connections_with_real_count() {
    let schema = test_schema();
    let (mut server, port) = boot(Some(ADMIN_TOKEN)).await;

    // Two live connections for the same user (two devices / sessions).
    let token_a = dev_login(port, "user-target").await;
    let token_b = dev_login(port, "user-target").await;
    let mut socket_a = open_authenticated_ws(port, &token_a, &schema).await;
    let mut socket_b = open_authenticated_ws(port, &token_b, &schema).await;

    // A third connection for a DIFFERENT user must survive.
    let token_other = dev_login(port, "user-bystander").await;
    let mut socket_other = open_authenticated_ws(port, &token_other, &schema).await;

    // Revoke every session for user-target.
    let admin_bearer = format!("Bearer {ADMIN_TOKEN}");
    let revoke = http_request(
        port,
        "POST",
        "/_frick/admin/sessions/revoke",
        &[("Authorization", &admin_bearer)],
        Some(r#"{"userId":"user-target"}"#),
    )
    .await;
    assert_eq!(revoke.0, 200, "revoke body: {}", revoke.1);
    // Both target sockets were closed → disconnected:2.
    assert!(
        revoke.1.contains("\"disconnected\":2"),
        "expected disconnected:2, body: {}",
        revoke.1
    );
    assert!(
        revoke.1.contains("\"revoked\":2"),
        "expected revoked:2, body: {}",
        revoke.1
    );

    // Both target sockets are live-closed.
    assert_eq!(wait_for_close(&mut socket_a).await, POLICY_VIOLATION);
    assert_eq!(wait_for_close(&mut socket_b).await, POLICY_VIOLATION);

    // The bystander stays open: a ping round-trips without a close.
    socket_other
        .send(TungMessage::Binary(
            encode_frame(&FrickFrame::Ping(frick_protocol::frame::PingPayload {
                sent_at: 1,
            }))
            .unwrap(),
        ))
        .await
        .unwrap();
    let pong = next_frame(&mut socket_other).await;
    assert!(
        matches!(pong, FrickFrame::Pong(_)),
        "bystander should still be live, got {pong:?}"
    );

    server.close().await;
}

/// Admin `sessions/revoke` by a single token closes only that connection.
#[tokio::test]
async fn admin_revoke_by_token_closes_one_connection() {
    let schema = test_schema();
    let (mut server, port) = boot(Some(ADMIN_TOKEN)).await;

    let token = dev_login(port, "user-bytoken").await;
    let mut socket = open_authenticated_ws(port, &token, &schema).await;

    let admin_bearer = format!("Bearer {ADMIN_TOKEN}");
    let body = format!(r#"{{"sessionToken":"{token}"}}"#);
    let revoke = http_request(
        port,
        "POST",
        "/_frick/admin/sessions/revoke",
        &[("Authorization", &admin_bearer)],
        Some(&body),
    )
    .await;
    assert_eq!(revoke.0, 200, "revoke body: {}", revoke.1);
    assert!(
        revoke.1.contains("\"disconnected\":1"),
        "expected disconnected:1, body: {}",
        revoke.1
    );

    assert_eq!(wait_for_close(&mut socket).await, POLICY_VIOLATION);
    server.close().await;
}

// ---- inspect admin-token auth (FR-278) --------------------------------------

/// In a non-production env the inspect tier accepts the configured admin token
/// (in addition to any active session). Proves the admin-token seam is wired.
#[tokio::test]
async fn inspect_accepts_admin_token() {
    let (mut server, port) = boot(Some(ADMIN_TOKEN)).await;
    let admin_bearer = format!("Bearer {ADMIN_TOKEN}");
    let info = http_request(
        port,
        "GET",
        "/_frick/inspect/server",
        &[("Authorization", &admin_bearer)],
        None,
    )
    .await;
    assert_eq!(
        info.0, 200,
        "admin token should authorize inspect: {}",
        info.1
    );
    assert!(info.1.contains("\"schemaId\""), "body: {}", info.1);
    server.close().await;
}

/// Inspect with no auth → 401, even with an admin token configured.
#[tokio::test]
async fn inspect_requires_auth() {
    let (mut server, port) = boot(Some(ADMIN_TOKEN)).await;
    let unauth = http_request(port, "GET", "/_frick/inspect/server", &[], None).await;
    assert_eq!(unauth.0, 401, "body: {}", unauth.1);
    assert!(
        unauth.1.contains("auth.unauthenticated"),
        "body: {}",
        unauth.1
    );
    server.close().await;
}

/// In PRODUCTION the inspect tier requires the admin token: a non-admin bearer
/// is rejected (401), and the admin token authorizes (200). Booted with a real
/// temp-file DB and inspection explicitly enabled (production defaults it OFF).
#[tokio::test]
async fn inspect_in_production_requires_admin_token() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("frick.sqlite");
    let mut env = std::collections::BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "production".to_string());
    env.insert(
        "FRICK_DB_PATH".to_string(),
        db_path.to_string_lossy().to_string(),
    );
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    env.insert("FRICK_ADMIN_TOKEN".to_string(), ADMIN_TOKEN.to_string());
    env.insert("FRICK_INSPECTION_ENABLED".to_string(), "true".to_string());
    let config = load_frick_config(&env).unwrap();
    assert!(config.env.is_production());

    let mut server = create_frick_server(config, test_schema()).await.unwrap();
    let port = server.listen().await.unwrap();

    // A non-admin bearer is rejected in production (a session token would be too,
    // but demo-auth is off here so any bearer is non-admin).
    let bogus = http_request(
        port,
        "GET",
        "/_frick/inspect/server",
        &[("Authorization", "Bearer not-the-admin-token")],
        None,
    )
    .await;
    assert_eq!(
        bogus.0, 401,
        "production inspect needs the admin token: {}",
        bogus.1
    );
    assert!(
        bogus.1.contains("auth.unauthenticated"),
        "body: {}",
        bogus.1
    );

    // The admin token authorizes.
    let admin_bearer = format!("Bearer {ADMIN_TOKEN}");
    let ok = http_request(
        port,
        "GET",
        "/_frick/inspect/server",
        &[("Authorization", &admin_bearer)],
        None,
    )
    .await;
    assert_eq!(ok.0, 200, "admin token should authorize: {}", ok.1);

    server.close().await;
}

// ---- HTTP helper ------------------------------------------------------------

/// A raw HTTP/1.1 request over loopback, returning `(status, body)`.
async fn http_request(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> (u16, String) {
    let mut stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{port}"))
        .await
        .unwrap();
    let mut header_block = String::new();
    for (name, value) in headers {
        header_block.push_str(name);
        header_block.push_str(": ");
        header_block.push_str(value);
        header_block.push_str("\r\n");
    }
    let request = match body {
        Some(body) => format!(
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n{header_block}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ),
        None => format!(
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\n{header_block}Connection: close\r\n\r\n"
        ),
    };
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut raw = String::new();
    stream.read_to_string(&mut raw).await.unwrap();
    let (head, resp_body) = raw.split_once("\r\n\r\n").unwrap_or((&raw, ""));
    let status = head
        .split("\r\n")
        .next()
        .unwrap_or("")
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    (status, resp_body.to_string())
}

fn extract_json_string(body: &str, key: &str) -> String {
    let needle = format!("\"{key}\":\"");
    let start = body.find(&needle).expect("key present") + needle.len();
    let rest = &body[start..];
    let end = rest.find('"').expect("closing quote");
    rest[..end].to_string()
}
