//! Black-box conformance scenario runner (FR-250).
//!
//! A language-neutral acceptance gate for the Frick Rust rewrite. The
//! scenarios in `tests/scenarios.rs` exercise an **arbitrary** Frick server
//! over HTTP + WebSocket and assert identical *observable* behavior — status
//! codes, response shapes, and frame flows — regardless of whether that server
//! is the TypeScript implementation or the Rust one.
//!
//! # Which server is under test
//!
//! [`ServerHandle::target`] picks the target:
//!
//! - If the env var `FRICK_CONFORMANCE_URL` is set (e.g.
//!   `http://127.0.0.1:4099`), the scenarios run against that **external**
//!   server. The external server **must** be booted with the
//!   `productTestSchema` (the e2e-smoke harness already does this) so the WS
//!   handshake schema hash matches.
//! - Otherwise an **in-process Rust server** is booted via
//!   [`frick_server::create_frick_server`] on port 0 with an in-memory store
//!   and dev-auth on, using the *same* `productTestSchema` decoded from the
//!   committed wire fixture `conformance/fixtures/wire/schema-product-validated.bin`.
//!
//! Both targets therefore run the identical schema, which is the precondition
//! for the Hello handshake (and every packed record on the wire) to match.
//!
//! # Running
//!
//! ```text
//! # Against the in-process Rust server (default):
//! cargo test -p frick-conformance
//!
//! # Against a running TypeScript server started with productTestSchema:
//! FRICK_CONFORMANCE_URL=http://127.0.0.1:4099 cargo test -p frick-conformance
//! ```
//!
//! See the crate README for how to start the TS server with the product test
//! schema.
//!
//! Panics are the assertion mechanism here: every helper that decodes a frame,
//! parses a response, or boots a server panics on the unexpected so a failing
//! scenario surfaces a clear message. `missing_panics_doc` is therefore allowed
//! crate-wide rather than documented on each helper.
#![allow(clippy::missing_panics_doc)]

use std::sync::OnceLock;

use frick_protocol::capabilities::FrickClientPlatform;
use frick_protocol::frame::{HelloPayload, SubscribePayload, SubscriptionKind};
use frick_protocol::{
    FrickFrame, FrickSchema, decode_frame, default_client_capabilities, encode_frame,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value as Json;
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// The committed wire fixture carrying the validated `productTestSchema` as a
/// `[FrameKind::Schema, schema]` frame. Decoded once and shared by every
/// scenario so the in-process server and the WS handshakes agree byte-for-byte.
const PRODUCT_SCHEMA_FIXTURE: &[u8] =
    include_bytes!("../../../conformance/fixtures/wire/schema-product-validated.bin");

/// Decode the product-test schema from the committed wire fixture.
///
/// The fixture is a `FrickFrame::Schema` frame; we pull the schema out of the
/// arm. Panics if the fixture ever stops being a Schema frame — that is a
/// fixture-drift bug the suite should surface loudly.
#[must_use]
pub fn product_test_schema() -> &'static FrickSchema {
    static SCHEMA: OnceLock<FrickSchema> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        let frame = decode_frame(PRODUCT_SCHEMA_FIXTURE)
            .expect("schema-product-validated.bin decodes as a frame");
        match frame {
            FrickFrame::Schema(schema) => *schema,
            other => panic!("expected a Schema frame in the fixture, got {other:?}"),
        }
    })
}

/// A handle to the server under test: either an external base URL or an
/// in-process Rust server kept alive for the lifetime of the handle.
pub struct ServerHandle {
    http_base: String,
    ws_url: String,
    /// The schema the target runs — the product-test schema for the default
    /// targets, or a caller-supplied schema for
    /// [`ServerHandle::in_process_with_schema`] (e.g. the calls scenarios splice
    /// the current call control-plane types in). Every [`WsConn`] this handle
    /// opens hellos with this schema, so the capability handshake agrees.
    schema: FrickSchema,
    /// `Some` only for the in-process Rust server; dropping it (via
    /// [`ServerHandle::shutdown`]) closes the server.
    inprocess: Option<frick_server::FrickServer>,
}

impl ServerHandle {
    /// Pick the target: the external server named by `FRICK_CONFORMANCE_URL`
    /// when set, else a freshly booted in-process Rust server.
    pub async fn target() -> Self {
        match std::env::var("FRICK_CONFORMANCE_URL") {
            Ok(url) if !url.trim().is_empty() => Self::external(url.trim()),
            _ => Self::in_process().await,
        }
    }

    /// Build a handle pointing at an already-running external server.
    fn external(base: &str) -> Self {
        let http_base = base.trim_end_matches('/').to_string();
        let ws_url = http_to_ws(&http_base);
        Self {
            http_base,
            ws_url,
            schema: product_test_schema().clone(),
            inprocess: None,
        }
    }

    /// Boot an in-process Rust server (port 0, `:memory:`, dev-auth on) running
    /// the product test schema, with the `ConversationInbox` projection
    /// registered (a real product app registers it; the framework does not
    /// auto-register declared projections). The registration lets the
    /// projection-subscribe scenario observe a `ProjectionDelta` snapshot.
    async fn in_process() -> Self {
        let server = Self::in_process_with_schema(product_test_schema().clone()).await;
        if let Some(inner) = server.inprocess.as_ref() {
            register_conversation_inbox(inner);
        }
        server
    }

    /// Boot an in-process Rust server running a **caller-supplied** schema (port
    /// 0, `:memory:`, dev-auth on). The FR-290 calls scenarios use this to run a
    /// schema that splices the *current* call control-plane object/stream/signal
    /// types in — the committed product-test fixture carries an older, partial
    /// call schema, so the live control-plane record shapes (e.g. `CallRoom.kind`)
    /// would fail the store's schema-pack. Every [`WsConn`] this handle opens
    /// hellos with the same schema, so the capability handshake agrees.
    ///
    /// Only valid for the in-process target; ignores `FRICK_CONFORMANCE_URL`.
    pub async fn in_process_with_schema(schema: FrickSchema) -> Self {
        let mut server = frick_server::create_frick_server(in_process_config(), schema.clone())
            .await
            .expect("in-process Rust server boots");
        let port = server.listen().await.expect("in-process server listens");
        let http_base = format!("http://127.0.0.1:{port}");
        let ws_url = format!("ws://127.0.0.1:{port}/_frick/sync");
        Self {
            http_base,
            ws_url,
            schema,
            inprocess: Some(server),
        }
    }

    /// The base HTTP URL, e.g. `http://127.0.0.1:NNNN` (no trailing slash).
    #[must_use]
    pub fn http_base(&self) -> &str {
        &self.http_base
    }

    /// The WebSocket sync endpoint, e.g. `ws://127.0.0.1:NNNN/_frick/sync`.
    #[must_use]
    pub fn ws_url(&self) -> &str {
        &self.ws_url
    }

    /// The active schema both servers must run.
    #[must_use]
    pub fn schema(&self) -> &FrickSchema {
        &self.schema
    }

    /// A configured HTTP client for this target.
    #[must_use]
    pub fn http(&self) -> HttpClient {
        HttpClient {
            base: self.http_base.clone(),
            client: reqwest::Client::new(),
        }
    }

    /// Open a WebSocket to the sync endpoint. The connection hellos with this
    /// handle's [`ServerHandle::schema`], so the capability handshake agrees with
    /// whatever schema the target runs.
    pub async fn connect_ws(&self) -> WsConn {
        let (socket, _response) = tokio_tungstenite::connect_async(&self.ws_url)
            .await
            .expect("ws connect");
        WsConn {
            socket,
            schema: self.schema.clone(),
        }
    }

    /// Gracefully shut down the in-process server (no-op for external).
    pub async fn shutdown(mut self) {
        if let Some(mut server) = self.inprocess.take() {
            server.close().await;
        }
    }
}

/// Config for the in-process Rust server: test env, in-memory store, port 0.
/// Dev-auth (`/auth/dev-login`) is on because the env is not production.
fn in_process_config() -> frick_server::FrickConfig {
    let mut env = std::collections::BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    frick_server::load_frick_config(&env).expect("conformance config loads")
}

/// Register a `ConversationInbox` projection sourced from `MessageStream`.
///
/// The product test schema *declares* this projection, but the framework does
/// not auto-register a runtime handler for declared projections (an app
/// registers it). We mirror that app behavior so the projection-subscribe
/// scenario can observe an initial `ProjectionDelta` snapshot frame. The
/// handler keys one row per `(conversationId)` carrying the last sequence.
fn register_conversation_inbox(server: &frick_server::FrickServer) {
    use frick_server::projections::{
        FrickProjection, FrickProjectionContext, FrickProjectionHandler, FrickProjectionSource,
        FrickProjectionWriteEvent, ProjectionApplyResult,
    };

    struct Inbox;
    impl FrickProjectionHandler for Inbox {
        fn apply(
            &self,
            event: &FrickProjectionWriteEvent,
            _ctx: &FrickProjectionContext,
        ) -> ProjectionApplyResult {
            match event {
                FrickProjectionWriteEvent::StreamEvent {
                    stream_id,
                    stream_event,
                    ..
                } => {
                    // One row per conversation, carrying the latest stream
                    // event. The exact row content is unimportant to the
                    // conformance assertion (which checks the delta shape).
                    ProjectionApplyResult::single(stream_id.clone(), Some(stream_event.clone()))
                }
                _ => ProjectionApplyResult::none(),
            }
        }
    }

    server
        .state
        .projections
        .register(FrickProjection::new(
            "ConversationInbox",
            vec![FrickProjectionSource::stream("MessageStream")],
            Box::new(Inbox),
        ))
        .expect("ConversationInbox registers");
}

/// Translate an `http(s)://` base into the `ws(s)://` sync endpoint.
fn http_to_ws(http_base: &str) -> String {
    let ws_scheme = if let Some(rest) = http_base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = http_base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        format!("ws://{http_base}")
    };
    format!("{}/_frick/sync", ws_scheme.trim_end_matches('/'))
}

// ---- HTTP helpers ----------------------------------------------------------

/// A thin reqwest wrapper that resolves paths against the target base URL.
pub struct HttpClient {
    base: String,
    client: reqwest::Client,
}

/// The JSON body + HTTP status of a response, plus any `ETag` header.
pub struct HttpResponse {
    pub status: u16,
    pub json: Json,
    pub etag: Option<String>,
}

impl HttpResponse {
    /// Read a top-level field as a string, panicking if absent.
    #[must_use]
    pub fn str_field(&self, key: &str) -> String {
        self.json
            .get(key)
            .and_then(Json::as_str)
            .unwrap_or_else(|| panic!("response missing string field {key:?}: {}", self.json))
            .to_string()
    }
}

impl HttpClient {
    /// `GET <path>` with an optional bearer token.
    pub async fn get(&self, path: &str, bearer: Option<&str>) -> HttpResponse {
        self.send(reqwest::Method::GET, path, bearer, None).await
    }

    /// `POST <path>` with a JSON body and optional bearer token.
    pub async fn post(&self, path: &str, body: &Json, bearer: Option<&str>) -> HttpResponse {
        self.send(reqwest::Method::POST, path, bearer, Some(body))
            .await
    }

    /// `PUT <path>` with a JSON body and optional bearer token.
    pub async fn put(&self, path: &str, body: &Json, bearer: Option<&str>) -> HttpResponse {
        self.send(reqwest::Method::PUT, path, bearer, Some(body))
            .await
    }

    /// `DELETE <path>` with an optional bearer token.
    pub async fn delete(&self, path: &str, bearer: Option<&str>) -> HttpResponse {
        self.send(reqwest::Method::DELETE, path, bearer, None).await
    }

    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        bearer: Option<&str>,
        body: Option<&Json>,
    ) -> HttpResponse {
        let url = format!("{}{}", self.base, path);
        let mut request = self.client.request(method, &url);
        if let Some(token) = bearer {
            request = request.bearer_auth(token);
        }
        if let Some(json) = body {
            request = request.json(json);
        }
        let response = request.send().await.expect("http request sends");
        let status = response.status().as_u16();
        let etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let text = response.text().await.unwrap_or_default();
        let json = serde_json::from_str::<Json>(&text).unwrap_or(Json::Null);
        HttpResponse { status, json, etag }
    }

    /// `POST /auth/dev-login {userId}` → the full response. Auto-creates the
    /// account when missing (the framework does this when dev-auth is on).
    pub async fn dev_login(&self, user_id: &str) -> HttpResponse {
        self.post(
            "/auth/dev-login",
            &serde_json::json!({ "userId": user_id }),
            None,
        )
        .await
    }

    /// `POST /auth/dev-login {userId}` → just the session token.
    pub async fn dev_login_token(&self, user_id: &str) -> String {
        let response = self.dev_login(user_id).await;
        assert_eq!(response.status, 200, "dev-login failed: {}", response.json);
        response.str_field("sessionToken")
    }
}

// ---- WebSocket helpers -----------------------------------------------------

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// A WebSocket connection that speaks msgpack [`FrickFrame`]s.
pub struct WsConn {
    socket: WsStream,
    /// The schema this connection hellos with — the target's active schema, so
    /// the capability handshake agrees (see [`ServerHandle::connect_ws`]).
    schema: FrickSchema,
}

impl WsConn {
    /// Send a frame as a msgpack binary message.
    pub async fn send(&mut self, frame: &FrickFrame) {
        let bytes = encode_frame(frame).expect("frame encodes");
        self.socket
            .send(WsMessage::Binary(bytes))
            .await
            .expect("ws send");
    }

    /// Receive the next *application* frame, transparently skipping the
    /// gateway's heartbeat `Ping` frames and transport-level ping/pong (the
    /// pattern from `crates/frick-server/tests/funnel_integration.rs`).
    pub async fn next_frame(&mut self) -> FrickFrame {
        loop {
            let message = self
                .socket
                .next()
                .await
                .expect("ws stream open")
                .expect("ws message");
            match message {
                WsMessage::Binary(bytes) => {
                    let frame = decode_frame(&bytes).expect("frame decodes");
                    if matches!(frame, FrickFrame::Ping(_)) {
                        continue;
                    }
                    return frame;
                }
                WsMessage::Ping(_) | WsMessage::Pong(_) => {}
                WsMessage::Close(_) => panic!("ws closed unexpectedly"),
                other => panic!("unexpected ws message {other:?}"),
            }
        }
    }

    /// Perform the Hello handshake with the product schema hash and a session
    /// token, asserting the `HelloAck` then `Schema` reply, and return the
    /// `HelloAck` schema hash. Advertises the default client capabilities so
    /// the server takes the capability-negotiation path (not the legacy
    /// hash-equality path).
    pub async fn hello(&mut self, session_token: &str) -> String {
        let schema = &self.schema;
        let hello = FrickFrame::Hello(Box::new(HelloPayload {
            replica_id: "conformance-replica".into(),
            device_id: "conformance-device".into(),
            schema_hash: schema.hash.clone(),
            known_cursors: std::iter::empty::<(String, i64)>().collect(),
            session_token: Some(session_token.to_string()),
            client_capabilities: Some(default_client_capabilities(
                FrickClientPlatform::Test,
                "0.0.0-conformance",
                schema,
            )),
        }));
        self.send(&hello).await;

        let ack = match self.next_frame().await {
            FrickFrame::HelloAck(ack) => ack,
            other => panic!("expected HelloAck, got {other:?}"),
        };
        match self.next_frame().await {
            FrickFrame::Schema(_) => {}
            other => panic!("expected Schema after HelloAck, got {other:?}"),
        }
        ack.schema_hash
    }

    /// Send a `Subscribe` frame for the given kind/name (+ optional key).
    pub async fn subscribe(
        &mut self,
        subscription_id: &str,
        kind: SubscriptionKind,
        name: &str,
        key: Option<&str>,
    ) {
        self.send(&FrickFrame::Subscribe(SubscribePayload {
            subscription_id: subscription_id.into(),
            kind,
            name: name.into(),
            key: key.map(str::to_string),
            cursor: None,
        }))
        .await;
    }

    /// Send a `Ping` frame.
    pub async fn ping(&mut self) {
        self.send(&FrickFrame::Ping(frick_protocol::frame::PingPayload {
            sent_at: 0,
        }))
        .await;
    }

    /// Send a `CallCommand` frame (FR-15 call control plane). The server routes
    /// it to the control plane and replies with a `CallCommandResult` (or a
    /// `Nack` on failure). Mirrors the way [`Self::subscribe`] sends a typed
    /// frame; the conformance scenarios await the reply via [`Self::next_frame`].
    pub async fn call_command(
        &mut self,
        request_id: &str,
        command: frick_protocol::calls::CallCommandOp,
    ) {
        self.send(&FrickFrame::CallCommand(
            frick_protocol::calls::CallCommandPayload {
                request_id: request_id.to_string(),
                command,
            },
        ))
        .await;
    }

    /// Send a `SignalSend` frame for the given signal type + key, carrying a
    /// `Value` payload. Used by the calls conformance scenarios to relay a
    /// `WebRTCSignal` (gated on call membership in FR-284). Mirrors the typed
    /// frame send of [`Self::subscribe`].
    pub async fn signal_send(
        &mut self,
        request_id: &str,
        name: &str,
        key: &str,
        value: frick_protocol::Value,
    ) {
        self.send(&FrickFrame::SignalSend(
            frick_protocol::frame::SignalPayload {
                request_id: request_id.to_string(),
                name: name.to_string(),
                key: key.to_string(),
                value,
            },
        ))
        .await;
    }

    /// Close the socket.
    pub async fn close(mut self) {
        self.socket.close(None).await.ok();
    }
}

/// A unique-per-run nonce suffix, so external (reused) TS servers don't trip the
/// dev-login global-handle uniqueness gotcha across reruns.
#[must_use]
pub fn nonce() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    format!("{nanos:x}")
}
