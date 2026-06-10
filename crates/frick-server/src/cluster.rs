//! The cluster bus (`apps/server/src/cluster/bus.ts`, map 06 §1).
//!
//! N stateless server nodes share one database; durability is unaffected by
//! node count. What the bus adds is **realtime fan-out**: a write accepted on
//! node A must reach WebSocket subscribers connected to node B. The bus is
//! optional — a [`GatewayHub`](crate::gateway::GatewayHub) with no bus is a
//! true single-node deployment (the gateway checks for a bus at every publish
//! site).
//!
//! ## Surface
//!
//! - [`ClusterEnvelope`] — the tagged union of every fan-out message (8 kinds,
//!   §1.3). The wire form is a msgpack map keyed by `kind`; the six sync kinds
//!   carry an optional `appId` (absent on the wire ⇒ [`DEFAULT_APP_ID`] on
//!   decode, FR-153). See [`envelope`].
//! - [`FrickClusterBus`] — the pluggable contract every adapter implements
//!   (§1.2): a stable [`node_id`](FrickClusterBus::node_id), fire-and-forget
//!   [`publish`](FrickClusterBus::publish) (MUST NOT panic — logs instead),
//!   [`subscribe`](FrickClusterBus::subscribe) returning an
//!   [`Unsubscribe`] handle, [`close`](FrickClusterBus::close), and an optional
//!   inbound tenant filter [`set_subscribed_tenants`](FrickClusterBus::set_subscribed_tenants).
//! - [`MemoryClusterBus`] + [`MemoryClusterChannel`] — the in-process default
//!   (single-node + tests, §1.5). Pass one shared channel to several buses and
//!   they fan out to each other, mimicking a broker.
//! - [`redis::RedisClusterBus`] — the production Redis adapter (§1.6), behind
//!   the same trait; its live test is feature-gated (`redis-live`) because CI
//!   has no Redis.
//!
//! ## Determinism
//!
//! The only nondeterministic seam is the node id: [`random_node_id`] draws from
//! the thread RNG at construction. Pass an explicit `node_id` (via
//! [`MemoryClusterBusOptions`]) to make a bus reproducible.

pub mod envelope;
pub mod memory;
pub mod redis;

pub use envelope::{ClusterEnvelope, NodeId, PresenceRecord, ProjectionChange, random_node_id};
pub use memory::{MemoryClusterBus, MemoryClusterBusOptions, MemoryClusterChannel};

/// Handler the gateway registers to receive peer publishes.
///
/// Mirrors the TS `ClusterEnvelopeHandler = (envelope: ClusterEnvelope) =>
/// void`. Handlers run inside the bus's dispatch loop and MUST NOT panic — the
/// bus isolates each handler so one buggy subscriber can't poison the rest, but
/// a handler that does panic produces a logged, swallowed error and nothing
/// more.
pub type ClusterEnvelopeHandler = Box<dyn Fn(&ClusterEnvelope) + Send + Sync>;

/// A shared, ref-counted cluster handler. The adapters store handlers behind an
/// `Arc` so they can snapshot the live set before dispatch (isolating a handler
/// that detaches mid-fan-out).
pub(crate) type SharedHandler = std::sync::Arc<dyn Fn(&ClusterEnvelope) + Send + Sync>;

/// An opaque unsubscribe handle returned by
/// [`FrickClusterBus::subscribe`]. Dropping it does **not** unsubscribe (the
/// handler stays live); call [`Unsubscribe::unsubscribe`] to detach. This
/// mirrors the TS `() => void` return — an explicit, idempotent detach.
#[must_use = "dropping an Unsubscribe leaves the handler attached; call .unsubscribe() to detach"]
pub struct Unsubscribe(Box<dyn FnOnce() + Send + Sync>);

impl Unsubscribe {
    /// Build an unsubscribe handle from a one-shot detach closure.
    pub(crate) fn new(detach: impl FnOnce() + Send + Sync + 'static) -> Self {
        Self(Box::new(detach))
    }

    /// Detach the associated handler. Idempotent at the bus layer: detaching a
    /// handler that was already removed (e.g. by `close()`) is a no-op.
    pub fn unsubscribe(self) {
        (self.0)();
    }
}

/// The pluggable fan-out contract every cluster adapter implements
/// (`FrickClusterBus`, `bus.ts:127-148`).
///
/// Guarantees the contract requires (and the ONLY ones):
/// - Every publish is tagged with an `originNodeId`; a bus must never deliver a
///   node's own publish back to that node's subscribers (the loop guard).
/// - Ordering across nodes is **best-effort**; consumers cope with out-of-order
///   Delta frames via per-stream cursors.
/// - `publish` failures are logged, never propagated (it cannot panic); peer
///   nodes simply miss the frame and clients catch up on reconnect via cursor
///   replay.
/// - No back-pressure on the bus path.
pub trait FrickClusterBus: Send + Sync {
    /// Stable node identifier the bus uses to tag outbound publishes.
    fn node_id(&self) -> &str;

    /// Publish a fan-out envelope. Best-effort — failures are logged, not
    /// propagated, and this MUST NOT panic.
    fn publish(&self, envelope: &ClusterEnvelope);

    /// Register a subscriber. Returns an [`Unsubscribe`] handle.
    fn subscribe(&self, handler: ClusterEnvelopeHandler) -> Unsubscribe;

    /// Tear down peer connections. Called from the integrator's shutdown path.
    /// Note: a [`GatewayHub`](crate::gateway::GatewayHub) does NOT close an
    /// injected bus — callers own its lifecycle.
    fn close(&self);

    /// Optional inbound filter: declare the set of tenants this node currently
    /// has subscribers for. Adapters that implement this drop inbound envelopes
    /// whose `tenantId` is not in the set before they reach the gateway. The
    /// three-state contract (§1.5):
    /// - never called (`None` was never pushed *and* no set ever set) ⇒
    ///   pass-through (every envelope everywhere, back-compat).
    /// - a non-empty set ⇒ deliver only matching tenants.
    /// - an **empty** set ⇒ drop everything.
    ///
    /// The default impl is a no-op, so adapters that don't override it keep the
    /// "every envelope everywhere" behaviour.
    fn set_subscribed_tenants(&self, _tenant_ids: Option<&std::collections::HashSet<String>>) {}
}

#[cfg(test)]
mod tests;
