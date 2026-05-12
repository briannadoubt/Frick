/**
 * Cluster bus contract tests.
 *
 * The gateway integration is exercised at construction time by the
 * existing server tests (any of them that hits a `publishStreamEvent`
 * exercises the bus-publish path when a bus is wired). These tests
 * focus on the bus itself: a publish on instance A reaches a subscriber
 * on instance B via the shared channel, and a bus never re-emits its
 * own publishes to its own subscribers.
 *
 * The Memory implementation is the framework default and the contract
 * any production adapter (Redis, NATS, Kafka) must satisfy.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryClusterBus, MemoryClusterChannel, type ClusterEnvelope } from "../src/cluster/bus.js";

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

describe("MemoryClusterBus", () => {
  it("delivers an envelope published on bus A to a subscriber on bus B", () => {
    const channel = new MemoryClusterChannel();
    const a = new MemoryClusterBus({ channel, nodeId: "node-a" });
    const b = new MemoryClusterBus({ channel, nodeId: "node-b" });

    const received: ClusterEnvelope[] = [];
    b.subscribe((envelope) => received.push(envelope));

    a.publish(streamEventEnvelope("node-a", 1));

    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe("streamEvent");
    expect(received[0]?.originNodeId).toBe("node-a");
  });

  it("filters out a bus's own publishes from its own subscribers (self-publish loop guard)", () => {
    const channel = new MemoryClusterChannel();
    const a = new MemoryClusterBus({ channel, nodeId: "node-a" });
    const b = new MemoryClusterBus({ channel, nodeId: "node-b" });

    const onA = vi.fn();
    const onB = vi.fn();
    a.subscribe(onA);
    b.subscribe(onB);

    a.publish(streamEventEnvelope("node-a", 1));

    expect(onA).not.toHaveBeenCalled();
    expect(onB).toHaveBeenCalledTimes(1);
  });

  it("isolates subscriber exceptions so one buggy handler can't poison the rest", () => {
    const channel = new MemoryClusterChannel();
    const a = new MemoryClusterBus({ channel, nodeId: "node-a" });
    const b = new MemoryClusterBus({ channel, nodeId: "node-b" });

    const okHandler = vi.fn();
    b.subscribe(() => { throw new Error("subscriber blew up"); });
    b.subscribe(okHandler);

    a.publish(streamEventEnvelope("node-a", 1));
    expect(okHandler).toHaveBeenCalledTimes(1);
  });

  it("close() detaches the bus from the shared channel", async () => {
    const channel = new MemoryClusterChannel();
    const a = new MemoryClusterBus({ channel, nodeId: "node-a" });
    const b = new MemoryClusterBus({ channel, nodeId: "node-b" });

    const onB = vi.fn();
    b.subscribe(onB);
    await b.close();

    a.publish(streamEventEnvelope("node-a", 1));
    expect(onB).not.toHaveBeenCalled();
  });

  it("assigns a stable random nodeId when none is supplied", () => {
    const a = new MemoryClusterBus();
    const b = new MemoryClusterBus();
    expect(a.nodeId).not.toBe(b.nodeId);
    expect(a.nodeId.length).toBeGreaterThan(8);
  });

  it("carries every envelope kind across nodes", () => {
    const channel = new MemoryClusterChannel();
    const a = new MemoryClusterBus({ channel, nodeId: "node-a" });
    const b = new MemoryClusterBus({ channel, nodeId: "node-b" });
    const seen: ClusterEnvelope[] = [];
    b.subscribe((envelope) => seen.push(envelope));

    a.publish({
      kind: "objects",
      originNodeId: "node-a",
      tenantId: "_default",
      type: "User",
      objects: [{ id: "u1", displayName: "Ada" }],
    });
    a.publish({
      kind: "signal",
      originNodeId: "node-a",
      tenantId: "_default",
      name: "WebRTCSignal",
      key: "call:room-1",
      value: { kind: "offer", senderDeviceId: "d1" },
      requestId: "req-1",
    });
    a.publish({
      kind: "projectionDelta",
      originNodeId: "node-a",
      tenantId: "_default",
      projection: "conversation-inbox",
      changes: [{ key: "user-ada:convo-1", value: { unreadCount: 3 } }],
    });
    a.publish({
      kind: "presenceDelta",
      originNodeId: "node-a",
      tenantId: "_default",
      name: "TypingState",
      records: [{ key: "convo-1:user-ada:device-web", value: { isTyping: true } }],
      cleared: [],
    });

    expect(seen.map((e) => e.kind)).toEqual([
      "objects",
      "signal",
      "projectionDelta",
      "presenceDelta",
    ]);
  });
});
