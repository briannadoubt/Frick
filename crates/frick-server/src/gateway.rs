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

use crate::authz::{
    Action, Decision, DenyReason, PolicyInput, PolicyResource, ResourceContext, apply_policy_hooks,
    decide_baseline,
};
use crate::cluster::{ClusterEnvelope, FrickClusterBus, PresenceRecord, ProjectionChange};
use crate::config::FrickLimits;
use crate::error::ServerError;
use crate::http::AppState;
use crate::object_visibility::{
    is_object_visible_to_user, owner_field_for_type, per_record_read_authz_active,
    subscriber_can_read_object_with_hooks,
};
use crate::principal::{DEFAULT_APP_ID, Principal};
use crate::projections::ProjectionRegistry;
use crate::session::principal_from_authorized_session_token;

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
    /// Storage app id this connection is pinned to (FR-277). `_default` unless a
    /// multi-app server matched a different app at Hello via the advertised
    /// `schemaId` (`handle_hello` sets it; it doubles as the per-app
    /// projection/search registry key — see [`projections_for_app`]).
    app_id: String,
    /// Whether the Hello handshake has completed (the gate at §6.3).
    handshake_complete: bool,
    /// Active subscriptions, by key. FR-256: an entry is inserted
    /// SYNCHRONOUSLY when the Subscribe frame is handled — before the async
    /// session re-validation in `handle_subscribe` — so a write that races in
    /// (e.g. an HTTP upsert on another task while the Subscribe is mid-await)
    /// cannot fan out to `subscribers:0` and drop the subscription's own echo
    /// delta. Deny / early-return paths remove the entry.
    subscriptions: HashSet<SubKey>,
    /// Combined Append + ObjectUpsert pending-write budget (deliberately one
    /// counter, §13.12).
    pending_writes: u32,
    /// Outbound frame channel to the writer task. Encoded frames are pushed
    /// here; the writer forwards them as binary messages.
    outbound: mpsc::UnboundedSender<Outbound>,
}

/// A message for the writer task: either an encoded frame or a close request.
#[derive(Debug)]
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
    /// Optional cluster bus (map 06 §1). `None` = single-node (every publish
    /// site fans out locally only). Set once at boot via
    /// [`GatewayHub::set_cluster_bus`]; the hub does NOT close it (the
    /// integrator owns its lifecycle).
    cluster_bus: Mutex<Option<Arc<dyn FrickClusterBus>>>,
}

/// App-registered WebSocket connection-lifecycle hook (FR-307). Fires when a
/// connection is registered or unregistered, carrying the resulting live
/// connection count for this node. Observational only (metrics, structured
/// logging) — it cannot alter the connection or deny it. Handlers run inline
/// after the hub lock is released, so they must be cheap and non-blocking and
/// must never call back into the hub. Empty on the standalone binary; a Rust
/// backend supplies its own via [`crate::boot::BootSeams`]. This is the seam
/// that active-connection gauges wire into.
pub trait ConnectionLifecycleHook: Send + Sync {
    /// A connection was just registered; `active` is the new live count.
    fn on_connect(&self, active: usize);
    /// A connection was just unregistered; `active` is the new live count.
    fn on_disconnect(&self, active: usize);
}

/// Shared, ordered set of connection-lifecycle hooks (see
/// [`ConnectionLifecycleHook`]).
pub type ConnectionLifecycleHooks =
    std::sync::Arc<Vec<std::sync::Arc<dyn ConnectionLifecycleHook>>>;

/// A monotonic token bucket for per-principal write rate limiting (FR-308).
/// Refills continuously at `refill_per_second` up to `burst` capacity.
struct TokenBucket {
    tokens: f64,
    last_refill: std::time::Instant,
}

impl TokenBucket {
    fn new(burst: f64, now: std::time::Instant) -> Self {
        Self {
            tokens: burst,
            last_refill: now,
        }
    }

    /// Refill for elapsed time, then try to spend one token. Returns true when a
    /// token was available (the action is allowed).
    fn try_consume(&mut self, now: std::time::Instant, burst: f64, refill_per_second: f64) -> bool {
        let elapsed = now
            .saturating_duration_since(self.last_refill)
            .as_secs_f64();
        self.tokens = (self.tokens + elapsed * refill_per_second).min(burst);
        self.last_refill = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// The locked interior of the hub.
#[derive(Default)]
struct HubInner {
    /// Live connections by id.
    connections: HashMap<u64, Connection>,
    /// Active connection count per principal connection-key (NUL-separated
    /// `tenantId\0userId`). Enforces `maxConnectionsPerPrincipal`.
    per_principal: HashMap<String, u32>,
    /// Connected-client count per tenant (`#tenantSubscriberCounts`). Drives
    /// the cluster bus's inbound tenant filter: when a tenant transitions
    /// between absent and present, the full key set is pushed down via
    /// `set_subscribed_tenants` so peer nodes can drop envelopes for tenants
    /// this node has no subscribers for (map 06 §1.4).
    tenant_subscriber_counts: HashMap<String, u32>,
    /// Per-principal write-rate token buckets (FR-308). Keyed by
    /// `principal.connection_key()`; pruned when the principal's last
    /// connection unregisters. Empty/unused when the bucket is disabled
    /// (`write_rate_burst <= 0`).
    rate_buckets: HashMap<String, TokenBucket>,
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
            cluster_bus: Mutex::new(None),
        })
    }

    /// Attach a [`FrickClusterBus`] for multi-node fan-out (map 06 §1.4).
    ///
    /// The integrator calls this once at boot (default = no bus = single node):
    ///
    /// ```ignore
    /// let hub = GatewayHub::new(state);
    /// let bus = MemoryClusterBus::new();          // or RedisClusterBus
    /// hub.set_cluster_bus(bus);                    // wires publish + inbound dispatch
    /// store.set_write_listener(hub.write_listener());
    /// ```
    ///
    /// Wiring performed:
    /// - every local publish site (object upsert/delete, stream append, signal,
    ///   projection delta, presence delta) additionally publishes the matching
    ///   [`ClusterEnvelope`] (tagged with the bus `originNodeId` and the
    ///   originating `appId ?? _default`);
    /// - a subscriber is registered that runs [`Self::handle_cluster_envelope`]
    ///   for inbound peer envelopes — the SAME local fan-out, WITHOUT
    ///   re-publishing (the origin node already did);
    /// - the current tenant key set is pushed down immediately so a bus joined
    ///   after clients connected starts filtering correctly.
    ///
    /// Calling this more than once replaces the bus (the previous subscription
    /// is dropped); intended to be called exactly once.
    pub fn set_cluster_bus(self: &Arc<Self>, bus: Arc<dyn FrickClusterBus>) {
        // Subscribe the inbound handler. A `Weak` back-reference keeps the bus
        // from pinning the hub alive; a delivery after the hub drops is a no-op.
        let weak = Arc::downgrade(self);
        let unsubscribe = bus.subscribe(Box::new(move |envelope: &ClusterEnvelope| {
            if let Some(hub) = weak.upgrade() {
                hub.handle_cluster_envelope(envelope);
            }
        }));
        // We keep the bus for the hub's lifetime; the subscription likewise lives
        // for the hub's lifetime, so we deliberately leak the unsubscribe handle
        // (detaching happens when the bus itself is closed/dropped by the
        // integrator). Mirrors the TS gateway, which never unsubscribes.
        std::mem::forget(unsubscribe);

        // Push the current tenant key set so a late-attached bus filters from the
        // start (parity with the gateway recomputing on every sub change).
        let tenants: HashSet<String> = self
            .inner
            .lock()
            .map(|inner| inner.tenant_subscriber_counts.keys().cloned().collect())
            .unwrap_or_default();
        bus.set_subscribed_tenants(Some(&tenants));

        if let Ok(mut slot) = self.cluster_bus.lock() {
            *slot = Some(bus);
        }
    }

    /// The attached cluster bus, if any.
    fn cluster_bus(&self) -> Option<Arc<dyn FrickClusterBus>> {
        self.cluster_bus.lock().ok().and_then(|slot| slot.clone())
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
        let mut transitioned_tenant = None;
        let mut active = None;
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(principal) = &connection.principal {
                *inner
                    .per_principal
                    .entry(principal.connection_key())
                    .or_insert(0) += 1;
                // Tenant refcount: +1 on attach (map 06 §1.4, gateway.ts:271).
                let tenant_id = principal.tenant_id.clone();
                if bump_tenant_count(&mut inner.tenant_subscriber_counts, &tenant_id, 1) {
                    transitioned_tenant = Some(());
                }
            }
            inner.connections.insert(id, connection);
            active = Some(inner.connections.len());
        }
        if transitioned_tenant.is_some() {
            self.push_subscribed_tenants();
        }
        // Fire lifecycle hooks after releasing the lock (FR-307).
        if let Some(active) = active {
            for hook in self.state.connection_lifecycle.iter() {
                hook.on_connect(active);
            }
        }
        id
    }

    /// Unregister a connection, releasing its per-principal slot.
    fn unregister(&self, id: u64) {
        let mut transitioned_tenant = false;
        let mut active = None;
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(connection) = inner.connections.remove(&id)
                && let Some(principal) = &connection.principal
            {
                let key = principal.connection_key();
                release_principal_slot(&mut inner.per_principal, &key);
                // Drop the principal's write-rate bucket once its last
                // connection is gone, so the map can't grow unbounded (FR-308).
                if !inner.per_principal.contains_key(&key) {
                    inner.rate_buckets.remove(&key);
                }
                // Tenant refcount: −1 on disconnect (gateway.ts:318).
                let tenant_id = principal.tenant_id.clone();
                transitioned_tenant =
                    bump_tenant_count(&mut inner.tenant_subscriber_counts, &tenant_id, -1);
            }
            active = Some(inner.connections.len());
        }
        if transitioned_tenant {
            self.push_subscribed_tenants();
        }
        // Fire lifecycle hooks after releasing the lock (FR-307).
        if let Some(active) = active {
            for hook in self.state.connection_lifecycle.iter() {
                hook.on_disconnect(active);
            }
        }
    }

    /// Push the current tenant key set to the cluster bus (`setSubscribedTenants`).
    /// Called only on absent↔present transitions so the bus snapshots a fresh
    /// set; adapters without the filter ignore it.
    fn push_subscribed_tenants(&self) {
        let Some(bus) = self.cluster_bus() else {
            return;
        };
        let tenants: HashSet<String> = self
            .inner
            .lock()
            .map(|inner| inner.tenant_subscriber_counts.keys().cloned().collect())
            .unwrap_or_default();
        bus.set_subscribed_tenants(Some(&tenants));
    }

    /// Live-close every connection matching `target` with a policy-violation
    /// close (`1008`) and return how many connections were signalled
    /// (`closeSession` / `closeSessionsForUser`, `src/sync/gateway.ts`). The
    /// logout route ([`crate::auth_routes`]) and the admin
    /// `sessions/revoke` route call this AFTER the session rows are deleted, so
    /// the socket's next per-frame re-validation would fail anyway — this just
    /// makes the teardown immediate (FR-278).
    ///
    /// A queued `Close` ends the writer task, which sends the WS close frame and
    /// returns; the inbound loop ends when the socket closes and `unregister`
    /// runs. The connection is NOT removed here — the per-connection task owns
    /// its own teardown, so a double-removal (and the per-principal / tenant
    /// refcount underflow it would cause) is avoided.
    ///
    /// Matching is by the connection's authenticated `session_token` and/or its
    /// principal's `user_id` (optionally tenant-scoped), per [`CloseTarget`]. An
    /// anonymous (no-principal, no-token) connection never matches.
    #[must_use]
    pub fn close_session(&self, target: &CloseTarget) -> u64 {
        let mut count: u64 = 0;
        let Ok(inner) = self.inner.lock() else {
            return 0;
        };
        for connection in inner.connections.values() {
            if !connection_matches_target(connection, target) {
                continue;
            }
            if connection
                .outbound
                .send(Outbound::Close(
                    close::POLICY_VIOLATION,
                    "Session revoked".to_string(),
                ))
                .is_ok()
            {
                count += 1;
            }
        }
        count
    }
}

/// Which live connections a [`GatewayHub::close_session`] call should tear down.
#[derive(Debug, Clone)]
pub enum CloseTarget {
    /// Every connection that authenticated with this exact session token (the
    /// logout path — a token-scoped revoke).
    Token(String),
    /// Every connection whose principal has this `user_id`, optionally narrowed
    /// to a single tenant (the admin `sessions/revoke` by-user path). `None`
    /// tenant matches the user across all tenants.
    User {
        user_id: String,
        tenant_id: Option<String>,
    },
}

/// Whether a live connection matches a [`CloseTarget`]. Token matches compare
/// the connection's authenticated `session_token`; user matches compare the
/// principal's `user_id` (and tenant, when scoped). A connection with neither a
/// token nor a principal matches nothing.
fn connection_matches_target(connection: &Connection, target: &CloseTarget) -> bool {
    match target {
        CloseTarget::Token(token) => connection.session_token.as_deref() == Some(token.as_str()),
        CloseTarget::User { user_id, tenant_id } => {
            connection.principal.as_ref().is_some_and(|principal| {
                principal.user_id == *user_id
                    && tenant_id
                        .as_deref()
                        .is_none_or(|tenant| principal.tenant_id == tenant)
            })
        }
    }
}

/// Apply a batch of tenant-count deltas (each `(tenantId, ±1)`) under one lock,
/// then push the subscribed-tenant set to the bus once if any of them
/// transitioned a tenant between absent and present.
fn apply_tenant_transitions(hub: &Arc<GatewayHub>, transitions: Vec<(String, i32)>) {
    if transitions.is_empty() {
        return;
    }
    let mut transitioned = false;
    if let Ok(mut inner) = hub.inner.lock() {
        for (tenant_id, delta) in transitions {
            transitioned |=
                bump_tenant_count(&mut inner.tenant_subscriber_counts, &tenant_id, delta);
        }
    }
    if transitioned {
        hub.push_subscribed_tenants();
    }
}

/// Adjust a per-tenant refcount; returns `true` when the tenant transitioned
/// between absent (0) and present (>0) — i.e. the caller should re-push the
/// subscribed-tenant set (`#bumpTenantCount`, gateway.ts:469-480).
fn bump_tenant_count(counts: &mut HashMap<String, u32>, tenant_id: &str, delta: i32) -> bool {
    let current = counts.get(tenant_id).copied().unwrap_or(0);
    let next = i64::from(current) + i64::from(delta);
    let transitioned = (current == 0) != (next <= 0);
    if next <= 0 {
        counts.remove(tenant_id);
    } else {
        counts.insert(
            tenant_id.to_string(),
            u32::try_from(next).unwrap_or(u32::MAX),
        );
    }
    transitioned
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
        Some(token) => principal_from_authorized_session_token(hub.state.as_ref(), token, now_ms)
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
        FrickFrame::CallCommand(payload) => handle_call_command(hub, id, payload).await,
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
        match principal_from_authorized_session_token(hub.state.as_ref(), token, now_ms).await {
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

    // 2. App routing (FR-277, `gateway.ts:540-551`). The advertised client
    //    capabilities' `schema.schemaId` selects the app via `findBySchemaId`.
    //    On a GENUINE multi-app server an advertised schemaId that matches no
    //    registered app AND isn't the store schemaId → Nack `auth.forbidden`
    //    reason `appNotAuthorized` (tenant-app-isolation-4). On a single-app
    //    server this never rejects — the store schema is the only target and the
    //    existing schema-hash compatibility behavior is preserved.
    //
    //    The compatibility target is the matched app's schema (so a multi-app
    //    client is checked against ITS app's schema, not the store/foundation
    //    schema); single-app keeps the store schema as the target. The storage
    //    app id pinned on the connection is `storage_app_id(matched)` — the
    //    matched id on multi-app, else `_default`.
    let advertised_schema_id = payload
        .client_capabilities
        .as_ref()
        .map(|caps| caps.schema.schema_id.as_str());
    let matched_app = advertised_schema_id.and_then(|id| hub.state.apps.find_by_schema_id(id));

    if hub.state.apps.is_multi_app()
        && let Some(advertised) = advertised_schema_id
        && matched_app.is_none()
        && advertised != hub.state.schema.schema_id
    {
        let known_app_ids: Vec<Value> = hub
            .state
            .apps
            .descriptors()
            .into_iter()
            .map(|descriptor| Value::from(descriptor.id))
            .collect();
        let nack = simple_nack(
            FrickErrorCode::AuthForbidden,
            "Application not authorized for this connection",
            "hello",
            false,
            Some(Value::Map(vec![
                ("reason".into(), "appNotAuthorized".into()),
                ("knownAppIds".into(), Value::Array(known_app_ids)),
            ])),
            Some(hub.state.schema.clone()),
        );
        send_frame(hub, id, &nack);
        return false;
    }

    // The resolved storage app id for the connection + the compatibility target.
    let resolved_app_id = hub
        .state
        .apps
        .storage_app_id(matched_app.map_or(crate::principal::DEFAULT_APP_ID, |app| app.id.as_str()))
        .to_string();
    let target = matched_app.map_or(&hub.state.schema, |app| &app.schema);
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
    //
    //    Tenant refcount (map 06 §1.4, gateway.ts:2220): a Hello that attaches a
    //    principal not present at connect time (anonymous upgrade → authed)
    //    bumps the new tenant +1. `reserve_hello_principal` already moved the
    //    per-principal slot; the tenant counter is independent.
    let mut tenant_transitions: Vec<(String, i32)> = Vec::new();
    if let Ok(mut inner) = hub.inner.lock()
        && let Some(connection) = inner.connections.get_mut(&id)
    {
        if let Some(principal) = authed {
            let previous_tenant = connection.principal.as_ref().map(|p| p.tenant_id.clone());
            let new_tenant = principal.tenant_id.clone();
            connection.principal = Some(principal);
            connection.session_token = payload.session_token;
            // Only adjust counts when the effective tenant actually changed
            // (re-Hello with the same principal is a no-op; same-key was
            // already filtered by `reserve_hello_principal`).
            if previous_tenant.as_deref() != Some(new_tenant.as_str()) {
                if let Some(previous) = previous_tenant {
                    tenant_transitions.push((previous, -1));
                }
                tenant_transitions.push((new_tenant, 1));
            }
        }
        // Pin the connection to its resolved storage app id (FR-277). On a
        // single-app server this is always `_default`; on multi-app it is the
        // Hello-matched app id, so every subsequent frame's store call + the
        // per-app projection/search lookups scope to that app
        // (tenant-app-isolation-3).
        connection.app_id = resolved_app_id;
        connection.handshake_complete = true;
    }
    apply_tenant_transitions(hub, tenant_transitions);

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
    // Subscription cap (re-subscribing the same id is exempt). Checked before
    // registration so a capped client never lands a pending entry.
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

    // Projection subscriptions: the projection must exist in the CONNECTION'S
    // app registry (map 05 §1.6; tenant-app-isolation-3) — an unknown name →
    // auth.forbidden reason projectionNotFound. On multi-app this is the matched
    // app's per-app registry, so app A cannot subscribe to app B's projection.
    if payload.kind == SubscriptionKind::Projection
        && !projections_for_app(hub, &app_id).contains(&payload.name)
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

    // assertCanSubscribe: baseline authz for the subscription kind, decided on
    // the connection's (Hello-authenticated) principal. Delivery is gated on
    // this BEFORE the subscription is registered, so a denied subscribe never
    // registers. object/stream/presence/signal map to their read actions.
    let hello_principal = connection_principal(hub, id);
    if let Some(hello_principal) = &hello_principal
        && let Decision::Deny {
            reason,
            public_message,
        } = decide_baseline(
            hello_principal,
            subscribe_action(payload.kind),
            &ResourceContext {
                tenant_id: hello_principal.tenant_id.clone(),
                owner_user_id: None,
            },
        )
    {
        send_auth_nack(hub, id, &payload.subscription_id, reason, &public_message);
        return false;
    }

    // FR-256: register the subscription SYNCHRONOUSLY — before the async
    // session re-validation below — so a write that races in (e.g. an HTTP
    // upsert handled on another task while this frame is mid-await) cannot fan
    // out to `subscribers:0` for this connection and silently drop this
    // subscription's own echo delta. Fan-out only reaches a connection whose
    // Hello principal already passes the tenant/app filter and (above) the
    // baseline authz, so registering here delivers no data the principal isn't
    // entitled to. Every deny / early-return path after this point removes the
    // entry, so a rejected subscribe leaves nothing behind.
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

    // Test-only deterministic suspension point modeling the production async
    // boundary (see FR-256 regression test). No-op / compiled out otherwise.
    #[cfg(test)]
    subscribe_test_pause(id).await;

    // Per-frame session re-validation (freshness / principal-change / tenant
    // archived). On denial it sends the Nack/close itself; we just drop the
    // registration so it can never deliver again.
    let Some(principal) = active_principal_for_frame(hub, id, &payload.subscription_id).await
    else {
        remove_subscription(hub, id, &payload.subscription_id);
        return false;
    };

    // Re-check the baseline authz against the freshly re-validated principal
    // (its tenant/scope is authoritative); a denial removes the entry.
    let mut subscribe_decision = decide_baseline(
        &principal,
        subscribe_action(payload.kind),
        &ResourceContext {
            tenant_id: principal.tenant_id.clone(),
            owner_user_id: None,
        },
    );
    // Projection subscriptions run app policy hooks (FR-296) at the subscribe
    // gate, mirroring the HTTP `GET /projections/:name` read route: projections
    // have no per-row owner concept, so a whole-projection hook deny is the only
    // hook relaxation, and enforcing it here closes the sync-gateway bypass for
    // projection deltas (snapshot + fan-out both flow from a passed subscribe).
    // Object subscriptions are hook-gated per row at delivery time instead
    // (snapshot / fan-out), so they are not double-checked here. With no hooks
    // registered `apply_policy_hooks` is a no-op passthrough — behavior-identical
    // to the pre-hook baseline-only gate.
    if payload.kind == SubscriptionKind::Projection {
        subscribe_decision = apply_policy_hooks(
            subscribe_decision,
            &PolicyInput {
                principal: &principal,
                action: Action::ProjectionRead,
                resource: PolicyResource {
                    kind: "projection",
                    name: Some(payload.name.clone()),
                    key: payload.key.clone(),
                    event: None,
                    owner_id: None,
                    tenant_id: principal.tenant_id.clone(),
                },
                context: None,
            },
            &hub.state.policy_hooks,
        )
        .await;
    }
    if let Decision::Deny {
        reason,
        public_message,
    } = subscribe_decision
    {
        remove_subscription(hub, id, &payload.subscription_id);
        send_auth_nack(hub, id, &payload.subscription_id, reason, &public_message);
        return false;
    }

    let limits = hub.limits().clone();
    match payload.kind {
        SubscriptionKind::Stream => {
            let Some(key) = payload.key.clone() else {
                // Stream subscribe without a key is a protocol error. Drop the
                // (now keyless) registration so it never lingers.
                remove_subscription(hub, id, &payload.subscription_id);
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
            // Tenant+type rows, then per-record read scoping for THIS subscriber
            // (FR-235/FR-116): own rows, unowned-type rows, rows with no owner
            // value (migrated data), and rows they hold a grant on. Listing the
            // full tenant set here (not an owner-filtered list) is what lets
            // grant relaxation surface shared rows in the snapshot.
            let rows = hub
                .state
                .store
                .objects()
                .list(&principal.tenant_id, &payload.name, &app_id)
                .await
                .unwrap_or_default();
            let mode = hub.state.config.object_visibility_mode;
            let owner_field = owner_field_for_type(&hub.state.schema, &payload.name);
            let per_record_active = per_record_read_authz_active(&hub.state.store).await;
            let mut visible = Vec::with_capacity(rows.len());
            for row in rows {
                if subscriber_can_read_object_with_hooks(
                    &hub.state.store,
                    &hub.state.policy_hooks,
                    mode,
                    owner_field,
                    &principal,
                    &payload.name,
                    &row,
                    per_record_active,
                    None,
                )
                .await
                {
                    visible.push(row);
                }
            }
            let objects = pack_object_rows(&hub.state.schema, &payload.name, &visible);
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
            let rows =
                projections_for_app(hub, &app_id).snapshot(&payload.name, &principal.tenant_id);
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

// A cohesive sequential handler: principal resolution → anti-flood gate →
// pending-write reservation → payload-size cap → baseline+policy authz → store
// append. Splitting it would scatter the ordered guard sequence; kept whole.
#[allow(clippy::too_many_lines)]
async fn handle_append(
    hub: &Arc<GatewayHub>,
    id: u64,
    payload: frick_protocol::frame::AppendPayload,
) -> bool {
    let Some(principal) = active_principal_for_frame(hub, id, &payload.request_id).await else {
        return false;
    };
    let limits = hub.limits().clone();

    // Anti-flood token bucket (FR-308), per principal connection-key. Disabled
    // unless the app sets write_rate_burst > 0; checked before reserving a
    // pending-write slot so a flood is shed cheaply.
    if !try_consume_write_token(hub, &principal.connection_key()) {
        let nack = simple_nack(
            FrickErrorCode::RateLimitExceeded,
            "Write rate limit exceeded",
            &payload.request_id,
            true,
            Some(Value::Map(vec![
                ("limit".into(), "writeRateBurst".into()),
                (
                    "configuredBurst".into(),
                    Value::from(limits.write_rate_burst),
                ),
                (
                    "configuredRefillPerSecond".into(),
                    Value::from(limits.write_rate_refill_per_second),
                ),
            ])),
            None,
        );
        send_frame(hub, id, &nack);
        return false;
    }

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
    // Pipeline mirrors the object-write path (FR-296): baseline → app policy
    // hooks (tightening-only). Running hooks here lets a Rust backend enforce
    // stream-scoped authz (e.g. channel broadcast: only admins may append to a
    // channel's MessageStream). With no stream-affecting hooks registered this
    // is behaviour-preserving.
    let baseline = decide_baseline(
        &principal,
        Action::StreamAppend,
        &ResourceContext {
            tenant_id: principal.tenant_id.clone(),
            owner_user_id: None,
        },
    );
    let decision = apply_policy_hooks(
        baseline,
        &PolicyInput {
            principal: &principal,
            action: Action::StreamAppend,
            resource: PolicyResource {
                kind: "stream",
                name: Some(payload.stream.clone()),
                key: Some(payload.key.clone()),
                event: Some(payload.event.clone()),
                owner_id: None,
                tenant_id: principal.tenant_id.clone(),
            },
            context: Some(&payload.payload),
        },
        &hub.state.policy_hooks,
    )
    .await;
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
            Some(&principal.user_id),
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
    // Cluster forwarding (map 06 §1.4): peers fan a `presenceDelta` to their
    // own subscribers. `records = [{key, value}]`, `cleared = []` for a set.
    if let Some(bus) = hub.cluster_bus() {
        bus.publish(&ClusterEnvelope::PresenceDelta {
            origin_node_id: bus.node_id().to_string(),
            tenant_id: principal.tenant_id.clone(),
            app_id: Some(app_id.clone()),
            name: payload.name.clone(),
            records: vec![PresenceRecord {
                key: payload.key.clone(),
                value: payload.value.clone(),
            }],
            cleared: vec![],
        });
    }
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
    // Cluster forwarding: a clear carries `records = []`, `cleared = [key]`.
    if let Some(bus) = hub.cluster_bus() {
        bus.publish(&ClusterEnvelope::PresenceDelta {
            origin_node_id: bus.node_id().to_string(),
            tenant_id: principal.tenant_id.clone(),
            app_id: Some(app_id.clone()),
            name: payload.name.clone(),
            records: vec![],
            cleared: vec![payload.key.clone()],
        });
    }
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
    // FR-284 / AURA-316: gate the WebRTCSignal *and* CallDataChannel relays on
    // call membership — only a member of the call (creator / non-resolved
    // invitee / participant of a non-ended call) may relay SDP/ICE or in-call
    // data-channel envelopes (reactions/raise-hand/captions). Both signals are
    // keyed by the call id, so the same membership check applies unchanged.
    if matches!(
        payload.name.as_str(),
        crate::calls::schema::WEBRTC_SIGNAL | crate::calls::schema::CALL_DATA_CHANNEL
    ) && !hub
        .state
        .calls
        .is_signal_member(
            &principal.tenant_id,
            &app_id,
            &payload.key,
            &principal.user_id,
        )
        .await
    {
        let nack = simple_nack(
            FrickErrorCode::AuthForbidden,
            "Not a member of this call",
            &payload.request_id,
            false,
            Some(Value::Map(vec![("reason".into(), "notMember".into())])),
            None,
        );
        send_frame(hub, id, &nack);
        return false;
    }
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

/// FR-282/FR-283 — route a `CallCommand` to the call control plane and reply
/// with a typed `CallCommandResult`, or a `Nack` mapped from the control-plane
/// error. The actor is the connection's authenticated principal.
async fn handle_call_command(
    hub: &Arc<GatewayHub>,
    id: u64,
    payload: frick_protocol::calls::CallCommandPayload,
) -> bool {
    let Some(principal) = active_principal_for_frame(hub, id, &payload.request_id).await else {
        return false;
    };
    let actor = crate::calls::CallActor {
        tenant_id: principal.tenant_id.clone(),
        user_id: principal.user_id.clone(),
        device_id: principal.device_id.clone(),
        app_id: Some(connection_app_id(hub, id)),
    };
    let request_id = payload.request_id.clone();
    match dispatch_call_command(&hub.state.calls, &actor, payload.command).await {
        Ok(mut result) => {
            result.request_id = request_id;
            // FR-285 — fan a "ringing" push out to each invitee. Best-effort: the
            // room is already created, so a push failure must never fail the
            // command (errors are swallowed/logged inside the helper).
            if result.op == frick_protocol::calls::CallCommandName::Create
                && let (Some(room), Some(invites)) = (result.room.as_ref(), result.invites.as_ref())
            {
                enqueue_ringing_push(hub, &actor.tenant_id, room, invites).await;
            }
            send_frame(hub, id, &FrickFrame::CallCommandResult(Box::new(result)));
        }
        Err(err) => {
            let (code, reason) = call_error_to_nack(&err);
            let nack = simple_nack(
                code,
                &err.to_string(),
                &request_id,
                false,
                Some(Value::Map(vec![("reason".into(), reason.into())])),
                None,
            );
            send_frame(hub, id, &nack);
        }
    }
    false
}

/// FR-285 — enqueue a "ringing" push notification per invitee of a freshly
/// created call.
///
/// Each invitee gets one `call.ringing` intent referencing the incoming call
/// from the creator, with `data` carrying at least
/// `{ type: "callRinging", callId, conversationId, createdBy }`. The intent is
/// enqueued as a durable `push.deliver` job via the notification router (the
/// same path HTTP admin-push and message notifications use), so delivery fans
/// out to every active device registration on the next worker tick.
///
/// **Best-effort by contract**: the call room already exists by the time this
/// runs, so a push failure must never fail the `CallCommand`. Every enqueue
/// error is logged and swallowed — this function never returns an error and
/// never panics. One intent is enqueued per invitee so a partial failure still
/// rings the rest.
async fn enqueue_ringing_push(
    hub: &Arc<GatewayHub>,
    tenant_id: &str,
    room: &frick_protocol::calls::CallRoomRecord,
    invites: &[frick_protocol::calls::CallInviteRecord],
) {
    use crate::push::types::{FrickNotificationIntent, NotificationBody};

    if invites.is_empty() {
        return;
    }

    let router = &hub.state.notification_router;
    let now_ms = now_ms();
    let created_by = room.created_by.as_str();
    let title = "Incoming call".to_string();
    // Safe fallback for platforms that cannot render client-side. The caller
    // id remains opaque routing metadata and must not become lock-screen text.
    let body = "Someone is calling you".to_string();

    for invite in invites {
        let data = Value::Map(vec![
            (Value::from("type"), Value::from("callRinging")),
            (Value::from("callId"), Value::from(room.id.as_str())),
            (
                Value::from("conversationId"),
                Value::from(room.conversation_id.as_str()),
            ),
            (Value::from("createdBy"), Value::from(created_by)),
            (Value::from("callerId"), Value::from(created_by)),
            (Value::from("kind"), Value::from(room.kind.as_str())),
            // Android must receive a high-priority data-only message so Play
            // Services does not bypass FirebaseMessagingService in background.
            (Value::from("clientRendered"), Value::from(true)),
        ]);
        let intent = FrickNotificationIntent {
            intent: "call.ringing".to_string(),
            tenant_id: tenant_id.to_string(),
            recipient_user_ids: vec![invite.invitee_user_id.clone()],
            body: NotificationBody {
                title: Some(title.clone()),
                body: Some(body.clone()),
                data: Some(data),
            },
            // Group ringing pushes for one call so a later end/cancel can
            // collapse them on the device.
            thread_id: Some(room.id.clone()),
            deep_link: None,
        };
        if let Err(err) = router.enqueue_intent(&intent, now_ms).await {
            tracing::warn!(
                target: "frick.calls.ringing_push",
                tenant_id = %tenant_id,
                call_id = %room.id,
                invitee_user_id = %invite.invitee_user_id,
                error = %err,
                "failed to enqueue ringing push for invitee (call already created; ignoring)",
            );
        }
    }
}

async fn dispatch_call_command(
    cp: &crate::calls::CallControlPlane,
    actor: &crate::calls::CallActor,
    command: frick_protocol::calls::CallCommandOp,
) -> Result<frick_protocol::calls::CallCommandResultPayload, crate::calls::CallError> {
    use frick_protocol::calls::{CallCommandName as Name, CallCommandOp as Op};
    let mut result = frick_protocol::calls::CallCommandResultPayload {
        request_id: String::new(),
        op: Name::Create,
        room: None,
        invites: None,
        participant: None,
        media_grant: None,
        invite: None,
        producer: None,
        consumer: None,
    };
    match command {
        Op::Create {
            conversation_id,
            invitee_user_ids,
            kind,
            region_hint,
        } => {
            let created = cp
                .create_call(
                    actor,
                    crate::calls::CreateCallInput {
                        conversation_id,
                        invitee_user_ids,
                        kind,
                        region_hint,
                    },
                )
                .await?;
            result.op = Name::Create;
            result.room = Some(created.room);
            result.invites = Some(created.invites);
        }
        Op::Join { call_id } => {
            let joined = cp.join_call(actor, &call_id).await?;
            result.op = Name::Join;
            result.room = Some(joined.room);
            result.participant = Some(joined.participant);
            result.media_grant = Some(joined.media_grant);
        }
        Op::Accept { call_id } => {
            result.op = Name::Accept;
            result.invite = Some(cp.accept_invite(actor, &call_id).await?);
        }
        Op::Leave { call_id } => {
            result.op = Name::Leave;
            result.room = Some(cp.leave_call(actor, &call_id).await?);
        }
        Op::End { call_id } => {
            result.op = Name::End;
            result.room = Some(cp.end_call(actor, &call_id).await?);
        }
        Op::SetMediaState { call_id, media } => {
            result.op = Name::SetMediaState;
            result.participant = Some(cp.set_media_state(actor, &call_id, &media).await?);
        }
        sfu @ (Op::SfuConnectTransport { .. } | Op::SfuProduce { .. } | Op::SfuConsume { .. }) => {
            dispatch_sfu_command(cp, actor, sfu, &mut result).await?;
        }
    }
    Ok(result)
}

/// Route the SFU media-negotiation ops (FR-292) to the control plane and populate
/// `result`. Split out of [`dispatch_call_command`] so each stays readable. The
/// caller guarantees `command` is one of the three `Sfu*` variants.
async fn dispatch_sfu_command(
    cp: &crate::calls::CallControlPlane,
    actor: &crate::calls::CallActor,
    command: frick_protocol::calls::CallCommandOp,
    result: &mut frick_protocol::calls::CallCommandResultPayload,
) -> Result<(), crate::calls::CallError> {
    use frick_protocol::calls::{CallCommandName as Name, CallCommandOp as Op};
    match command {
        Op::SfuConnectTransport {
            call_id,
            token,
            transport_id,
            dtls_parameters,
        } => {
            cp.sfu_connect_transport(actor, &call_id, &token, &transport_id, dtls_parameters)
                .await?;
            result.op = Name::SfuConnectTransport;
        }
        Op::SfuProduce {
            call_id,
            token,
            transport_id,
            kind,
            rtp_parameters,
        } => {
            let producer = cp
                .sfu_produce(
                    actor,
                    &call_id,
                    &token,
                    &transport_id,
                    sfu_media_kind(kind),
                    rtp_parameters,
                )
                .await?;
            result.op = Name::SfuProduce;
            result.producer = Some(frick_protocol::calls::CallSfuProduceResult {
                producer_id: producer.id,
                kind: wire_media_kind(producer.kind),
            });
        }
        Op::SfuConsume {
            call_id,
            token,
            transport_id,
            producer_id,
            rtp_capabilities,
        } => {
            let consumer = cp
                .sfu_consume(
                    actor,
                    &call_id,
                    &token,
                    &transport_id,
                    &producer_id,
                    rtp_capabilities,
                )
                .await?;
            result.op = Name::SfuConsume;
            result.consumer = Some(frick_protocol::calls::CallSfuConsumeResult {
                consumer_id: consumer.id,
                producer_id: consumer.producer_id,
                kind: wire_media_kind(consumer.kind),
                rtp_parameters: consumer.rtp_parameters,
            });
        }
        // The caller only ever passes the three Sfu* variants above.
        other => unreachable!(
            "dispatch_sfu_command received a non-SFU op: {:?}",
            other.name()
        ),
    }
    Ok(())
}

fn call_error_to_nack(err: &crate::calls::CallError) -> (FrickErrorCode, &'static str) {
    use crate::calls::{CallAuthzReason, CallError, CallStateReason};
    match err {
        CallError::Authz(reason, _) => (
            FrickErrorCode::AuthForbidden,
            match reason {
                CallAuthzReason::NotCreator => "notCreator",
                CallAuthzReason::NotInvitee => "notInvitee",
                CallAuthzReason::NotSelf => "notSelf",
            },
        ),
        CallError::State(reason, _) => match reason {
            CallStateReason::CallNotFound => (FrickErrorCode::StorageNotFound, "callNotFound"),
            CallStateReason::CapacityExceeded => {
                (FrickErrorCode::RateLimitExceeded, "capacityExceeded")
            }
            CallStateReason::CallEnded => (FrickErrorCode::StorageConflict, "callEnded"),
            CallStateReason::NotParticipant => (FrickErrorCode::StorageConflict, "notParticipant"),
            CallStateReason::InviteAlreadyResolved => {
                (FrickErrorCode::StorageConflict, "inviteAlreadyResolved")
            }
            CallStateReason::NoInvitees => (FrickErrorCode::StorageConflict, "noInvitees"),
        },
        CallError::MediaUnsupported(_) => (FrickErrorCode::AuthForbidden, "mediaUnsupported"),
        // A bad/expired join token or a transport/producer ownership violation
        // (FR-166/170/171/172) → forbidden, never an internal error.
        CallError::MediaForbidden(_) => (FrickErrorCode::AuthForbidden, "forbidden"),
        CallError::Media(_) | CallError::Store(_) | CallError::Decode(_) => {
            (FrickErrorCode::ServerInternal, "internal")
        }
    }
}

/// Map the wire SFU media kind onto the backend's [`crate::calls::MediaKind`].
fn sfu_media_kind(kind: frick_protocol::calls::CallSfuMediaKind) -> crate::calls::MediaKind {
    use frick_protocol::calls::CallSfuMediaKind;
    match kind {
        CallSfuMediaKind::Audio => crate::calls::MediaKind::Audio,
        CallSfuMediaKind::Video => crate::calls::MediaKind::Video,
    }
}

/// Map the backend's [`crate::calls::MediaKind`] back onto the wire enum.
fn wire_media_kind(kind: crate::calls::MediaKind) -> frick_protocol::calls::CallSfuMediaKind {
    use frick_protocol::calls::CallSfuMediaKind;
    match kind {
        crate::calls::MediaKind::Audio => CallSfuMediaKind::Audio,
        crate::calls::MediaKind::Video => CallSfuMediaKind::Video,
    }
}

// ---- fan-out funnel (§6.7) --------------------------------------------------

impl GatewayHub {
    /// The single store-write fan-out funnel (`#handleStoreWrite`). The store
    /// write listener calls this on every successful object upsert / delete and
    /// stream append.
    ///
    /// This is the **origin** path (a local write): it fans out locally AND
    /// forwards the matching [`ClusterEnvelope`] to the cluster bus so peer
    /// nodes fan it to their own subscribers (FR-114, map 06 §1.4). The inbound
    /// path ([`Self::handle_cluster_envelope`]) reuses the same `fan_out_*`
    /// helpers but never re-publishes.
    fn handle_store_write(self: &Arc<Self>, event: &FrickStoreWriteEvent) {
        // App post-commit write side-effects (FR-304): dispatched detached for
        // every event kind, with a store handle. A failing or slow side-effect
        // can neither fail nor block the originating write — errors are logged.
        for side_effect in &self.state.write_side_effects {
            let fut = side_effect.on_write(event.clone(), Arc::clone(&self.state.store));
            tokio::spawn(async move {
                if let Err(err) = fut.await {
                    tracing::error!(target: "frick.write_side_effect", error = %err, "write side-effect failed");
                }
            });
        }
        // Cross-region federation seam (AURA-323): hand each locally-originated
        // write to app federation hooks so a backend can forward/replicate it to
        // peer regions per its own routing policy. Observational + non-blocking;
        // any network forwarding is the hook's own responsibility.
        for hook in self.state.federation_hooks.iter() {
            hook.on_local_write(event);
        }
        match event {
            FrickStoreWriteEvent::ObjectUpsert {
                tenant_id,
                app_id,
                object_type,
                object_id,
                object,
                writer_user_id,
            } => {
                self.fan_out_object_upsert(
                    tenant_id,
                    app_id,
                    object_type,
                    object_id,
                    object,
                    writer_user_id.as_deref(),
                );
                if let Some(bus) = self.cluster_bus() {
                    bus.publish(&ClusterEnvelope::Objects {
                        origin_node_id: bus.node_id().to_string(),
                        tenant_id: tenant_id.clone(),
                        app_id: Some(app_id.clone()),
                        object_type: object_type.clone(),
                        objects: vec![object.clone()],
                    });
                }
            }
            FrickStoreWriteEvent::ObjectDelete {
                tenant_id,
                app_id,
                object_type,
                object_id,
            } => {
                self.fan_out_object_delete(tenant_id, app_id, object_type, object_id);
                if let Some(bus) = self.cluster_bus() {
                    bus.publish(&ClusterEnvelope::ObjectDeletes {
                        origin_node_id: bus.node_id().to_string(),
                        tenant_id: tenant_id.clone(),
                        app_id: Some(app_id.clone()),
                        object_type: object_type.clone(),
                        ids: vec![object_id.clone()],
                    });
                }
            }
            FrickStoreWriteEvent::StreamAppend { tenant_id, event } => {
                self.fan_out_stream_append(tenant_id, event);
                if let Some(bus) = self.cluster_bus()
                    && let Ok(packed) = pack_stream_event(&self.schema(), &event.event)
                {
                    bus.publish(&ClusterEnvelope::StreamEvent {
                        origin_node_id: bus.node_id().to_string(),
                        tenant_id: tenant_id.clone(),
                        app_id: Some(event.app_id.clone()),
                        stream: event.event.stream.clone(),
                        stream_id: event.event.stream_id.clone(),
                        sequence: event.event.sequence,
                        packed,
                    });
                }
            }
        }
    }

    // A single linear delivery pipeline: match subscribers → synchronous
    // baseline split → async hook/grant resolution. Splitting it would scatter
    // the ordered delivery contract the funnel/hook tests rely on; kept whole.
    #[allow(clippy::too_many_lines)]
    fn fan_out_object_upsert(
        self: &Arc<Self>,
        tenant_id: &str,
        app_id: &str,
        object_type: &str,
        object_id: &str,
        object: &Value,
        writer_user_id: Option<&str>,
    ) {
        // The record id rides the packed tuple's id slot, so the packed
        // *fields* must not include `id` — schema object types do not declare
        // an `id` field, and `pack_object_record` errors on an unknown field.
        // Strip it first, matching the TS `withoutRecordId` before packing.
        let schema = self.schema();
        let value = without_record_id(object);
        let Ok(packed) = pack_object_record(&schema, object_type, object_id, &value) else {
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

        // Per-record read scoping (FR-235/FR-116/FR-296). The ownership baseline
        // is a synchronous field compare, so baseline-visible subscribers
        // (owners, the writer, admins, unowned-type rows, migrated rows) are
        // delivered to inline — preserving ordering and the synchronous-delivery
        // contract the funnel tests rely on. Subscribers who fail the baseline
        // (owner mismatch) may still hold a sharing grant; those are resolved
        // asynchronously below, since grant lookups hit the store.
        //
        // When app policy hooks are registered (FR-296) a hook can tighten a
        // whole object TYPE, so a baseline-visible subscriber is NOT necessarily
        // allowed: every matching subscriber is instead routed through the async
        // `subscriber_can_read_object_with_hooks` pipeline (hooks + grant
        // relaxation), the same authz the HTTP LIST and snapshot paths run. With
        // NO hooks registered this branch is never taken and delivery is
        // byte-identical to the pre-hook synchronous path.
        let mode = self.state.config.object_visibility_mode;
        let owner_field = owner_field_for_type(&schema, object_type);
        let has_hooks = !self.state.policy_hooks.is_empty();
        // Subscribers deferred to the async store-touching pipeline: owner-
        // mismatch grant candidates always; when hooks are live, every matching
        // subscriber (baseline-visible ones too, since a hook may deny the type).
        let mut deferred: Vec<(Principal, mpsc::UnboundedSender<Outbound>)> = Vec::new();
        {
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
                let matches = connection
                    .subscriptions
                    .iter()
                    .any(|sub| sub.kind == SubscriptionKind::Object && sub.name == object_type);
                if !matches {
                    continue;
                }
                if has_hooks {
                    // Hook stage may tighten even a baseline allow — defer all.
                    deferred.push((principal.clone(), connection.outbound.clone()));
                    continue;
                }
                let baseline_visible = writer_user_id == Some(principal.user_id.as_str())
                    || principal.is_admin()
                    || is_object_visible_to_user(mode, owner_field, object, &principal.user_id);
                if baseline_visible {
                    let _ = connection.outbound.send(Outbound::Frame(bytes.clone()));
                } else {
                    deferred.push((principal.clone(), connection.outbound.clone()));
                }
            }
        }

        if deferred.is_empty() {
            return;
        }
        // Deferred subscribers are resolved off the hot path — grant / hook
        // evaluation tolerates the brief asynchronous delay, and skipping it
        // entirely when no grant has ever been issued AND no hooks are
        // registered keeps the common deployment fully synchronous. When hooks
        // are live the full `subscriber_can_read_object_with_hooks` pipeline runs
        // per subscriber (hooks compose with per-record grant relaxation); when
        // they are not, only owner-mismatch grant candidates reach here and the
        // grant probe alone decides.
        let hub = Arc::clone(self);
        let tenant_id = tenant_id.to_string();
        let object_type = object_type.to_string();
        let object_id = object_id.to_string();
        let object = object.clone();
        let writer_user_id = writer_user_id.map(str::to_string);
        let owner_field_owned = owner_field.map(str::to_string);
        tokio::spawn(async move {
            let per_record_active = per_record_read_authz_active(&hub.state.store).await;
            if has_hooks {
                for (principal, outbound) in deferred {
                    if subscriber_can_read_object_with_hooks(
                        &hub.state.store,
                        &hub.state.policy_hooks,
                        mode,
                        owner_field_owned.as_deref(),
                        &principal,
                        &object_type,
                        &object,
                        per_record_active,
                        writer_user_id.as_deref(),
                    )
                    .await
                    {
                        let _ = outbound.send(Outbound::Frame(bytes.clone()));
                    }
                }
                return;
            }
            if !per_record_active {
                return;
            }
            for (principal, outbound) in deferred {
                if hub
                    .state
                    .store
                    .grants()
                    .has_active_grant_for(
                        &tenant_id,
                        &principal.user_id,
                        &object_type,
                        &object_id,
                        "read",
                    )
                    .await
                    .unwrap_or(false)
                {
                    let _ = outbound.send(Outbound::Frame(bytes.clone()));
                }
            }
        });
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

    /// A record's read visibility was REVOKED for some principals (a sharing
    /// grant was revoked or left, FR-235). For each object subscriber in the
    /// tenant/app partition, the row's read pipeline is re-evaluated against
    /// current grant state: a subscriber who can no longer read it receives a
    /// removal Delta (the same tombstone + `removed` shape a delete uses) so
    /// the row disappears live; the owner and any remaining grantees receive
    /// nothing. A removal for a row a subscriber never held is harmless — the
    /// client drops ids it does not have — so no per-subscriber bookkeeping is
    /// needed. Async (it reads the row + probes grants); callers `await` it.
    pub async fn fan_out_object_visibility_revoked(
        self: &Arc<Self>,
        tenant_id: &str,
        app_id: &str,
        object_type: &str,
        object_id: &str,
    ) {
        // If the row is gone, the delete fan-out already handles dropping it.
        let Ok(Some(object)) = self
            .state
            .store
            .objects()
            .read(tenant_id, object_type, object_id, app_id)
            .await
        else {
            return;
        };
        let schema = self.schema();
        let Ok(tombstone) =
            pack_object_record(&schema, object_type, object_id, &Value::Map(vec![]))
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

        let mode = self.state.config.object_visibility_mode;
        let owner_field = owner_field_for_type(&schema, object_type);
        let per_record_active = per_record_read_authz_active(&self.state.store).await;

        let mut subscribers: Vec<(Principal, mpsc::UnboundedSender<Outbound>)> = Vec::new();
        {
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
                let matches = connection
                    .subscriptions
                    .iter()
                    .any(|sub| sub.kind == SubscriptionKind::Object && sub.name == object_type);
                if matches {
                    subscribers.push((principal.clone(), connection.outbound.clone()));
                }
            }
        }

        for (principal, outbound) in subscribers {
            if subscriber_can_read_object_with_hooks(
                &self.state.store,
                &self.state.policy_hooks,
                mode,
                owner_field,
                &principal,
                object_type,
                &object,
                per_record_active,
                None,
            )
            .await
            {
                // Still readable (owner / remaining grantees / unowned type).
                continue;
            }
            let _ = outbound.send(Outbound::Frame(bytes.clone()));
        }
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

    /// Fan a projection delta out to the projection's subscribers
    /// (`publishProjectionDelta`, map 05 §1.6) AND forward it over the cluster
    /// bus (map 06 §1.4). The projection registry's delta listener calls this
    /// (wired in `boot`); it is the **origin** path. The inbound path uses
    /// [`Self::fan_out_projection_delta`] directly (no re-publish).
    pub fn publish_projection_delta(&self, notice: &crate::projections::ProjectionDeltaNotice) {
        self.fan_out_projection_delta(notice);
        if let Some(bus) = self.cluster_bus() {
            bus.publish(&ClusterEnvelope::ProjectionDelta {
                origin_node_id: bus.node_id().to_string(),
                tenant_id: notice.tenant_id.clone(),
                app_id: Some(notice.app_id.clone()),
                projection: notice.projection.clone(),
                changes: notice
                    .changes
                    .iter()
                    .map(projection_change_to_envelope)
                    .collect(),
            });
        }
    }

    /// Local-only projection-delta fan-out, reused by the cluster handler
    /// (`#fanOutProjectionDelta`).
    fn fan_out_projection_delta(&self, notice: &crate::projections::ProjectionDeltaNotice) {
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

    /// Publish a signal to local subscribers AND forward it over the cluster
    /// bus (`publishSignal`, gateway.ts:990-1018). The integrator's HTTP signal
    /// route calls this; client WS signals route through the in-connection
    /// handler (which, matching the TS gateway, fans out locally only and does
    /// not forward over the bus). `request_id` defaults to `"http"` for
    /// HTTP-originated signals.
    pub fn publish_signal(
        &self,
        name: &str,
        key: &str,
        value: &Value,
        tenant_id: &str,
        app_id: &str,
        request_id: &str,
    ) {
        let payload = SignalPayload {
            request_id: request_id.to_string(),
            name: name.to_string(),
            key: key.to_string(),
            value: value.clone(),
        };
        // `fan_out_signal` is a free fn taking `&Arc<Self>`; build one cheaply
        // via the schema-only path it needs. Inline the broadcast instead to
        // avoid an Arc; reuse the same matcher.
        self.fan_out_signal_local(tenant_id, app_id, &payload);
        if let Some(bus) = self.cluster_bus() {
            bus.publish(&ClusterEnvelope::Signal {
                origin_node_id: bus.node_id().to_string(),
                tenant_id: tenant_id.to_string(),
                app_id: Some(app_id.to_string()),
                name: name.to_string(),
                key: key.to_string(),
                value: value.clone(),
                request_id: request_id.to_string(),
            });
        }
    }

    /// Apply a [`ClusterEnvelope`] received from a peer node
    /// (`#handleClusterEnvelope`, gateway.ts:916-989). Runs the same local
    /// fan-out the originating node's `publish*` methods do, but does NOT
    /// forward back to the bus — the origin already published it. Self-published
    /// envelopes are filtered upstream by the bus's loop guard, so this only
    /// sees genuine peer traffic.
    ///
    /// The two media-placement kinds fall through and are ignored (the gateway
    /// has no `default` arm; only a media-placement subscriber handles them).
    /// Envelopes from older peers with `app_id == None` default to
    /// [`DEFAULT_APP_ID`].
    #[allow(clippy::too_many_lines)] // one linear dispatch over every envelope kind
    pub fn handle_cluster_envelope(self: &Arc<Self>, envelope: &ClusterEnvelope) {
        match envelope {
            ClusterEnvelope::StreamEvent {
                tenant_id,
                app_id,
                packed,
                ..
            } => {
                self.fan_out_packed_stream_event(
                    tenant_id,
                    app_id_or_default(app_id.as_deref()),
                    packed,
                );
            }
            ClusterEnvelope::Objects {
                tenant_id,
                app_id,
                object_type,
                objects,
                ..
            } => {
                let app_id = app_id_or_default(app_id.as_deref());
                for object in objects {
                    let object_id = object_id_of(object);
                    // A peer write carries no local writer identity.
                    self.fan_out_object_upsert(
                        tenant_id,
                        app_id,
                        object_type,
                        &object_id,
                        object,
                        None,
                    );
                }
            }
            ClusterEnvelope::ObjectDeletes {
                tenant_id,
                app_id,
                object_type,
                ids,
                ..
            } => {
                let app_id = app_id_or_default(app_id.as_deref());
                for object_id in ids {
                    self.fan_out_object_delete(tenant_id, app_id, object_type, object_id);
                }
            }
            ClusterEnvelope::Signal {
                tenant_id,
                app_id,
                name,
                key,
                value,
                request_id,
                ..
            } => {
                let payload = SignalPayload {
                    request_id: request_id.clone(),
                    name: name.clone(),
                    key: key.clone(),
                    value: value.clone(),
                };
                self.fan_out_signal_local(
                    tenant_id,
                    app_id_or_default(app_id.as_deref()),
                    &payload,
                );
            }
            ClusterEnvelope::ProjectionDelta {
                tenant_id,
                app_id,
                projection,
                changes,
                ..
            } => {
                self.fan_out_projection_delta(&crate::projections::ProjectionDeltaNotice {
                    projection: projection.clone(),
                    tenant_id: tenant_id.clone(),
                    app_id: app_id_or_default(app_id.as_deref()).to_string(),
                    changes: changes.iter().map(envelope_change_to_projection).collect(),
                });
            }
            ClusterEnvelope::PresenceDelta {
                tenant_id,
                app_id,
                name,
                records,
                cleared,
                ..
            } => {
                // Pick the "primary" key for the local-subscriber lookup; if both
                // records and cleared are empty, the envelope is silently
                // ignored (gateway.ts:972-988).
                let Some(key) = records
                    .first()
                    .map(|record| record.key.clone())
                    .or_else(|| cleared.first().cloned())
                else {
                    return;
                };
                self.fan_out_presence_delta(
                    tenant_id,
                    app_id_or_default(app_id.as_deref()),
                    name,
                    &key,
                    records,
                    cleared,
                );
            }
            // Media-placement kinds (FR-293): ignored by the gateway. They are
            // handled by the `ClusterMediaPlacement` registry, which subscribes
            // to the bus directly (its own handler maintains the call→home map),
            // exactly as the TS `cluster-media-placement.ts` does — the gateway
            // never routes these. See `calls::media_placement`.
            ClusterEnvelope::MediaPlacementClaim { .. }
            | ClusterEnvelope::MediaPlacementRelease { .. } => {}
        }
    }

    /// Broadcast a pre-packed stream event to local Stream subscribers (the
    /// inbound counterpart of [`Self::fan_out_stream_append`], which packs from
    /// a [`StoredEvent`]).
    fn fan_out_packed_stream_event(
        &self,
        tenant_id: &str,
        app_id: &str,
        packed: &frick_protocol::codec::PackedStreamEvent,
    ) {
        let stream = stream_name_of(&self.schema(), packed);
        let stream_id = packed.1.clone();
        let frame = FrickFrame::Delta(DeltaPayload {
            objects: vec![],
            events: vec![packed.clone()],
            cursor: packed.2,
            removed: None,
        });
        let Ok(bytes) = encode_frame(&frame) else {
            return;
        };
        self.broadcast_to_subscribers(
            SubscriptionKind::Stream,
            &stream,
            Some(&stream_id),
            tenant_id,
            app_id,
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

/// Local presence-delta fan-out for the connection handlers. A `set` passes
/// `value = Some(v)`, `cleared = false`; a `clear` passes `value = None`,
/// `cleared = true`. Delegates to [`GatewayHub::fan_out_presence_delta`], the
/// path the cluster handler also uses.
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
        Some(value) => vec![PresenceRecord {
            key: key.to_string(),
            value: value.clone(),
        }],
        None => vec![],
    };
    let cleared_keys = if cleared {
        vec![key.to_string()]
    } else {
        vec![]
    };
    hub.fan_out_presence_delta(tenant_id, app_id, name, key, &records, &cleared_keys);
}

impl GatewayHub {
    /// Fan a presence delta out to the local subscribers of `(name, key)`
    /// (`#fanOutPresenceDelta`, gateway.ts:1727-1762). Records whose value is
    /// [`Value::Nil`] are dropped before packing (the wire `null` removal
    /// marker); `cleared` carries the cleared keys verbatim. Tenant + app
    /// filtered. Reused by the cluster inbound handler.
    fn fan_out_presence_delta(
        &self,
        tenant_id: &str,
        app_id: &str,
        name: &str,
        key: &str,
        records: &[PresenceRecord],
        cleared: &[String],
    ) {
        let packed: Vec<_> = records
            .iter()
            .filter(|record| !matches!(record.value, Value::Nil))
            .filter_map(|record| {
                pack_presence_record(&self.state.schema, name, &record.key, &record.value).ok()
            })
            .collect();
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
            for sub in &connection.subscriptions {
                if sub.kind == SubscriptionKind::Presence
                    && sub.name == name
                    && sub.key.as_deref() == Some(key)
                {
                    let frame = FrickFrame::PresenceDelta(PresenceDeltaPayload {
                        subscription_id: sub.subscription_id.clone(),
                        records: packed.clone(),
                        cleared: cleared.to_vec(),
                    });
                    if let Ok(bytes) = encode_frame(&frame) {
                        let _ = connection.outbound.send(Outbound::Frame(bytes));
                    }
                }
            }
        }
    }

    /// Fan a signal out to the local subscribers of `(name, key)` (`routeSignal`
    /// local-delivery path). Tenant + app filtered. Reused by the cluster
    /// inbound handler and [`Self::publish_signal`].
    fn fan_out_signal_local(&self, tenant_id: &str, app_id: &str, payload: &SignalPayload) {
        let Ok(envelope) = pack_signal_envelope(
            &self.state.schema,
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
                sub.kind == SubscriptionKind::Signal
                    && sub.name == payload.name
                    && sub.key.as_deref() == Some(payload.key.as_str())
            });
            if matches {
                let _ = connection.outbound.send(Outbound::Frame(bytes.clone()));
            }
        }
    }
}

/// Local signal fan-out for the connection handler. Delegates to
/// [`GatewayHub::fan_out_signal_local`].
fn fan_out_signal(hub: &Arc<GatewayHub>, tenant_id: &str, app_id: &str, payload: &SignalPayload) {
    hub.fan_out_signal_local(tenant_id, app_id, payload);
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
        match principal_from_authorized_session_token(hub.state.as_ref(), &token, now_ms()).await {
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

/// The projection registry scoped to a connection's app (FR-277,
/// `gateway.ts:510-515`): the per-app registry of the connection's
/// (Hello-resolved) `app_id` on a genuine multi-app server, else the shared
/// `_default` registry. On a single-app server the `app_id` is always `_default`
/// and this is `state.projections`, so subscribe validation + snapshots are
/// unchanged.
fn projections_for_app<'a>(hub: &'a Arc<GatewayHub>, app_id: &str) -> &'a ProjectionRegistry {
    if hub.state.apps.is_multi_app() {
        hub.state
            .apps
            .get(app_id)
            .map_or(&hub.state.projections, |app| &app.projections)
    } else {
        &hub.state.projections
    }
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

/// Remove a subscription by id (FR-256: a subscribe whose async session
/// re-validation or authz denies, or a post-registration protocol error,
/// must not leave its synchronously-registered entry behind). No-op if the
/// subscription (or connection) is already gone.
fn remove_subscription(hub: &Arc<GatewayHub>, id: u64, subscription_id: &str) {
    if let Ok(mut inner) = hub.inner.lock()
        && let Some(connection) = inner.connections.get_mut(&id)
    {
        connection
            .subscriptions
            .retain(|existing| existing.subscription_id != subscription_id);
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

/// Anti-flood gate (FR-308): spend one write token for `key`'s bucket. Returns
/// `true` when the write is allowed. A non-positive burst disables the bucket
/// and always allows (backward compatible). The bucket is created full on first
/// use so a fresh principal can immediately burst up to capacity.
//
// Casts are precision-safe in practice: write_rate_burst / _refill_per_second
// are small operator-configured rate counts (single/double digits up to a few
// thousand), far below f64's 2^52 exact-integer range.
#[allow(clippy::cast_precision_loss)]
fn try_consume_write_token(hub: &Arc<GatewayHub>, key: &str) -> bool {
    let limits = hub.limits();
    let burst = limits.write_rate_burst;
    if burst <= 0 {
        return true;
    }
    let burst = burst as f64;
    let refill = limits.write_rate_refill_per_second.max(0) as f64;
    let now = std::time::Instant::now();
    let Ok(mut inner) = hub.inner.lock() else {
        return true; // never block writes on a poisoned lock
    };
    let bucket = inner
        .rate_buckets
        .entry(key.to_string())
        .or_insert_with(|| TokenBucket::new(burst, now));
    bucket.try_consume(now, burst, refill)
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

// ---- cluster helpers --------------------------------------------------------

/// An envelope `appId` (`Option<&str>`) resolved to a `&str`, defaulting an
/// absent value (an older peer's envelope) to [`DEFAULT_APP_ID`] (FR-153).
fn app_id_or_default(app_id: Option<&str>) -> &str {
    app_id.unwrap_or(DEFAULT_APP_ID)
}

/// Extract the `id` field of an object [`Value`] map (used to address the
/// inbound object upsert; the value carries its own id).
fn object_id_of(object: &Value) -> String {
    object
        .as_map()
        .and_then(|entries| {
            entries
                .iter()
                .find(|(key, _)| key.as_str() == Some("id"))
                .and_then(|(_, value)| value.as_str())
        })
        .unwrap_or_default()
        .to_string()
}

/// Resolve the stream's schema name from a packed stream event's `streamTypeId`
/// (`packed[0]`). Falls back to an empty name (no subscriber matches) when the
/// id is unknown.
fn stream_name_of(
    schema: &FrickSchema,
    packed: &frick_protocol::codec::PackedStreamEvent,
) -> String {
    frick_protocol::schema::stream_by_id(schema, packed.0)
        .map(|stream| stream.name.clone())
        .unwrap_or_default()
}

/// Project a registry [`ProjectionChange`](crate::projections::ProjectionChange)
/// onto a cluster-envelope [`ProjectionChange`]. The registry change's
/// `value: Option<Value>` (`None` = removal) maps to [`Value::Nil`].
fn projection_change_to_envelope(
    change: &crate::projections::ProjectionChange,
) -> ProjectionChange {
    ProjectionChange {
        key: change.key.clone(),
        value: change.value.clone().unwrap_or(Value::Nil),
    }
}

/// Inverse of [`projection_change_to_envelope`]: a cluster-envelope change's
/// [`Value::Nil`] value maps back to a registry change's `None` (removal).
fn envelope_change_to_projection(
    change: &ProjectionChange,
) -> crate::projections::ProjectionChange {
    crate::projections::ProjectionChange {
        key: change.key.clone(),
        value: match &change.value {
            Value::Nil => None,
            value => Some(value.clone()),
        },
    }
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
        // Strip the record id before packing — it rides the tuple's id slot,
        // not the field list (see `fan_out_object_upsert`).
        let fields = without_record_id(value);
        if let Ok(record) = pack_object_record(schema, object_type, &id, &fields) {
            packed.push(record);
        }
    }
    packed
}

/// Drop the `id` key from an object value before packing — the record id is
/// carried in the packed tuple's id slot, and schema object types never
/// declare an `id` field. Mirrors the TS `withoutRecordId`.
fn without_record_id(value: &Value) -> Value {
    match value {
        Value::Map(entries) => Value::Map(
            entries
                .iter()
                .filter(|(key, _)| key.as_str() != Some("id"))
                .cloned()
                .collect(),
        ),
        other => other.clone(),
    }
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

// ---- test-only deterministic suspension seam (FR-256) -----------------------

/// A per-connection rendezvous a test can install to deterministically suspend
/// `handle_subscribe` at the point it would await its async session
/// re-validation in production. `arrived` fires when the handler reaches the
/// pause; `release` is awaited there until the test signals it. This lets the
/// FR-256 regression deterministically interleave a concurrent write at the
/// exact boundary the fix moves registration across — without depending on the
/// in-memory store (which never actually suspends). Compiled out of release
/// builds entirely.
#[cfg(test)]
pub(crate) struct SubscribePause {
    pub(crate) arrived: Arc<tokio::sync::Notify>,
    pub(crate) release: Arc<tokio::sync::Notify>,
}

#[cfg(test)]
static SUBSCRIBE_PAUSES: std::sync::OnceLock<Mutex<HashMap<u64, SubscribePause>>> =
    std::sync::OnceLock::new();

/// Install a pause for connection `id`, returning the `(arrived, release)`
/// handles the test drives.
#[cfg(test)]
pub(crate) fn install_subscribe_pause(
    id: u64,
) -> (Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>) {
    let arrived = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    SUBSCRIBE_PAUSES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
        .insert(
            id,
            SubscribePause {
                arrived: Arc::clone(&arrived),
                release: Arc::clone(&release),
            },
        );
    (arrived, release)
}

/// If a pause is installed for `id`, signal `arrived` and await `release`
/// (consuming the pause so it fires at most once). No-op otherwise.
#[cfg(test)]
async fn subscribe_test_pause(id: u64) {
    let pause = SUBSCRIBE_PAUSES
        .get()
        .and_then(|map| map.lock().unwrap().remove(&id));
    if let Some(pause) = pause {
        let release = Arc::clone(&pause.release);
        let release_notified = release.notified();
        pause.arrived.notify_one();
        release_notified.await;
    }
}

#[cfg(test)]
mod tests;
