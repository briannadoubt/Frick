//! End-to-end proof of the boot wiring (FR-243/FR-244): a single
//! `create_frick_server` serves the auth, data-plane, and gateway routers on
//! one port over one store, and an HTTP `POST /objects/...` fans out a `Delta`
//! to a WebSocket subscriber through the store-write-listener funnel.
//!
//! The gateway's own round-trip test upserts via a WS frame against a
//! hand-wired hub; this test instead drives the write through the HTTP
//! data-plane route against the boot-wired hub, exercising the integration
//! seam (`boot::create_frick_server` → `set_write_listener` → merged routers).

use std::collections::BTreeMap;

use frick_protocol::frame::{HelloPayload, SubscribePayload, SubscriptionKind};
use frick_protocol::schema::{FieldDef, FieldKind, FrickSchema, ObjectDef};
use frick_protocol::{FrickFrame, decode_frame, encode_frame};
use frick_server::{create_frick_server, load_frick_config};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as TungMessage;

#[tokio::test]
async fn http_object_upsert_fans_out_to_ws_subscriber() {
    let schema = note_schema();
    let mut server = create_frick_server(test_config(), schema.clone())
        .await
        .unwrap();
    let port = server.listen().await.unwrap();

    // Authenticate over the HTTP auth surface.
    let token = dev_login_token(port, "user-ada").await;

    // Connect to the gateway, served on the SAME port as the HTTP routes
    // (this is the integration the boot wiring provides).
    let url = format!("ws://127.0.0.1:{port}/_frick/sync");
    let (mut socket, _response) = tokio_tungstenite::connect_async(&url).await.unwrap();

    // Hello → HelloAck + Schema.
    let hello = FrickFrame::Hello(Box::new(HelloPayload {
        replica_id: "replica-1".into(),
        device_id: "device-1".into(),
        schema_hash: schema.hash.clone(),
        known_cursors: std::iter::empty::<(String, i64)>().collect(),
        session_token: Some(token.clone()),
        client_capabilities: None,
    }));
    socket
        .send(TungMessage::Binary(encode_frame(&hello).unwrap()))
        .await
        .unwrap();
    assert!(matches!(
        next_frame(&mut socket).await,
        FrickFrame::HelloAck(_)
    ));
    assert!(matches!(
        next_frame(&mut socket).await,
        FrickFrame::Schema(_)
    ));

    // Subscribe to the Note object type → empty Snapshot.
    let subscribe = FrickFrame::Subscribe(SubscribePayload {
        subscription_id: "sub-notes".into(),
        kind: SubscriptionKind::Object,
        name: "Note".into(),
        key: None,
        cursor: None,
    });
    socket
        .send(TungMessage::Binary(encode_frame(&subscribe).unwrap()))
        .await
        .unwrap();
    let frame = next_frame(&mut socket).await;
    let FrickFrame::Snapshot(snapshot) = frame else {
        panic!("expected snapshot, got {frame:?}");
    };
    assert!(snapshot.objects.is_empty());

    // Drive the write through the HTTP data-plane route (NOT a WS frame).
    let status = http_put_object(port, &token, "Note", "n1", r#"{"body":"hello"}"#).await;
    assert!(status.starts_with('2'), "upsert HTTP status was {status}");

    // The funnel must deliver a Delta carrying n1 over the socket.
    let mut saw_delta = false;
    for _ in 0..4 {
        if let FrickFrame::Delta(delta) = next_frame(&mut socket).await {
            assert_eq!(delta.objects.len(), 1);
            assert_eq!(delta.objects[0].1, "n1");
            saw_delta = true;
            break;
        }
    }
    assert!(saw_delta, "expected a Delta from the HTTP upsert funnel");

    socket.close(None).await.ok();
    server.close().await;
}

/// A registered projection driven by an HTTP object upsert fans a
/// `ProjectionDelta` to a WS projection subscriber through the boot wiring
/// (FR-245): store write → projection driver → registry.notify → delta
/// listener → gateway → subscriber.
#[tokio::test]
async fn http_upsert_drives_projection_delta_to_ws_subscriber() {
    use frick_protocol::frame::SubscriptionKind;
    use frick_server::projections::{
        FrickProjection, FrickProjectionContext, FrickProjectionHandler, FrickProjectionSource,
        FrickProjectionWriteEvent, ProjectionApplyResult,
    };

    // A projection that mirrors each Note upsert into a row keyed by object id.
    struct NoteMirror;
    impl FrickProjectionHandler for NoteMirror {
        fn apply(
            &self,
            event: &FrickProjectionWriteEvent,
            _ctx: &FrickProjectionContext,
        ) -> ProjectionApplyResult {
            match event {
                FrickProjectionWriteEvent::ObjectUpsert {
                    object_id, object, ..
                } => ProjectionApplyResult::single(object_id.clone(), Some(object.clone())),
                _ => ProjectionApplyResult::none(),
            }
        }
    }

    let schema = note_schema();
    let mut server = create_frick_server(test_config(), schema.clone())
        .await
        .unwrap();
    server
        .state
        .projections
        .register(FrickProjection::new(
            "note-mirror",
            vec![FrickProjectionSource::object("Note")],
            Box::new(NoteMirror),
        ))
        .unwrap();
    let port = server.listen().await.unwrap();
    let token = dev_login_token(port, "user-ada").await;

    let url = format!("ws://127.0.0.1:{port}/_frick/sync");
    let (mut socket, _response) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let hello = FrickFrame::Hello(Box::new(HelloPayload {
        replica_id: "replica-1".into(),
        device_id: "device-1".into(),
        schema_hash: schema.hash.clone(),
        known_cursors: std::iter::empty::<(String, i64)>().collect(),
        session_token: Some(token.clone()),
        client_capabilities: None,
    }));
    socket
        .send(TungMessage::Binary(encode_frame(&hello).unwrap()))
        .await
        .unwrap();
    assert!(matches!(
        next_frame(&mut socket).await,
        FrickFrame::HelloAck(_)
    ));
    assert!(matches!(
        next_frame(&mut socket).await,
        FrickFrame::Schema(_)
    ));

    // Subscribe to the projection → initial (empty) ProjectionDelta snapshot.
    let subscribe = FrickFrame::Subscribe(SubscribePayload {
        subscription_id: "sub-proj".into(),
        kind: SubscriptionKind::Projection,
        name: "note-mirror".into(),
        key: None,
        cursor: None,
    });
    socket
        .send(TungMessage::Binary(encode_frame(&subscribe).unwrap()))
        .await
        .unwrap();
    let FrickFrame::ProjectionDelta(snapshot) = next_frame(&mut socket).await else {
        panic!("expected initial projection snapshot");
    };
    assert_eq!(snapshot.projection, "note-mirror");
    assert!(snapshot.changes.is_empty());

    // HTTP upsert drives the projection; a live ProjectionDelta must arrive.
    let status = http_put_object(port, &token, "Note", "n1", r#"{"body":"hi"}"#).await;
    assert!(status.starts_with('2'), "upsert HTTP status was {status}");

    let mut saw = false;
    for _ in 0..4 {
        if let FrickFrame::ProjectionDelta(delta) = next_frame(&mut socket).await {
            assert_eq!(delta.projection, "note-mirror");
            assert_eq!(delta.changes.len(), 1);
            assert_eq!(delta.changes[0].key, "n1");
            // A non-nil value means upsert (nil would be a row delete).
            assert!(!delta.changes[0].value.is_nil());
            saw = true;
            break;
        }
    }
    assert!(saw, "expected a live ProjectionDelta from the HTTP upsert");

    socket.close(None).await.ok();
    server.close().await;
}

// -- helpers ----------------------------------------------------------------

fn test_config() -> frick_server::FrickConfig {
    let mut env = BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    load_frick_config(&env).unwrap()
}

fn note_schema() -> FrickSchema {
    FrickSchema {
        name: "note-app".into(),
        schema_id: "note-app".into(),
        schema_version: "0.1.0".into(),
        schema_revision: 1,
        minimum_client_revision: 1,
        minimum_server_revision: 1,
        protocol: "frick.realtime".into(),
        protocol_version: 1,
        compatibility: "greenfield-cutover".into(),
        hash: "note-app-hash-0.1.0".into(),
        objects: vec![ObjectDef {
            id: 1,
            name: "Note".into(),
            fields: vec![
                FieldDef {
                    id: 1,
                    name: "id".into(),
                    kind: FieldKind::Id,
                    required: true,
                    ref_: None,
                    enum_values: None,
                    sensitivity: None,
                },
                FieldDef {
                    id: 2,
                    name: "body".into(),
                    kind: FieldKind::String,
                    required: false,
                    ref_: None,
                    enum_values: None,
                    sensitivity: None,
                },
            ],
            indexes: vec![],
            merge_policy: None,
        }],
        streams: vec![],
        events: vec![],
        presences: vec![],
        signals: vec![],
        blobs: vec![],
        jobs: vec![],
        projections: vec![],
    }
}

async fn next_frame(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> FrickFrame {
    loop {
        match socket
            .next()
            .await
            .expect("socket open")
            .expect("ws message")
        {
            TungMessage::Binary(bytes) => {
                let frame = decode_frame(&bytes).expect("decodes");
                // Skip the gateway's application-level heartbeat Ping frames —
                // a real client would Pong/ignore them.
                if matches!(frame, FrickFrame::Ping(_)) {
                    continue;
                }
                return frame;
            }
            TungMessage::Ping(_) | TungMessage::Pong(_) => {}
            other => panic!("unexpected ws message {other:?}"),
        }
    }
}

async fn dev_login_token(port: u16, user_id: &str) -> String {
    let body = format!("{{\"userId\":\"{user_id}\"}}");
    let response = http_post(port, "/auth/dev-login", &body, None).await;
    let needle = "\"sessionToken\":\"";
    let start = response.find(needle).expect("token present") + needle.len();
    let rest = &response[start..];
    rest[..rest.find('"').unwrap()].to_string()
}

async fn http_put_object(port: u16, token: &str, ty: &str, id: &str, body: &str) -> String {
    let response = http_request(
        port,
        "PUT",
        &format!("/objects/{ty}/{id}"),
        body,
        Some(token),
    )
    .await;
    // Parse the status code out of the response line "HTTP/1.1 NNN ...".
    response
        .split_whitespace()
        .nth(1)
        .unwrap_or("000")
        .to_string()
}

async fn http_post(port: u16, path: &str, body: &str, token: Option<&str>) -> String {
    http_request(port, "POST", path, body, token).await
}

async fn http_request(
    port: u16,
    method: &str,
    path: &str,
    body: &str,
    token: Option<&str>,
) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{port}"))
        .await
        .unwrap();
    let auth = token
        .map(|t| format!("Authorization: Bearer {t}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n{auth}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    response
}
