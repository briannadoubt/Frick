//! FR-293 — the SFU media-placement seam (the Rust port of the deleted
//! TypeScript `apps/server/src/calls/media-placement.ts` +
//! `cluster-media-placement.ts`).
//!
//! Resolves, for a given `call_id`, *which node* homes that call's SFU router,
//! which **region** it lives in, and the **reachable media address** clients
//! should ICE their WebRTC transports to. This is the single point of
//! indirection that lets the [`SfuMediaPlaneAdapter`] stay single-box today and
//! grow into a multi-node deployment tomorrow without the adapter (or the
//! control plane) changing shape.
//!
//! Two implementations sit behind the [`MediaPlacement`] trait:
//!  - [`LocalMediaPlacement`] — single-box default: every call is homed on
//!    *this* node, reachable at the one configured announced IP, in this node's
//!    region. No coordination.
//!  - [`ClusterMediaPlacement`] — bus-coordinated home-node registry: the first
//!    node to allocate a call's router becomes its home, publishes the claim on
//!    the [`FrickClusterBus`], and every other node resolves `place_for(call_id)`
//!    to the home node's announced address. A client therefore ICEs straight to
//!    the home SFU regardless of which node its control WebSocket landed on.
//!
//! The trait methods are object-safe + async via boxed futures (the push- /
//! media-plane-adapter convention), so either impl slots in behind the same
//! `Arc<dyn MediaPlacement>`.
//!
//! [`SfuMediaPlaneAdapter`]: super::sfu_media_plane::SfuMediaPlaneAdapter

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use crate::cluster::{ClusterEnvelope, FrickClusterBus, NodeId, Unsubscribe};

/// Sentinel tenant tag for placement envelopes. Placement is keyed by `call_id`,
/// not tenant, but every [`ClusterEnvelope`] carries a `tenant_id`; using a
/// stable sentinel keeps the bus's tenant machinery uniform. Underscore-prefixed
/// to match the framework's reserved-namespace convention (`_default`).
pub const MEDIA_PLACEMENT_TENANT: &str = "_media_placement";

/// Default registry-entry lifetime: a missed release self-heals after this. 1h.
pub const DEFAULT_PLACEMENT_TTL_MS: i64 = 60 * 60 * 1000;

/// The node that homes a call's router, the region it lives in, and the address
/// clients connect to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaHome {
    /// Stable id of the node hosting the router (this node, for single-box).
    pub node_id: NodeId,
    /// Region the home node lives in — echoed onto the [`MediaSession`] so the
    /// control plane (and clients) know where media was placed.
    ///
    /// [`MediaSession`]: super::media_plane::MediaSession
    pub region: String,
    /// Announced media address advertised in ICE candidates — the public or LAN
    /// IP/hostname participants route their WebRTC transports to.
    pub announced_ip: String,
}

/// Boxed future alias keeping the trait object-safe (cf. `MediaPlaneAdapter`).
pub type MediaPlacementFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Where a call's media (its SFU router) lives, and how to reach it (FR-293).
///
/// The [`SfuMediaPlaneAdapter`] injects one of these and calls
/// [`place_for`](MediaPlacement::place_for) when it allocates a session,
/// [`release`](MediaPlacement::release) when it tears one down.
///
/// [`SfuMediaPlaneAdapter`]: super::sfu_media_plane::SfuMediaPlaneAdapter
pub trait MediaPlacement: Send + Sync {
    /// Resolve the home node + region + reachable media address for `call_id`.
    /// Idempotent: repeated calls for the same live call resolve to the same
    /// placement.
    fn place_for<'a>(&'a self, call_id: &'a str) -> MediaPlacementFuture<'a, MediaHome>;

    /// Release a call's media placement. Called from the home node when the
    /// router is torn down. Idempotent and safe to call on a non-home node
    /// (no-op if this node doesn't own it).
    fn release<'a>(&'a self, call_id: &'a str) -> MediaPlacementFuture<'a, ()>;
}

/// Single-box placement: every call is homed on *this* node, reachable at the
/// one configured announced IP, in this node's region. The multi-node,
/// bus-coordinated registry is [`ClusterMediaPlacement`] — this impl
/// deliberately does no coordination.
#[derive(Debug, Clone)]
pub struct LocalMediaPlacement {
    home: MediaHome,
}

impl LocalMediaPlacement {
    /// Build a single-box placement from this node's identity.
    ///
    /// `node_id` defaults to `"local"` when `None`; `region` defaults to
    /// `"local"` when `None`. `announced_ip` is the address mediasoup/the SFU
    /// advertises in ICE candidates (e.g. `"127.0.0.1"` for local dev, the box's
    /// public IP in prod).
    #[must_use]
    pub fn new(
        node_id: Option<String>,
        region: Option<String>,
        announced_ip: impl Into<String>,
    ) -> Self {
        Self {
            home: MediaHome {
                node_id: node_id.unwrap_or_else(|| "local".to_string()),
                region: region.unwrap_or_else(|| "local".to_string()),
                announced_ip: announced_ip.into(),
            },
        }
    }

    /// Convenience: a placement whose announced IP is `127.0.0.1` and whose node
    /// id and region are both `"local"`. The default single-box wiring for the
    /// SFU arm (boot) and for tests.
    #[must_use]
    pub fn loopback() -> Self {
        Self::new(None, None, "127.0.0.1")
    }
}

impl MediaPlacement for LocalMediaPlacement {
    fn place_for<'a>(&'a self, _call_id: &'a str) -> MediaPlacementFuture<'a, MediaHome> {
        let home = self.home.clone();
        Box::pin(async move { home })
    }

    fn release<'a>(&'a self, _call_id: &'a str) -> MediaPlacementFuture<'a, ()> {
        Box::pin(async move {})
    }
}

/// One registry entry: the home recorded for a call plus when it was learned, so
/// a TTL can evict a missed release.
#[derive(Clone)]
struct RegistryEntry {
    home: MediaHome,
    /// When this entry was learned/claimed, in epoch ms, for TTL eviction.
    at_ms: i64,
}

/// Injectable clock so TTL expiry is deterministic in tests. Returns epoch ms.
pub type PlacementClock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// Construction options for [`ClusterMediaPlacement`].
pub struct ClusterMediaPlacementOptions {
    /// This node's media identity. Defaults to the bus's `node_id` so placement
    /// and fan-out agree on who "this node" is.
    pub node_id: Option<NodeId>,
    /// Region this node lives in. Defaults to `"local"`.
    pub region: Option<String>,
    /// Announced media IP/hostname this node advertises in ICE candidates.
    pub announced_ip: String,
    /// Registry-entry TTL in ms. Defaults to [`DEFAULT_PLACEMENT_TTL_MS`]. A
    /// missed release self-heals after this.
    pub ttl_ms: Option<i64>,
    /// Injectable clock for deterministic TTL. Defaults to wall-clock epoch ms.
    pub clock: Option<PlacementClock>,
}

impl ClusterMediaPlacementOptions {
    /// Minimal options: just the announced IP, everything else defaulted.
    #[must_use]
    pub fn with_announced_ip(announced_ip: impl Into<String>) -> Self {
        Self {
            node_id: None,
            region: None,
            announced_ip: announced_ip.into(),
            ttl_ms: None,
            clock: None,
        }
    }
}

/// The interior of a [`ClusterMediaPlacement`], shared between the public handle
/// and the bus subscription closure (which learns peer claims/releases).
struct ClusterPlacementInner {
    node_id: NodeId,
    region: String,
    announced_ip: String,
    ttl_ms: i64,
    clock: PlacementClock,
    bus: Arc<dyn FrickClusterBus>,
    /// `call_id → entry`. Guarded by a mutex; both `place_for`/`release` and the
    /// bus-subscription handler mutate it.
    registry: Mutex<HashMap<String, RegistryEntry>>,
}

impl ClusterPlacementInner {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, RegistryEntry>> {
        self.registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The TTL-aware live entry for a call, evicting it if expired.
    fn live_entry(&self, call_id: &str) -> Option<RegistryEntry> {
        let now = (self.clock)();
        let mut registry = self.lock();
        let entry = registry.get(call_id)?;
        if now - entry.at_ms >= self.ttl_ms {
            // Expired — a missed release / crashed home. Treat as absent so the
            // next resolve re-claims; evict so we stop checking the stale entry.
            registry.remove(call_id);
            return None;
        }
        Some(entry.clone())
    }

    fn home(&self) -> MediaHome {
        MediaHome {
            node_id: self.node_id.clone(),
            region: self.region.clone(),
            announced_ip: self.announced_ip.clone(),
        }
    }

    fn publish_claim(&self, call_id: &str, home: &MediaHome) {
        self.bus.publish(&ClusterEnvelope::MediaPlacementClaim {
            origin_node_id: self.node_id.clone(),
            tenant_id: MEDIA_PLACEMENT_TENANT.to_string(),
            call_id: call_id.to_string(),
            home_node_id: home.node_id.clone(),
            announced_ip: home.announced_ip.clone(),
        });
    }

    /// Resolve (or claim) the home for a call. If a live entry exists (we home
    /// it, or a peer does — both authoritative) return it; else claim locally,
    /// record, and announce.
    fn place_for(&self, call_id: &str) -> MediaHome {
        if let Some(entry) = self.live_entry(call_id) {
            return entry.home;
        }
        let home = self.home();
        let now = (self.clock)();
        self.lock().insert(
            call_id.to_string(),
            RegistryEntry {
                home: home.clone(),
                at_ms: now,
            },
        );
        self.publish_claim(call_id, &home);
        home
    }

    /// Release a call's placement. Only the home node announces a release — a
    /// non-home node releasing would be lying to peers about an entry it doesn't
    /// own. Idempotent.
    fn release(&self, call_id: &str) {
        let we_own = {
            let mut registry = self.lock();
            let we_own = registry
                .get(call_id)
                .is_some_and(|entry| entry.home.node_id == self.node_id);
            registry.remove(call_id);
            we_own
        };
        if we_own {
            self.bus.publish(&ClusterEnvelope::MediaPlacementRelease {
                origin_node_id: self.node_id.clone(),
                tenant_id: MEDIA_PLACEMENT_TENANT.to_string(),
                call_id: call_id.to_string(),
            });
        }
    }

    /// Inbound bus envelope: learn a peer's claim/release. Own echoes are
    /// already dropped by the bus's loop guard; we re-check defensively.
    fn on_envelope(&self, envelope: &ClusterEnvelope) {
        if envelope.origin_node_id() == self.node_id {
            return;
        }
        match envelope {
            ClusterEnvelope::MediaPlacementClaim {
                call_id,
                home_node_id,
                announced_ip,
                ..
            } => {
                self.on_peer_claim(
                    call_id,
                    &MediaHome {
                        node_id: home_node_id.clone(),
                        // A peer claim carries no region; the announced IP is the
                        // load-bearing reach address. Region is informational and
                        // resolved locally per node, so we leave it empty for a
                        // learned remote home.
                        region: String::new(),
                        announced_ip: announced_ip.clone(),
                    },
                );
            }
            ClusterEnvelope::MediaPlacementRelease { call_id, .. } => {
                // The home announced teardown — drop our cached entry.
                self.lock().remove(call_id);
            }
            // Every other kind is sync fan-out and not our concern.
            _ => {}
        }
    }

    /// Converge on a peer's claim. Tie-break = **lowest `node_id` wins** so all
    /// nodes pick the same home from the same set of claims regardless of arrival
    /// order. Returns `true` if *this* node lost a tie it had claimed (the caller
    /// can then release the orphaned router — though for the foundation we simply
    /// let the backend reap an idle router).
    fn on_peer_claim(&self, call_id: &str, peer_home: &MediaHome) -> bool {
        let now = (self.clock)();
        let mut registry = self.lock();
        let Some(current) = registry.get(call_id).cloned() else {
            // First we've heard of this call — adopt the peer's home.
            registry.insert(
                call_id.to_string(),
                RegistryEntry {
                    home: peer_home.clone(),
                    at_ms: now,
                },
            );
            return false;
        };
        if current.home.node_id == peer_home.node_id {
            // Re-announcement of the home we already have — refresh TTL only.
            registry.insert(
                call_id.to_string(),
                RegistryEntry {
                    home: peer_home.clone(),
                    at_ms: now,
                },
            );
            return false;
        }
        // Conflict: two different homes for one call. Lowest node id wins.
        if peer_home.node_id < current.home.node_id {
            let we_had_claimed = current.home.node_id == self.node_id;
            registry.insert(
                call_id.to_string(),
                RegistryEntry {
                    home: peer_home.clone(),
                    at_ms: now,
                },
            );
            return we_had_claimed;
        }
        // We hold the lower id; keep ours. The peer adopts ours when our claim
        // reaches it. Both converge on the lowest id with no further messages.
        false
    }
}

/// Default clock: wall-clock epoch milliseconds (mirrors the inlined pattern in
/// `boot`/`jobs`/`push`).
fn wall_clock_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// Multi-box, bus-coordinated home-node registry (FR-293). The first node to
/// `place_for` a call becomes its home and publishes the claim; peers learn it
/// over the [`FrickClusterBus`] and resolve to the home node's announced
/// address. See the module docs for the protocol + tie-break.
pub struct ClusterMediaPlacement {
    inner: Arc<ClusterPlacementInner>,
    /// The bus subscription, detached on [`close`](Self::close)/drop.
    unsubscribe: Mutex<Option<Unsubscribe>>,
}

impl ClusterMediaPlacement {
    /// Build a bus-coordinated placement over `bus`. Subscribes to the bus to
    /// learn peer claims/releases; the subscription lives until [`close`] or
    /// drop.
    ///
    /// [`close`]: Self::close
    #[must_use]
    pub fn new(bus: &Arc<dyn FrickClusterBus>, options: ClusterMediaPlacementOptions) -> Arc<Self> {
        let node_id = options.node_id.unwrap_or_else(|| bus.node_id().to_string());
        let inner = Arc::new(ClusterPlacementInner {
            node_id,
            region: options.region.unwrap_or_else(|| "local".to_string()),
            announced_ip: options.announced_ip,
            ttl_ms: options.ttl_ms.unwrap_or(DEFAULT_PLACEMENT_TTL_MS),
            clock: options.clock.unwrap_or_else(|| Arc::new(wall_clock_ms)),
            bus: Arc::clone(bus),
            registry: Mutex::new(HashMap::new()),
        });

        // Subscribe to the bus to maintain the registry from peer claims. A weak
        // back-reference keeps the bus from pinning the placement alive; a
        // delivery after the placement drops is a no-op.
        let weak = Arc::downgrade(&inner);
        let unsubscribe = bus.subscribe(Box::new(move |envelope: &ClusterEnvelope| {
            if let Some(inner) = weak.upgrade() {
                inner.on_envelope(envelope);
            }
        }));

        Arc::new(Self {
            inner,
            unsubscribe: Mutex::new(Some(unsubscribe)),
        })
    }

    /// Test/inspection: the home currently recorded for a call, if any
    /// (TTL-aware).
    #[must_use]
    pub fn home_for(&self, call_id: &str) -> Option<MediaHome> {
        self.inner.live_entry(call_id).map(|entry| entry.home)
    }

    /// Tear down the bus subscription. Idempotent.
    pub fn close(&self) {
        if let Some(unsubscribe) = self
            .unsubscribe
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            unsubscribe.unsubscribe();
        }
    }
}

impl Drop for ClusterMediaPlacement {
    fn drop(&mut self) {
        self.close();
    }
}

impl MediaPlacement for ClusterMediaPlacement {
    fn place_for<'a>(&'a self, call_id: &'a str) -> MediaPlacementFuture<'a, MediaHome> {
        let inner = Arc::clone(&self.inner);
        let call_id = call_id.to_string();
        Box::pin(async move { inner.place_for(&call_id) })
    }

    fn release<'a>(&'a self, call_id: &'a str) -> MediaPlacementFuture<'a, ()> {
        let inner = Arc::clone(&self.inner);
        let call_id = call_id.to_string();
        Box::pin(async move { inner.release(&call_id) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cluster::{MemoryClusterBus, MemoryClusterBusOptions, MemoryClusterChannel};

    fn cluster_placement(
        bus: &Arc<dyn FrickClusterBus>,
        node_id: &str,
        clock: PlacementClock,
        ttl_ms: i64,
    ) -> Arc<ClusterMediaPlacement> {
        ClusterMediaPlacement::new(
            bus,
            ClusterMediaPlacementOptions {
                node_id: Some(node_id.to_string()),
                region: Some("local".to_string()),
                announced_ip: format!("ip-for-{node_id}"),
                ttl_ms: Some(ttl_ms),
                clock: Some(clock),
            },
        )
    }

    /// A test clock whose value can be advanced between `place_for` calls.
    #[derive(Clone)]
    struct TestClock(Arc<std::sync::atomic::AtomicI64>);

    impl TestClock {
        fn new(start_ms: i64) -> Self {
            Self(Arc::new(std::sync::atomic::AtomicI64::new(start_ms)))
        }
        fn advance(&self, by_ms: i64) {
            self.0.fetch_add(by_ms, std::sync::atomic::Ordering::SeqCst);
        }
        fn as_clock(&self) -> PlacementClock {
            let cell = Arc::clone(&self.0);
            Arc::new(move || cell.load(std::sync::atomic::Ordering::SeqCst))
        }
    }

    #[tokio::test]
    async fn local_placement_returns_this_node_consistently() {
        let placement =
            LocalMediaPlacement::new(Some("node-a".into()), Some("us-east".into()), "203.0.113.7");
        let first = placement.place_for("call-1").await;
        let second = placement.place_for("call-2").await;
        assert_eq!(first.node_id, "node-a");
        assert_eq!(first.region, "us-east");
        assert_eq!(first.announced_ip, "203.0.113.7");
        // Different call ids resolve to the same home — single box.
        assert_eq!(first, second);
        // Release is a harmless no-op.
        placement.release("call-1").await;
        assert_eq!(placement.place_for("call-1").await, first);
    }

    #[tokio::test]
    async fn local_placement_defaults_node_and_region_to_local() {
        let placement = LocalMediaPlacement::loopback();
        let home = placement.place_for("call-1").await;
        assert_eq!(home.node_id, "local");
        assert_eq!(home.region, "local");
        assert_eq!(home.announced_ip, "127.0.0.1");
    }

    #[tokio::test]
    async fn cluster_placement_claims_and_publishes() {
        let channel = MemoryClusterChannel::new();
        let bus_a = MemoryClusterBus::with_options(MemoryClusterBusOptions {
            node_id: Some("node-a".into()),
            channel: Some(channel.clone()),
        });
        let bus_b = MemoryClusterBus::with_options(MemoryClusterBusOptions {
            node_id: Some("node-b".into()),
            channel: Some(channel.clone()),
        });
        let clock = TestClock::new(0);
        let bus_a: Arc<dyn FrickClusterBus> = bus_a;
        let bus_b: Arc<dyn FrickClusterBus> = bus_b;
        let placement_a =
            cluster_placement(&bus_a, "node-a", clock.as_clock(), DEFAULT_PLACEMENT_TTL_MS);
        let placement_b =
            cluster_placement(&bus_b, "node-b", clock.as_clock(), DEFAULT_PLACEMENT_TTL_MS);

        // A places call-1: it claims locally and announces over the bus.
        let home = placement_a.place_for("call-1").await;
        assert_eq!(home.node_id, "node-a");
        assert_eq!(home.announced_ip, "ip-for-node-a");

        // B learned the claim over the bus and now resolves to A's home.
        let from_b = placement_b.place_for("call-1").await;
        assert_eq!(from_b.node_id, "node-a");
        assert_eq!(from_b.announced_ip, "ip-for-node-a");
        assert_eq!(
            placement_b.home_for("call-1").map(|h| h.node_id),
            Some("node-a".to_string())
        );
    }

    #[tokio::test]
    async fn cluster_placement_tie_break_picks_lowest_node_id() {
        // Two isolated buses (no shared channel) so each node claims call-1
        // locally before either's claim arrives — a split brain. We then deliver
        // the claims manually to drive convergence deterministically.
        let bus_a = MemoryClusterBus::with_options(MemoryClusterBusOptions {
            node_id: Some("node-a".into()),
            channel: None,
        });
        let bus_b = MemoryClusterBus::with_options(MemoryClusterBusOptions {
            node_id: Some("node-b".into()),
            channel: None,
        });
        let clock = TestClock::new(0);
        let bus_a: Arc<dyn FrickClusterBus> = bus_a;
        let bus_b: Arc<dyn FrickClusterBus> = bus_b;
        let placement_a =
            cluster_placement(&bus_a, "node-a", clock.as_clock(), DEFAULT_PLACEMENT_TTL_MS);
        let placement_b =
            cluster_placement(&bus_b, "node-b", clock.as_clock(), DEFAULT_PLACEMENT_TTL_MS);

        // Both claim locally (split brain) — each homes itself.
        assert_eq!(placement_a.place_for("call-1").await.node_id, "node-a");
        assert_eq!(placement_b.place_for("call-1").await.node_id, "node-b");

        // Deliver each peer's claim to the other. node-a < node-b, so both must
        // converge on node-a.
        let claim_a = ClusterEnvelope::MediaPlacementClaim {
            origin_node_id: "node-a".into(),
            tenant_id: MEDIA_PLACEMENT_TENANT.into(),
            call_id: "call-1".into(),
            home_node_id: "node-a".into(),
            announced_ip: "ip-for-node-a".into(),
        };
        let claim_b = ClusterEnvelope::MediaPlacementClaim {
            origin_node_id: "node-b".into(),
            tenant_id: MEDIA_PLACEMENT_TENANT.into(),
            call_id: "call-1".into(),
            home_node_id: "node-b".into(),
            announced_ip: "ip-for-node-b".into(),
        };
        // B hears A's (lower) claim → B yields to A.
        placement_b.inner.on_envelope(&claim_a);
        // A hears B's (higher) claim → A keeps itself.
        placement_a.inner.on_envelope(&claim_b);

        assert_eq!(
            placement_a.home_for("call-1").map(|h| h.node_id),
            Some("node-a".to_string()),
            "lowest id keeps its claim"
        );
        assert_eq!(
            placement_b.home_for("call-1").map(|h| h.node_id),
            Some("node-a".to_string()),
            "higher id adopts the lowest"
        );
    }

    #[tokio::test]
    async fn cluster_placement_release_frees_the_home() {
        let channel = MemoryClusterChannel::new();
        let bus_a = MemoryClusterBus::with_options(MemoryClusterBusOptions {
            node_id: Some("node-a".into()),
            channel: Some(channel.clone()),
        });
        let bus_b = MemoryClusterBus::with_options(MemoryClusterBusOptions {
            node_id: Some("node-b".into()),
            channel: Some(channel.clone()),
        });
        let clock = TestClock::new(0);
        let bus_a: Arc<dyn FrickClusterBus> = bus_a;
        let bus_b: Arc<dyn FrickClusterBus> = bus_b;
        let placement_a =
            cluster_placement(&bus_a, "node-a", clock.as_clock(), DEFAULT_PLACEMENT_TTL_MS);
        let placement_b =
            cluster_placement(&bus_b, "node-b", clock.as_clock(), DEFAULT_PLACEMENT_TTL_MS);

        placement_a.place_for("call-1").await;
        // B learned it.
        assert!(placement_b.home_for("call-1").is_some());

        // The home releases — peers evict their cached entry over the bus.
        placement_a.release("call-1").await;
        assert!(placement_a.home_for("call-1").is_none());
        assert!(
            placement_b.home_for("call-1").is_none(),
            "release frees the entry on peers too"
        );

        // After release a fresh place_for re-claims (possibly on a different
        // node). Here B claims it now that the slot is free.
        let reclaimed = placement_b.place_for("call-1").await;
        assert_eq!(reclaimed.node_id, "node-b");
    }

    #[tokio::test]
    async fn cluster_placement_ttl_expiry_reclaims() {
        // A short TTL so an entry self-heals when no release arrives (a crashed
        // home). After expiry the next resolve re-claims for this node.
        let bus = MemoryClusterBus::with_options(MemoryClusterBusOptions {
            node_id: Some("node-a".into()),
            channel: None,
        });
        let clock = TestClock::new(1_000);
        let bus: Arc<dyn FrickClusterBus> = bus;
        let placement =
            cluster_placement(&bus, "node-a", clock.as_clock(), /* ttl_ms */ 10_000);

        // Learn a peer's home (node-z) so this node is *not* the home.
        placement
            .inner
            .on_envelope(&ClusterEnvelope::MediaPlacementClaim {
                origin_node_id: "node-z".into(),
                tenant_id: MEDIA_PLACEMENT_TENANT.into(),
                call_id: "call-1".into(),
                home_node_id: "node-z".into(),
                announced_ip: "ip-for-node-z".into(),
            });
        assert_eq!(
            placement.place_for("call-1").await.node_id,
            "node-z",
            "before expiry, the learned remote home stands"
        );

        // Advance past the TTL: the stale entry is treated as absent, so the next
        // resolve re-claims for this node.
        clock.advance(10_001);
        let reclaimed = placement.place_for("call-1").await;
        assert_eq!(
            reclaimed.node_id, "node-a",
            "after TTL expiry the home self-heals and re-claims locally"
        );
    }
}
