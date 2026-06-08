/**
 * Cross-region bus federation contract tests (FR-105).
 *
 * These mirror the intra-region `cluster-bus.test.ts` one level up. The
 * Memory federation harness wires N region buses together so the full
 * cross-region path is deterministic without real WAN infra. We prove:
 *
 *   - a write published in region A reaches a subscriber in region B,
 *   - an envelope is NOT re-delivered to its origin region (loop guard),
 *   - intra-region (node-to-node) behaviour is unchanged when federation
 *     is composed on top of an existing cluster bus,
 *   - a single-region server with no region bus behaves exactly as today.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MemoryClusterBus,
  MemoryClusterChannel,
  type ClusterEnvelope,
} from "../src/cluster/bus.js";
import {
  FederatingClusterBus,
  MemoryRegionBus,
  MemoryRegionFabric,
  type RegionEnvelope,
} from "../src/cluster/region-bus.js";

function streamEventEnvelope(originNodeId: string, sequence: number): ClusterEnvelope {
  return {
    kind: "streamEvent",
    originNodeId,
    tenantId: "_default",
    stream: "MessageStream",
    streamId: "conversation-general",
    sequence,
    packed: [1, "conversation-general", sequence, `evt-${sequence}`, 1, []],
  };
}

describe("MemoryRegionBus", () => {
  it("federates an envelope published in region A to a subscriber in region B", () => {
    const fabric = new MemoryRegionFabric();
    const east = new MemoryRegionBus({ regionId: "us-east", fabric });
    const west = new MemoryRegionBus({ regionId: "eu-west", fabric });

    const received: RegionEnvelope[] = [];
    west.subscribe((re) => received.push(re));

    east.publish({ originRegionId: "us-east", envelope: streamEventEnvelope("node-a", 1) });

    expect(received).toHaveLength(1);
    expect(received[0]?.originRegionId).toBe("us-east");
    expect(received[0]?.envelope.kind).toBe("streamEvent");
  });

  it("does NOT re-deliver an envelope to its origin region (cross-region loop guard)", () => {
    const fabric = new MemoryRegionFabric();
    const east = new MemoryRegionBus({ regionId: "us-east", fabric });
    const west = new MemoryRegionBus({ regionId: "eu-west", fabric });

    const onEast = vi.fn();
    const onWest = vi.fn();
    east.subscribe(onEast);
    west.subscribe(onWest);

    east.publish({ originRegionId: "us-east", envelope: streamEventEnvelope("node-a", 1) });

    expect(onEast).not.toHaveBeenCalled(); // origin region never sees its own publish
    expect(onWest).toHaveBeenCalledTimes(1);
  });

  it("fans out to every peer region in a mesh without looping", () => {
    const fabric = new MemoryRegionFabric();
    const east = new MemoryRegionBus({ regionId: "us-east", fabric });
    const west = new MemoryRegionBus({ regionId: "eu-west", fabric });
    const apac = new MemoryRegionBus({ regionId: "ap-southeast", fabric });

    const onWest = vi.fn();
    const onApac = vi.fn();
    const onEast = vi.fn();
    west.subscribe(onWest);
    apac.subscribe(onApac);
    east.subscribe(onEast);

    east.publish({ originRegionId: "us-east", envelope: streamEventEnvelope("node-a", 1) });

    expect(onWest).toHaveBeenCalledTimes(1);
    expect(onApac).toHaveBeenCalledTimes(1);
    expect(onEast).not.toHaveBeenCalled();
  });

  it("isolates subscriber exceptions so one buggy region handler can't poison the rest", () => {
    const fabric = new MemoryRegionFabric();
    const east = new MemoryRegionBus({ regionId: "us-east", fabric });
    const west = new MemoryRegionBus({ regionId: "eu-west", fabric });

    const ok = vi.fn();
    west.subscribe(() => {
      throw new Error("region handler blew up");
    });
    west.subscribe(ok);

    east.publish({ originRegionId: "us-east", envelope: streamEventEnvelope("node-a", 1) });
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("close() detaches the region from the fabric", async () => {
    const fabric = new MemoryRegionFabric();
    const east = new MemoryRegionBus({ regionId: "us-east", fabric });
    const west = new MemoryRegionBus({ regionId: "eu-west", fabric });

    const onWest = vi.fn();
    west.subscribe(onWest);
    await west.close();

    east.publish({ originRegionId: "us-east", envelope: streamEventEnvelope("node-a", 1) });
    expect(onWest).not.toHaveBeenCalled();
  });
});

describe("FederatingClusterBus", () => {
  /**
   * Builds two full regions, each with its own intra-region cluster bus
   * (a shared MemoryClusterChannel per region) plus a federation bus on a
   * shared fabric, and presents each as a FrickClusterBus to the gateway.
   */
  function buildTwoRegions() {
    const fabric = new MemoryRegionFabric();

    // Region east: two nodes sharing one intra-region channel.
    const eastChannel = new MemoryClusterChannel();
    const eastNode1Local = new MemoryClusterBus({ channel: eastChannel, nodeId: "east-1" });
    const eastNode2Local = new MemoryClusterBus({ channel: eastChannel, nodeId: "east-2" });
    const eastNode1 = new FederatingClusterBus({
      regionId: "us-east",
      local: eastNode1Local,
      region: new MemoryRegionBus({ regionId: "us-east", fabric }),
    });
    const eastNode2 = new FederatingClusterBus({
      regionId: "us-east",
      local: eastNode2Local,
      region: new MemoryRegionBus({ regionId: "us-east", fabric }),
    });

    // Region west: one node.
    const westChannel = new MemoryClusterChannel();
    const westNode1Local = new MemoryClusterBus({ channel: westChannel, nodeId: "west-1" });
    const westNode1 = new FederatingClusterBus({
      regionId: "eu-west",
      local: westNode1Local,
      region: new MemoryRegionBus({ regionId: "eu-west", fabric }),
    });

    return { eastNode1, eastNode2, westNode1 };
  }

  it("a write in region east reaches a subscriber in region west", () => {
    const { eastNode1, westNode1 } = buildTwoRegions();

    const onWest = vi.fn();
    westNode1.subscribe(onWest);

    eastNode1.publish(streamEventEnvelope("east-1", 1));

    expect(onWest).toHaveBeenCalledTimes(1);
    expect(onWest.mock.calls[0]?.[0]?.originNodeId).toBe("east-1");
  });

  it("preserves intra-region fan-out: a peer NODE in the same region still receives the write", () => {
    const { eastNode1, eastNode2 } = buildTwoRegions();

    const onEast2 = vi.fn();
    eastNode2.subscribe(onEast2);

    eastNode1.publish(streamEventEnvelope("east-1", 1));

    // east-2 shares east-1's intra-region channel, so it sees the write
    // exactly as it would without federation.
    expect(onEast2).toHaveBeenCalledTimes(1);
  });

  it("does not double-deliver across the WAN: a federated write fans out once per node in the peer region", () => {
    const { eastNode1, westNode1 } = buildTwoRegions();

    const onWest = vi.fn();
    westNode1.subscribe(onWest);

    eastNode1.publish(streamEventEnvelope("east-1", 1));

    // Exactly once: east-2 re-injecting into east's channel must not
    // re-federate (it only federates its own node's publishes), and the
    // originRegionId guard stops west from echoing back.
    expect(onWest).toHaveBeenCalledTimes(1);
  });

  it("does not echo a write back to its origin region", () => {
    const { eastNode1, eastNode2, westNode1 } = buildTwoRegions();

    const onEast1 = vi.fn();
    const onEast2 = vi.fn();
    // west subscribes only to re-inject; we watch east.
    westNode1.subscribe(() => {});
    eastNode1.subscribe(onEast1);
    eastNode2.subscribe(onEast2);

    eastNode1.publish(streamEventEnvelope("east-1", 1));

    // east-1 never sees its own publish (per-node guard); east-2 sees it
    // once via the local channel; neither sees a federated echo from west.
    expect(onEast1).not.toHaveBeenCalled();
    expect(onEast2).toHaveBeenCalledTimes(1);
  });

  it("delegates nodeId and setSubscribedTenants to the wrapped local bus", () => {
    const fabric = new MemoryRegionFabric();
    const local = new MemoryClusterBus({ channel: new MemoryClusterChannel(), nodeId: "east-1" });
    const fed = new FederatingClusterBus({
      regionId: "us-east",
      local,
      region: new MemoryRegionBus({ regionId: "us-east", fabric }),
    });

    expect(fed.nodeId).toBe("east-1");
    // Should not throw — forwards to the local bus's optional filter.
    expect(() => fed.setSubscribedTenants(new Set(["acme"]))).not.toThrow();
  });

  it("single-region (no FederatingClusterBus) is unchanged: plain MemoryClusterBus still works", () => {
    // Backward-compat: a server that never wires a region bus uses its
    // FrickClusterBus directly, with no federation behaviour bolted on.
    const channel = new MemoryClusterChannel();
    const a = new MemoryClusterBus({ channel, nodeId: "node-a" });
    const b = new MemoryClusterBus({ channel, nodeId: "node-b" });

    const onB = vi.fn();
    b.subscribe(onB);
    a.publish(streamEventEnvelope("node-a", 1));

    expect(onB).toHaveBeenCalledTimes(1);
  });
});
