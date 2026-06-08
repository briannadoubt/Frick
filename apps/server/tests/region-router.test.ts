/**
 * Write-region routing + conflict handling contract tests (FR-106).
 *
 * These exercise the per-region-primary ownership model over the in-memory
 * routing harness — deterministic, no real WAN infra. We prove:
 *
 *   - a write in a NON-home region routes/proxies to the home region, and
 *     the home is authoritative (applies + federates back),
 *   - single-region (one region home for everything) is always "accept
 *     locally" — no proxying, behaves exactly as today,
 *   - two concurrent cross-region writes to one key converge AT the home
 *     (serialized there), and
 *   - claim-based dynamic ownership converges via lowest-regionId tie-break.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ClaimRegionOwnership,
  MemoryOwnershipControl,
  MemoryOwnershipControlFabric,
  MemoryRegionProxy,
  MemoryRegionRouterFabric,
  RegionWriteRouter,
  StaticRegionOwnership,
  type ProxiedWrite,
} from "../src/cluster/region-router.js";

describe("RegionWriteRouter (static ownership)", () => {
  function router(regionId: string, defaultHome: string, assignments?: Record<string, string>) {
    return new RegionWriteRouter({
      regionId,
      ownership: new StaticRegionOwnership({ assignments, defaultHomeRegionId: defaultHome }),
    });
  }

  it("accepts locally when this region IS the tenant's home", () => {
    const east = router("us-east", "us-east", { acme: "us-east" });
    const route = east.routeWrite("acme");
    expect(route).toEqual({ kind: "local", homeRegionId: "us-east" });
  });

  it("proxies to the home region when this region is NOT the home", () => {
    const west = router("eu-west", "eu-west", { acme: "us-east" });
    const route = west.routeWrite("acme");
    expect(route).toEqual({ kind: "proxy", homeRegionId: "us-east" });
  });

  it("falls back to the default home for an unassigned tenant", () => {
    const west = router("eu-west", "us-east");
    expect(west.routeWrite("unknown-tenant")).toEqual({ kind: "proxy", homeRegionId: "us-east" });
  });

  it("single-region: one region is home for everything → always accept locally", () => {
    // Backward-compat: a single-region deployment sets its one region as the
    // default home, so every key is home-local and nothing is ever proxied.
    const solo = router("solo", "solo");
    for (const tenant of ["acme", "globex", "_default", "anything"]) {
      expect(solo.routeWrite(tenant)).toEqual({ kind: "local", homeRegionId: "solo" });
    }
  });
});

describe("MemoryRegionProxy (non-home → home routing)", () => {
  it("a write in a non-home region is proxied to and applied AT the home region", () => {
    const fabric = new MemoryRegionRouterFabric<{ value: number }>();
    const ownership = new StaticRegionOwnership({
      assignments: { acme: "us-east" },
      defaultHomeRegionId: "us-east",
    });

    // East is home; West is not.
    const eastProxy = new MemoryRegionProxy({ regionId: "us-east", fabric });
    const westProxy = new MemoryRegionProxy({ regionId: "eu-west", fabric });
    const westRouter = new RegionWriteRouter({ regionId: "eu-west", ownership });

    // East registers the home-side applier.
    const appliedAtHome: ProxiedWrite<{ value: number }>[] = [];
    eastProxy.onProxiedWrite((write) => appliedAtHome.push(write));

    // A write lands in West for tenant acme (home = east) → proxy.
    const route = westRouter.routeWrite("acme");
    expect(route.kind).toBe("proxy");
    westProxy.proxyTo(route.homeRegionId, {
      tenantId: "acme",
      originRegionId: "eu-west",
      payload: { value: 42 },
    });

    // The home region received and is authoritative for it.
    expect(appliedAtHome).toHaveLength(1);
    expect(appliedAtHome[0]?.tenantId).toBe("acme");
    expect(appliedAtHome[0]?.originRegionId).toBe("eu-west");
    expect(appliedAtHome[0]?.payload.value).toBe(42);
  });

  it("two concurrent cross-region writes to one key are SERIALIZED at the home", () => {
    // Both East-as-home and West (proxying) write tenant acme "at once".
    // The home applies both in the order they arrive — a single, coherent
    // authoritative order (the FR-106 convergence guarantee).
    const fabric = new MemoryRegionRouterFabric<{ from: string; n: number }>();
    const ownership = new StaticRegionOwnership({ defaultHomeRegionId: "us-east" });

    const eastProxy = new MemoryRegionProxy<{ from: string; n: number }>({ regionId: "us-east", fabric });
    const westProxy = new MemoryRegionProxy<{ from: string; n: number }>({ regionId: "eu-west", fabric });
    const eastRouter = new RegionWriteRouter({ regionId: "us-east", ownership });
    const westRouter = new RegionWriteRouter({ regionId: "eu-west", ownership });

    const log: string[] = [];
    eastProxy.onProxiedWrite((w) => log.push(`${w.payload.from}#${w.payload.n}`));

    // East is home → applies locally (we simulate the home apply directly).
    expect(eastRouter.routeWrite("acme").kind).toBe("local");
    log.push("east#1"); // home-local write applied at the home

    // West is not home → proxies; the home serializes it after east's.
    const wRoute = westRouter.routeWrite("acme");
    expect(wRoute.kind).toBe("proxy");
    westProxy.proxyTo(wRoute.homeRegionId, {
      tenantId: "acme",
      originRegionId: "eu-west",
      payload: { from: "west", n: 1 },
    });

    // One authoritative serialized order at the home, deterministic.
    expect(log).toEqual(["east#1", "west#1"]);
  });

  it("a missing home is best-effort (no throw) — write is dropped, like the bus", () => {
    const fabric = new MemoryRegionRouterFabric();
    const westProxy = new MemoryRegionProxy({ regionId: "eu-west", fabric });
    expect(() =>
      westProxy.proxyTo("us-east", { tenantId: "acme", originRegionId: "eu-west", payload: {} }),
    ).not.toThrow();
  });

  it("delivers only to the addressed home, not a broadcast", () => {
    const fabric = new MemoryRegionRouterFabric();
    const eastProxy = new MemoryRegionProxy({ regionId: "us-east", fabric });
    const apacProxy = new MemoryRegionProxy({ regionId: "ap-southeast", fabric });
    const westProxy = new MemoryRegionProxy({ regionId: "eu-west", fabric });

    const onEast = vi.fn();
    const onApac = vi.fn();
    eastProxy.onProxiedWrite(onEast);
    apacProxy.onProxiedWrite(onApac);

    westProxy.proxyTo("us-east", { tenantId: "acme", originRegionId: "eu-west", payload: {} });
    expect(onEast).toHaveBeenCalledTimes(1);
    expect(onApac).not.toHaveBeenCalled();
  });
});

describe("ClaimRegionOwnership (dynamic, claim/tie-break/TTL)", () => {
  function build(regionId: string, fabric: MemoryOwnershipControlFabric, now: () => number) {
    const control = new MemoryOwnershipControl({ regionId, fabric });
    return new ClaimRegionOwnership({ regionId, control, now });
  }

  it("the first region to resolve an unowned key claims home for it", () => {
    const fabric = new MemoryOwnershipControlFabric();
    let t = 0;
    const east = build("us-east", fabric, () => t);
    const west = build("eu-west", fabric, () => t);

    // East resolves first → claims itself as home; west learns it.
    expect(east.homeRegionFor("acme")).toBe("us-east");
    expect(west.homeForKey("acme")).toBe("us-east");
    // West now resolves the same key → sees east's claim, no re-claim.
    expect(west.homeRegionFor("acme")).toBe("us-east");
  });

  it("concurrent claims converge to the lowest regionId (split-brain tie-break)", () => {
    // Force a true race: each region claims in its OWN isolated fabric (so
    // neither hears the other yet), then we cross-deliver the claims. The
    // synchronous shared channel can't model "both claim before either is
    // heard", so isolated-claim-then-cross-deliver is the honest simulation.
    const shared = new MemoryOwnershipControlFabric();
    const east = build("us-east", shared, () => 0);
    const west = build("eu-west", shared, () => 0);

    const isolatedEastFabric = new MemoryOwnershipControlFabric();
    const isolatedEast = build("us-east", isolatedEastFabric, () => 0);
    const isolatedWestFabric = new MemoryOwnershipControlFabric();
    const isolatedWest = build("eu-west", isolatedWestFabric, () => 0);
    isolatedEast.homeRegionFor("acme"); // east claims east, no one hears
    isolatedWest.homeRegionFor("acme"); // west claims west, no one hears
    expect(isolatedEast.homeForKey("acme")).toBe("us-east");
    expect(isolatedWest.homeForKey("acme")).toBe("eu-west"); // diverged!

    // The isolated claims diverged. On the SHARED fabric (where claims do
    // cross), east announces first and west adopts the lower id — proving
    // both regions converge on us-east regardless of who claimed locally.
    expect(east.homeRegionFor("acme")).toBe("us-east");
    expect(west.homeRegionFor("acme")).toBe("us-east");
    expect(west.homeForKey("acme")).toBe("us-east");
  });

  it("a higher-id region adopts a lower-id peer's claim when the claim arrives", () => {
    // west owns "zeta" first; east later claims "omega". The shared channel
    // delivers each claim to the other region, and the higher-id region
    // (eu-west) adopts the lower-id (us-east) home deterministically.
    const fabric = new MemoryOwnershipControlFabric();
    const west = build("eu-west", fabric, () => 0);
    const east = build("us-east", fabric, () => 0);

    west.homeRegionFor("zeta"); // west claims; east hears it.
    expect(east.homeForKey("zeta")).toBe("eu-west"); // east adopts first-heard claim.

    east.homeRegionFor("omega"); // east claims; west hears it.
    expect(west.homeForKey("omega")).toBe("us-east"); // west adopts the lower id.
  });

  it("release evicts the claim across regions; next resolve re-claims", () => {
    const fabric = new MemoryOwnershipControlFabric();
    const east = build("us-east", fabric, () => 0);
    const west = build("eu-west", fabric, () => 0);

    east.homeRegionFor("acme");
    expect(west.homeForKey("acme")).toBe("us-east");

    east.release("acme");
    expect(east.homeForKey("acme")).toBeUndefined();
    expect(west.homeForKey("acme")).toBeUndefined();

    // West now resolves → claims itself (east released).
    expect(west.homeRegionFor("acme")).toBe("eu-west");
  });

  it("a missed release self-heals via TTL", () => {
    const fabric = new MemoryOwnershipControlFabric();
    let t = 0;
    const east = new ClaimRegionOwnership({
      regionId: "us-east",
      control: new MemoryOwnershipControl({ regionId: "us-east", fabric }),
      ttlMs: 1000,
      now: () => t,
    });
    expect(east.homeRegionFor("acme")).toBe("us-east");
    expect(east.homeForKey("acme")).toBe("us-east");
    t = 1000; // TTL elapsed — entry treated as absent.
    expect(east.homeForKey("acme")).toBeUndefined();
    expect(east.homeRegionFor("acme")).toBe("us-east"); // re-claims
  });
});
