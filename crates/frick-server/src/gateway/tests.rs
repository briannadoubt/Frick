//! Gateway tests: handshake-gate + dispatch decisions on synthesized frames,
//! plus a real WebSocket round-trip (dev-login → Hello → HelloAck+Schema →
//! Subscribe object → ObjectUpsert → Delta).

use std::collections::BTreeMap;
use std::time::Duration;

use frick_protocol::frame::{
    HelloPayload, ObjectUpsertPayload, SubscribePayload, SubscriptionKind,
};
use frick_protocol::schema::{FieldDef, FieldKind, ObjectDef};
use frick_protocol::{FrickFrame, FrickSchema, Value, decode_frame, encode_frame};
use tokio_tungstenite::tungstenite::Message as TungMessage;

use super::*;
use crate::boot::create_frick_server;
use crate::config::{FrickConfig, load_frick_config};
use crate::http::AppStateInner;
use crate::principal::DEFAULT_TENANT_ID;

// ---- pure unit tests (no socket) --------------------------------------------

#[test]
fn pre_hello_request_id_extracts_per_kind() {
    let subscribe = FrickFrame::Subscribe(SubscribePayload {
        subscription_id: "sub-1".into(),
        kind: SubscriptionKind::Object,
        name: "Note".into(),
        key: None,
        cursor: None,
    });
    assert_eq!(super::pre_hello_request_id(&subscribe), "sub-1");

    let upsert = FrickFrame::ObjectUpsert(ObjectUpsertPayload {
        request_id: "req-9".into(),
        object_type: "Note".into(),
        object_id: "n1".into(),
        value: Value::Map(vec![]),
        expected_version: None,
    });
    assert_eq!(super::pre_hello_request_id(&upsert), "req-9");

    // A frame kind with no natural request id falls back to "pre-hello".
    let ping = FrickFrame::Ping(frick_protocol::frame::PingPayload { sent_at: 0 });
    assert_eq!(super::pre_hello_request_id(&ping), "pre-hello");
}

#[test]
fn subscribe_action_maps_each_kind() {
    assert_eq!(
        super::subscribe_action(SubscriptionKind::Object),
        Action::ObjectRead
    );
    assert_eq!(
        super::subscribe_action(SubscriptionKind::Stream),
        Action::StreamRead
    );
    assert_eq!(
        super::subscribe_action(SubscriptionKind::Presence),
        Action::PresenceRead
    );
    assert_eq!(
        super::subscribe_action(SubscriptionKind::Signal),
        Action::SignalRead
    );
}

#[test]
fn auth_nack_uses_unauthenticated_code_for_unauthenticated_reason() {
    // Build the hub over a state whose schema is the foundation so we can
    // synthesize an enqueued frame and read it back off the outbound channel.
    let nack = super::simple_nack(
        FrickErrorCode::AuthForbidden,
        "nope",
        "req-1",
        false,
        Some(Value::Map(vec![("reason".into(), "ownerMismatch".into())])),
        None,
    );
    let FrickFrame::Nack(payload) = nack else {
        panic!("expected nack");
    };
    // Code/message are duplicated at the payload top level.
    assert_eq!(payload.code, Some(FrickErrorCode::AuthForbidden));
    assert_eq!(payload.message.as_deref(), Some("nope"));
    assert_eq!(payload.error.code, FrickErrorCode::AuthForbidden);
    assert_eq!(payload.request_id, "req-1");
}

#[test]
fn handshake_gate_rejects_non_hello_frames_before_hello() {
    // Drive a synthesized connection through the dispatch gate by registering a
    // connection and calling `handle_raw_frame` with a Subscribe before Hello.
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let hub = test_hub().await;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<super::Outbound>();
        let id = hub.register(super::Connection {
            principal: None,
            session_token: None,
            app_id: DEFAULT_APP_ID.to_string(),
            handshake_complete: false,
            subscriptions: std::collections::HashSet::new(),
            pending_writes: 0,
            outbound: tx,
        });

        let frame = FrickFrame::Subscribe(SubscribePayload {
            subscription_id: "sub-x".into(),
            kind: SubscriptionKind::Object,
            name: "Note".into(),
            key: None,
            cursor: None,
        });
        let bytes = encode_frame(&frame).unwrap();
        let close = super::handle_raw_frame(&hub, id, &bytes).await;
        assert!(!close, "a gated subscribe should not close the connection");

        let out = rx.try_recv().expect("a nack frame");
        let super::Outbound::Frame(bytes) = out else {
            panic!("expected a frame");
        };
        let FrickFrame::Nack(nack) = decode_frame(&bytes).unwrap() else {
            panic!("expected nack");
        };
        assert_eq!(nack.error.code, FrickErrorCode::SyncProtocolError);
        assert_eq!(nack.request_id, "sub-x");
        // reason handshakeRequired in details.
        let Some(Value::Map(details)) = &nack.error.details else {
            panic!("details map");
        };
        assert!(
            details
                .iter()
                .any(|(k, v)| k.as_str() == Some("reason")
                    && v.as_str() == Some("handshakeRequired"))
        );
    });
}

#[test]
fn ping_is_allowed_pre_hello_and_pongs() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let hub = test_hub().await;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<super::Outbound>();
        let id = hub.register(super::Connection {
            principal: None,
            session_token: None,
            app_id: DEFAULT_APP_ID.to_string(),
            handshake_complete: false,
            subscriptions: std::collections::HashSet::new(),
            pending_writes: 0,
            outbound: tx,
        });
        let bytes = encode_frame(&FrickFrame::Ping(frick_protocol::frame::PingPayload {
            sent_at: 7,
        }))
        .unwrap();
        super::handle_raw_frame(&hub, id, &bytes).await;
        let super::Outbound::Frame(bytes) = rx.try_recv().expect("a pong") else {
            panic!("expected a frame");
        };
        let FrickFrame::Pong(pong) = decode_frame(&bytes).unwrap() else {
            panic!("expected pong");
        };
        assert_eq!(pong.sent_at, 7);
    });
}

#[test]
fn store_write_listener_fans_out_object_upsert_to_subscriber() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let hub = test_hub().await;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<super::Outbound>();
        let principal = Principal {
            user_id: "user-ada".into(),
            device_id: "d".into(),
            replica_id: "r".into(),
            tenant_id: DEFAULT_TENANT_ID.to_string(),
            scope: crate::principal::PrincipalScope::Tenant,
            service_scopes: vec![],
        };
        let id = hub.register(super::Connection {
            principal: Some(principal),
            session_token: None,
            app_id: DEFAULT_APP_ID.to_string(),
            handshake_complete: true,
            subscriptions: [super::SubKey {
                subscription_id: "sub-notes".into(),
                kind: SubscriptionKind::Object,
                name: "Note".into(),
                key: None,
            }]
            .into_iter()
            .collect(),
            pending_writes: 0,
            outbound: tx,
        });
        let _ = id;

        // Fire the funnel directly (the integrator wires this to the store).
        hub.handle_store_write(&FrickStoreWriteEvent::ObjectUpsert {
            tenant_id: DEFAULT_TENANT_ID.to_string(),
            app_id: DEFAULT_APP_ID.to_string(),
            object_type: "Note".into(),
            object_id: "n1".into(),
            object: note_value("n1", "hi"),
        });

        let super::Outbound::Frame(bytes) = rx.try_recv().expect("a delta") else {
            panic!("expected a frame");
        };
        let FrickFrame::Delta(delta) = decode_frame(&bytes).unwrap() else {
            panic!("expected delta");
        };
        assert_eq!(delta.objects.len(), 1);
        assert_eq!(delta.objects[0].1, "n1");
    });
}

#[test]
fn store_write_listener_skips_other_tenant() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let hub = test_hub().await;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<super::Outbound>();
        let principal = Principal {
            user_id: "user-ada".into(),
            device_id: "d".into(),
            replica_id: "r".into(),
            tenant_id: DEFAULT_TENANT_ID.to_string(),
            scope: crate::principal::PrincipalScope::Tenant,
            service_scopes: vec![],
        };
        hub.register(super::Connection {
            principal: Some(principal),
            session_token: None,
            app_id: DEFAULT_APP_ID.to_string(),
            handshake_complete: true,
            subscriptions: [super::SubKey {
                subscription_id: "sub-notes".into(),
                kind: SubscriptionKind::Object,
                name: "Note".into(),
                key: None,
            }]
            .into_iter()
            .collect(),
            pending_writes: 0,
            outbound: tx,
        });

        // A write under a DIFFERENT tenant must not reach this subscriber.
        hub.handle_store_write(&FrickStoreWriteEvent::ObjectUpsert {
            tenant_id: "tenant-other".into(),
            app_id: DEFAULT_APP_ID.to_string(),
            object_type: "Note".into(),
            object_id: "n1".into(),
            object: note_value("n1", "hi"),
        });
        assert!(
            rx.try_recv().is_err(),
            "cross-tenant write should not fan out"
        );
    });
}

// ---- WebSocket round-trip ---------------------------------------------------

/// Boot a server, open a real ws client, dev-login, Hello → HelloAck+Schema,
/// subscribe to an object type, upsert, and assert the Delta arrives.
#[tokio::test]
async fn ws_round_trip_hello_subscribe_upsert_delta() {
    use futures_util::SinkExt;

    let schema = note_schema();
    let mut server = create_frick_server(test_config(), schema.clone())
        .await
        .unwrap();

    // Build the hub over the SAME app state the server serves, merge its router
    // onto a fresh listener, and register the write listener — this mirrors the
    // integrator wiring exactly (see the module docs / integratorApi).
    let hub = GatewayHub::new(std::sync::Arc::clone(&server.state));
    server.state.store.set_write_listener(hub.write_listener());

    // Serve the gateway router on its own port (the boot router doesn't merge
    // the gateway in this story; the integrator does).
    let app = hub.router();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let serve = tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    // dev-login for a token via the HTTP auth surface (boot router).
    let http_port = server.listen().await.unwrap();
    let token = dev_login_token(http_port, "user-ada").await;

    // Open the ws client.
    let url = format!("ws://127.0.0.1:{port}/_frick/sync");
    let (mut socket, _response) = tokio_tungstenite::connect_async(&url).await.unwrap();

    // Hello (authenticated).
    let hello = FrickFrame::Hello(Box::new(HelloPayload {
        replica_id: "replica-1".into(),
        device_id: "device-1".into(),
        schema_hash: schema.hash.clone(),
        // Empty cursor map; collected from no entries to avoid a direct
        // `indexmap` dependency in this crate's test surface.
        known_cursors: std::iter::empty::<(String, i64)>().collect(),
        session_token: Some(token),
        client_capabilities: None,
    }));
    socket
        .send(TungMessage::Binary(encode_frame(&hello).unwrap()))
        .await
        .unwrap();

    // Expect HelloAck then Schema.
    let ack = next_frame(&mut socket).await;
    assert!(matches!(ack, FrickFrame::HelloAck(_)), "got {ack:?}");
    let schema_frame = next_frame(&mut socket).await;
    assert!(
        matches!(schema_frame, FrickFrame::Schema(_)),
        "got {schema_frame:?}"
    );

    // Subscribe to the Note object type.
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
    let snapshot = next_frame(&mut socket).await;
    let FrickFrame::Snapshot(snapshot) = snapshot else {
        panic!("expected snapshot, got {snapshot:?}");
    };
    assert_eq!(snapshot.subscription_id, "sub-notes");
    assert!(snapshot.objects.is_empty(), "fresh store has no notes yet");

    // ObjectUpsert a note.
    let upsert = FrickFrame::ObjectUpsert(ObjectUpsertPayload {
        request_id: "req-1".into(),
        object_type: "Note".into(),
        object_id: "n1".into(),
        value: note_value("n1", "hello"),
        expected_version: None,
    });
    socket
        .send(TungMessage::Binary(encode_frame(&upsert).unwrap()))
        .await
        .unwrap();

    // The Ack and the Delta both arrive (order: the funnel fires after the
    // store write returns, so the Ack may come first). Collect frames until we
    // see a Delta carrying our note.
    let mut saw_ack = false;
    let mut saw_delta = false;
    for _ in 0..4 {
        match next_frame(&mut socket).await {
            FrickFrame::Ack(ack) => {
                assert_eq!(ack.request_id, "req-1");
                assert_eq!(ack.version, Some(1));
                saw_ack = true;
            }
            FrickFrame::Delta(delta) => {
                assert_eq!(delta.objects.len(), 1);
                assert_eq!(delta.objects[0].1, "n1");
                saw_delta = true;
            }
            other => panic!("unexpected frame {other:?}"),
        }
        if saw_ack && saw_delta {
            break;
        }
    }
    assert!(saw_ack && saw_delta, "expected both an Ack and a Delta");

    socket.close(None).await.ok();
    serve.abort();
    server.close().await;
}

/// Handshake gate over a real socket: a Subscribe before Hello is Nacked with
/// `handshakeRequired` and the connection stays open.
#[tokio::test]
async fn ws_handshake_gate_over_socket() {
    use futures_util::SinkExt;

    let schema = note_schema();
    let server = create_frick_server(test_config(), schema.clone())
        .await
        .unwrap();
    let hub = GatewayHub::new(std::sync::Arc::clone(&server.state));
    let app = hub.router();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let serve = tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    let url = format!("ws://127.0.0.1:{port}/_frick/sync");
    let (mut socket, _) = tokio_tungstenite::connect_async(&url).await.unwrap();

    let subscribe = FrickFrame::Subscribe(SubscribePayload {
        subscription_id: "sub-early".into(),
        kind: SubscriptionKind::Object,
        name: "Note".into(),
        key: None,
        cursor: None,
    });
    socket
        .send(TungMessage::Binary(encode_frame(&subscribe).unwrap()))
        .await
        .unwrap();

    let FrickFrame::Nack(nack) = next_frame(&mut socket).await else {
        panic!("expected a nack");
    };
    assert_eq!(nack.error.code, FrickErrorCode::SyncProtocolError);
    assert_eq!(nack.request_id, "sub-early");

    socket.close(None).await.ok();
    serve.abort();
}

// ---- helpers ----------------------------------------------------------------

fn test_config() -> FrickConfig {
    let mut env = BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    load_frick_config(&env).unwrap()
}

/// A hub over a fresh in-memory `Note`-schema state (no listening socket).
async fn test_hub() -> std::sync::Arc<GatewayHub> {
    let store = frick_store::FrickStore::open(frick_store::FrickStoreOptions {
        schema: Some(note_schema()),
        ..frick_store::FrickStoreOptions::default()
    })
    .await
    .unwrap();
    let state = std::sync::Arc::new(AppStateInner {
        config: test_config(),
        store,
        schema: note_schema(),
        started_at: "1970-01-01T00:00:00.000Z".into(),
        auth_limiter: std::sync::Mutex::new(crate::http::AuthLimiter::default()),
        projections: crate::projections::ProjectionRegistry::new(),
    });
    GatewayHub::new(state)
}

/// A minimal valid schema with one object type `Note { id, body }`.
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

fn note_value(id: &str, body: &str) -> Value {
    Value::Map(vec![
        ("id".into(), Value::from(id)),
        ("body".into(), Value::from(body)),
    ])
}

/// Read the next frame off the socket, ignoring server pings.
async fn next_frame(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> FrickFrame {
    use futures_util::StreamExt;
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("frame within timeout")
            .expect("a message")
            .expect("an ok message");
        match message {
            TungMessage::Binary(bytes) => {
                let frame = decode_frame(&bytes).unwrap();
                // The heartbeat may inject server→client Pings; skip them.
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

/// Dev-login over the HTTP surface, returning the session token.
async fn dev_login_token(port: u16, user_id: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let body = format!(r#"{{"userId":"{user_id}"}}"#);
    let mut stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{port}"))
        .await
        .unwrap();
    let request = format!(
        "POST /auth/dev-login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    let needle = "\"sessionToken\":\"";
    let start = response.find(needle).expect("token present") + needle.len();
    let rest = &response[start..];
    let end = rest.find('"').expect("closing quote");
    rest[..end].to_string()
}
