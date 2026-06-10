//! The WebSocket sync gateway (`apps/server/src/sync/gateway.ts`, map 02 §6).
//!
//! Endpoint `GET /_frick/sync`. The gateway is the single real-time broadcast
//! funnel (FR-114): every object upsert / delete and stream append flows
//! through the [`FrickStore`] write listener into [`GatewayHub::handle_store_write`],
//! which fans the change out to the matching subscribers. HTTP and WS frame
//! handlers never publish inline.
//!
//! ## Structure
//!
//! - [`GatewayHub`] is an `Arc`-shared registry of live [`Connection`]s. Each
//!   connection carries its [`Principal`] (optional — anonymous pre-Hello / no
//!   token), its pinned storage `app_id`, its set of [`SubKey`] subscriptions,
//!   and a per-connection outbound [`mpsc::UnboundedSender`].
//! - The connection task (`run_connection`) owns the inbound loop: it decodes
//!   frames, runs the handshake gate, dispatches per the frame table, and
//!   processes frames strictly in arrival order (one `await` per frame before
//!   the next is read off the socket).
//! - A writer task drains the outbound channel to the WS sink and enforces the
//!   outbound buffered-bytes cap (`close 1013`).
//!
//! ## Determinism
//!
//! The gateway is the time + random boundary for this layer: it reads system
//! epoch-ms directly, passing values down to the facade/store, which stay pure.
//! (The facade owns its own clock/id seams for the values it stamps.)

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use frick_protocol::frame::{
    AckPayload, DeltaPayload, HelloAckPayload, HelloPayload, NackPayload, ObjectRemoval,
    ObjectUpsertPayload, PingPayload, PongPayload, PresenceClearPayload, PresenceDeltaPayload,
    PresenceSetPayload, SignalDeliverPayload, SignalPayload, SnapshotPayload, StreamPagePayload,
    SubscribePayload, SubscriptionKind,
};
use frick_protocol::{
    FrameKind, FrickClientCapabilities, FrickErrorCode, FrickErrorEnvelope, FrickFrame,
    FrickSchema, PackedRecord, Value, compare_schema_compatibility, decode_frame,
    default_server_capabilities, encode_frame, pack_object_record, pack_presence_record,
    pack_signal_envelope, pack_stream_event, reject_schema_mismatch,
    unsupported_required_capabilities,
};
use frick_store::stores::stream::StoredEvent;
use frick_store::{FrickStoreWriteEvent, FrickStoreWriteListener, StoreError};
use futures_util::SinkExt;
use futures_util::stream::StreamExt;
use tokio::sync::mpsc;

use crate::authz::{Action, Decision, DenyReason, ResourceContext, decide_baseline};
use crate::config::FrickLimits;
use crate::error::ServerError;
use crate::http::AppState;
use crate::principal::{DEFAULT_APP_ID, Principal};
use crate::session::principal_from_active_session_token;

/// WebSocket close codes used by the gateway (`src/sync/gateway.ts`,
/// `src/sync/wire.ts`).
mod close {
    /// Policy violation: authentication failures after Hello, principal change,
    /// archived tenant, session revoked.
    pub const POLICY_VIOLATION: u16 = 1008;
    /// Message too large: an inbound frame above `maxWebSocketFrameBytes`.
    pub const TOO_LARGE: u16 = 1009;
    /// Try again later: connection caps and the outbound-buffer overflow.
    pub const TRY_AGAIN_LATER: u16 = 1013;
}

/// One live WebSocket connection's mutable state. The outbound sender lets the
/// fan-out paths (and the per-connection handlers) enqueue frames without
/// owning the connection's task; the writer task drains it to the sink.
struct Connection {
    /// `None` until a successful authenticated Hello / connect-time bearer.
    principal: Option<Principal>,
    /// The session token this connection authenticated with, if any. Per-frame
    /// revalidation re-reads the session under this token.
    session_token: Option<String>,
    /// Storage app id this connection is pinned to (FR-153). `_default` unless a
    /// multi-app server matched a different app at Hello (not wired here yet).
    app_id: String,
    /// Whether the Hello handshake has completed (the gate at §6.3).
    handshake_complete: bool,
    /// Active subscriptions, by key.
    subscriptions: HashSet<SubKey>,
    /// Combined Append + ObjectUpsert pending-write budget (deliberately one
    /// counter, §13.12).
    pending_writes: u32,
    /// Outbound frame channel to the writer task. Encoded frames are pushed
    /// here; the writer forwards them as binary messages.
    outbound: mpsc::UnboundedSender<Outbound>,
}

/// A message for the writer task: either an encoded frame or a close request.
enum Outbound {
    Frame(Vec<u8>),
    Close(u16, String),
}

/// A subscription's identity: kind + name + optional key. Object/projection
/// subscriptions ignore key for matching; stream/presence/signal match on key.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SubKey {
    /// The client-chosen subscription id (used to address delta frames).
    subscription_id: String,
    kind: SubscriptionKind,
    name: String,
    key: Option<String>,
}

/// Shared gateway state behind an `Arc`.
pub struct GatewayHub {
    state: AppState,
    inner: Mutex<HubInner>,
    /// Monotonic connection id allocator.
    next_id: AtomicU64,
}

/// The locked interior of the hub.
#[derive(Default)]
struct HubInner {
    /// Live connections by id.
    connections: HashMap<u64, Connection>,
    /// Active connection count per principal connection-key (NUL-separated
    /// `tenantId\0userId`). Enforces `maxConnectionsPerPrincipal`.
    per_principal: HashMap<String, u32>,
}

impl GatewayHub {
    /// Construct a hub over the shared [`AppState`]. The store write listener
    /// the integrator registers ([`GatewayHub::write_listener`]) and the axum
    /// router ([`GatewayHub::router`]) are produced from the returned `Arc`.
    #[must_use]
    pub fn new(state: AppState) -> Arc<Self> {
        Arc::new(Self {
            state,
            inner: Mutex::new(HubInner::default()),
            next_id: AtomicU64::new(1),
        })
    }

    /// The axum router exposing `GET /_frick/sync`. Merge this onto the boot
    /// router. The hub is carried as the handler's state.
    pub fn router(self: &Arc<Self>) -> axum::Router {
        axum::Router::new()
            .route("/_frick/sync", get(upgrade))
            .with_state(Arc::clone(self))
    }

    /// The [`FrickStore`] write listener the integrator registers via
    /// `store.set_write_listener(hub.write_listener())`. It holds a `Weak`
    /// back-reference so the listener never keeps the hub alive; a fan-out that
    /// outlives the hub is a no-op.
    #[must_use]
    pub fn write_listener(self: &Arc<Self>) -> FrickStoreWriteListener {
        let weak = Arc::downgrade(self);
        Box::new(move |event: &FrickStoreWriteEvent| {
            if let Some(hub) = weak.upgrade() {
                hub.handle_store_write(event);
            }
        })
    }

    /// Live connection count (test/inspection aid).
    #[must_use]
    pub fn connection_count(&self) -> usize {
        self.inner.lock().map_or(0, |inner| inner.connections.len())
    }

    fn limits(&self) -> &FrickLimits {
        &self.state.config.limits
    }

    // ---- registration ---------------------------------------------------

    /// Register a freshly-connected client, returning its id. Caller has
    /// already passed the global + per-principal caps.
    fn register(&self, connection: Connection) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(principal) = &connection.principal {
                *inner
                    .per_principal
                    .entry(principal.connection_key())
                    .or_insert(0) += 1;
            }
            inner.connections.insert(id, connection);
        }
        id
    }

    /// Unregister a connection, releasing its per-principal slot.
    fn unregister(&self, id: u64) {
        if let Ok(mut inner) = self.inner.lock()
            && let Some(connection) = inner.connections.remove(&id)
            && let Some(principal) = &connection.principal
        {
            release_principal_slot(&mut inner.per_principal, &principal.connection_key());
        }
    }
}

/// Decrement (and prune) a per-principal connection count.
fn release_principal_slot(per_principal: &mut HashMap<String, u32>, key: &str) {
    if let Some(count) = per_principal.get_mut(key) {
        *count = count.saturating_sub(1);
        if *count == 0 {
            per_principal.remove(key);
        }
    }
}

/// The axum upgrade handler. Performs the optional connect-time bearer auth
/// before the upgrade callback runs the connection.
async fn upgrade(
    State(hub): State<Arc<GatewayHub>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    // Optional connect-time Bearer auth: an invalid token is silently ignored
    // (the client may still Hello-auth later) — §6.1.2 / §13.14.
    let bearer = bearer_token(&headers);
    let now_ms = now_ms();
    let principal = match &bearer {
        Some(token) => principal_from_active_session_token(&hub.state.store, token, now_ms)
            .await
            .ok(),
        None => None,
    };

    ws.on_upgrade(move |socket| async move {
        run_connection(hub, socket, principal, bearer).await;
    })
}

/// Drive one connection: enforce caps, register, spawn the writer task, then
/// process inbound frames strictly in arrival order until the socket closes.
#[allow(clippy::too_many_lines)]
async fn run_connection(
    hub: Arc<GatewayHub>,
    socket: WebSocket,
    principal: Option<Principal>,
    bearer: Option<String>,
) {
    let limits = hub.limits().clone();

    // Global connection cap (§6.1.1): close 1013 before any registration.
    let active = hub.inner.lock().map_or(0, |inner| inner.connections.len());
    let max_connections = usize::try_from(limits.max_web_socket_connections).unwrap_or(usize::MAX);
    if active >= max_connections {
        close_socket(
            socket,
            close::TRY_AGAIN_LATER,
            "WebSocket connection limit exceeded",
        )
        .await;
        return;
    }

    // Per-principal cap (§6.1.4): a connect-authenticated principal over its cap
    // gets a Nack(rateLimit.exceeded, requestId "connect") then close 1013.
    if let Some(principal) = &principal {
        let over_cap = hub.inner.lock().is_ok_and(|inner| {
            let current = inner
                .per_principal
                .get(&principal.connection_key())
                .copied()
                .unwrap_or(0);
            i64::from(current) >= limits.max_connections_per_principal
        });
        if over_cap {
            let nack = principal_cap_nack("connect", limits.max_connections_per_principal);
            let mut socket = socket;
            if let Ok(bytes) = encode_frame(&nack) {
                let _ = socket.send(Message::Binary(bytes)).await;
            }
            close_socket(
                socket,
                close::TRY_AGAIN_LATER,
                "WebSocket connection limit exceeded",
            )
            .await;
            return;
        }
    }

    // Outbound channel + writer task. The writer owns the sink; handlers and
    // fan-out enqueue messages onto the channel.
    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<Outbound>();
    let (mut sink, mut stream) = socket.split();

    let connection = Connection {
        principal,
        session_token: bearer,
        app_id: DEFAULT_APP_ID.to_string(),
        handshake_complete: false,
        subscriptions: HashSet::new(),
        pending_writes: 0,
        outbound: outbound_tx,
    };
    let id = hub.register(connection);

    let max_outbound =
        usize::try_from(limits.max_web_socket_outbound_buffered_bytes).unwrap_or(usize::MAX);
    let writer = tokio::spawn(async move {
        let mut buffered: usize = 0;
        while let Some(message) = outbound_rx.recv().await {
            match message {
                Outbound::Close(code, reason) => {
                    let _ = sink
                        .send(Message::Close(Some(CloseFrame {
                            code,
                            reason: reason.into(),
                        })))
                        .await;
                    return;
                }
                Outbound::Frame(bytes) => {
                    let frame_len = bytes.len();
                    // Outbound backpressure (§6.8): close 1013 when the buffered
                    // total would exceed the cap.
                    if buffered.saturating_add(frame_len) > max_outbound {
                        let _ = sink
                            .send(Message::Close(Some(CloseFrame {
                                code: close::TRY_AGAIN_LATER,
                                reason: "WebSocket outbound buffer exceeded".into(),
                            })))
                            .await;
                        return;
                    }
                    buffered += frame_len;
                    if sink.send(Message::Binary(bytes)).await.is_err() {
                        return;
                    }
                    // The send future resolving means the bytes left our buffer.
                    buffered -= frame_len;
                }
            }
        }
        let _ = sink.flush().await;
    });

    // Heartbeat: every max(50ms, heartbeatIntervalSeconds*1000) ping; terminate
    // when no inbound frame arrives within the timeout (§6.1.6).
    let interval_ms = (limits.heartbeat_interval_seconds * 1000).max(50);
    let timeout_ms = (limits.heartbeat_timeout_seconds * 1000).max(interval_ms);
    let period = u64::try_from(interval_ms).unwrap_or(50).max(1);
    let mut heartbeat = tokio::time::interval(Duration::from_millis(period));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_seen = now_ms();

    loop {
        tokio::select! {
            biased;
            _ = heartbeat.tick() => {
                if now_ms() - last_seen > timeout_ms {
                    // No inbound within the timeout: terminate.
                    break;
                }
                send_frame(&hub, id, &FrickFrame::Ping(PingPayload { sent_at: now_ms() }));
            }
            message = stream.next() => {
                let Some(Ok(message)) = message else { break };
                let close_after = match message {
                    Message::Binary(payload) => {
                        last_seen = now_ms();
                        handle_raw_frame(&hub, id, &payload).await
                    }
                    Message::Text(text) => {
                        last_seen = now_ms();
                        handle_raw_frame(&hub, id, text.as_bytes()).await
                    }
                    Message::Ping(_) | Message::Pong(_) => {
                        last_seen = now_ms();
                        false
                    }
                    Message::Close(_) => break,
                };
                if close_after {
                    break;
                }
            }
        }
    }

    hub.unregister(id);
    // Dropping the last outbound sender ends the writer loop; abort to stop
    // promptly and await its exit so the socket is fully released.
    writer.abort();
    let _ = writer.await;
}

/// Raw-frame handling (§6.2): inbound size re-check, decode, then dispatch.
/// Returns `true` when the connection should close after this frame.
async fn handle_raw_frame(hub: &Arc<GatewayHub>, id: u64, payload: &[u8]) -> bool {
    let limits = hub.limits();
    let max_frame = usize::try_from(limits.max_web_socket_frame_bytes).unwrap_or(usize::MAX);
    if payload.len() > max_frame {
        let nack = simple_nack(
            FrickErrorCode::RateLimitExceeded,
            "Inbound WebSocket frame exceeds maximum size",
            "frame",
            false,
            Some(Value::Map(vec![
                ("limit".into(), "maxWebSocketFrameBytes".into()),
                (
                    "configuredMax".into(),
                    Value::from(limits.max_web_socket_frame_bytes),
                ),
            ])),
            None,
        );
        send_frame(hub, id, &nack);
        send_close(hub, id, close::TOO_LARGE, "frame too large");
        return true;
    }

    match decode_frame(payload) {
        Ok(frame) => dispatch(hub, id, frame).await,
        Err(error) => {
            let nack = simple_nack(
                FrickErrorCode::SyncProtocolError,
                &error.to_string(),
                "unknown",
                false,
                None,
                None,
            );
            send_frame(hub, id, &nack);
            false
        }
    }
}

/// Frame dispatch (§6.3 gate + §6.6 table). Returns `true` to close.
async fn dispatch(hub: &Arc<GatewayHub>, id: u64, frame: FrickFrame) -> bool {
    let kind = frame.kind();

    // Handshake gate (§6.3): before a successful Hello, only Hello and Ping are
    // allowed; everything else → Nack sync.protocolError reason handshakeRequired.
    if !handshake_complete(hub, id) && kind != FrameKind::Hello && kind != FrameKind::Ping {
        let request_id = pre_hello_request_id(&frame);
        let nack = simple_nack(
            FrickErrorCode::SyncProtocolError,
            "Hello handshake required before sync frames",
            &request_id,
            false,
            Some(Value::Map(vec![(
                "reason".into(),
                "handshakeRequired".into(),
            )])),
            Some(hub.state.schema.clone()),
        );
        send_frame(hub, id, &nack);
        return false;
    }

    match frame {
        FrickFrame::Hello(payload) => handle_hello(hub, id, *payload).await,
        FrickFrame::Subscribe(payload) => handle_subscribe(hub, id, payload).await,
        FrickFrame::Append(payload) => handle_append(hub, id, payload).await,
        FrickFrame::ObjectUpsert(payload) => handle_object_upsert(hub, id, payload).await,
        FrickFrame::PresenceSet(payload) => handle_presence_set(hub, id, payload).await,
        FrickFrame::PresenceClear(payload) => handle_presence_clear(hub, id, payload).await,
        FrickFrame::SignalSend(payload) => handle_signal(hub, id, payload).await,
        FrickFrame::CursorCommit(payload) => {
            // Pure echo Ack — no durable cursor state (§13.9).
            send_frame(
                hub,
                id,
                &FrickFrame::Ack(AckPayload {
                    request_id: payload.subscription_id,
                    cursor: Some(payload.cursor),
                    version: None,
                }),
            );
            false
        }
        FrickFrame::Ping(payload) => {
            send_frame(
                hub,
                id,
                &FrickFrame::Pong(PongPayload {
                    sent_at: payload.sent_at,
                    received_at: now_ms(),
                }),
            );
            false
        }
        FrickFrame::CallCommand(_) => {
            // Calls are deferred (FR-15): every command → auth.forbidden
            // reason callsDisabled.
            let nack = simple_nack(
                FrickErrorCode::AuthForbidden,
                "Call control plane is disabled",
                "call",
                false,
                Some(Value::Map(vec![("reason".into(), "callsDisabled".into())])),
                None,
            );
            send_frame(hub, id, &nack);
            false
        }
        // Unknown / server→client frame kinds are silently ignored (§6.6).
        _ => false,
    }
}

// ---- Hello (§6.4) -----------------------------------------------------------

#[allow(clippy::too_many_lines)]
async fn handle_hello(hub: &Arc<GatewayHub>, id: u64, payload: HelloPayload) -> bool {
    // 1. Session auth. No token → anonymous OK. Invalid → auth.unauthenticated,
    //    close 1008. A different principal than the connection's → auth.forbidden,
    //    close 1008.
    let now_ms = now_ms();
    let mut authed: Option<Principal> = None;
    if let Some(token) = &payload.session_token {
        match principal_from_active_session_token(&hub.state.store, token, now_ms).await {
            Ok(principal) => {
                // Re-Hello with a principal mismatching the connection's → forbidden.
                if let Some(existing) = connection_principal(hub, id)
                    && !same_principal(&existing, &principal)
                {
                    return send_hello_auth_nack(
                        hub,
                        id,
                        FrickErrorCode::AuthForbidden,
                        "Hello session token does not match the connection principal",
                        "notAuthorizedForResource",
                    );
                }
                // Per-principal cap re-check (idempotent for the same key).
                if !reserve_hello_principal(hub, id, &principal) {
                    let nack =
                        principal_cap_nack("hello", hub.limits().max_connections_per_principal);
                    send_frame(hub, id, &nack);
                    send_close(hub, id, close::TRY_AGAIN_LATER, "connection limit exceeded");
                    return true;
                }
                authed = Some(principal);
            }
            Err(_) => {
                return send_hello_auth_nack(
                    hub,
                    id,
                    FrickErrorCode::AuthUnauthenticated,
                    "Invalid session token",
                    "unauthenticated",
                );
            }
        }
    }

    // 2. Schema compatibility against the (single-app) store schema. Multi-app
    //    routing is not wired in this story; the store schema is the target.
    let target = &hub.state.schema;
    let server_caps = default_server_capabilities(target);

    let compatibility = match &payload.client_capabilities {
        // 3. Legacy, no capabilities: strict hash equality.
        None => {
            if reject_schema_mismatch(&payload.schema_hash, &target.hash).is_err() {
                let nack = simple_nack(
                    FrickErrorCode::SchemaIncompatible,
                    &format!(
                        "Schema mismatch: client={} server={}",
                        payload.schema_hash, target.hash
                    ),
                    "hello",
                    false,
                    None,
                    Some(target.clone()),
                );
                send_frame(hub, id, &nack);
                return false;
            }
            compare_schema_compatibility(target, target)
        }
        // 4. With capabilities: structural compatibility + required-cap check.
        Some(caps) => {
            let client_schema = schema_from_client_caps(caps, target);
            let compatibility = compare_schema_compatibility(&client_schema, target);
            if !compatibility.compatible {
                let nack = simple_nack(
                    FrickErrorCode::SchemaIncompatible,
                    compatibility
                        .message
                        .as_deref()
                        .unwrap_or("Schema incompatible"),
                    "hello",
                    false,
                    None,
                    Some(target.clone()),
                );
                send_frame(hub, id, &nack);
                return false;
            }
            let unsupported = unsupported_required_capabilities(caps, &server_caps);
            if !unsupported.is_empty() {
                let nack = simple_nack(
                    FrickErrorCode::SyncProtocolError,
                    "Client requires unsupported capabilities",
                    "hello",
                    false,
                    Some(Value::Map(vec![(
                        "unsupportedCapabilities".into(),
                        Value::Array(unsupported.into_iter().map(Value::from).collect()),
                    )])),
                    Some(target.clone()),
                );
                send_frame(hub, id, &nack);
                return false;
            }
            compatibility
        }
    };

    // 5. Success: persist the authenticated principal, mark handshake complete,
    //    then send [HelloAck, ...] followed by [Schema, ...].
    if let Ok(mut inner) = hub.inner.lock()
        && let Some(connection) = inner.connections.get_mut(&id)
    {
        if let Some(principal) = authed {
            connection.principal = Some(principal);
            connection.session_token = payload.session_token;
        }
        connection.handshake_complete = true;
    }

    let hello_ack = FrickFrame::HelloAck(Box::new(HelloAckPayload {
        schema_hash: target.hash.clone(),
        schema_id: target.schema_id.clone(),
        schema_revision: target.schema_revision,
        schema_compatibility: compatibility,
        server_capabilities: server_caps,
    }));
    send_frame(hub, id, &hello_ack);
    send_frame(hub, id, &FrickFrame::Schema(Box::new(target.clone())));
    false
}

// ---- Subscribe (§6.6) -------------------------------------------------------

#[allow(clippy::too_many_lines)]
async fn handle_subscribe(hub: &Arc<GatewayHub>, id: u64, payload: SubscribePayload) -> bool {
    let Some(principal) = active_principal_for_frame(hub, id, &payload.subscription_id).await
    else {
        return false;
    };

    // Subscription cap (re-subscribing the same id is exempt).
    let (already, count, app_id) = subscription_count(hub, id, &payload.subscription_id);
    if !already && i64::from(count) >= hub.limits().max_subscriptions_per_connection {
        let nack = simple_nack(
            FrickErrorCode::RateLimitExceeded,
            "Maximum subscriptions per connection exceeded",
            &payload.subscription_id,
            false,
            Some(Value::Map(vec![
                ("limit".into(), "maxSubscriptionsPerConnection".into()),
                (
                    "configuredMax".into(),
                    Value::from(hub.limits().max_subscriptions_per_connection),
                ),
            ])),
            None,
        );
        send_frame(hub, id, &nack);
        return false;
    }

    // Projection subscriptions: the projection must exist in the registry
    // (map 05 §1.6) — an unknown name → auth.forbidden reason projectionNotFound.
    if payload.kind == SubscriptionKind::Projection
        && !hub.state.projections.contains(&payload.name)
    {
        let nack = simple_nack(
            FrickErrorCode::AuthForbidden,
            &format!("Unknown projection {}", payload.name),
            &payload.subscription_id,
            false,
            Some(Value::Map(vec![
                ("reason".into(), "projectionNotFound".into()),
                ("projection".into(), Value::from(payload.name.as_str())),
            ])),
            None,
        );
        send_frame(hub, id, &nack);
        return false;
    }

    // assertCanSubscribe: baseline authz for the kind. object/stream/presence/
    // signal map to their read actions.
    let decision = decide_baseline(
        &principal,
        subscribe_action(payload.kind),
        &ResourceContext {
            tenant_id: principal.tenant_id.clone(),
            owner_user_id: None,
        },
    );
    if let Decision::Deny {
        reason,
        public_message,
    } = decision
    {
        send_auth_nack(hub, id, &payload.subscription_id, reason, &public_message);
        return false;
    }

    // Record the subscription.
    add_subscription(
        hub,
        id,
        SubKey {
            subscription_id: payload.subscription_id.clone(),
            kind: payload.kind,
            name: payload.name.clone(),
            key: payload.key.clone(),
        },
    );

    let limits = hub.limits().clone();
    match payload.kind {
        SubscriptionKind::Stream => {
            let Some(key) = payload.key.clone() else {
                // Stream subscribe without a key is a protocol error.
                let nack = simple_nack(
                    FrickErrorCode::SyncProtocolError,
                    "Stream subscription requires a key",
                    &payload.subscription_id,
                    false,
                    None,
                    None,
                );
                send_frame(hub, id, &nack);
                return false;
            };
            let cursor = payload.cursor.unwrap_or(0);
            let page_limit = limits.max_stream_page_size;
            let events = hub
                .state
                .store
                .streams()
                .read(
                    &principal.tenant_id,
                    &payload.name,
                    &key,
                    cursor,
                    Some(page_limit + 1),
                    &app_id,
                )
                .await
                .unwrap_or_default();
            let take = usize::try_from(page_limit).unwrap_or(usize::MAX);
            let has_more = events.len() > take;
            let mut packed = Vec::new();
            for stored in events.iter().take(take) {
                if let Ok(event) = pack_stream_event(&hub.state.schema, &stored.event) {
                    packed.push(event);
                }
            }
            let last_cursor = packed.last().map_or(cursor, |event| event.2);
            send_frame(
                hub,
                id,
                &FrickFrame::StreamPage(StreamPagePayload {
                    subscription_id: payload.subscription_id,
                    events: packed,
                    cursor: last_cursor,
                    has_more,
                }),
            );
        }
        SubscriptionKind::Object => {
            let rows = hub
                .state
                .store
                .objects()
                .list(&principal.tenant_id, &payload.name, &app_id)
                .await
                .unwrap_or_default();
            let objects = pack_object_rows(&hub.state.schema, &payload.name, &rows);
            send_frame(
                hub,
                id,
                &FrickFrame::Snapshot(SnapshotPayload {
                    subscription_id: payload.subscription_id,
                    objects,
                    cursor: 0,
                }),
            );
        }
        // Projection subscribe delivers the registry's materialized rows for
        // the principal's tenant as one initial ProjectionDelta snapshot frame
        // (empty `changes` when there are none yet) — map 05 §1.6.
        SubscriptionKind::Projection => {
            let rows = hub
                .state
                .projections
                .snapshot(&payload.name, &principal.tenant_id);
            send_frame(
                hub,
                id,
                &FrickFrame::ProjectionDelta(frick_protocol::frame::ProjectionDeltaPayload {
                    projection: payload.name,
                    changes: crate::projections::changes_to_frame(&rows),
                }),
            );
        }
        // Presence/signal subscriptions register the matcher; the initial
        // delivery is the live fan-out (no snapshot frame), matching TS.
        SubscriptionKind::Presence | SubscriptionKind::Signal => {}
    }
    false
}

// ---- Append (§6.6) ----------------------------------------------------------

async fn handle_append(
    hub: &Arc<GatewayHub>,
    id: u64,
    payload: frick_protocol::frame::AppendPayload,
) -> bool {
    let Some(principal) = active_principal_for_frame(hub, id, &payload.request_id).await else {
        return false;
    };
    let limits = hub.limits().clone();

    if !try_reserve_pending_write(hub, id) {
        let nack = simple_nack(
            FrickErrorCode::RateLimitExceeded,
            "Pending append queue is full",
            &payload.request_id,
            true,
            Some(Value::Map(vec![
                ("limit".into(), "maxPendingAppendsPerClient".into()),
                (
                    "configuredMax".into(),
                    Value::from(limits.max_pending_appends_per_client),
                ),
            ])),
            None,
        );
        send_frame(hub, id, &nack);
        return false;
    }

    // Payload size cap (msgpack-encoded bytes).
    let encoded_len = encode_value_len(&payload.payload);
    let max_payload = usize::try_from(limits.max_stream_append_payload_bytes).unwrap_or(usize::MAX);
    if encoded_len > max_payload {
        release_pending_write(hub, id);
        let nack = simple_nack(
            FrickErrorCode::StreamAppendRejected,
            "Append payload exceeds maximum size",
            &payload.request_id,
            false,
            Some(Value::Map(vec![
                ("reason".into(), "payloadTooLarge".into()),
                (
                    "configuredMax".into(),
                    Value::from(limits.max_stream_append_payload_bytes),
                ),
            ])),
            None,
        );
        send_frame(hub, id, &nack);
        return false;
    }

    // assertCanAppend → store.appendEvent (idempotent by requestId). The store
    // write listener fans the created event out (no inline broadcast, FR-114).
    let decision = decide_baseline(
        &principal,
        Action::StreamAppend,
        &ResourceContext {
            tenant_id: principal.tenant_id.clone(),
            owner_user_id: None,
        },
    );
    if let Decision::Deny {
        reason,
        public_message,
    } = decision
    {
        release_pending_write(hub, id);
        send_auth_nack(hub, id, &payload.request_id, reason, &public_message);
        return false;
    }

    let app_id = connection_app_id(hub, id);
    let result = hub
        .state
        .store
        .append_event(
            &principal.tenant_id,
            &payload.stream,
            &payload.key,
            &principal.replica_id,
            &payload.request_id,
            &payload.event,
            &payload.payload,
            &app_id,
        )
        .await;
    release_pending_write(hub, id);

    if let Ok(append) = result {
        send_frame(
            hub,
            id,
            &FrickFrame::Ack(AckPayload {
                request_id: payload.request_id,
                cursor: Some(append.event.event.sequence),
                version: None,
            }),
        );
    } else {
        let nack = simple_nack(
            FrickErrorCode::SyncProtocolError,
            "Append failed",
            &payload.request_id,
            false,
            None,
            None,
        );
        send_frame(hub, id, &nack);
    }
    false
}

// ---- ObjectUpsert (§6.6) ----------------------------------------------------

#[allow(clippy::too_many_lines)]
async fn handle_object_upsert(
    hub: &Arc<GatewayHub>,
    id: u64,
    payload: ObjectUpsertPayload,
) -> bool {
    let Some(principal) = active_principal_for_frame(hub, id, &payload.request_id).await else {
        return false;
    };
    let limits = hub.limits().clone();

    if !try_reserve_pending_write(hub, id) {
        let nack = simple_nack(
            FrickErrorCode::RateLimitExceeded,
            "Pending write queue is full",
            &payload.request_id,
            true,
            Some(Value::Map(vec![
                ("limit".into(), "maxPendingAppendsPerClient".into()),
                (
                    "configuredMax".into(),
                    Value::from(limits.max_pending_appends_per_client),
                ),
            ])),
            None,
        );
        send_frame(hub, id, &nack);
        return false;
    }

    let decision = decide_baseline(
        &principal,
        Action::ObjectWrite,
        &ResourceContext {
            tenant_id: principal.tenant_id.clone(),
            owner_user_id: None,
        },
    );
    if let Decision::Deny {
        reason,
        public_message,
    } = decision
    {
        release_pending_write(hub, id);
        send_auth_nack(hub, id, &payload.request_id, reason, &public_message);
        return false;
    }

    let merge_policy = hub.state.store.object_merge_policy(&payload.object_type);
    let app_id = connection_app_id(hub, id);
    let result = hub
        .state
        .store
        .upsert_object_with_policy(
            &principal.tenant_id,
            &app_id,
            &payload.object_type,
            &payload.object_id,
            &payload.value,
            payload.expected_version,
        )
        .await;
    release_pending_write(hub, id);

    match result {
        Ok(upsert) => {
            send_frame(
                hub,
                id,
                &FrickFrame::Ack(AckPayload {
                    request_id: payload.request_id,
                    cursor: None,
                    version: Some(upsert.next_version),
                }),
            );
        }
        Err(StoreError::ObjectVersionConflict {
            expected_version,
            actual_version,
            ..
        }) => {
            let mut details = Vec::new();
            if let Some(expected) = expected_version {
                details.push(("expectedVersion".into(), Value::from(expected)));
            }
            details.push(("actualVersion".into(), Value::from(actual_version)));
            details.push(("mergePolicy".into(), Value::from(merge_policy.as_str())));
            let nack = simple_nack(
                FrickErrorCode::StorageConflict,
                "Object version conflict",
                &payload.request_id,
                false,
                Some(Value::Map(details)),
                Some(hub.state.schema.clone()),
            );
            send_frame(hub, id, &nack);
        }
        Err(_) => {
            let nack = simple_nack(
                FrickErrorCode::SyncProtocolError,
                "Object upsert failed",
                &payload.request_id,
                false,
                None,
                None,
            );
            send_frame(hub, id, &nack);
        }
    }
    false
}

// ---- Presence (§6.6) --------------------------------------------------------

async fn handle_presence_set(hub: &Arc<GatewayHub>, id: u64, payload: PresenceSetPayload) -> bool {
    let Some(principal) = active_principal_for_frame(hub, id, &payload.request_id).await else {
        return false;
    };
    let decision = decide_baseline(
        &principal,
        Action::PresenceWrite,
        &ResourceContext {
            tenant_id: principal.tenant_id.clone(),
            owner_user_id: None,
        },
    );
    if let Decision::Deny {
        reason,
        public_message,
    } = decision
    {
        send_auth_nack(hub, id, &payload.request_id, reason, &public_message);
        return false;
    }

    // TTL from schema presence.ttlMs/1000, clamped to [min, max] seconds.
    let limits = hub.limits();
    let ttl_seconds = frick_protocol::schema::presence_by_name(&hub.state.schema, &payload.name)
        .map_or(limits.presence_ttl_min_seconds, |presence| {
            presence.ttl_ms / 1000
        });
    let clamped = ttl_seconds.clamp(
        limits.presence_ttl_min_seconds,
        limits.presence_ttl_max_seconds,
    );
    let app_id = connection_app_id(hub, id);
    let _ = hub
        .state
        .store
        .set_presence(
            &principal.tenant_id,
            &payload.name,
            &payload.key,
            &payload.value,
            clamped * 1000,
            &app_id,
        )
        .await;

    fan_out_presence(
        hub,
        &principal.tenant_id,
        &app_id,
        &payload.name,
        &payload.key,
        Some(&payload.value),
        false,
    );
    send_frame(hub, id, &ack(payload.request_id));
    false
}

async fn handle_presence_clear(
    hub: &Arc<GatewayHub>,
    id: u64,
    payload: PresenceClearPayload,
) -> bool {
    let Some(principal) = active_principal_for_frame(hub, id, &payload.request_id).await else {
        return false;
    };
    let decision = decide_baseline(
        &principal,
        Action::PresenceWrite,
        &ResourceContext {
            tenant_id: principal.tenant_id.clone(),
            owner_user_id: None,
        },
    );
    if let Decision::Deny {
        reason,
        public_message,
    } = decision
    {
        send_auth_nack(hub, id, &payload.request_id, reason, &public_message);
        return false;
    }
    let app_id = connection_app_id(hub, id);
    let _ = hub
        .state
        .store
        .clear_presence(&principal.tenant_id, &payload.name, &payload.key, &app_id)
        .await;
    fan_out_presence(
        hub,
        &principal.tenant_id,
        &app_id,
        &payload.name,
        &payload.key,
        None,
        true,
    );
    send_frame(hub, id, &ack(payload.request_id));
    false
}

// ---- Signal (§6.6) ----------------------------------------------------------

async fn handle_signal(hub: &Arc<GatewayHub>, id: u64, payload: SignalPayload) -> bool {
    let Some(principal) = active_principal_for_frame(hub, id, &payload.request_id).await else {
        return false;
    };
    let decision = decide_baseline(
        &principal,
        Action::SignalSend,
        &ResourceContext {
            tenant_id: principal.tenant_id.clone(),
            owner_user_id: None,
        },
    );
    if let Decision::Deny {
        reason,
        public_message,
    } = decision
    {
        send_auth_nack(hub, id, &payload.request_id, reason, &public_message);
        return false;
    }
    let app_id = connection_app_id(hub, id);
    let _ = hub
        .state
        .store
        .enqueue_signal(
            &principal.tenant_id,
            &payload.name,
            &payload.key,
            &payload.value,
            None,
            &app_id,
        )
        .await;
    fan_out_signal(hub, &principal.tenant_id, &app_id, &payload);
    send_frame(hub, id, &ack(payload.request_id));
    false
}

// ---- fan-out funnel (§6.7) --------------------------------------------------

impl GatewayHub {
    /// The single store-write fan-out funnel (`#handleStoreWrite`). The store
    /// write listener calls this on every successful object upsert / delete and
    /// stream append.
    fn handle_store_write(&self, event: &FrickStoreWriteEvent) {
        match event {
            FrickStoreWriteEvent::ObjectUpsert {
                tenant_id,
                app_id,
                object_type,
                object_id,
                object,
            } => self.fan_out_object_upsert(tenant_id, app_id, object_type, object_id, object),
            FrickStoreWriteEvent::ObjectDelete {
                tenant_id,
                app_id,
                object_type,
                object_id,
            } => self.fan_out_object_delete(tenant_id, app_id, object_type, object_id),
            FrickStoreWriteEvent::StreamAppend { tenant_id, event } => {
                self.fan_out_stream_append(tenant_id, event);
            }
        }
    }

    fn fan_out_object_upsert(
        &self,
        tenant_id: &str,
        app_id: &str,
        object_type: &str,
        object_id: &str,
        object: &Value,
    ) {
        let Ok(packed) = pack_object_record(&self.schema(), object_type, object_id, object) else {
            return;
        };
        let frame = FrickFrame::Delta(DeltaPayload {
            objects: vec![packed],
            events: vec![],
            cursor: now_ms(),
            removed: None,
        });
        let Ok(bytes) = encode_frame(&frame) else {
            return;
        };
        self.broadcast_to_subscribers(
            SubscriptionKind::Object,
            object_type,
            None,
            tenant_id,
            app_id,
            &bytes,
        );
    }

    fn fan_out_object_delete(
        &self,
        tenant_id: &str,
        app_id: &str,
        object_type: &str,
        object_id: &str,
    ) {
        // Tombstone: an id-only record (no field state survives a delete).
        let Ok(tombstone) =
            pack_object_record(&self.schema(), object_type, object_id, &Value::Map(vec![]))
        else {
            return;
        };
        let frame = FrickFrame::Delta(DeltaPayload {
            objects: vec![tombstone],
            events: vec![],
            cursor: now_ms(),
            removed: Some(vec![ObjectRemoval {
                object_type: object_type.to_string(),
                id: object_id.to_string(),
            }]),
        });
        let Ok(bytes) = encode_frame(&frame) else {
            return;
        };
        self.broadcast_to_subscribers(
            SubscriptionKind::Object,
            object_type,
            None,
            tenant_id,
            app_id,
            &bytes,
        );
    }

    fn fan_out_stream_append(&self, tenant_id: &str, event: &StoredEvent) {
        let Ok(packed) = pack_stream_event(&self.schema(), &event.event) else {
            return;
        };
        let frame = FrickFrame::Delta(DeltaPayload {
            objects: vec![],
            events: vec![packed],
            cursor: event.event.sequence,
            removed: None,
        });
        let Ok(bytes) = encode_frame(&frame) else {
            return;
        };
        self.broadcast_to_subscribers(
            SubscriptionKind::Stream,
            &event.event.stream,
            Some(&event.event.stream_id),
            tenant_id,
            &event.app_id,
            &bytes,
        );
    }

    /// The schema this gateway serves (the store schema).
    fn schema(&self) -> FrickSchema {
        self.state.schema.clone()
    }

    /// Send pre-encoded `bytes` to every connection subscribed to
    /// `(kind, name, key?)` whose active principal is in `tenant_id` and whose
    /// pinned app matches `app_id`.
    /// Fan a projection delta out to the projection's subscribers
    /// (`publishProjectionDelta` / `#fanOutProjectionDelta`, map 05 §1.6).
    /// Tenant + app filtered; the projection registry's delta listener calls
    /// this (wired in `boot`).
    pub fn publish_projection_delta(&self, notice: &crate::projections::ProjectionDeltaNotice) {
        let frame = FrickFrame::ProjectionDelta(crate::projections::notice_to_payload(notice));
        let Ok(bytes) = encode_frame(&frame) else {
            return;
        };
        self.broadcast_to_subscribers(
            SubscriptionKind::Projection,
            &notice.projection,
            None,
            &notice.tenant_id,
            &notice.app_id,
            &bytes,
        );
    }

    fn broadcast_to_subscribers(
        &self,
        kind: SubscriptionKind,
        name: &str,
        key: Option<&str>,
        tenant_id: &str,
        app_id: &str,
        bytes: &[u8],
    ) {
        let Ok(inner) = self.inner.lock() else { return };
        for connection in inner.connections.values() {
            let Some(principal) = &connection.principal else {
                continue;
            };
            if !principal.is_active_cheap() || principal.tenant_id != tenant_id {
                continue;
            }
            if connection.app_id != app_id {
                continue;
            }
            let matches = connection.subscriptions.iter().any(|sub| {
                sub.kind == kind
                    && sub.name == name
                    && match key {
                        Some(key) => sub.key.as_deref() == Some(key),
                        None => true,
                    }
            });
            if matches {
                let _ = connection.outbound.send(Outbound::Frame(bytes.to_vec()));
            }
        }
    }
}

// ---- presence/signal local fan-out ------------------------------------------

fn fan_out_presence(
    hub: &Arc<GatewayHub>,
    tenant_id: &str,
    app_id: &str,
    name: &str,
    key: &str,
    value: Option<&Value>,
    cleared: bool,
) {
    let records = match value {
        Some(value) => pack_presence_record(&hub.state.schema, name, key, value)
            .map(|record| vec![record])
            .unwrap_or_default(),
        None => vec![],
    };
    let cleared_keys = if cleared {
        vec![key.to_string()]
    } else {
        vec![]
    };

    let Ok(inner) = hub.inner.lock() else { return };
    for connection in inner.connections.values() {
        let Some(principal) = &connection.principal else {
            continue;
        };
        if !principal.is_active_cheap() || principal.tenant_id != tenant_id {
            continue;
        }
        if connection.app_id != app_id {
            continue;
        }
        for sub in &connection.subscriptions {
            if sub.kind == SubscriptionKind::Presence
                && sub.name == name
                && sub.key.as_deref() == Some(key)
            {
                let frame = FrickFrame::PresenceDelta(PresenceDeltaPayload {
                    subscription_id: sub.subscription_id.clone(),
                    records: records.clone(),
                    cleared: cleared_keys.clone(),
                });
                if let Ok(bytes) = encode_frame(&frame) {
                    let _ = connection.outbound.send(Outbound::Frame(bytes));
                }
            }
        }
    }
}

fn fan_out_signal(hub: &Arc<GatewayHub>, tenant_id: &str, app_id: &str, payload: &SignalPayload) {
    let Ok(envelope) = pack_signal_envelope(
        &hub.state.schema,
        &payload.name,
        &payload.key,
        &payload.value,
    ) else {
        return;
    };
    let frame = FrickFrame::SignalDeliver(SignalDeliverPayload { envelope });
    let Ok(bytes) = encode_frame(&frame) else {
        return;
    };
    let Ok(inner) = hub.inner.lock() else { return };
    for connection in inner.connections.values() {
        let Some(principal) = &connection.principal else {
            continue;
        };
        if !principal.is_active_cheap() || principal.tenant_id != tenant_id {
            continue;
        }
        if connection.app_id != app_id {
            continue;
        }
        let matches = connection.subscriptions.iter().any(|sub| {
            sub.kind == SubscriptionKind::Signal
                && sub.name == payload.name
                && sub.key.as_deref() == Some(payload.key.as_str())
        });
        if matches {
            let _ = connection.outbound.send(Outbound::Frame(bytes.clone()));
        }
    }
}

// ---- per-frame session re-validation (§6.5) ---------------------------------

/// Re-read the session on every authenticated frame. Returns the active
/// principal, or `None` after sending the appropriate Nack (and, for fatal
/// cases, queuing a 1008 close).
async fn active_principal_for_frame(
    hub: &Arc<GatewayHub>,
    id: u64,
    request_id: &str,
) -> Option<Principal> {
    let (principal, token) = {
        let inner = hub.inner.lock().ok()?;
        let connection = inner.connections.get(&id)?;
        (
            connection.principal.clone(),
            connection.session_token.clone(),
        )
    };

    let Some(principal) = principal else {
        // Anonymous: auth Nack, connection stays open.
        send_auth_nack(
            hub,
            id,
            request_id,
            DenyReason::Unauthenticated,
            "Missing session token",
        );
        return None;
    };

    if let Some(token) = token {
        match principal_from_active_session_token(&hub.state.store, &token, now_ms()).await {
            Ok(active) => {
                if !same_principal(&principal, &active) {
                    send_auth_nack(
                        hub,
                        id,
                        request_id,
                        DenyReason::NotAuthorizedForResource,
                        "Session principal changed",
                    );
                    send_close(
                        hub,
                        id,
                        close::POLICY_VIOLATION,
                        "Session principal changed",
                    );
                    return None;
                }
                set_connection_principal(hub, id, active.clone());
                return Some(active);
            }
            Err(error) => {
                let (code, message) = match error {
                    ServerError::SessionExpired => (
                        FrickErrorCode::AuthUnauthenticated,
                        "Session expired".to_string(),
                    ),
                    ServerError::Authentication { message } => {
                        (FrickErrorCode::AuthUnauthenticated, message)
                    }
                    _ => (
                        FrickErrorCode::AuthUnauthenticated,
                        "Invalid session".to_string(),
                    ),
                };
                let nack = simple_nack(
                    code,
                    &message,
                    request_id,
                    false,
                    Some(Value::Map(vec![(
                        "reason".into(),
                        "unauthenticated".into(),
                    )])),
                    None,
                );
                send_frame(hub, id, &nack);
                send_close(hub, id, close::POLICY_VIOLATION, &message);
                return None;
            }
        }
    }

    if !principal.is_active_cheap() {
        send_auth_nack(
            hub,
            id,
            request_id,
            DenyReason::Unauthenticated,
            "Tenant is archived",
        );
        send_close(hub, id, close::POLICY_VIOLATION, "Tenant is archived");
        return None;
    }
    Some(principal)
}

// ---- connection-state accessors --------------------------------------------

fn handshake_complete(hub: &Arc<GatewayHub>, id: u64) -> bool {
    hub.inner.lock().is_ok_and(|inner| {
        inner
            .connections
            .get(&id)
            .is_some_and(|connection| connection.handshake_complete)
    })
}

fn connection_principal(hub: &Arc<GatewayHub>, id: u64) -> Option<Principal> {
    hub.inner
        .lock()
        .ok()
        .and_then(|inner| inner.connections.get(&id).and_then(|c| c.principal.clone()))
}

fn connection_app_id(hub: &Arc<GatewayHub>, id: u64) -> String {
    hub.inner.lock().map_or_else(
        |_| DEFAULT_APP_ID.to_string(),
        |inner| {
            inner
                .connections
                .get(&id)
                .map_or_else(|| DEFAULT_APP_ID.to_string(), |c| c.app_id.clone())
        },
    )
}

fn set_connection_principal(hub: &Arc<GatewayHub>, id: u64, principal: Principal) {
    if let Ok(mut inner) = hub.inner.lock()
        && let Some(connection) = inner.connections.get_mut(&id)
    {
        connection.principal = Some(principal);
    }
}

/// Reserve a per-principal slot at Hello. Idempotent for a connection that
/// already holds a slot under the same key (re-Hello). Returns `false` when the
/// principal is already at its cap.
fn reserve_hello_principal(hub: &Arc<GatewayHub>, id: u64, principal: &Principal) -> bool {
    let Ok(mut inner) = hub.inner.lock() else {
        return false;
    };
    let key = principal.connection_key();
    let previous_key = inner
        .connections
        .get(&id)
        .and_then(|c| c.principal.as_ref())
        .map(Principal::connection_key);
    // Already counted toward this exact key? Idempotent.
    if previous_key.as_deref() == Some(key.as_str()) {
        return true;
    }
    let current = inner.per_principal.get(&key).copied().unwrap_or(0);
    if i64::from(current) >= hub.state.config.limits.max_connections_per_principal {
        return false;
    }
    // Release a previous (anonymous-or-different) reservation, then take the new.
    if let Some(previous_key) = previous_key {
        release_principal_slot(&mut inner.per_principal, &previous_key);
    }
    *inner.per_principal.entry(key).or_insert(0) += 1;
    true
}

fn subscription_count(
    hub: &Arc<GatewayHub>,
    id: u64,
    subscription_id: &str,
) -> (bool, u32, String) {
    let fallback = (false, 0, DEFAULT_APP_ID.to_string());
    hub.inner.lock().map_or(fallback.clone(), |inner| {
        inner.connections.get(&id).map_or(fallback, |connection| {
            let already = connection
                .subscriptions
                .iter()
                .any(|sub| sub.subscription_id == subscription_id);
            let count = u32::try_from(connection.subscriptions.len()).unwrap_or(u32::MAX);
            (already, count, connection.app_id.clone())
        })
    })
}

fn add_subscription(hub: &Arc<GatewayHub>, id: u64, sub: SubKey) {
    if let Ok(mut inner) = hub.inner.lock()
        && let Some(connection) = inner.connections.get_mut(&id)
    {
        // Replace any existing entry with the same subscription id.
        connection
            .subscriptions
            .retain(|existing| existing.subscription_id != sub.subscription_id);
        connection.subscriptions.insert(sub);
    }
}

fn try_reserve_pending_write(hub: &Arc<GatewayHub>, id: u64) -> bool {
    let cap = hub.limits().max_pending_appends_per_client;
    let Ok(mut inner) = hub.inner.lock() else {
        return false;
    };
    let Some(connection) = inner.connections.get_mut(&id) else {
        return false;
    };
    if i64::from(connection.pending_writes) >= cap {
        return false;
    }
    connection.pending_writes += 1;
    true
}

fn release_pending_write(hub: &Arc<GatewayHub>, id: u64) {
    if let Ok(mut inner) = hub.inner.lock()
        && let Some(connection) = inner.connections.get_mut(&id)
    {
        connection.pending_writes = connection.pending_writes.saturating_sub(1);
    }
}

// ---- outbound + close -------------------------------------------------------

/// Enqueue a frame to a connection's outbound channel.
fn send_frame(hub: &Arc<GatewayHub>, id: u64, frame: &FrickFrame) {
    let Ok(bytes) = encode_frame(frame) else {
        return;
    };
    if let Ok(inner) = hub.inner.lock()
        && let Some(connection) = inner.connections.get(&id)
    {
        let _ = connection.outbound.send(Outbound::Frame(bytes));
    }
}

/// Queue a Close frame on the connection's outbound channel. The writer task
/// emits it and ends; the inbound loop ends when the socket closes.
fn send_close(hub: &Arc<GatewayHub>, id: u64, code: u16, reason: &str) {
    if let Ok(inner) = hub.inner.lock()
        && let Some(connection) = inner.connections.get(&id)
    {
        let _ = connection
            .outbound
            .send(Outbound::Close(code, reason.to_string()));
    }
}

/// Close a raw (not-yet-registered) socket with a code/reason.
async fn close_socket(mut socket: WebSocket, code: u16, reason: &str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.to_string().into(),
        })))
        .await;
}

// ---- Nack helpers -----------------------------------------------------------

/// Build a `[Nack, {requestId, error, code, message}]` frame, duplicating the
/// code/message at the payload top level (§6.6). When `schema` is `Some`, the
/// envelope is stamped with that schema's hash/revision (the store schema for
/// handshake/conflict Nacks).
fn simple_nack(
    code: FrickErrorCode,
    message: &str,
    request_id: &str,
    retryable: bool,
    details: Option<Value>,
    schema: Option<FrickSchema>,
) -> FrickFrame {
    let (schema_hash, schema_revision) = schema.map_or((None, None), |schema| {
        (Some(schema.hash), Some(schema.schema_revision))
    });
    let envelope = FrickErrorEnvelope {
        code,
        message: message.to_string(),
        request_id: request_id.to_string(),
        retryable,
        details,
        schema_hash,
        schema_revision,
    };
    FrickFrame::Nack(NackPayload {
        request_id: request_id.to_string(),
        error: envelope,
        code: Some(code),
        message: Some(message.to_string()),
    })
}

/// The per-principal cap Nack (`rateLimit.exceeded`, retryable).
fn principal_cap_nack(request_id: &str, configured_max: i64) -> FrickFrame {
    simple_nack(
        FrickErrorCode::RateLimitExceeded,
        "Maximum connections per principal exceeded",
        request_id,
        true,
        Some(Value::Map(vec![
            ("limit".into(), "maxConnectionsPerPrincipal".into()),
            ("configuredMax".into(), Value::from(configured_max)),
        ])),
        None,
    )
}

/// Send an auth Nack from a [`DenyReason`] (`#sendAuthNack`): the code is
/// `auth.unauthenticated` for the unauthenticated reason, else `auth.forbidden`.
fn send_auth_nack(
    hub: &Arc<GatewayHub>,
    id: u64,
    request_id: &str,
    reason: DenyReason,
    public_message: &str,
) {
    let code = if reason == DenyReason::Unauthenticated {
        FrickErrorCode::AuthUnauthenticated
    } else {
        FrickErrorCode::AuthForbidden
    };
    let nack = simple_nack(
        code,
        public_message,
        request_id,
        false,
        Some(Value::Map(vec![(
            "reason".into(),
            Value::from(reason.as_str()),
        )])),
        None,
    );
    send_frame(hub, id, &nack);
}

/// Hello-time auth Nack (requestId `"hello"`) followed by a 1008 close. Returns
/// `true` (the dispatch contract: close the connection).
fn send_hello_auth_nack(
    hub: &Arc<GatewayHub>,
    id: u64,
    code: FrickErrorCode,
    message: &str,
    reason: &str,
) -> bool {
    let nack = simple_nack(
        code,
        message,
        "hello",
        false,
        Some(Value::Map(vec![("reason".into(), Value::from(reason))])),
        None,
    );
    send_frame(hub, id, &nack);
    send_close(hub, id, close::POLICY_VIOLATION, message);
    true
}

// ---- pure helpers -----------------------------------------------------------

/// A no-extra-field Ack (presence/signal acks carry only the request id).
fn ack(request_id: String) -> FrickFrame {
    FrickFrame::Ack(AckPayload {
        request_id,
        cursor: None,
        version: None,
    })
}

/// Current wall-clock epoch milliseconds.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// Extract a `Bearer <token>` from the `Authorization` header (case-insensitive
/// scheme), matching `bearerTokenFromRequest`.
fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let (scheme, token) = value.split_once(char::is_whitespace)?;
    if scheme.eq_ignore_ascii_case("bearer") {
        let token = token.trim();
        (!token.is_empty()).then(|| token.to_string())
    } else {
        None
    }
}

/// `samePrincipal`: equal user/device/replica/tenant.
fn same_principal(left: &Principal, right: &Principal) -> bool {
    left.user_id == right.user_id
        && left.device_id == right.device_id
        && left.replica_id == right.replica_id
        && left.tenant_id == right.tenant_id
}

/// The Nack request id for a pre-Hello frame (`requestIdForPreHelloFrame`).
fn pre_hello_request_id(frame: &FrickFrame) -> String {
    match frame {
        FrickFrame::Subscribe(payload) => payload.subscription_id.clone(),
        FrickFrame::CursorCommit(payload) => payload.subscription_id.clone(),
        FrickFrame::Append(payload) => payload.request_id.clone(),
        FrickFrame::ObjectUpsert(payload) => payload.request_id.clone(),
        FrickFrame::PresenceSet(payload) => payload.request_id.clone(),
        FrickFrame::PresenceClear(payload) => payload.request_id.clone(),
        FrickFrame::SignalSend(payload) => payload.request_id.clone(),
        _ => "pre-hello".to_string(),
    }
}

/// Map a subscription kind to the read action used by `assertCanSubscribe`.
/// Every kind maps to exactly one action (projection is gated separately
/// upstream, but still authorizes as `projection.read`).
fn subscribe_action(kind: SubscriptionKind) -> Action {
    match kind {
        SubscriptionKind::Object => Action::ObjectRead,
        SubscriptionKind::Stream => Action::StreamRead,
        SubscriptionKind::Presence => Action::PresenceRead,
        SubscriptionKind::Signal => Action::SignalRead,
        SubscriptionKind::Projection => Action::ProjectionRead,
    }
}

/// Build a client-side [`FrickSchema`] from advertised capabilities, taking the
/// hash/revision/id from the capability and the structural body from the target
/// (the gateway only compares identity, not structure — matching
/// `schemaFromClientCapabilities`'s use in `compareSchemaCompatibility`).
fn schema_from_client_caps(caps: &FrickClientCapabilities, target: &FrickSchema) -> FrickSchema {
    FrickSchema {
        schema_id: caps.schema.schema_id.clone(),
        schema_revision: caps.schema.schema_revision,
        hash: caps.schema.schema_hash.clone(),
        ..target.clone()
    }
}

/// Pack a set of stored object values for a Snapshot/Delta. Each value carries
/// its `id`; rows that fail to pack are skipped.
fn pack_object_rows(schema: &FrickSchema, object_type: &str, rows: &[Value]) -> Vec<PackedRecord> {
    let mut packed = Vec::with_capacity(rows.len());
    for value in rows {
        let id = value
            .as_map()
            .and_then(|entries| {
                entries
                    .iter()
                    .find(|(key, _)| key.as_str() == Some("id"))
                    .and_then(|(_, value)| value.as_str())
            })
            .unwrap_or_default()
            .to_string();
        if let Ok(record) = pack_object_record(schema, object_type, &id, value) {
            packed.push(record);
        }
    }
    packed
}

/// The msgpack-encoded byte length of a value (for the append payload cap).
fn encode_value_len(value: &Value) -> usize {
    let mut buffer = Vec::new();
    if rmpv::encode::write_value(&mut buffer, value).is_ok() {
        buffer.len()
    } else {
        0
    }
}

#[cfg(test)]
mod tests;
