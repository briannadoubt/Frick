//! [`MemoryClusterBus`] + [`MemoryClusterChannel`] (`bus.ts:150-241`).
//!
//! The framework default: in-process fan-out for single-node deployments and
//! the test harness. Production multi-node deployments supply a Redis adapter
//! ([`super::redis::RedisClusterBus`]) that conforms to the same
//! [`FrickClusterBus`] trait.
//!
//! [`MemoryClusterChannel`] is a tiny shared pub/sub: pass one channel to
//! several [`MemoryClusterBus`] instances and a publish on any of them reaches
//! every other bus's local handlers — mimicking a real broker without one.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use super::{
    ClusterEnvelope, ClusterEnvelopeHandler, FrickClusterBus, SharedHandler, Unsubscribe,
    random_node_id,
};

/// Construction options for a [`MemoryClusterBus`].
#[derive(Default)]
pub struct MemoryClusterBusOptions {
    /// Stable node id. Defaults to a fresh [`random_node_id`].
    pub node_id: Option<String>,
    /// Optional cross-instance channel. Pass the same
    /// [`MemoryClusterChannel`] to multiple buses and they fan out to each
    /// other — useful for integration tests exercising the multi-node publish
    /// path without a real broker. Defaults to a fresh private channel (no
    /// peers).
    pub channel: Option<MemoryClusterChannel>,
}

/// A subscription slot on the shared channel: an id keyed [`AttachedHandler`].
struct AttachedHandler {
    id: u64,
    handler: SharedHandler,
}

/// Shared in-process channel: a tiny pub/sub used by multiple
/// [`MemoryClusterBus`] instances to mimic a real broker.
///
/// Cheap to clone — clones share the same handler set behind an `Arc`. Each
/// attachment is keyed by a per-bus monotonic id so detach is precise.
#[derive(Clone)]
pub struct MemoryClusterChannel {
    inner: Arc<MemoryClusterChannelInner>,
}

struct MemoryClusterChannelInner {
    handlers: Mutex<Vec<AttachedHandler>>,
    next_id: AtomicU64,
}

impl Default for MemoryClusterChannel {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryClusterChannel {
    /// A fresh empty channel.
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(MemoryClusterChannelInner {
                handlers: Mutex::new(Vec::new()),
                next_id: AtomicU64::new(1),
            }),
        }
    }

    /// Deliver `envelope` to every attached handler, isolating (and swallowing)
    /// per-handler panics so one buggy handler can't poison the rest. Handlers
    /// are snapshotted before dispatch so a handler that detaches mid-fan-out
    /// doesn't perturb the iteration.
    pub(crate) fn publish(&self, envelope: &ClusterEnvelope) {
        let snapshot: Vec<SharedHandler> = {
            let Ok(handlers) = self.inner.handlers.lock() else {
                return;
            };
            handlers.iter().map(|h| Arc::clone(&h.handler)).collect()
        };
        for handler in snapshot {
            // Isolate per-handler failures. A panicking handler is a programming
            // error; we contain it so peer fan-out for the rest survives. The
            // in-memory channel is silent by design (production adapters log).
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(envelope)));
        }
    }

    /// Attach a channel-level handler, returning its id for detach.
    fn attach(&self, handler: SharedHandler) -> u64 {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut handlers) = self.inner.handlers.lock() {
            handlers.push(AttachedHandler { id, handler });
        }
        id
    }

    /// Detach the channel-level handler with `id`. Idempotent.
    fn detach(&self, id: u64) {
        if let Ok(mut handlers) = self.inner.handlers.lock() {
            handlers.retain(|h| h.id != id);
        }
    }
}

/// The locked interior of a [`MemoryClusterBus`].
#[derive(Default)]
struct BusInner {
    /// Local subscribers (the gateway handler, plus any test handlers).
    local_handlers: Vec<(u64, SharedHandler)>,
    /// `None` = pass-through (back-compat). `Some(set)` filters; an empty set
    /// drops everything (§1.5).
    subscribed_tenants: Option<HashSet<String>>,
    /// Monotonic local-handler id allocator.
    next_handler_id: u64,
}

/// Default in-process [`FrickClusterBus`]. Suitable for single-node
/// deployments and the framework's own test harness.
pub struct MemoryClusterBus {
    node_id: String,
    channel: MemoryClusterChannel,
    inner: Arc<Mutex<BusInner>>,
    /// The id of this bus's attachment on the shared channel; `Some` until
    /// `close()` detaches it.
    channel_attachment: Mutex<Option<u64>>,
    closed: AtomicBool,
}

impl MemoryClusterBus {
    /// A bus with a fresh random node id and a fresh private channel (no peers).
    #[must_use]
    pub fn new() -> Arc<Self> {
        Self::with_options(MemoryClusterBusOptions::default())
    }

    /// A bus joined to a shared `channel` (peers fan out to each other), with a
    /// fresh random node id.
    #[must_use]
    pub fn with_channel(channel: MemoryClusterChannel) -> Arc<Self> {
        Self::with_options(MemoryClusterBusOptions {
            channel: Some(channel),
            ..MemoryClusterBusOptions::default()
        })
    }

    /// A bus from explicit options.
    #[must_use]
    pub fn with_options(options: MemoryClusterBusOptions) -> Arc<Self> {
        let node_id = options.node_id.unwrap_or_else(random_node_id);
        let channel = options.channel.unwrap_or_default();
        let inner = Arc::new(Mutex::new(BusInner::default()));

        // Funnel cross-bus traffic into our local handlers, applying the loop
        // guard and tenant filter before dispatch.
        let bus_node_id = node_id.clone();
        let bus_inner = Arc::clone(&inner);
        let attachment = channel.attach(Arc::new(move |envelope: &ClusterEnvelope| {
            // Loop guard: never deliver a node its own publish.
            if envelope.origin_node_id() == bus_node_id {
                return;
            }
            let snapshot = {
                let Ok(state) = bus_inner.lock() else {
                    return;
                };
                // Tenant filter (None = pass-through; empty set = drop all).
                if let Some(tenants) = &state.subscribed_tenants
                    && !tenants.contains(envelope.tenant_id())
                {
                    return;
                }
                state
                    .local_handlers
                    .iter()
                    .map(|(_, handler)| Arc::clone(handler))
                    .collect::<Vec<_>>()
            };
            for handler in snapshot {
                // Isolate per-handler failures so one buggy gateway subscriber
                // can't break peer fan-out for the rest.
                let _ =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(envelope)));
            }
        }));

        Arc::new(Self {
            node_id,
            channel,
            inner,
            channel_attachment: Mutex::new(Some(attachment)),
            closed: AtomicBool::new(false),
        })
    }
}

impl FrickClusterBus for MemoryClusterBus {
    fn node_id(&self) -> &str {
        &self.node_id
    }

    fn publish(&self, envelope: &ClusterEnvelope) {
        // Publishes after close are still forwarded to the channel (only the
        // inbound attachment is detached) — but with no local subscribers they
        // reach no one on this node. Mirrors the TS behaviour.
        self.channel.publish(envelope);
    }

    fn subscribe(&self, handler: ClusterEnvelopeHandler) -> Unsubscribe {
        let handler: SharedHandler = Arc::from(handler);
        let id = {
            let Ok(mut state) = self.inner.lock() else {
                return Unsubscribe::new(|| {});
            };
            let id = state.next_handler_id;
            state.next_handler_id += 1;
            state.local_handlers.push((id, handler));
            id
        };
        let inner = Arc::clone(&self.inner);
        Unsubscribe::new(move || {
            if let Ok(mut state) = inner.lock() {
                state.local_handlers.retain(|(hid, _)| *hid != id);
            }
        })
    }

    fn set_subscribed_tenants(&self, tenant_ids: Option<&HashSet<String>>) {
        if let Ok(mut state) = self.inner.lock() {
            // Snapshot — the caller may keep mutating the set after handing it
            // over (pinned by the snapshot test). `None` re-arms pass-through.
            state.subscribed_tenants = tenant_ids.cloned();
        }
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        // Detach inbound first so no further peer traffic is dispatched.
        if let Ok(mut attachment) = self.channel_attachment.lock()
            && let Some(id) = attachment.take()
        {
            self.channel.detach(id);
        }
        if let Ok(mut state) = self.inner.lock() {
            state.local_handlers.clear();
        }
    }
}
