//! Black-box conformance scenarios (FR-250).
//!
//! Each `#[tokio::test]` drives [`ServerHandle::target`], so the whole suite
//! runs against whichever server `FRICK_CONFORMANCE_URL` points at — the
//! in-process Rust server by default, or a running TypeScript server started
//! with the `productTestSchema` when the env var is set.
//!
//! The assertions are deliberately about *observable* behavior: HTTP status
//! codes, JSON response shapes, and the WebSocket frame flow. Both server
//! implementations must produce them identically.
//!
//! Ported from the e2e-smoke harness (`scripts/e2e-smoke.ts`) and the server
//! black-box suite (`apps/server/tests/server.test.ts`), per
//! `internal/rust-rewrite/maps/08-tooling-tests.md` §5.3–§5.4 and
//! `internal/rust-rewrite/maps/02-server-architecture.md` §4 + §6.

use frick_conformance::{ServerHandle, nonce};
use frick_protocol::FrickFrame;
use frick_protocol::frame::SubscriptionKind;
use serde_json::json;

// ---- lifecycle --------------------------------------------------------------

#[tokio::test]
async fn health_ready_and_schema() {
    let server = ServerHandle::target().await;
    let http = server.http();

    // GET /health → {ok:true, ...}
    let health = http.get("/health", None).await;
    assert_eq!(health.status, 200, "health body: {}", health.json);
    assert_eq!(
        health.json.get("ok").and_then(serde_json::Value::as_bool),
        Some(true)
    );

    // GET /ready → status "ready" with the active schema hash.
    let ready = http.get("/ready", None).await;
    assert_eq!(ready.status, 200, "ready body: {}", ready.json);
    assert_eq!(
        ready.json.get("status").and_then(serde_json::Value::as_str),
        Some("ready")
    );
    assert_eq!(ready.str_field("schemaHash"), server.schema().hash);

    // GET /schema → the active schema (identity matches).
    let schema = http.get("/schema", None).await;
    assert_eq!(schema.status, 200, "schema body: {}", schema.json);
    assert_eq!(schema.str_field("schemaId"), server.schema().schema_id);
    assert_eq!(schema.str_field("hash"), server.schema().hash);

    server.shutdown().await;
}

// ---- auth -------------------------------------------------------------------

#[tokio::test]
async fn dev_login_issues_a_usable_bearer_token() {
    let server = ServerHandle::target().await;
    let http = server.http();
    let user_id = format!("user-conf-dev-{}", nonce());

    let login = http.dev_login(&user_id).await;
    assert_eq!(login.status, 200, "dev-login body: {}", login.json);
    assert_eq!(login.str_field("schemaHash"), server.schema().hash);
    assert_eq!(login.str_field("userId"), user_id);
    assert!(
        login.str_field("sessionToken").len() > 30,
        "session token too short"
    );
    // The documented shape carries device/replica ids and an expiry.
    assert!(!login.str_field("deviceId").is_empty());
    assert!(!login.str_field("replicaId").is_empty());
    assert!(!login.str_field("expiresAt").is_empty());

    // The bearer authorizes a subsequent protected request.
    let token = login.str_field("sessionToken");
    let objects = http.get("/objects?type=User", Some(&token)).await;
    assert_eq!(
        objects.status, 200,
        "authorized /objects body: {}",
        objects.json
    );

    server.shutdown().await;
}

#[tokio::test]
async fn unauthenticated_objects_is_401_unauthenticated() {
    let server = ServerHandle::target().await;
    let http = server.http();

    let response = http.get("/objects?type=User", None).await;
    assert_eq!(response.status, 401, "body: {}", response.json);
    // Top-level duplicated error code (sendError contract).
    assert_eq!(
        response
            .json
            .get("code")
            .and_then(serde_json::Value::as_str),
        Some("auth.unauthenticated"),
        "body: {}",
        response.json
    );

    server.shutdown().await;
}

#[tokio::test]
async fn signup_returns_201_with_the_documented_shape() {
    let server = ServerHandle::target().await;
    let http = server.http();
    let suffix = nonce();
    // Handle: lowercase, 3–32 chars, `[a-z0-9][a-z0-9_-]*[a-z0-9]`. Keep it
    // short enough after the nonce.
    let handle = format!("conf{}", &suffix[suffix.len().saturating_sub(10)..]);
    let password = "conformance-pass-123";

    let body = json!({
        "displayName": "Conformance User",
        "handle": handle,
        "password": password,
    });
    let signup = http.post("/auth/signup", &body, None).await;
    assert_eq!(signup.status, 201, "signup body: {}", signup.json);
    assert_eq!(signup.str_field("schemaHash"), server.schema().hash);
    assert_eq!(signup.str_field("handle"), handle);
    assert_eq!(signup.str_field("displayName"), "Conformance User");
    assert!(signup.str_field("sessionToken").len() > 30);
    assert!(!signup.str_field("userId").is_empty());

    // login with the wrong password → 401.
    let wrong = json!({ "identity": handle, "password": "not-the-password" });
    let login = http.post("/auth/login", &wrong, None).await;
    assert_eq!(login.status, 401, "wrong-password body: {}", login.json);

    server.shutdown().await;
}

// ---- objects ----------------------------------------------------------------

#[tokio::test]
async fn object_crud_round_trip() {
    let server = ServerHandle::target().await;
    let http = server.http();
    let token = http
        .dev_login_token(&format!("user-conf-obj-{}", nonce()))
        .await;
    let object_id = format!("user-row-{}", nonce());

    // The list starts without our row.
    let initial = http.get("/objects?type=User", Some(&token)).await;
    assert_eq!(initial.status, 200, "list body: {}", initial.json);
    assert_eq!(initial.str_field("schemaHash"), server.schema().hash);

    // PUT creates it (201) with a version + ETag.
    let put = http
        .put(
            &format!("/objects/User/{object_id}"),
            &json!({ "displayName": "Conformance" }),
            Some(&token),
        )
        .await;
    assert!(
        put.status == 201 || put.status == 200,
        "put status {}: {}",
        put.status,
        put.json
    );
    assert!(put.json.get("version").is_some(), "missing version");
    assert!(put.etag.is_some(), "missing ETag header");

    // GET shows the row.
    let after = http.get("/objects?type=User", Some(&token)).await;
    assert_eq!(after.status, 200, "list body: {}", after.json);
    let data = after.json.get("data").and_then(serde_json::Value::as_array);
    let found = data.is_some_and(|rows| {
        rows.iter().any(|row| {
            row.get("id").and_then(serde_json::Value::as_str) == Some(object_id.as_str())
        })
    });
    assert!(found, "uploaded row not in list: {}", after.json);

    // DELETE is idempotent and reports existence.
    let deleted = http
        .delete(&format!("/objects/User/{object_id}"), Some(&token))
        .await;
    assert_eq!(deleted.status, 200, "delete body: {}", deleted.json);
    assert_eq!(
        deleted
            .json
            .get("existed")
            .and_then(serde_json::Value::as_bool),
        Some(true),
        "delete body: {}",
        deleted.json
    );

    server.shutdown().await;
}

// ---- streams ----------------------------------------------------------------

#[tokio::test]
async fn stream_append_read_and_idempotency() {
    let server = ServerHandle::target().await;
    let http = server.http();
    let token = http
        .dev_login_token(&format!("user-conf-stream-{}", nonce()))
        .await;
    let key = format!("conversation-{}", nonce());
    let request_id = format!("req-{}", nonce());

    let append_body = json!({
        "stream": "MessageStream",
        "key": key,
        "event": "MessageSent",
        "payload": {
            "messageId": format!("msg-{}", nonce()),
            "senderId": "user-sender",
            "body": "hello conformance",
            "createdAt": 1_700_000_000_000_i64,
        },
        "requestId": request_id,
    });

    let append = http.post("/append", &append_body, Some(&token)).await;
    assert_eq!(append.status, 200, "append body: {}", append.json);
    assert_eq!(
        append.json.get("ok").and_then(serde_json::Value::as_bool),
        Some(true)
    );
    let event_id = append
        .json
        .get("event")
        .and_then(|e| e.get("eventId"))
        .and_then(serde_json::Value::as_str)
        .expect("append returns an eventId")
        .to_string();

    // Read the event back via GET /streams/<stream>/<key>?after=0.
    let read = http
        .get(
            &format!("/streams/MessageStream/{key}?after=0"),
            Some(&token),
        )
        .await;
    assert_eq!(read.status, 200, "stream read body: {}", read.json);
    let events = read.json.get("data").and_then(serde_json::Value::as_array);
    let present = events.is_some_and(|rows| {
        rows.iter().any(|event| {
            event.get("eventId").and_then(serde_json::Value::as_str) == Some(event_id.as_str())
        })
    });
    assert!(present, "appended event not in stream: {}", read.json);

    // Re-append with the same requestId is idempotent: same event id.
    let replay = http.post("/append", &append_body, Some(&token)).await;
    assert_eq!(replay.status, 200, "replay body: {}", replay.json);
    let replay_event_id = replay
        .json
        .get("event")
        .and_then(|e| e.get("eventId"))
        .and_then(serde_json::Value::as_str)
        .expect("replay returns an eventId");
    assert_eq!(
        replay_event_id, event_id,
        "idempotent re-append returned a different event"
    );

    server.shutdown().await;
}

// ---- signals ----------------------------------------------------------------

#[tokio::test]
async fn signal_post_then_drain_round_trip() {
    let server = ServerHandle::target().await;
    let http = server.http();
    let token = http
        .dev_login_token(&format!("user-conf-signal-{}", nonce()))
        .await;
    let key = format!("call-{}", nonce());

    // POST a WebRTCSignal to /signals/<name>/<key>.
    let signal = json!({
        "senderDeviceId": "device-a",
        "kind": "offer",
        "payload": "c2RwLW9mZmVy",
    });
    let posted = http
        .post(
            &format!("/signals/WebRTCSignal/{key}"),
            &signal,
            Some(&token),
        )
        .await;
    assert_eq!(posted.status, 200, "signal post body: {}", posted.json);
    assert_eq!(
        posted.json.get("ok").and_then(serde_json::Value::as_bool),
        Some(true)
    );

    // GET drains it (at-most-once) → {schemaHash, name, key, data}.
    let drained = http
        .get(&format!("/signals/WebRTCSignal/{key}"), Some(&token))
        .await;
    assert_eq!(drained.status, 200, "signal drain body: {}", drained.json);
    assert_eq!(drained.str_field("schemaHash"), server.schema().hash);
    assert_eq!(drained.str_field("name"), "WebRTCSignal");
    assert_eq!(drained.str_field("key"), key);
    let data = drained
        .json
        .get("data")
        .and_then(serde_json::Value::as_array);
    assert_eq!(
        data.map(Vec::len),
        Some(1),
        "expected one drained signal: {}",
        drained.json
    );

    server.shutdown().await;
}

// ---- WebSocket sync (the headline scenario) --------------------------------

/// The headline scenario, mirroring `scripts/e2e-smoke.ts`: dev-login →
/// connect WS → Hello → HelloAck + Schema → Subscribe to a stream → initial
/// `StreamPage` → append over HTTP → a `Delta` carrying the event arrives over
/// the socket.
#[tokio::test]
async fn ws_sync_stream_round_trip() {
    let server = ServerHandle::target().await;
    let http = server.http();
    let token = http
        .dev_login_token(&format!("user-conf-ws-{}", nonce()))
        .await;
    let key = format!("conversation-{}", nonce());

    let mut ws = server.connect_ws().await;

    // Hello → HelloAck + Schema; the ack carries the active schema hash.
    let ack_hash = ws.hello(&token).await;
    assert_eq!(ack_hash, server.schema().hash);

    // Subscribe to the MessageStream for one conversation key → initial
    // StreamPage (keyed stream subscriptions reply with a page, not a Snapshot).
    ws.subscribe(
        "sub-stream",
        SubscriptionKind::Stream,
        "MessageStream",
        Some(&key),
    )
    .await;
    let page = match ws.next_frame().await {
        FrickFrame::StreamPage(page) => page,
        other => panic!("expected StreamPage, got {other:?}"),
    };
    assert_eq!(page.subscription_id, "sub-stream");

    // Drive an append over HTTP.
    let event_id = format!("evt-{}", nonce());
    let append_body = json!({
        "stream": "MessageStream",
        "key": key,
        "event": "MessageSent",
        "payload": {
            "messageId": event_id,
            "senderId": "user-sender",
            "body": "delta over the socket",
            "createdAt": 1_700_000_000_000_i64,
        },
        "requestId": format!("req-{}", nonce()),
    });
    let append = http.post("/append", &append_body, Some(&token)).await;
    assert_eq!(append.status, 200, "append body: {}", append.json);

    // The funnel delivers a Delta carrying the appended event over the socket.
    let mut saw_delta = false;
    for _ in 0..6 {
        if let FrickFrame::Delta(delta) = ws.next_frame().await
            && !delta.events.is_empty()
        {
            saw_delta = true;
            break;
        }
    }
    assert!(saw_delta, "expected a Delta carrying the appended event");

    ws.close().await;
    server.shutdown().await;
}

/// An object subscription replies with an initial `Snapshot` frame, and a
/// subsequent HTTP object upsert fans a live `Delta` carrying the row over the
/// socket. The Delta half exercises the object-pack fan-out path for a schema
/// type (`User`) that declares no explicit `id` field — a wire-parity case
/// that must match the TS server (the record id rides the packed tuple's id
/// slot, not the field list).
#[tokio::test]
async fn ws_object_subscribe_snapshot_then_live_delta() {
    let server = ServerHandle::target().await;
    let http = server.http();
    let user_id = format!("user-conf-obj-sub-{}", nonce());
    let token = http.dev_login_token(&user_id).await;

    let mut ws = server.connect_ws().await;
    ws.hello(&token).await;

    ws.subscribe("sub-user", SubscriptionKind::Object, "User", None)
        .await;
    let snapshot = match ws.next_frame().await {
        FrickFrame::Snapshot(snapshot) => snapshot,
        other => panic!("expected Snapshot, got {other:?}"),
    };
    assert_eq!(snapshot.subscription_id, "sub-user");
    assert_eq!(snapshot.cursor, 0, "object snapshot cursor should be 0");

    // Upsert a User over HTTP; the funnel must deliver an object Delta.
    let object_id = format!("user-row-{}", nonce());
    let upsert = http
        .put(
            &format!("/objects/User/{object_id}"),
            &json!({ "displayName": "Conformance Ada" }),
            Some(&token),
        )
        .await;
    assert!(
        upsert.status == 200 || upsert.status == 201,
        "object upsert status {}: {}",
        upsert.status,
        upsert.json
    );

    let mut saw_delta = false;
    for _ in 0..6 {
        if let FrickFrame::Delta(delta) = ws.next_frame().await
            && delta.objects.iter().any(|record| record.1 == object_id)
        {
            saw_delta = true;
            break;
        }
    }
    assert!(
        saw_delta,
        "expected a live object Delta carrying {object_id}"
    );

    ws.close().await;
    server.shutdown().await;
}

#[tokio::test]
async fn ws_subscribe_before_hello_is_nacked_handshake_required() {
    let server = ServerHandle::target().await;
    let mut ws = server.connect_ws().await;

    // A Subscribe before Hello → Nack sync.protocolError reason handshakeRequired.
    ws.subscribe("sub-early", SubscriptionKind::Object, "User", None)
        .await;
    let nack = match ws.next_frame().await {
        FrickFrame::Nack(nack) => nack,
        other => panic!("expected Nack, got {other:?}"),
    };
    assert_eq!(
        nack.error.code,
        frick_protocol::FrickErrorCode::SyncProtocolError
    );
    let reason = nack
        .error
        .details
        .as_ref()
        .and_then(|details| match details {
            frick_protocol::Value::Map(entries) => entries.iter().find_map(|(key, value)| {
                if key.as_str() == Some("reason") {
                    value.as_str()
                } else {
                    None
                }
            }),
            _ => None,
        });
    assert_eq!(reason, Some("handshakeRequired"), "nack: {nack:?}");

    ws.close().await;
    server.shutdown().await;
}

#[tokio::test]
async fn ws_ping_before_hello_is_ponged() {
    let server = ServerHandle::target().await;
    let mut ws = server.connect_ws().await;

    // Ping pre-Hello is allowed and answered with a Pong. (next_frame skips the
    // gateway's *own* heartbeat Pings, but a Pong reply is a distinct frame.)
    ws.ping().await;
    let frame = ws.next_frame().await;
    assert!(
        matches!(frame, FrickFrame::Pong(_)),
        "expected Pong, got {frame:?}"
    );

    ws.close().await;
    server.shutdown().await;
}

// ---- projection subscribe ---------------------------------------------------

#[tokio::test]
async fn ws_projection_subscribe_yields_initial_delta_or_not_found() {
    let server = ServerHandle::target().await;
    let http = server.http();
    let token = http
        .dev_login_token(&format!("user-conf-proj-{}", nonce()))
        .await;

    let mut ws = server.connect_ws().await;
    ws.hello(&token).await;

    // Subscribe to the ConversationInbox projection. The in-process Rust target
    // registers this projection (a real product app does too), so it replies
    // with an initial ProjectionDelta snapshot frame. An external server that
    // did NOT register the declared projection Nacks auth.forbidden with reason
    // projectionNotFound — both are valid identical behaviors given the
    // registration state, so accept either.
    ws.subscribe(
        "sub-inbox",
        SubscriptionKind::Projection,
        "ConversationInbox",
        None,
    )
    .await;

    match ws.next_frame().await {
        FrickFrame::ProjectionDelta(delta) => {
            assert_eq!(delta.projection, "ConversationInbox");
        }
        FrickFrame::Nack(nack) => {
            let reason = nack
                .error
                .details
                .as_ref()
                .and_then(|details| match details {
                    frick_protocol::Value::Map(entries) => {
                        entries.iter().find_map(|(key, value)| {
                            if key.as_str() == Some("reason") {
                                value.as_str()
                            } else {
                                None
                            }
                        })
                    }
                    _ => None,
                });
            assert_eq!(
                reason,
                Some("projectionNotFound"),
                "unexpected projection nack: {nack:?}"
            );
        }
        other => panic!("expected ProjectionDelta or Nack, got {other:?}"),
    }

    ws.close().await;
    server.shutdown().await;
}
