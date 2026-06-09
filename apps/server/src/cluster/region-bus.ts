/**
 * Cross-region bus federation (FR-105) — the first deliverable of the
 * FR-20 multi-region epic.
 *
 * The {@link FrickClusterBus} solves fan-out BETWEEN nodes inside ONE
 * region: a write on node A reaches a subscriber on node B because both
 * nodes share an intra-region bus (Memory in tests, Redis in prod). It
 * says nothing about regions — every node is assumed to share one bus.
 *
 * Multi-region deployments break that assumption. Each region runs its
 * own intra-region bus (its own Redis), so a write that lands in region
 * `us-east` never reaches a subscriber connected to a node in `eu-west`.
 * Federation is the layer that carries cluster envelopes ACROSS regions.
 *
 * `FrickRegionBus` is the pluggable seam for that cross-region hop. It is
 * deliberately the same async pub/sub shape as `FrickClusterBus`, one
 * level up:
 *
 *   FrickClusterBus    : node  <-> node   (within a region)
 *   FrickRegionBus     : region <-> region (across regions)
 *
 * The framework composes the two rather than replacing the cluster bus:
 * {@link FederatingClusterBus} wraps a region's existing intra-region
 * `FrickClusterBus` and a `FrickRegionBus`, so the gateway keeps talking
 * to one `FrickClusterBus` and is completely unaware federation exists.
 * A single-region server that never wires a `FrickRegionBus` behaves
 * exactly as today (additive + backward-compatible).
 *
 * Loop prevention: every federated envelope is tagged with its
 * `originRegionId`. A region's federation bus never re-delivers an
 * envelope that originated in its own region — the regional analogue of
 * the cluster bus's per-node `originNodeId` guard. Combined with the
 * existing per-node guard, a write fans out exactly once per node, in
 * every region, with no cycles even in a mesh topology.
 *
 * What this layer intentionally does NOT do (deferred — see
 * docs/multi-region.md):
 *   - FR-106: write-region routing + cross-region conflict handling.
 *     Federation here is best-effort realtime fan-out; durable
 *     convergence + which region "owns" a write is FR-106.
 *   - FR-107: region-aware failover + load-balancer integration. The
 *     seam is failover-friendly (regions can come and go), but the
 *     health-checking / LB glue is FR-107.
 */

import type { ClusterEnvelope, ClusterEnvelopeHandler, FrickClusterBus } from "./bus.js";
import { randomNodeId } from "./bus.js";
import { MEDIA_PLACEMENT_TENANT } from "../calls/cluster-media-placement.js";

/** Stable identifier for a region, e.g. `us-east`, `eu-west`. */
export type RegionId = string;

/**
 * A {@link ClusterEnvelope} wrapped with the region it originated in.
 *
 * The inner `envelope` is byte-for-byte the same union the intra-region
 * cluster bus already carries (so the receiving region can hand it
 * straight to its local `FrickClusterBus.publish`). `originRegionId` is
 * the cross-region loop guard, exactly mirroring how `originNodeId`
 * guards the per-node hop.
 */
export interface RegionEnvelope {
  /** Region the wrapped envelope was first published in. */
  readonly originRegionId: RegionId;
  /** The intra-region fan-out payload, unchanged. */
  readonly envelope: ClusterEnvelope;
}

/** Handler a region registers to receive envelopes federated from peers. */
export type RegionEnvelopeHandler = (envelope: RegionEnvelope) => void;

/**
 * The cross-region federation seam. Mirrors {@link FrickClusterBus} one
 * level up: `publish` ships an envelope to OTHER regions, `subscribe`
 * receives envelopes federated FROM other regions.
 *
 * Implementations MUST tag outbound envelopes with {@link regionId} and
 * MUST NOT deliver an inbound envelope back to the region it originated
 * in (the `originRegionId === regionId` loop guard). Like the cluster
 * bus, `publish` is best-effort fire-and-forget — failures are logged,
 * not thrown — and cross-region ordering is best-effort (consumers
 * already tolerate out-of-order Delta frames via per-stream cursors).
 */
export interface FrickRegionBus {
  /** Stable identifier for THIS region; used to tag outbound publishes. */
  readonly regionId: RegionId;
  /** Federate an envelope to peer regions. Best-effort. */
  publish(envelope: RegionEnvelope): void;
  /** Register a subscriber for envelopes federated from peers. Returns an unsubscribe fn. */
  subscribe(handler: RegionEnvelopeHandler): () => void;
  /** Tear down peer-region connections. Called from `server.close()`. */
  close(): Promise<void>;
}

/**
 * Shared in-process fabric connecting N {@link MemoryRegionBus}
 * instances — the regional analogue of `MemoryClusterChannel`. Pass the
 * same fabric to several `MemoryRegionBus`es and they federate to each
 * other, letting tests exercise the full cross-region path deterministically
 * without real inter-region infra.
 */
export class MemoryRegionFabric {
  readonly #handlers = new Set<RegionEnvelopeHandler>();

  publish(envelope: RegionEnvelope): void {
    for (const handler of this.#handlers) {
      try {
        handler(envelope);
      } catch {
        // Isolate per-region failures so one buggy region can't poison
        // federation for the rest. Production region buses log via their
        // own observability; the in-memory fabric is silent by design.
      }
    }
  }

  attach(handler: RegionEnvelopeHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }
}

export interface MemoryRegionBusOptions {
  /** Stable region id. Required — regions are named, not anonymous. */
  readonly regionId: RegionId;
  /**
   * Shared fabric wiring this region to its peers. Pass the same fabric
   * to every `MemoryRegionBus` that should federate together.
   */
  readonly fabric: MemoryRegionFabric;
}

/**
 * In-memory {@link FrickRegionBus}. The federation analogue of
 * `MemoryClusterBus`: suitable for the framework's own test harness and
 * for single-process multi-region simulations. Production deployments
 * supply a WAN-spanning adapter (e.g. a cross-region Redis stream, NATS
 * super-cluster, or Kafka MirrorMaker) that conforms to the same
 * interface.
 */
export class MemoryRegionBus implements FrickRegionBus {
  readonly regionId: RegionId;
  readonly #fabric: MemoryRegionFabric;
  readonly #localHandlers = new Set<RegionEnvelopeHandler>();
  #fabricDetach: (() => void) | undefined;

  constructor(options: MemoryRegionBusOptions) {
    this.regionId = options.regionId;
    this.#fabric = options.fabric;
    this.#fabricDetach = this.#fabric.attach((regionEnvelope) => {
      // Loop guard: never re-deliver an envelope that originated here.
      if (regionEnvelope.originRegionId === this.regionId) return;
      for (const handler of this.#localHandlers) {
        try {
          handler(regionEnvelope);
        } catch {
          // Isolate per-handler failures.
        }
      }
    });
  }

  publish(envelope: RegionEnvelope): void {
    this.#fabric.publish(envelope);
  }

  subscribe(handler: RegionEnvelopeHandler): () => void {
    this.#localHandlers.add(handler);
    return () => this.#localHandlers.delete(handler);
  }

  async close(): Promise<void> {
    this.#fabricDetach?.();
    this.#fabricDetach = undefined;
    this.#localHandlers.clear();
  }
}

export interface FederatingClusterBusOptions {
  /** This region's identity, stamped on every federated publish. */
  readonly regionId: RegionId;
  /** The region's existing intra-region bus (Memory/Redis). All node-to-node fan-out still flows through this. */
  readonly local: FrickClusterBus;
  /** The cross-region federation transport. */
  readonly region: FrickRegionBus;
}

/**
 * Composes an intra-region {@link FrickClusterBus} with a
 * {@link FrickRegionBus} and presents the SAME `FrickClusterBus`
 * interface to the gateway. This is the seam the server wires when
 * federation is configured; everything upstream stays unaware that more
 * than one region exists.
 *
 * Flow:
 *  - `publish(envelope)`:
 *      1. forward to the local cluster bus (unchanged node-to-node fan-out), and
 *      2. if the envelope originated on THIS node (originNodeId === local.nodeId),
 *         also federate it to peer regions wrapped as a {@link RegionEnvelope}.
 *         We only federate our own node's publishes so an envelope that
 *         merely arrived from a peer NODE in our region isn't re-federated
 *         (the local bus already fanned it to every node here).
 *  - inbound from peer regions: re-injected into the LOCAL cluster bus so
 *    it fans out to every node in this region exactly as a local publish
 *    would. The `originRegionId` guard on the region bus prevents the
 *    envelope from looping back to its source region.
 *
 * Backward-compatible: with no `FrickRegionBus` wired, callers just use
 * their `FrickClusterBus` directly and this wrapper is never constructed.
 */
export class FederatingClusterBus implements FrickClusterBus {
  readonly regionId: RegionId;
  readonly #local: FrickClusterBus;
  readonly #region: FrickRegionBus;
  #regionUnsub: (() => void) | undefined;
  // Tenants this region currently serves. `undefined` = pass-through
  // (back-compat, before the gateway declares its served set). Mirrors the
  // intra-region bus's filter so the federation hop honors it too.
  #subscribedTenants: ReadonlySet<string> | undefined;

  constructor(options: FederatingClusterBusOptions) {
    this.regionId = options.regionId;
    this.#local = options.local;
    this.#region = options.region;

    // Envelopes federated from peer regions are re-injected locally so they
    // fan out to every node in this region just like a local write — but only
    // if this region actually serves the envelope's tenant. Re-injection goes
    // through local.publish (the publish path, which is never tenant-filtered:
    // the intra-region filter lives on the inbound hop), so without this guard
    // EVERY cross-region frame for EVERY tenant would be re-published onto this
    // region's intra-region bus and only dropped per-node downstream — forfeiting
    // the setSubscribedTenants bandwidth/CPU saving on federated traffic
    // (finding multi-region-6). We also defensively skip malformed inner
    // envelopes here (finding multi-region-4).
    this.#regionUnsub = this.#region.subscribe((regionEnvelope) => {
      const inner = regionEnvelope.envelope as ClusterEnvelope | undefined;
      if (inner === null || typeof inner !== "object" || typeof inner.kind !== "string") {
        return; // malformed cross-region payload — never re-inject (multi-region-4).
      }
      if (!this.#servesTenant(inner.tenantId)) return;
      this.#local.publish(inner);
    });
  }

  /**
   * Whether this region currently serves `tenantId`. Pass-through until the
   * gateway declares a served set. The media-placement sentinel tenant is
   * always served (placement is keyed by callId, not tenant, and the gateway
   * never lists it among real tenants) so call-routing federation is unaffected.
   */
  #servesTenant(tenantId: string): boolean {
    if (this.#subscribedTenants === undefined) return true;
    if (tenantId === MEDIA_PLACEMENT_TENANT) return true;
    return this.#subscribedTenants.has(tenantId);
  }

  /** Delegates to the intra-region bus's node id — the gateway's loop guard is unchanged. */
  get nodeId(): string {
    return this.#local.nodeId;
  }

  publish(envelope: ClusterEnvelope): void {
    // 1. Intra-region fan-out is unchanged.
    this.#local.publish(envelope);
    // 2. Federate to peer regions, but only envelopes that originated on
    //    THIS node. Envelopes arriving from a peer node in our own region
    //    were already fanned out region-wide by the local bus; re-federating
    //    them would double-ship across the WAN.
    if (envelope.originNodeId === this.#local.nodeId) {
      this.#region.publish({ originRegionId: this.regionId, envelope });
    }
  }

  subscribe(handler: ClusterEnvelopeHandler): () => void {
    return this.#local.subscribe(handler);
  }

  setSubscribedTenants(tenantIds: ReadonlySet<string>): void {
    // Snapshot for the federation-hop filter (caller may keep mutating the set
    // after handing it over), and delegate to the intra-region bus so the
    // node-to-node inbound filter still applies.
    this.#subscribedTenants = new Set(tenantIds);
    this.#local.setSubscribedTenants?.(tenantIds);
  }

  async close(): Promise<void> {
    this.#regionUnsub?.();
    this.#regionUnsub = undefined;
    await Promise.allSettled([this.#region.close(), this.#local.close()]);
  }
}

/** Convenience: a stable-ish random region id for tests/dev when none is provided. */
export function randomRegionId(): RegionId {
  return `region-${randomNodeId()}`;
}
