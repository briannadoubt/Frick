/**
 * Region-aware failover contract tests (FR-107).
 *
 * Deterministic over the in-memory ownership model — no real infra. We prove:
 *
 *   - a region marked down triggers deterministic home promotion to the
 *     lowest-id surviving region, and writes re-route to the new home,
 *   - draining promotes away gracefully,
 *   - a recovered region rejoins cleanly (becomes an eligible target again,
 *     without flapping the promotion that already happened),
 *   - health-state transitions are idempotent and observable.
 */
import { describe, expect, it, vi } from "vitest";
import {
  RegionWriteRouter,
  StaticRegionOwnership,
} from "../src/cluster/region-router.js";
import { RegionFailoverCoordinator } from "../src/cluster/region-failover.js";

describe("RegionFailoverCoordinator", () => {
  function setup(initialHealth?: Record<string, "healthy" | "draining" | "down">) {
    const ownership = new StaticRegionOwnership({
      assignments: { acme: "us-east", globex: "eu-west" },
      defaultHomeRegionId: "us-east",
    });
    const onPromote = vi.fn();
    const coordinator = new RegionFailoverCoordinator({
      ownership,
      initialHealth: { "us-east": "healthy", "eu-west": "healthy", "ap-southeast": "healthy", ...initialHealth },
      onPromote,
    });
    return { ownership, coordinator, onPromote };
  }

  it("promotes a key's home to the lowest-id surviving region when the home goes down", () => {
    const { ownership, coordinator, onPromote } = setup();
    coordinator.manageTenant("acme"); // home = us-east

    coordinator.markDown("us-east");

    // Surviving healthy regions: eu-west, ap-southeast → lowest id = ap-southeast.
    expect(ownership.homeRegionFor("acme")).toBe("ap-southeast");
    expect(onPromote).toHaveBeenCalledWith({
      key: "acme",
      fromRegionId: "us-east",
      toRegionId: "ap-southeast",
    });
  });

  it("re-routes writes to the promoted home", () => {
    const { ownership, coordinator } = setup();
    coordinator.manageTenant("acme");
    const apacRouter = new RegionWriteRouter({ regionId: "ap-southeast", ownership });

    // Before failover ap-southeast proxies acme to us-east.
    expect(apacRouter.routeWrite("acme")).toEqual({ kind: "proxy", homeRegionId: "us-east" });

    coordinator.markDown("us-east");

    // After failover ap-southeast IS the home → accepts locally.
    expect(apacRouter.routeWrite("acme")).toEqual({ kind: "local", homeRegionId: "ap-southeast" });
  });

  it("draining promotes owned keys away gracefully", () => {
    const { ownership, coordinator } = setup();
    coordinator.manageTenant("globex"); // home = eu-west

    coordinator.drain("eu-west");

    // Survivors: us-east, ap-southeast → lowest = ap-southeast.
    expect(ownership.homeRegionFor("globex")).toBe("ap-southeast");
  });

  it("only promotes keys homed on the failed region", () => {
    const { ownership, coordinator } = setup();
    coordinator.manageTenant("acme"); // us-east
    coordinator.manageTenant("globex"); // eu-west

    coordinator.markDown("eu-west");

    expect(ownership.homeRegionFor("acme")).toBe("us-east"); // untouched
    expect(ownership.homeRegionFor("globex")).toBe("ap-southeast"); // promoted
  });

  it("a recovered region rejoins cleanly without reverting the promotion", () => {
    const { ownership, coordinator } = setup();
    coordinator.manageTenant("acme");

    coordinator.markDown("us-east");
    expect(ownership.homeRegionFor("acme")).toBe("ap-southeast");

    // us-east comes back. Promotion is NOT reverted (no write-ownership flap).
    coordinator.markHealthy("us-east");
    expect(coordinator.healthOf("us-east")).toBe("healthy");
    expect(coordinator.isAvailable("us-east")).toBe(true);
    expect(ownership.homeRegionFor("acme")).toBe("ap-southeast"); // stays promoted
  });

  it("health transitions are idempotent (reporting the same health twice is a no-op)", () => {
    const { ownership, coordinator, onPromote } = setup();
    coordinator.manageTenant("acme");

    coordinator.markDown("us-east");
    expect(onPromote).toHaveBeenCalledTimes(1);
    const homeAfterFirst = ownership.homeRegionFor("acme");

    coordinator.markDown("us-east"); // already down — no second promotion.
    expect(onPromote).toHaveBeenCalledTimes(1);
    expect(ownership.homeRegionFor("acme")).toBe(homeAfterFirst);
  });

  it("manageTenant on a tenant whose static home is already down promotes eagerly", () => {
    const { ownership, coordinator } = setup({ "us-east": "down" });
    const home = coordinator.manageTenant("acme"); // static home us-east is down

    expect(home).toBe("ap-southeast"); // promoted on first management
    expect(ownership.homeRegionFor("acme")).toBe("ap-southeast");
  });

  it("promotionTargetFor is deterministic: lowest-id healthy region, excluding the failed home", () => {
    const { coordinator } = setup();
    const regions = ["us-east", "eu-west", "ap-southeast"];
    expect(coordinator.promotionTargetFor("us-east", regions)).toBe("ap-southeast");
    expect(coordinator.promotionTargetFor("ap-southeast", regions)).toBe("eu-west");
  });

  it("with no healthy survivor, ownership is left as-is (honest degraded state)", () => {
    const { ownership, coordinator, onPromote } = setup({
      "eu-west": "down",
      "ap-southeast": "down",
    });
    coordinator.manageTenant("acme"); // home us-east still healthy here

    coordinator.markDown("us-east"); // now every region is down.

    // Nowhere to promote → home stays us-east, no promotion event emitted.
    expect(ownership.homeRegionFor("acme")).toBe("us-east");
    expect(onPromote).not.toHaveBeenCalled();
  });
});
