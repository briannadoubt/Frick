//! Production Redis-backed [`FrickClusterBus`] (FR-27, `apps/server/src/cluster/redis-bus.ts`).
//!
//! Fans cluster envelopes across stateless nodes over a single Redis pub/sub
//! channel (default `frick:cluster`). Mirrors [`MemoryClusterBus`]
//! (super::memory) semantics exactly: every publish is tagged with this node's
//! `originNodeId` and inbound envelopes from our own node are dropped (the loop
//! guard); once the gateway calls `set_subscribed_tenants`, inbound envelopes
//! for tenants this node doesn't serve are dropped before dispatch.
//!
//! Envelopes are **msgpack**-encoded (not JSON) via
//! [`ClusterEnvelope::to_msgpack`] so binary values inside packed stream-event
//! fields survive the round-trip. Two connections are used because a Redis
//! connection in subscribe mode cannot also issue `PUBLISH`: a dedicated
//! `subscriber` plus a `publisher`.
//!
//! ## Transport abstraction & testing
//!
//! The adapter is decoupled from any concrete Redis client via
//! [`RedisBusClient`] — a minimal publish/subscribe/quit surface that ioredis
//! (in the TS world) or any Rust Redis crate satisfies. This crate ships **no**
//! Redis client dependency: CI has no Redis, so the live round-trip is not
//! wired here. The verifiable deliverable is the contract + the msgpack wire
//! form + the in-memory bus + the gateway wiring. An integrator supplies a
//! [`RedisBusClient`] impl (e.g. over `redis`/`fred`) and constructs a
//! [`RedisClusterBus`]; a smoke test against a live broker belongs behind the
//! `redis-live` cargo feature (see [`crate::cluster::tests`]).
//!
//! Log event names (stable, used by ops): `frick.cluster.redis.decode_failed`,
//! `.handler_threw`, `.encode_failed`, `.publish_failed`.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::{
    ClusterEnvelope, ClusterEnvelopeHandler, FrickClusterBus, SharedHandler, Unsubscribe,
    random_node_id,
};

/// Default Redis pub/sub channel name (`redis-bus.ts:58`).
pub const DEFAULT_CHANNEL: &str = "frick:cluster";

/// Best-effort structured logger for the adapter's swallowed failures. Maps the
/// TS `(event, detail) => void`. The default is a no-op.
pub type RedisBusLogger = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// Minimal Redis client surface the bus needs (`RedisBusClient`,
/// `redis-bus.ts:35-43`). Any Redis client can satisfy it.
///
/// `publish` must transmit the **raw bytes** unmodified (msgpack, binary-safe).
/// The subscriber side delivers raw bytes to the handler the bus registered via
/// [`RedisClusterBus::on_message`] — i.e. the integrator's client wiring must
/// call `on_message(channel, payload)` for each received pub/sub message,
/// passing the bytes through without UTF-8 decoding.
pub trait RedisBusClient: Send + Sync {
    /// `PUBLISH channel payload` (fire-and-forget; errors are the caller's to
    /// surface via the logger — the bus treats publish as best-effort).
    fn publish(&self, channel: &str, payload: &[u8]);
    /// `SUBSCRIBE channel`. Called once at construction.
    fn subscribe(&self, channel: &str);
    /// `QUIT` / close the connection. Called from [`RedisClusterBus::close`].
    fn quit(&self);
}

/// Options for [`RedisClusterBus::new`].
pub struct RedisClusterBusOptions {
    /// Connection used to `PUBLISH`.
    pub publisher: Arc<dyn RedisBusClient>,
    /// Dedicated connection in subscribe mode. Must NOT be the same client as
    /// `publisher`.
    pub subscriber: Arc<dyn RedisBusClient>,
    /// Stable node id; defaults to a random one.
    pub node_id: Option<String>,
    /// Pub/sub channel name. Defaults to [`DEFAULT_CHANNEL`].
    pub channel: Option<String>,
    /// Structured logger for best-effort failures.
    pub logger: Option<RedisBusLogger>,
}

/// The locked interior of a [`RedisClusterBus`].
#[derive(Default)]
struct RedisInner {
    handlers: Vec<(u64, SharedHandler)>,
    subscribed_tenants: Option<HashSet<String>>,
    next_handler_id: u64,
}

/// Redis-backed cluster bus. Construct with [`RedisClusterBus::new`]; drive the
/// inbound side by calling [`RedisClusterBus::on_message`] from the client's
/// pub/sub message callback.
pub struct RedisClusterBus {
    node_id: String,
    channel: String,
    publisher: Arc<dyn RedisBusClient>,
    subscriber: Arc<dyn RedisBusClient>,
    log: RedisBusLogger,
    inner: Arc<Mutex<RedisInner>>,
    closed: AtomicBool,
}

impl RedisClusterBus {
    /// Build a bus over the two connections and `SUBSCRIBE` the subscriber to
    /// the channel. The caller is responsible for routing the subscriber's
    /// received messages back into [`Self::on_message`].
    #[must_use]
    pub fn new(options: RedisClusterBusOptions) -> Arc<Self> {
        let node_id = options.node_id.unwrap_or_else(random_node_id);
        let channel = options
            .channel
            .unwrap_or_else(|| DEFAULT_CHANNEL.to_string());
        let log: RedisBusLogger = options.logger.unwrap_or_else(|| Arc::new(|_, _| {}));
        options.subscriber.subscribe(&channel);
        Arc::new(Self {
            node_id,
            channel,
            publisher: options.publisher,
            subscriber: options.subscriber,
            log,
            inner: Arc::new(Mutex::new(RedisInner::default())),
            closed: AtomicBool::new(false),
        })
    }

    /// The channel this bus publishes/subscribes on.
    #[must_use]
    pub fn channel(&self) -> &str {
        &self.channel
    }

    /// Feed an inbound pub/sub message into the bus (`#onMessage`,
    /// `redis-bus.ts:90-114`). `channel` and `message` are the raw bytes Redis
    /// delivered. In order: channel guard, msgpack decode (log
    /// `decode_failed` + drop on failure), loop guard, tenant filter, dispatch
    /// (per-handler panics logged as `handler_threw`).
    pub fn on_message(&self, channel: &[u8], message: &[u8]) {
        // 1. Channel guard (pattern-sub leakage).
        if channel != self.channel.as_bytes() {
            return;
        }
        // 2. msgpack decode; no shape validation beyond decode.
        let envelope = match ClusterEnvelope::from_msgpack(message) {
            Ok(envelope) => envelope,
            Err(error) => {
                (self.log)("frick.cluster.redis.decode_failed", &error.to_string());
                return;
            }
        };
        // 3. Loop guard.
        if envelope.origin_node_id() == self.node_id {
            return;
        }
        // 4. Tenant filter.
        let snapshot = {
            let Ok(state) = self.inner.lock() else { return };
            if let Some(tenants) = &state.subscribed_tenants
                && !tenants.contains(envelope.tenant_id())
            {
                return;
            }
            state
                .handlers
                .iter()
                .map(|(_, handler)| Arc::clone(handler))
                .collect::<Vec<_>>()
        };
        // 5. Dispatch with per-handler isolation.
        for handler in snapshot {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(&envelope)))
                .is_err()
            {
                (self.log)("frick.cluster.redis.handler_threw", "");
            }
        }
    }
}

impl FrickClusterBus for RedisClusterBus {
    fn node_id(&self) -> &str {
        &self.node_id
    }

    fn publish(&self, envelope: &ClusterEnvelope) {
        // No-op after close.
        if self.closed.load(Ordering::Relaxed) {
            return;
        }
        let payload = match envelope.to_msgpack() {
            Ok(payload) => payload,
            Err(error) => {
                (self.log)("frick.cluster.redis.encode_failed", &error.to_string());
                return;
            }
        };
        // Best-effort: a panicking client impl is contained and logged, never
        // propagated (publish is fire-and-forget per the contract).
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.publisher.publish(&self.channel, &payload);
        }))
        .is_err()
        {
            (self.log)("frick.cluster.redis.publish_failed", "");
        }
    }

    fn subscribe(&self, handler: ClusterEnvelopeHandler) -> Unsubscribe {
        let handler: SharedHandler = Arc::from(handler);
        let id = {
            let Ok(mut state) = self.inner.lock() else {
                return Unsubscribe::new(|| {});
            };
            let id = state.next_handler_id;
            state.next_handler_id += 1;
            state.handlers.push((id, handler));
            id
        };
        // The Unsubscribe captures a handle to the shared inner state (not
        // `self`), so detach is precise and outlives the borrow — mirroring the
        // Memory bus. Detaching an already-removed handler (e.g. after close) is
        // a no-op.
        let inner = Arc::clone(&self.inner);
        Unsubscribe::new(move || {
            if let Ok(mut state) = inner.lock() {
                state.handlers.retain(|(hid, _)| *hid != id);
            }
        })
    }

    fn set_subscribed_tenants(&self, tenant_ids: Option<&HashSet<String>>) {
        if let Ok(mut state) = self.inner.lock() {
            state.subscribed_tenants = tenant_ids.cloned();
        }
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        if let Ok(mut state) = self.inner.lock() {
            state.handlers.clear();
        }
        self.subscriber.quit();
        self.publisher.quit();
    }
}
