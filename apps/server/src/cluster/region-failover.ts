/**
 * Region-aware failover (FR-107) — health tracking + deterministic home
 * promotion on regional outage, layered on FR-106's per-region-primary
 * ownership ({@link RegionWriteRouter} / {@link RegionOwnershipResolver})
 * and FR-105's federation seam ({@link FrickRegionBus}).
 *
 * ## Why this exists
 *
 * FR-106 gives every write key a single **home region**. That is the
 * conflict story, but it also makes the home a per-key availability
 * dependency: if a key's home region goes down, writes to that key have
 * nowhere authoritative to land. FR-107 closes that gap with minimal,
 * testable orchestration:
 *
 *   - track each region's **health** (`healthy` / `draining` / `down`),
 *   - let a region attach / detach from the fabric cleanly (the
 *     FR-105 seam is failover-friendly — regions come and go), and
 *   - on a home region transitioning to `down` (or `draining`), **promote**
 *     a surviving region to home for every key the failed region owned,
 *     **deterministically** so every region agrees on the new home without
 *     coordination.
 *
 * ## Promotion rule (deterministic, coordination-free)
 *
 * When the home for a key becomes unavailable, the new home is the
 * **lowest-`regionId` healthy region** (lexicographic) among the survivors.
 * This mirrors FR-106/FR-154's lowest-id tie-break, so it is total and
 * symmetric: from the same `{ownership snapshot} × {health map}` every
 * region computes the identical promotion with no messages exchanged.
 * Writes then re-route to the promoted home via the unchanged
 * {@link RegionWriteRouter.routeWrite} path — promotion is just an
 * ownership reassignment, and routing reads ownership live.
 *
 * **Candidate universe (finding multi-region-2).** Promotion candidates are the
 * **full known region universe** — the union of the ownership map's regions
 * (assignment values + default), the configured regions
 * ({@link RegionFailoverCoordinatorOptions.configuredRegions}), and every
 * region with a reported health entry — **not** merely the regions this
 * coordinator happens to have heard health for. A region absent from the health
 * map is considered with its default `healthy` status, so a genuinely healthy
 * region that was never explicitly reported is still an eligible target, and
 * every region computes the identical winner from identical ownership +
 * configured-region inputs. (Determinism still requires that every coordinator
 * observe the same ownership snapshot and configured-region set + a consistent
 * health view; the per-region instances exchange no messages, so operators must
 * feed each the same inputs — see `docs/multi-region.md` → "Failover
 * determinism".)
 *
 * When a recovered region **rejoins** (`down`/`draining` → `healthy`),
 * promotion is *not* automatically reverted — the promoted home stays home
 * until an operator (or a future static-config reconcile) moves it back.
 * This avoids write-ownership flapping on a flaky region. The recovered
 * region simply becomes an eligible promotion target again and resumes
 * owning any keys statically assigned to it that were never reassigned.
 *
 * ## Health states
 *
 *   - `healthy` — serving; eligible to own writes and to be promoted to.
 *   - `draining` — finishing in-flight work, accepting no new home
 *     assignments; treated as unavailable for promotion *targets* and its
 *     owned keys are promoted away (graceful: drain before the LB pulls it).
 *   - `down` — failed health checks; unavailable, owned keys promoted away.
 *
 * ## Additive & opt-in
 *
 * A single-region server wires none of this: there is one region, it is
 * always healthy, it is home for everything, and no promotion ever fires.
 * Multi-region deployments opt in by constructing a
 * {@link RegionFailoverCoordinator} over their ownership model.
 */

import {
  StaticRegionOwnership,
  writeKeyForTenant,
  type RegionOwnershipResolver,
  type WriteKey,
} from "./region-router.js";
import type { RegionId } from "./region-bus.js";

/** Operational health of a region from the failover coordinator's view. */
export type RegionHealth = "healthy" | "draining" | "down";

/**
 * Observer notified when a key's home is promoted to a new region, so the
 * coordinator can be composed with side effects (logging, metrics, warming
 * the new home). Best-effort — failures are isolated.
 */
export type HomePromotionHandler = (event: {
  readonly key: WriteKey;
  readonly fromRegionId: RegionId;
  readonly toRegionId: RegionId;
}) => void;

export interface RegionFailoverCoordinatorOptions {
  /**
   * The mutable ownership map promotions reassign into. FR-107 requires a
   * {@link StaticRegionOwnership} (or any resolver exposing `reassign`)
   * because promotion *writes* ownership. Claim-based ownership self-heals
   * via its own TTL/release path, so the coordinator drives the static map.
   */
  readonly ownership: StaticRegionOwnership;
  /**
   * Initial region → health. Regions absent from the map are treated as
   * `healthy` the first time they're referenced (optimistic default).
   */
  readonly initialHealth?: Readonly<Record<RegionId, RegionHealth>>;
  /**
   * The configured region universe — every region this deployment may promote
   * a key to, beyond the ones referenced by the ownership map. Used together
   * with the ownership assignments + reported health to build a complete
   * promotion-candidate set, so a healthy region that was never explicitly
   * reported into {@link initialHealth}/`reportHealth` is still an eligible
   * failover target and every region computes the identical promotion winner
   * (finding multi-region-2). Optional and additive: omit it and the candidate
   * universe is still the union of ownership values + reported-health regions.
   */
  readonly configuredRegions?: Iterable<RegionId>;
  /** Called after each home promotion. */
  readonly onPromote?: HomePromotionHandler;
}

/**
 * Tracks region health and deterministically promotes a surviving region to
 * home when a key's home becomes unavailable. The orchestration is
 * intentionally minimal: it owns a health map + the set of keys it has
 * observed (so it knows which homes to re-evaluate) and reassigns ownership
 * on health transitions.
 */
export class RegionFailoverCoordinator {
  readonly #ownership: StaticRegionOwnership;
  readonly #health = new Map<RegionId, RegionHealth>();
  /** Keys the coordinator manages, so it knows what to re-home on outage. */
  readonly #managedKeys = new Set<WriteKey>();
  /** Statically-configured region universe (FR-107 promotion candidates). */
  readonly #configuredRegions: ReadonlySet<RegionId>;
  readonly #onPromote: HomePromotionHandler | undefined;

  constructor(options: RegionFailoverCoordinatorOptions) {
    this.#ownership = options.ownership;
    this.#onPromote = options.onPromote;
    this.#configuredRegions = new Set(options.configuredRegions ?? []);
    for (const [regionId, health] of Object.entries(options.initialHealth ?? {})) {
      this.#health.set(regionId, health);
    }
  }

  /**
   * The full known region universe promotion considers: the union of the
   * ownership map's regions (assignment values + default), the configured
   * regions, and every region with a reported health entry. Driving promotion
   * from this complete set — rather than only `#health.keys()` — means a
   * healthy region that was never explicitly reported is still an eligible
   * target, and every region computes the identical winner from identical
   * ownership + configured-region inputs (finding multi-region-2).
   */
  #candidateUniverse(): Set<RegionId> {
    const universe = new Set<RegionId>(this.#ownership.knownRegions());
    for (const region of this.#configuredRegions) universe.add(region);
    for (const region of this.#health.keys()) universe.add(region);
    return universe;
  }

  /** Current health of a region (`healthy` if never reported). */
  healthOf(regionId: RegionId): RegionHealth {
    return this.#health.get(regionId) ?? "healthy";
  }

  /** Whether a region is an eligible home / promotion target. */
  isAvailable(regionId: RegionId): boolean {
    return this.healthOf(regionId) === "healthy";
  }

  /**
   * Register a key for failover management and ensure it has a home. Called
   * when the deployment learns of a tenant (e.g. on first route). Records
   * the key so its home is re-evaluated on health transitions. Returns the
   * current home.
   */
  manageTenant(tenantId: string): RegionId {
    const key = writeKeyForTenant(tenantId);
    this.#managedKeys.add(key);
    const home = this.#ownership.homeRegionFor(key);
    // If the static home is already unavailable, promote eagerly so the
    // first write routes correctly.
    if (!this.isAvailable(home)) return this.#promoteAwayFrom(key, home);
    return home;
  }

  /**
   * Report a region's health. On a transition that makes a home
   * unavailable (`draining`/`down`), every managed key homed there is
   * promoted to the lowest-id surviving region. Returns the regions, if
   * any, that gained homes (for observability). Idempotent: reporting the
   * same health twice is a no-op.
   */
  reportHealth(regionId: RegionId, health: RegionHealth): void {
    const prev = this.healthOf(regionId);
    if (prev === health) return;
    this.#health.set(regionId, health);
    const nowUnavailable = health !== "healthy" && prev === "healthy";
    if (!nowUnavailable) return; // recovery doesn't revert promotions (see docs).
    for (const key of this.#managedKeys) {
      if (this.#ownership.homeRegionFor(key) === regionId) {
        this.#promoteAwayFrom(key, regionId);
      }
    }
  }

  /** Convenience: mark a region down (failed health check). */
  markDown(regionId: RegionId): void {
    this.reportHealth(regionId, "down");
  }

  /** Convenience: begin draining a region (graceful pre-removal). */
  drain(regionId: RegionId): void {
    this.reportHealth(regionId, "draining");
  }

  /** Convenience: mark a region healthy (attach / recovery). */
  markHealthy(regionId: RegionId): void {
    this.reportHealth(regionId, "healthy");
  }

  /**
   * The deterministic promotion target for a key whose home is unavailable:
   * the lowest-`regionId` healthy region among `candidates` (excluding the
   * failed home). Returns `undefined` if no healthy region exists. Pure —
   * the same inputs always yield the same target on every region.
   */
  promotionTargetFor(failedHomeRegionId: RegionId, candidates: Iterable<RegionId>): RegionId | undefined {
    let best: RegionId | undefined;
    for (const candidate of candidates) {
      if (candidate === failedHomeRegionId) continue;
      if (!this.isAvailable(candidate)) continue;
      if (best === undefined || candidate < best) best = candidate;
    }
    return best;
  }

  // -- internals -----------------------------------------------------------

  #promoteAwayFrom(key: WriteKey, failedHome: RegionId): RegionId {
    // Candidates are the FULL known region universe, not just the regions this
    // coordinator happens to have heard health for (finding multi-region-2):
    // a region absent from #health is considered with its default `healthy`,
    // and every region computing promotion from the same ownership +
    // configured-region inputs picks the identical lowest-id winner.
    const target = this.promotionTargetFor(failedHome, this.#candidateUniverse());
    if (target === undefined) {
      // No survivor known — leave ownership as-is. The next health report
      // that brings a region up (and the eager check in manageTenant) will
      // re-evaluate. This is the honest degraded state: with zero healthy
      // regions there is nowhere to promote to.
      return failedHome;
    }
    const effective = this.#ownership.reassign(key, target);
    if (effective !== failedHome) this.#emitPromotion(key, failedHome, effective);
    return effective;
  }

  #emitPromotion(key: WriteKey, from: RegionId, to: RegionId): void {
    if (!this.#onPromote) return;
    try {
      this.#onPromote({ key, fromRegionId: from, toRegionId: to });
    } catch {
      // Best-effort observability; promotion already took effect.
    }
  }
}

/**
 * Re-export of {@link RegionOwnershipResolver} for callers that wire
 * failover against a custom resolver. (FR-107's coordinator requires the
 * mutable {@link StaticRegionOwnership}; this type is here for symmetry.)
 */
export type { RegionOwnershipResolver };
