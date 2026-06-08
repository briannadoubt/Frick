/**
 * FR-154 — multi-box SFU placement (bus-coordinated home-node registry).
 *
 * The follow-up to FR-83's {@link LocalMediaPlacement} ("always this node").
 * This impl coordinates placement across a horizontally-scaled cluster over the
 * existing {@link FrickClusterBus}: the first node to allocate a call's router
 * becomes that call's **home**, publishes the placement, and every other node
 * resolves `placeFor(callId)` to the home node's announced media address. A
 * client therefore ICEs straight to the home SFU regardless of which node its
 * control WebSocket landed on — media is decoupled from sync placement, and
 * signaling already rides the relay→bus so produce/consume reaches the home
 * node cross-node for free.
 *
 * **Explicitly NOT here:** SFU-to-SFU cascading / mediasoup PipeTransport. One
 * call stays homed to exactly one node; its ceiling is that node's capacity.
 * Cross-region placement is FR-105/FR-106, a separate layer.
 *
 * ## Protocol
 *
 * - **resolve** — `placeFor(callId)`:
 *   1. If this node already homes the call → return the local home.
 *   2. Else if a peer's claim for the call is known (learned over the bus) →
 *      return that remote home.
 *   3. Else → claim the call locally, record it, and **publish** a
 *      `mediaPlacementClaim` so peers learn it. Return the local home.
 *
 * - **claim/learn** — a subscriber maintains the `callId → home` registry from
 *   peer `mediaPlacementClaim` envelopes. Own echoes are dropped by the bus's
 *   `originNodeId` guard, and we re-check `originNodeId` defensively.
 *
 * - **tie-break (split-brain)** — two nodes can `placeFor` the same call before
 *   either's claim arrives, so both claim locally. Convergence rule:
 *   **lowest `homeNodeId` (lexicographic) wins; first-write-wins on a tie**
 *   (a tie is impossible since node ids are unique). When a peer claim arrives:
 *     - peer id `<` our recorded home id → adopt the peer's home (we lost), and
 *       if *we* had claimed locally, release our now-orphaned router via the
 *       injected `onYieldHome` hook.
 *     - peer id `>` our recorded home id → keep ours; the peer will independently
 *       adopt ours when our claim reaches it. Both nodes converge on the lowest
 *       id with no further messages.
 *   The rule is total and symmetric, so all nodes pick the same home from the
 *   same set of claims regardless of arrival order.
 *
 * - **release** — when a call's router is released, the home node calls
 *   {@link release}, which evicts the local entry and publishes a
 *   `mediaPlacementRelease`; peers evict their cached entry on receipt. A TTL
 *   backstops the registry so a missed release (node crash) self-heals: an entry
 *   older than `ttlMs` is treated as absent on the next resolve.
 *
 * Additive & opt-in: {@link LocalMediaPlacement} stays the single-box default;
 * this is wired only when a cluster bus is configured.
 */

import type { ClusterEnvelope, FrickClusterBus, NodeId } from "../cluster/bus.js";
import type { MediaHome, MediaPlacement } from "./media-placement.js";

/**
 * Sentinel tenant tag for placement envelopes. Placement is keyed by `callId`,
 * not tenant, but every {@link ClusterEnvelope} carries a `tenantId`; using a
 * stable sentinel keeps the bus's tenant machinery uniform. Underscore-prefixed
 * to match the framework's reserved-namespace convention (`_default`).
 */
export const MEDIA_PLACEMENT_TENANT = "_media_placement";

/** Default registry-entry lifetime: a missed release self-heals after this. */
const DEFAULT_PLACEMENT_TTL_MS = 60 * 60 * 1000; // 1h

interface RegistryEntry {
  readonly home: MediaHome;
  /** When this entry was learned/claimed, for TTL eviction. */
  readonly at: number;
}

export interface ClusterMediaPlacementOptions {
  /** The cluster bus this node coordinates placement over. */
  readonly bus: FrickClusterBus;
  /**
   * This node's media identity. `nodeId` defaults to the bus's `nodeId` so
   * placement and fan-out agree on who "this node" is.
   */
  readonly nodeId?: NodeId;
  /** Announced media IP/hostname this node advertises in ICE candidates. */
  readonly announcedIp: string;
  /** Registry-entry TTL in ms. Defaults to 1h. A missed release self-heals after this. */
  readonly ttlMs?: number;
  /** Injectable clock for deterministic TTL. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Called when this node *loses* a tie-break for a call it had claimed
   * locally (a lower-id peer wins). The adapter releases the orphaned router
   * here so no media state lingers on the losing node. Best-effort: failures
   * are swallowed (the registry has already converged; the router is at worst a
   * harmless idle leak the backend can reap).
   */
  readonly onYieldHome?: (callId: string) => void | Promise<void>;
}

export class ClusterMediaPlacement implements MediaPlacement {
  readonly #bus: FrickClusterBus;
  readonly #nodeId: NodeId;
  readonly #announcedIp: string;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #onYieldHome: ((callId: string) => void | Promise<void>) | undefined;
  readonly #registry = new Map<string, RegistryEntry>();
  #unsubscribe: (() => void) | undefined;

  constructor(options: ClusterMediaPlacementOptions) {
    this.#bus = options.bus;
    this.#nodeId = options.nodeId ?? options.bus.nodeId;
    this.#announcedIp = options.announcedIp;
    this.#ttlMs = options.ttlMs ?? DEFAULT_PLACEMENT_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#onYieldHome = options.onYieldHome;
    this.#unsubscribe = this.#bus.subscribe((envelope) => this.#onEnvelope(envelope));
  }

  async placeFor(callId: string): Promise<MediaHome> {
    const known = this.#liveEntry(callId);
    if (known) {
      // Either we already home it, or a peer does — both are authoritative.
      return known.home;
    }
    // No live entry: claim it for this node, record, and announce.
    const home: MediaHome = { nodeId: this.#nodeId, announcedIp: this.#announcedIp };
    this.#registry.set(callId, { home, at: this.#now() });
    this.#publishClaim(callId, home);
    return home;
  }

  /**
   * Release a call's media placement. Call this from the home node when the
   * router is torn down: evicts the local entry and tells peers to do the same.
   * Idempotent and safe to call on a non-home node (no-op if we don't own it).
   */
  release(callId: string): void {
    const entry = this.#registry.get(callId);
    // Only the home node announces a release — a non-home node releasing would
    // be lying to peers about an entry it doesn't own.
    const weOwn = entry?.home.nodeId === this.#nodeId;
    this.#registry.delete(callId);
    if (weOwn) {
      this.#bus.publish({
        kind: "mediaPlacementRelease",
        originNodeId: this.#nodeId,
        tenantId: MEDIA_PLACEMENT_TENANT,
        callId,
      });
    }
  }

  /** Test/inspection: the home currently recorded for a call, if any (TTL-aware). */
  homeFor(callId: string): MediaHome | undefined {
    return this.#liveEntry(callId)?.home;
  }

  /** Tear down the bus subscription. */
  close(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  // -- internals -----------------------------------------------------------

  #liveEntry(callId: string): RegistryEntry | undefined {
    const entry = this.#registry.get(callId);
    if (!entry) return undefined;
    if (this.#now() - entry.at >= this.#ttlMs) {
      // Expired — a missed release / crashed home. Treat as absent so the next
      // resolve re-claims. Evict so we don't keep checking the stale entry.
      this.#registry.delete(callId);
      return undefined;
    }
    return entry;
  }

  #publishClaim(callId: string, home: MediaHome): void {
    this.#bus.publish({
      kind: "mediaPlacementClaim",
      originNodeId: this.#nodeId,
      tenantId: MEDIA_PLACEMENT_TENANT,
      callId,
      homeNodeId: home.nodeId,
      announcedIp: home.announcedIp,
    });
  }

  #onEnvelope(envelope: ClusterEnvelope): void {
    // Defensive origin-dedupe (the bus already drops our own echoes).
    if (envelope.originNodeId === this.#nodeId) return;
    if (envelope.kind === "mediaPlacementClaim") {
      this.#onPeerClaim(envelope.callId, {
        nodeId: envelope.homeNodeId,
        announcedIp: envelope.announcedIp,
      });
    } else if (envelope.kind === "mediaPlacementRelease") {
      // The home announced teardown — drop our cached entry. (If we somehow
      // still think we own it, that's a stale local view; honor the home.)
      this.#registry.delete(envelope.callId);
    }
    // All other kinds are sync fan-out and not our concern.
  }

  #onPeerClaim(callId: string, peerHome: MediaHome): void {
    const current = this.#registry.get(callId);
    if (!current) {
      // First we've heard of this call — adopt the peer's home.
      this.#registry.set(callId, { home: peerHome, at: this.#now() });
      return;
    }
    if (current.home.nodeId === peerHome.nodeId) {
      // Re-announcement of the home we already have — refresh TTL, nothing else.
      this.#registry.set(callId, { home: peerHome, at: this.#now() });
      return;
    }
    // Conflict: two different homes for one call. Tie-break = lowest nodeId wins.
    if (peerHome.nodeId < current.home.nodeId) {
      // Peer wins. Adopt its home.
      const weHadClaimed = current.home.nodeId === this.#nodeId;
      this.#registry.set(callId, { home: peerHome, at: this.#now() });
      if (weHadClaimed) {
        // We claimed locally and lost — release our orphaned router.
        void this.#yieldHome(callId);
      }
    }
    // else: we hold the lower id; keep ours. The peer will adopt ours when our
    // claim reaches it. Both converge on the lowest id.
  }

  async #yieldHome(callId: string): Promise<void> {
    if (!this.#onYieldHome) return;
    try {
      await this.#onYieldHome(callId);
    } catch {
      // Best-effort: convergence already happened; a lingering idle router on
      // the losing node is harmless and reapable by the backend.
    }
  }
}
