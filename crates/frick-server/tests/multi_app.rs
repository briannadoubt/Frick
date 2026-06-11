//! Multi-app routing + isolation integration tests (FR-277, map 02 §10).
//!
//! These boot a genuine 2-app server through the real boot path
//! ([`create_frick_server_with_apps`] + [`FrickServer::listen`]), so the
//! `app_resolution_layer` middleware, the per-app store partitioning, the WS
//! Hello app routing, and the per-app registries are all exercised exactly as
//! production wires them — there is no hand-rolled router here.
//!
//! What they prove:
//! - **HTTP isolation**: an object written under app A (`PUT /a/objects/...`) is
//!   NOT visible to an app-B reader (`GET /b/objects?type=...`) and vice-versa,
//!   even for the same tenant/owner. The storage `app_id` partition is the
//!   boundary.
//! - **WS Hello app routing**: a Hello advertising app A's `schemaId` binds the
//!   connection to app A; an advertised schemaId that matches no registered app
//!   is rejected with `auth.forbidden` / `appNotAuthorized`
//!   (tenant-app-isolation-4).
//! - **Inspect**: `GET /_frick/inspect/apps` lists both apps with their
//!   `{id, basePath, schemaId, schemaRevision}`.

use std::time::Duration;

use frick_protocol::capabilities::default_client_capabilities;
use frick_protocol::frame::HelloPayload;
use frick_protocol::{FrickClientPlatform, FrickFrame, FrickSchema, decode_frame, encode_frame};
use frick_schema::SchemaBuilder;
use frick_schema::builder::field;
use frick_server::config::load_frick_config;
use frick_server::{
    AppDefinition, BootSeams, FrickConfig, FrickServer, create_frick_server_with_apps,
};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message as TungMessage;

fn test_config() -> FrickConfig {
    let mut env = std::collections::BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    // The inspect surface is gated on this; default-off in production.
    env.insert("FRICK_INSPECTION_ENABLED".to_string(), "true".to_string());
    load_frick_config(&env).unwrap()
}

/// A `Note { body }` schema with the given id/hash. Both apps share structure so
/// the Hello compatibility check passes; only the `schema_id` / `hash` differ so
/// `find_by_schema_id` distinguishes them.
fn app_schema(id: &str) -> FrickSchema {
    SchemaBuilder::new(id, id)
        .hash(format!("{id}-hash"))
        .object("Note", 1, |o| o.field(field::string("body", 1).required()))
        .build()
        .expect("app schema validates")
}

/// Boot a genuine 2-app server: app A at `/a` (schema `app-a`), app B at `/b`
/// (schema `app-b`). Neither app is the root, so the lifecycle/auth/ws/inspect
/// paths resolve to no app (path untouched) and the data plane is reached only
/// under `/a/*` and `/b/*`.
async fn boot_two_app_server() -> FrickServer {
    let apps = vec![
        AppDefinition::new("app-a", "/a", app_schema("app-a")),
        AppDefinition::new("app-b", "/b", app_schema("app-b")),
    ];
    let mut server = create_frick_server_with_apps(
        test_config(),
        // The STORE schema must declare every object type the apps write (the
        // store validates writes against it). Both apps share the `Note`
        // structure, so a single store schema covers them. HTTP error envelopes
        // still carry the foundation hash/revision regardless (map 02 §13.3) —
        // that is stamped from the foundation constant, not this schema.
        app_schema("store"),
        apps,
        BootSeams::production(),
    )
    .await
    .expect("two-app server boots");
    server.listen().await.expect("server listens");
    server
}

#[tokio::test]
async fn http_writes_are_isolated_per_app() {
    let mut server = boot_two_app_server().await;
    let port = server.port();
    let token = dev_login(port, "user-ada").await;

    // Write a Note under app A.
    let create = http(
        port,
        "PUT",
        "/a/objects/Note/note-a",
        &[("Authorization", &bearer(&token))],
        r#"{"body":"from-app-a"}"#,
    )
    .await;
    assert_eq!(create.status, 201, "app A create body: {}", create.body);

    // Write a separate Note under app B.
    let create_b = http(
        port,
        "PUT",
        "/b/objects/Note/note-b",
        &[("Authorization", &bearer(&token))],
        r#"{"body":"from-app-b"}"#,
    )
    .await;
    assert_eq!(create_b.status, 201, "app B create body: {}", create_b.body);

    // App A sees only its own write.
    let list_a = http(
        port,
        "GET",
        "/a/objects?type=Note",
        &[("Authorization", &bearer(&token))],
        "",
    )
    .await;
    assert_eq!(list_a.status, 200, "app A list body: {}", list_a.body);
    assert!(
        list_a.body.contains("from-app-a"),
        "app A must see its own note: {}",
        list_a.body
    );
    assert!(
        !list_a.body.contains("from-app-b"),
        "ISOLATION BREACH: app A saw app B's note: {}",
        list_a.body
    );

    // App B sees only its own write.
    let list_b = http(
        port,
        "GET",
        "/b/objects?type=Note",
        &[("Authorization", &bearer(&token))],
        "",
    )
    .await;
    assert_eq!(list_b.status, 200, "app B list body: {}", list_b.body);
    assert!(
        list_b.body.contains("from-app-b"),
        "app B must see its own note: {}",
        list_b.body
    );
    assert!(
        !list_b.body.contains("from-app-a"),
        "ISOLATION BREACH: app B saw app A's note: {}",
        list_b.body
    );

    // Cross-app write guard: app B cannot overwrite a row owned by app A (the
    // store rejects a write to an id another app already owns).
    let cross = http(
        port,
        "PUT",
        "/b/objects/Note/note-a",
        &[("Authorization", &bearer(&token))],
        r#"{"body":"app-b-trespass"}"#,
    )
    .await;
    assert_eq!(
        cross.status, 400,
        "cross-app overwrite must be rejected: {}",
        cross.body
    );
    assert!(
        cross.body.contains("Cross-app access denied"),
        "expected a cross-app guard error: {}",
        cross.body
    );

    server.close().await;
}

#[tokio::test]
async fn inspect_apps_lists_both_apps() {
    let mut server = boot_two_app_server().await;
    let port = server.port();
    let token = dev_login(port, "user-ada").await;

    let response = http(
        port,
        "GET",
        "/_frick/inspect/apps",
        &[("Authorization", &bearer(&token))],
        "",
    )
    .await;
    assert_eq!(response.status, 200, "inspect body: {}", response.body);

    // Both app descriptors are present with their base paths + schema ids.
    for (id, base_path, schema_id) in [("app-a", "/a", "app-a"), ("app-b", "/b", "app-b")] {
        assert!(
            response.body.contains(&format!("\"id\":\"{id}\"")),
            "missing app id {id}: {}",
            response.body
        );
        assert!(
            response
                .body
                .contains(&format!("\"basePath\":\"{base_path}\"")),
            "missing basePath {base_path}: {}",
            response.body
        );
        assert!(
            response
                .body
                .contains(&format!("\"schemaId\":\"{schema_id}\"")),
            "missing schemaId {schema_id}: {}",
            response.body
        );
    }

    server.close().await;
}

#[tokio::test]
async fn ws_hello_binds_to_advertised_app_and_isolates_reads() {
    let mut server = boot_two_app_server().await;
    let port = server.port();
    let token = dev_login(port, "user-ada").await;

    // Seed a Note under app A over HTTP.
    let create = http(
        port,
        "PUT",
        "/a/objects/Note/note-ws",
        &[("Authorization", &bearer(&token))],
        r#"{"body":"a-only"}"#,
    )
    .await;
    assert_eq!(create.status, 201, "seed body: {}", create.body);

    let url = format!("ws://127.0.0.1:{port}/_frick/sync");

    // A Hello advertising app A's schemaId binds to app A: a subscribe snapshot
    // for `Note` returns app A's seeded row.
    {
        let (mut socket, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        send_hello(&mut socket, &token, &app_schema("app-a")).await;
        expect_hello_ack_then_schema(&mut socket).await;

        let snapshot = subscribe_objects(&mut socket, "sub-a", "Note").await;
        let FrickFrame::Snapshot(snapshot) = snapshot else {
            panic!("expected a snapshot, got {snapshot:?}");
        };
        assert_eq!(snapshot.subscription_id, "sub-a");
        assert_eq!(
            snapshot.objects.len(),
            1,
            "app-A-bound connection must see app A's note"
        );
        assert_eq!(snapshot.objects[0].1, "note-ws");
        socket.close(None).await.ok();
    }

    // A Hello advertising app B's schemaId binds to app B: the same `Note`
    // subscribe snapshot is EMPTY — app A's row is not visible.
    {
        let (mut socket, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        send_hello(&mut socket, &token, &app_schema("app-b")).await;
        expect_hello_ack_then_schema(&mut socket).await;

        let snapshot = subscribe_objects(&mut socket, "sub-b", "Note").await;
        let FrickFrame::Snapshot(snapshot) = snapshot else {
            panic!("expected a snapshot, got {snapshot:?}");
        };
        assert!(
            snapshot.objects.is_empty(),
            "ISOLATION BREACH: app-B-bound connection saw app A's note: {:?}",
            snapshot.objects
        );
        socket.close(None).await.ok();
    }

    server.close().await;
}

#[tokio::test]
async fn ws_hello_rejects_unregistered_schema_id() {
    let mut server = boot_two_app_server().await;
    let port = server.port();
    let token = dev_login(port, "user-ada").await;

    let url = format!("ws://127.0.0.1:{port}/_frick/sync");
    let (mut socket, _) = tokio_tungstenite::connect_async(&url).await.unwrap();

    // Advertise a schemaId that matches no registered app and isn't the store
    // schema id → Nack auth.forbidden reason appNotAuthorized.
    send_hello(&mut socket, &token, &app_schema("app-unknown")).await;

    let frame = next_frame(&mut socket).await;
    let FrickFrame::Nack(nack) = frame else {
        panic!("expected a Nack for an unregistered schemaId, got {frame:?}");
    };
    assert_eq!(
        nack.error.code,
        frick_protocol::FrickErrorCode::AuthForbidden,
        "expected auth.forbidden, got {:?}",
        nack.error.code
    );
    // The reason rides `details.reason = appNotAuthorized`.
    let details = format!("{:?}", nack.error.details);
    assert!(
        details.contains("appNotAuthorized"),
        "expected appNotAuthorized in details, got {details}"
    );

    socket.close(None).await.ok();
    server.close().await;
}

// ── WS helpers ───────────────────────────────────────────────────────────────

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn send_hello(socket: &mut WsStream, token: &str, schema: &FrickSchema) {
    let caps = default_client_capabilities(FrickClientPlatform::Web, "test-sdk", schema);
    let hello = FrickFrame::Hello(Box::new(HelloPayload {
        replica_id: "replica-1".into(),
        device_id: "device-1".into(),
        schema_hash: schema.hash.clone(),
        known_cursors: std::iter::empty::<(String, i64)>().collect(),
        session_token: Some(token.to_string()),
        client_capabilities: Some(caps),
    }));
    socket
        .send(TungMessage::Binary(encode_frame(&hello).unwrap()))
        .await
        .unwrap();
}

async fn expect_hello_ack_then_schema(socket: &mut WsStream) {
    let ack = next_frame(socket).await;
    assert!(matches!(ack, FrickFrame::HelloAck(_)), "got {ack:?}");
    let schema = next_frame(socket).await;
    assert!(matches!(schema, FrickFrame::Schema(_)), "got {schema:?}");
}

async fn subscribe_objects(socket: &mut WsStream, sub_id: &str, name: &str) -> FrickFrame {
    use frick_protocol::frame::{SubscribePayload, SubscriptionKind};
    let subscribe = FrickFrame::Subscribe(SubscribePayload {
        subscription_id: sub_id.into(),
        kind: SubscriptionKind::Object,
        name: name.into(),
        key: None,
        cursor: None,
    });
    socket
        .send(TungMessage::Binary(encode_frame(&subscribe).unwrap()))
        .await
        .unwrap();
    next_frame(socket).await
}

async fn next_frame(socket: &mut WsStream) -> FrickFrame {
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
            TungMessage::Close(frame) => panic!("socket closed: {frame:?}"),
            other => panic!("unexpected ws message {other:?}"),
        }
    }
}

// ── HTTP helpers (raw HTTP/1.1 over a fresh socket, mirroring dataplane.rs) ───

struct HttpResponse {
    status: u16,
    body: String,
}

async fn dev_login(port: u16, user_id: &str) -> String {
    let body = format!(r#"{{"userId":"{user_id}"}}"#);
    let response = http(port, "POST", "/auth/dev-login", &[], &body).await;
    extract_json_string(&response.body, "sessionToken")
}

async fn http(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> HttpResponse {
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
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n{header_block}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut raw = String::new();
    stream.read_to_string(&mut raw).await.unwrap();
    parse_http(&raw)
}

fn parse_http(raw: &str) -> HttpResponse {
    let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((raw, ""));
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    HttpResponse {
        status,
        body: body.to_string(),
    }
}

fn extract_json_string(body: &str, key: &str) -> String {
    let needle = format!("\"{key}\":\"");
    let start = body.find(&needle).expect("key present") + needle.len();
    let rest = &body[start..];
    let end = rest.find('"').expect("closing quote");
    rest[..end].to_string()
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}
