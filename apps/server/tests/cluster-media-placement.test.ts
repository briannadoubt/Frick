import { describe, expect, it, vi } from "vitest";

import { MemoryClusterBus, MemoryClusterChannel } from "../src/cluster/bus.js";
import {
  ClusterMediaPlacement,
  DEFAULT_SFU_MEDIA_CODECS,
  FakeSfuBackend,
  LocalMediaPlacement,
  SfuMediaPlaneAdapter,
} from "../src/calls/index.js";

/**
 * FR-154 — multi-box SFU placement (bus-coordinated home-node registry).
 *
 * Two (or three) in-process {@link MemoryClusterBus} instances wired as peers
 * through a shared {@link MemoryClusterChannel}, each fronting its own
 * {@link FakeSfuBackend} + {@link SfuMediaPlaneAdapter}, prove the placement
 * protocol: claim/resolve, the tie-break that prevents split-brain, release
 * reclaiming the registry cross-node, and the TTL backstop. A final case shows
 * single-box {@link LocalMediaPlacement} is unchanged.
 */

const IP_A = "10.0.0.1";
const IP_B = "10.0.0.2";
const IP_C = "10.0.0.3";

function peerBuses(...nodeIds: string[]) {
  const channel = new MemoryClusterChannel();
  return nodeIds.map((nodeId) => new MemoryClusterBus({ channel, nodeId }));
}

function adapterFor(placement: ClusterMediaPlacement) {
  const backend = new FakeSfuBackend();
  const adapter = new SfuMediaPlaneAdapter({
    backend,
    placement,
    mediaCodecs: DEFAULT_SFU_MEDIA_CODECS,
    tokenSecret: "secret",
  });
  return { backend, adapter };
}

describe("ClusterMediaPlacement", () => {
  it("resolves a call allocated on node A to A's home from node B (no second router)", async () => {
    const [busA, busB] = peerBuses("node-a", "node-b");
    const placeA = new ClusterMediaPlacement({ bus: busA!, announcedIp: IP_A });
    const placeB = new ClusterMediaPlacement({ bus: busB!, announcedIp: IP_B });
    const a = adapterFor(placeA);
    const b = adapterFor(placeB);

    // A allocates the call's router → A becomes home and publishes the claim.
    const sessionA = await a.adapter.allocateSession("call-1");
    expect(sessionA.connection!["homeNodeId"]).toBe("node-a");
    expect(sessionA.connection!["announcedIp"]).toBe(IP_A);
    expect(a.backend.hasRouter("call-1")).toBe(true);

    // B resolves the SAME call to A's home — it must NOT claim it itself.
    const home = await placeB.placeFor("call-1");
    expect(home).toEqual({ nodeId: "node-a", announcedIp: IP_A });

    // B never allocated a router for this call; media homes on A only.
    expect(b.backend.hasRouter("call-1")).toBe(false);

    placeA.close();
    placeB.close();
  });

  it("converges simultaneous claims to one home via lowest-nodeId tie-break (no split-brain)", async () => {
    // Defer fan-out so both nodes claim BEFORE either's claim is delivered.
    const channel = new MemoryClusterChannel();
    const queue: Array<() => void> = [];
    const realPublish = channel.publish.bind(channel);
    vi.spyOn(channel, "publish").mockImplementation((env) => {
      queue.push(() => realPublish(env));
    });

    const busA = new MemoryClusterBus({ channel, nodeId: "node-a" });
    const busZ = new MemoryClusterBus({ channel, nodeId: "node-z" });

    const yieldedA: string[] = [];
    const yieldedZ: string[] = [];
    const placeA = new ClusterMediaPlacement({
      bus: busA,
      announcedIp: IP_A,
      onYieldHome: (c) => void yieldedA.push(c),
    });
    const placeZ = new ClusterMediaPlacement({
      bus: busZ,
      announcedIp: IP_B,
      onYieldHome: (c) => void yieldedZ.push(c),
    });

    // Both claim locally while delivery is paused → split-brain in flight.
    const homeA0 = await placeA.placeFor("call-x");
    const homeZ0 = await placeZ.placeFor("call-x");
    expect(homeA0.nodeId).toBe("node-a");
    expect(homeZ0.nodeId).toBe("node-z");

    // Now flush both claims to peers.
    for (const deliver of queue.splice(0)) deliver();

    // Lowest nodeId ("node-a") wins on BOTH nodes — converged, no split-brain.
    expect(placeA.homeFor("call-x")).toEqual({ nodeId: "node-a", announcedIp: IP_A });
    expect(placeZ.homeFor("call-x")).toEqual({ nodeId: "node-a", announcedIp: IP_A });

    // The loser (node-z) yielded its orphaned router; the winner did not.
    expect(yieldedZ).toEqual(["call-x"]);
    expect(yieldedA).toEqual([]);

    placeA.close();
    placeZ.close();
  });

  it("converges three simultaneous claims to the single lowest-id home", async () => {
    const channel = new MemoryClusterChannel();
    const queue: Array<() => void> = [];
    const realPublish = channel.publish.bind(channel);
    vi.spyOn(channel, "publish").mockImplementation((env) => {
      queue.push(() => realPublish(env));
    });
    const busA = new MemoryClusterBus({ channel, nodeId: "node-a" });
    const busB = new MemoryClusterBus({ channel, nodeId: "node-b" });
    const busC = new MemoryClusterBus({ channel, nodeId: "node-c" });
    const pA = new ClusterMediaPlacement({ bus: busA, announcedIp: IP_A });
    const pB = new ClusterMediaPlacement({ bus: busB, announcedIp: IP_B });
    const pC = new ClusterMediaPlacement({ bus: busC, announcedIp: IP_C });

    await pA.placeFor("call-y");
    await pB.placeFor("call-y");
    await pC.placeFor("call-y");
    for (const deliver of queue.splice(0)) deliver();

    const winner = { nodeId: "node-a", announcedIp: IP_A };
    expect(pA.homeFor("call-y")).toEqual(winner);
    expect(pB.homeFor("call-y")).toEqual(winner);
    expect(pC.homeFor("call-y")).toEqual(winner);

    pA.close();
    pB.close();
    pC.close();
  });

  it("reclaims the registry entry across nodes when the home node releases", async () => {
    const [busA, busB] = peerBuses("node-a", "node-b");
    const placeA = new ClusterMediaPlacement({ bus: busA!, announcedIp: IP_A });
    const placeB = new ClusterMediaPlacement({ bus: busB!, announcedIp: IP_B });

    await placeA.placeFor("call-1");
    expect(await placeB.placeFor("call-1")).toEqual({ nodeId: "node-a", announcedIp: IP_A });

    // Home node releases → both nodes drop the entry.
    placeA.release("call-1");
    expect(placeA.homeFor("call-1")).toBeUndefined();
    expect(placeB.homeFor("call-1")).toBeUndefined();

    // After release, B re-resolving the call now homes it on B itself.
    const reHome = await placeB.placeFor("call-1");
    expect(reHome).toEqual({ nodeId: "node-b", announcedIp: IP_B });

    placeA.close();
    placeB.close();
  });

  it("does not announce a release from a non-home node", () => {
    const [busA, busB] = peerBuses("node-a", "node-b");
    const placeA = new ClusterMediaPlacement({ bus: busA!, announcedIp: IP_A });
    const placeB = new ClusterMediaPlacement({ bus: busB!, announcedIp: IP_B });

    const publishB = vi.spyOn(busB!, "publish");
    void placeA.placeFor("call-1"); // homed on A
    // B learns A's home; B releasing must be a no-op (B doesn't own it).
    placeB.release("call-1");
    expect(publishB).not.toHaveBeenCalled();

    placeA.close();
    placeB.close();
  });

  it("self-heals a missed release via TTL (stale entry treated as absent)", async () => {
    let now = 1_000;
    const clock = () => now;
    const [busA, busB] = peerBuses("node-a", "node-b");
    const placeA = new ClusterMediaPlacement({ bus: busA!, announcedIp: IP_A, ttlMs: 5_000, now: clock });
    const placeB = new ClusterMediaPlacement({ bus: busB!, announcedIp: IP_B, ttlMs: 5_000, now: clock });

    await placeA.placeFor("call-1");
    expect(await placeB.placeFor("call-1")).toEqual({ nodeId: "node-a", announcedIp: IP_A });

    // Home crashes without releasing; TTL elapses on B.
    now += 5_000;
    // B re-resolving past the TTL re-claims for itself.
    expect(await placeB.placeFor("call-1")).toEqual({ nodeId: "node-b", announcedIp: IP_B });

    placeA.close();
    placeB.close();
  });

  it("ignores its own claim echoes (origin dedupe)", async () => {
    const [busA] = peerBuses("node-a");
    const placeA = new ClusterMediaPlacement({ bus: busA!, announcedIp: IP_A });
    const home1 = await placeA.placeFor("call-1");
    // Resolving again is idempotent — same home, no re-claim churn.
    const home2 = await placeA.placeFor("call-1");
    expect(home1).toEqual(home2);
    expect(home1.nodeId).toBe("node-a");
    placeA.close();
  });
});

describe("LocalMediaPlacement (single-box) is unchanged under FR-154", () => {
  it("always homes every call on this node at the configured IP", async () => {
    const placement = new LocalMediaPlacement({ announcedIp: IP_A });
    expect(await placement.placeFor("call-1")).toEqual({ nodeId: "local", announcedIp: IP_A });
    expect(await placement.placeFor("call-2")).toEqual({ nodeId: "local", announcedIp: IP_A });
  });

  it("an SFU adapter with no bus still allocates locally with no coordination", async () => {
    const backend = new FakeSfuBackend();
    const adapter = new SfuMediaPlaneAdapter({
      backend,
      announcedIp: IP_A,
      mediaCodecs: DEFAULT_SFU_MEDIA_CODECS,
      tokenSecret: "secret",
    });
    const session = await adapter.allocateSession("call-1");
    expect(session.connection!["homeNodeId"]).toBe("local");
    expect(session.connection!["announcedIp"]).toBe(IP_A);
  });
});
