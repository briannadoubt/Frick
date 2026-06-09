/**
 * Write-region routing + conflict handling (FR-106) — the "per-region
 * primary" ownership model layered on top of FR-105's best-effort
 * cross-region fan-out transport ({@link FrickRegionBus} /
 * {@link FederatingClusterBus}).
 *
 * ## Why this exists
 *
 * FR-105 carries realtime fan-out across regions but takes **no position
 * on ownership**: two regions can accept writes to the same key
 * "simultaneously" and the federated streams can interleave differently
 * in different regions (see `docs/multi-region.md` → "Ordering &
 * consistency"). That is fine for realtime hints (consumers reconcile via
 * per-stream cursors) but it is not a conflict story.
 *
 * FR-106 supplies the conflict story by adopting topology option **C —
 * per-region primary (write-region routing)** from the design doc: every
 * write key has exactly one **home region** that owns its writes. A node
 * that receives a write either:
 *
 *   - **accepts locally** — this region *is* the key's home, so the write
 *     is applied here and federated outward via FR-105 as today; or
 *   - **proxies to the home region R** — this region is *not* the home, so
 *     the write is forwarded to R, applied there (the authoritative
 *     serialization point), and the authoritative stream flows back via
 *     FR-105 federation.
 *
 * Because all writes to a key funnel through a single home region, the
 * home region **serializes** concurrent cross-region writes to that key —
 * that is the coherent-ordering win the doc calls out. The convergence
 * guarantee is therefore **home-region-authoritative**: the home's applied
 * order is the order every region eventually observes.
 *
 * ## Ownership granularity
 *
 * Home is assigned **per tenant** (`tenantId → homeRegionId`). Tenant-home
 * is the simplest correct default and matches how the rest of the stack is
 * already tenant-partitioned (object/stream/presence stores are all
 * tenant-scoped). Finer granularity (tenant+object) is a forward-compatible
 * extension — {@link writeKeyForTenant} centralizes how a routing key is
 * derived so a future tenant+object key is a one-line change — but is not
 * needed for the conflict guarantee, which only requires *a* single home
 * per key.
 *
 * ## Ownership assignment
 *
 * Two strategies share one {@link RegionOwnershipResolver} interface:
 *
 *   - {@link StaticRegionOwnership} — a config map `tenantId → homeRegionId`
 *     plus a `defaultHomeRegionId` fallback. This is the recommended
 *     default: ownership is a deployment decision (you place a tenant's
 *     home near its users), it needs zero coordination, and it is trivially
 *     correct. A **single-region** deployment sets the default home to its
 *     one region → every key is home-local → `routeWrite` always returns
 *     "accept locally" → zero proxying → behaves exactly as today.
 *
 *   - {@link ClaimRegionOwnership} — a claim-based dynamic assignment over
 *     the region bus, mirroring FR-154's `ClusterMediaPlacement`
 *     (claim/resolve/tie-break/TTL). The first region to route a write for
 *     an unowned tenant **claims** home for it and announces the claim to
 *     peers; concurrent claims converge by a deterministic tie-break
 *     (**lowest `regionId` wins**, total + symmetric, exactly like
 *     FR-154's lowest-`nodeId` rule); a TTL backstops a missed release so a
 *     crashed home self-heals. This is opt-in for deployments that want
 *     dynamic placement instead of static config.
 *
 * ## Conflict handling
 *
 * With a single home per key, conflicts are resolved by **serialization at
 * the home**, not by a merge rule — concurrent cross-region writes to one
 * key are ordered by the home region as they arrive, and that order is the
 * authoritative stream federated back to everyone. (The alternative —
 * accept-anywhere-then-converge with a region-stamped deterministic rule —
 * is documented in `docs/multi-region.md` as the rejected option; home
 * authoritative routing is preferred and simpler.)
 *
 * ## Additive & backward-compatible
 *
 * Nothing here is wired by a single-region server. The router is opt-in;
 * when unwired, the gateway publishes through its `FrickClusterBus`
 * (possibly a `FederatingClusterBus`) exactly as before. Even when wired,
 * a single-region deployment is home for everything, so `routeWrite`
 * always says "accept locally" and the proxy transport is never used.
 */

import type { RegionId } from "./region-bus.js";

/** Default ownership-claim lifetime: a missed release self-heals after this. */
const DEFAULT_OWNERSHIP_TTL_MS = 60 * 60 * 1000; // 1h

/**
 * The routing key a write is owned by. Tenant-home is the default
 * granularity (see module docs); the key is a plain string so a future
 * tenant+object granularity is a drop-in change to {@link writeKeyForTenant}.
 */
export type WriteKey = string;

/** Derive the routing key for a tenant. Centralized so granularity can evolve. */
export function writeKeyForTenant(tenantId: string): WriteKey {
  return tenantId;
}

/**
 * Resolves the home region that owns writes for a given key. Both the
 * static-config and claim-based ownership models implement this, so the
 * {@link RegionWriteRouter} is agnostic to how home is assigned.
 */
export interface RegionOwnershipResolver {
  /**
   * The region that owns writes for `key`. MUST be deterministic for a
   * given ownership state so every region agrees on the home.
   */
  homeRegionFor(key: WriteKey): RegionId;
}

export interface StaticRegionOwnershipOptions {
  /**
   * Explicit `writeKey → homeRegionId` assignments. A key absent from the
   * map falls back to {@link defaultHomeRegionId}.
   */
  readonly assignments?: Readonly<Record<WriteKey, RegionId>>;
  /**
   * Home region for any key not in {@link assignments}. In a single-region
   * deployment this is the one region, making every key home-local.
   */
  readonly defaultHomeRegionId: RegionId;
}

/**
 * Static, config-driven ownership: `tenantId → homeRegionId` with a default
 * fallback. Recommended default — zero coordination, trivially correct,
 * and ownership is a deployment decision (place a tenant's home near its
 * users).
 */
export class StaticRegionOwnership implements RegionOwnershipResolver {
  #assignments: ReadonlyMap<WriteKey, RegionId>;
  readonly #default: RegionId;

  constructor(options: StaticRegionOwnershipOptions) {
    this.#assignments = new Map(Object.entries(options.assignments ?? {}));
    this.#default = options.defaultHomeRegionId;
  }

  homeRegionFor(key: WriteKey): RegionId {
    return this.#assignments.get(key) ?? this.#default;
  }

  /**
   * Reassign a key's home (or clear it back to the default with
   * `undefined`). Used by FR-107 failover to promote a surviving region
   * when the current home goes down. Returns the new effective home.
   */
  reassign(key: WriteKey, homeRegionId: RegionId | undefined): RegionId {
    const next = new Map(this.#assignments);
    if (homeRegionId === undefined) next.delete(key);
    else next.set(key, homeRegionId);
    this.#assignments = next;
    return this.homeRegionFor(key);
  }
}

/**
 * The outcome of routing a write: either accept it on this region, or
 * proxy it to the named home region.
 */
export type WriteRoute =
  | { readonly kind: "local"; readonly homeRegionId: RegionId }
  | { readonly kind: "proxy"; readonly homeRegionId: RegionId };

export interface RegionWriteRouterOptions {
  /** This region's identity. A route is "local" when home === this region. */
  readonly regionId: RegionId;
  /** How home regions are resolved (static or claim-based). */
  readonly ownership: RegionOwnershipResolver;
}

/**
 * Resolves whether a write is owned by this region (accept locally) or by a
 * peer region (proxy home). This is the FR-106 seam the gateway consults
 * before applying a write in a multi-region deployment.
 *
 * Stateless beyond its injected {@link RegionOwnershipResolver}: the router
 * never holds write state, only routing decisions.
 */
export class RegionWriteRouter {
  readonly regionId: RegionId;
  readonly #ownership: RegionOwnershipResolver;

  constructor(options: RegionWriteRouterOptions) {
    this.regionId = options.regionId;
    this.#ownership = options.ownership;
  }

  /** The home region that owns writes for `tenantId`. */
  homeRegionForTenant(tenantId: string): RegionId {
    return this.#ownership.homeRegionFor(writeKeyForTenant(tenantId));
  }

  /**
   * Route a write for `tenantId`. Returns `local` when this region is the
   * home (apply + federate as today) or `proxy` naming the home region the
   * write must be forwarded to.
   */
  routeWrite(tenantId: string): WriteRoute {
    const homeRegionId = this.homeRegionForTenant(tenantId);
    return homeRegionId === this.regionId
      ? { kind: "local", homeRegionId }
      : { kind: "proxy", homeRegionId };
  }
}

// ---------------------------------------------------------------------------
// In-memory proxy transport
// ---------------------------------------------------------------------------

/**
 * A write a non-home region proxies to the home region. The payload is
 * opaque to the transport — the gateway hands over whatever it needs to
 * re-apply the write at the home (in practice the same data it would have
 * applied locally). Tagged with `tenantId` so the home can route it and
 * with `originRegionId` for observability/loop-awareness.
 */
export interface ProxiedWrite<TPayload = unknown> {
  readonly tenantId: string;
  readonly originRegionId: RegionId;
  readonly payload: TPayload;
}

/** Handler the home region registers to apply writes proxied to it. */
export type ProxiedWriteHandler<TPayload = unknown> = (write: ProxiedWrite<TPayload>) => void;

/**
 * Shared in-process fabric delivering {@link ProxiedWrite}s from non-home
 * regions to the home region — the routing analogue of
 * `MemoryRegionFabric`. A region registers a handler keyed by its own
 * `regionId`; `send(home, write)` delivers only to `home`'s handler, so a
 * proxied write reaches exactly the owning region (no broadcast). Used by
 * tests to exercise the full non-home → home routing path deterministically
 * without real infra. Production supplies a WAN request/response transport
 * conforming to {@link RegionProxyTransport}.
 */
export class MemoryRegionRouterFabric<TPayload = unknown> {
  readonly #handlers = new Map<RegionId, ProxiedWriteHandler<TPayload>>();

  /** Register the home-side handler for a region. Returns a detach fn. */
  attach(regionId: RegionId, handler: ProxiedWriteHandler<TPayload>): () => void {
    this.#handlers.set(regionId, handler);
    return () => {
      if (this.#handlers.get(regionId) === handler) this.#handlers.delete(regionId);
    };
  }

  /** Deliver a proxied write to `homeRegionId`'s handler, if attached. */
  send(homeRegionId: RegionId, write: ProxiedWrite<TPayload>): void {
    const handler = this.#handlers.get(homeRegionId);
    if (!handler) return; // home not reachable — best-effort, like the bus.
    try {
      handler(write);
    } catch {
      // Isolate home-side failures, mirroring the fabric's per-handler
      // isolation. Production transports log via their own observability.
    }
  }

  /** Whether a home-side handler is currently attached for a region. */
  has(regionId: RegionId): boolean {
    return this.#handlers.has(regionId);
  }
}

/**
 * The proxy-transport seam: a non-home region calls `proxyTo(home, write)`
 * to forward a write to its owning region; the home region calls
 * `onProxiedWrite` to receive writes routed to it. Mirrors
 * {@link FrickRegionBus}'s publish/subscribe shape, but **addressed**
 * (point-to-point to the home) rather than broadcast.
 */
export interface RegionProxyTransport<TPayload = unknown> {
  /** This region's identity. */
  readonly regionId: RegionId;
  /** Forward a write to its home region. Best-effort. */
  proxyTo(homeRegionId: RegionId, write: ProxiedWrite<TPayload>): void;
  /** Register the handler that applies writes proxied to THIS region. */
  onProxiedWrite(handler: ProxiedWriteHandler<TPayload>): () => void;
  /** Detach from the fabric/transport. */
  close(): Promise<void>;
}

export interface MemoryRegionProxyOptions<TPayload = unknown> {
  readonly regionId: RegionId;
  readonly fabric: MemoryRegionRouterFabric<TPayload>;
}

/**
 * In-memory {@link RegionProxyTransport} over a shared
 * {@link MemoryRegionRouterFabric}. The routing analogue of
 * `MemoryRegionBus`. Production deployments supply a WAN request/response
 * adapter (e.g. an HTTP call to the home region's ingress, or a
 * cross-region queue) implementing the same interface.
 */
export class MemoryRegionProxy<TPayload = unknown> implements RegionProxyTransport<TPayload> {
  readonly regionId: RegionId;
  readonly #fabric: MemoryRegionRouterFabric<TPayload>;
  #detach: (() => void) | undefined;

  constructor(options: MemoryRegionProxyOptions<TPayload>) {
    this.regionId = options.regionId;
    this.#fabric = options.fabric;
  }

  proxyTo(homeRegionId: RegionId, write: ProxiedWrite<TPayload>): void {
    this.#fabric.send(homeRegionId, write);
  }

  onProxiedWrite(handler: ProxiedWriteHandler<TPayload>): () => void {
    this.#detach?.();
    // Capture THIS registration's detach in the returned closure rather than
    // re-reading this.#detach at unsubscribe time. If onProxiedWrite is called
    // again (h1 then h2), the unsubscribe returned for h1 must tear down h1's
    // attachment — not whatever is currently live — so disposing the stale
    // subscription can't accidentally detach h2, the active handler
    // (finding multi-region-7).
    const detach = this.#fabric.attach(this.regionId, handler);
    this.#detach = detach;
    return () => {
      detach();
      if (this.#detach === detach) this.#detach = undefined;
    };
  }

  async close(): Promise<void> {
    this.#detach?.();
    this.#detach = undefined;
  }
}

// ---------------------------------------------------------------------------
// Claim-based dynamic ownership (FR-154-style claim/tie-break/TTL)
// ---------------------------------------------------------------------------

/**
 * Bus envelope kind announcing a region's claim/release of a write key's
 * home. Carried over the region bus alongside FR-105 fan-out. Kept
 * structurally separate from {@link RegionEnvelope}'s inner
 * `ClusterEnvelope` so claim traffic never reaches the gateway's sync
 * dispatch — it is delivered only to {@link ClaimRegionOwnership}
 * subscribers via a dedicated control channel.
 */
export type OwnershipControlMessage =
  | { readonly kind: "ownershipClaim"; readonly key: WriteKey; readonly homeRegionId: RegionId }
  | { readonly kind: "ownershipRelease"; readonly key: WriteKey; readonly homeRegionId: RegionId };

/** Handler for ownership-control messages from peer regions. */
export type OwnershipControlHandler = (message: OwnershipControlMessage) => void;

/**
 * Control channel for ownership claim/release announcements. A tiny
 * broadcast bus, separate from the data-plane region bus, so ownership
 * coordination is decoupled from realtime fan-out. The in-memory impl is
 * {@link MemoryOwnershipControlFabric}; production can ride the same WAN
 * transport as the region bus.
 */
export interface OwnershipControlChannel {
  readonly regionId: RegionId;
  /** Announce a claim/release to peer regions. Best-effort. */
  publish(message: OwnershipControlMessage): void;
  /** Receive announcements from peers (never our own). Returns unsubscribe. */
  subscribe(handler: OwnershipControlHandler): () => void;
  close(): Promise<void>;
}

/** Shared in-process fabric wiring N {@link MemoryOwnershipControl} regions. */
export class MemoryOwnershipControlFabric {
  readonly #handlers = new Set<{ regionId: RegionId; handler: OwnershipControlHandler }>();

  attach(regionId: RegionId, handler: OwnershipControlHandler): () => void {
    const entry = { regionId, handler };
    this.#handlers.add(entry);
    return () => this.#handlers.delete(entry);
  }

  publish(fromRegionId: RegionId, message: OwnershipControlMessage): void {
    for (const entry of this.#handlers) {
      if (entry.regionId === fromRegionId) continue; // never echo to origin.
      try {
        entry.handler(message);
      } catch {
        // Isolate per-region failures.
      }
    }
  }
}

export interface MemoryOwnershipControlOptions {
  readonly regionId: RegionId;
  readonly fabric: MemoryOwnershipControlFabric;
}

/** In-memory {@link OwnershipControlChannel} over a shared fabric. */
export class MemoryOwnershipControl implements OwnershipControlChannel {
  readonly regionId: RegionId;
  readonly #fabric: MemoryOwnershipControlFabric;
  readonly #handlers = new Set<OwnershipControlHandler>();
  #detach: (() => void) | undefined;

  constructor(options: MemoryOwnershipControlOptions) {
    this.regionId = options.regionId;
    this.#fabric = options.fabric;
    this.#detach = this.#fabric.attach(this.regionId, (message) => {
      for (const handler of this.#handlers) {
        try {
          handler(message);
        } catch {
          // Isolate per-handler failures.
        }
      }
    });
  }

  publish(message: OwnershipControlMessage): void {
    this.#fabric.publish(this.regionId, message);
  }

  subscribe(handler: OwnershipControlHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  async close(): Promise<void> {
    this.#detach?.();
    this.#detach = undefined;
    this.#handlers.clear();
  }
}

interface OwnershipEntry {
  readonly homeRegionId: RegionId;
  readonly at: number;
}

export interface ClaimRegionOwnershipOptions {
  /** This region's identity — the home it claims for unowned keys. */
  readonly regionId: RegionId;
  /** Control channel for claim/release announcements. */
  readonly control: OwnershipControlChannel;
  /** Claim TTL in ms. A missed release (crashed home) self-heals after this. Defaults to 1h. */
  readonly ttlMs?: number;
  /** Injectable clock for deterministic TTL. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Claim-based dynamic ownership over the region bus, mirroring FR-154's
 * `ClusterMediaPlacement` one level up (region instead of node):
 *
 *   - **resolve/claim** — `homeRegionFor(key)`: returns the known home if a
 *     live claim exists (ours or a peer's); otherwise **claims** the key
 *     for this region, records it, announces an `ownershipClaim`, and
 *     returns this region.
 *   - **learn** — a subscriber maintains the `key → home` registry from
 *     peer `ownershipClaim` messages; own echoes are dropped by the
 *     control channel's origin guard.
 *   - **tie-break (split-brain)** — two regions can claim the same key
 *     before either's claim arrives. Convergence: **lowest `regionId`
 *     (lexicographic) wins** — total + symmetric, so all regions pick the
 *     same home from the same claims regardless of arrival order. On a
 *     peer claim with a lower id, we adopt it (we lost); with a higher id,
 *     we keep ours (the peer will adopt ours when our claim reaches it).
 *   - **release/TTL** — {@link release} evicts and announces an
 *     `ownershipRelease`; a TTL backstops a missed release so a crashed
 *     home re-claims on the next resolve.
 *
 * `homeRegionFor` is **not** pure (it may claim + announce on first call
 * for a key), which still satisfies {@link RegionOwnershipResolver}'s
 * determinism contract: from the same converged claim set, every region
 * returns the same home.
 */
export class ClaimRegionOwnership implements RegionOwnershipResolver {
  readonly regionId: RegionId;
  readonly #control: OwnershipControlChannel;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #registry = new Map<WriteKey, OwnershipEntry>();
  #unsubscribe: (() => void) | undefined;

  constructor(options: ClaimRegionOwnershipOptions) {
    this.regionId = options.regionId;
    this.#control = options.control;
    this.#ttlMs = options.ttlMs ?? DEFAULT_OWNERSHIP_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#unsubscribe = this.#control.subscribe((message) => this.#onMessage(message));
  }

  homeRegionFor(key: WriteKey): RegionId {
    const known = this.#liveEntry(key);
    if (known) return known.homeRegionId;
    // Unowned (or expired) — claim it for this region and announce.
    this.#registry.set(key, { homeRegionId: this.regionId, at: this.#now() });
    this.#control.publish({ kind: "ownershipClaim", key, homeRegionId: this.regionId });
    return this.regionId;
  }

  /**
   * Release this region's home claim for `key` (e.g. on graceful drain).
   * Idempotent; a no-op if we don't own `key` (we can't speak for a claim
   * we don't hold). Peers evict on receipt and re-claim on next resolve.
   */
  release(key: WriteKey): void {
    const entry = this.#registry.get(key);
    const weOwn = entry?.homeRegionId === this.regionId;
    this.#registry.delete(key);
    if (weOwn) {
      this.#control.publish({ kind: "ownershipRelease", key, homeRegionId: this.regionId });
    }
  }

  /** Test/inspection: the home currently recorded for a key (TTL-aware). */
  homeForKey(key: WriteKey): RegionId | undefined {
    return this.#liveEntry(key)?.homeRegionId;
  }

  close(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  // -- internals -----------------------------------------------------------

  #liveEntry(key: WriteKey): OwnershipEntry | undefined {
    const entry = this.#registry.get(key);
    if (!entry) return undefined;
    if (this.#now() - entry.at >= this.#ttlMs) {
      this.#registry.delete(key);
      return undefined;
    }
    return entry;
  }

  #onMessage(message: OwnershipControlMessage): void {
    if (message.kind === "ownershipClaim") {
      this.#onPeerClaim(message.key, message.homeRegionId);
    } else {
      // Release — drop our cached entry; next resolve re-claims deterministically.
      const entry = this.#registry.get(message.key);
      if (entry && entry.homeRegionId === message.homeRegionId) {
        this.#registry.delete(message.key);
      }
    }
  }

  #onPeerClaim(key: WriteKey, peerHome: RegionId): void {
    const current = this.#registry.get(key);
    if (!current) {
      this.#registry.set(key, { homeRegionId: peerHome, at: this.#now() });
      return;
    }
    if (current.homeRegionId === peerHome) {
      // Re-announcement of the home we already hold — refresh TTL.
      this.#registry.set(key, { homeRegionId: peerHome, at: this.#now() });
      return;
    }
    // Conflict: two homes for one key. Tie-break = lowest regionId wins.
    if (peerHome < current.homeRegionId) {
      this.#registry.set(key, { homeRegionId: peerHome, at: this.#now() });
    }
    // else: we hold the lower id; keep ours. The peer adopts ours when our
    // claim reaches it. Both converge on the lowest id with no further messages.
  }
}
