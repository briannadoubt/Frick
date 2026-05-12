# Horizontal scale

The single-process default works fine for a few thousand concurrent WebSocket subscribers. Past that, you need to run multiple server nodes behind a load balancer — and that means cross-node fan-out, because a write that lands on node A has to reach a subscriber connected to node B.

This page documents the framework's cluster surface, the in-memory default that ships with `@frick/server`, and what a production Redis / NATS adapter looks like.

## What "horizontal scale" actually requires

The framework already lets you run N nodes in front of one SQLite database (or the SQLite-compatible substrate of your choice). Every node hits the same database, so durability and per-tenant isolation are unchanged. What's missing without the cluster bus is **realtime fan-out**:

| Path | Single node | N nodes without bus | N nodes with bus |
|---|---|---|---|
| Stream events | Subscribers on the same node receive ✓ | Subscribers on **peer** nodes never see it ✗ | All subscribers receive ✓ |
| Object upserts | Same ✓ | Peers see it only when they re-read ✗ | All subscribers receive ✓ |
| Signals | Same ✓ | Same ✗ | All subscribers receive ✓ |
| Presence deltas | Same ✓ | Same ✗ | All subscribers receive ✓ |
| Projection deltas | Same ✓ | Same ✗ | All subscribers receive ✓ |

Every fan-out kind crosses the bus. Loop guard is per-bus via `originNodeId` (the bus never delivers a node's own publish back to its own subscribers).

## The contract

`FrickClusterBus` (defined in [`apps/server/src/cluster/bus.ts`](../apps/server/src/cluster/bus.ts)) is the minimum interface any adapter must satisfy:

```ts
interface FrickClusterBus {
  readonly nodeId: NodeId;
  publish(envelope: ClusterEnvelope): void;
  subscribe(handler: ClusterEnvelopeHandler): () => void;
  close(): Promise<void>;
}
```

`ClusterEnvelope` is a tagged union carrying every framework-published fan-out shape (stream event, object upsert, signal, projection delta, presence delta). Each envelope is stamped with `originNodeId` so the receiving bus can filter self-publishes — that loop guard is the only ordering / dedup guarantee the contract requires.

## The default — `MemoryClusterBus`

Ships in the box. Useful for:

- **Tests** that exercise multi-node behavior without a real broker (the framework's own `apps/server/tests/cluster-bus.test.ts` is the reference).
- **Single-node deploys** that may want to scale to N nodes later without rewiring — the in-memory bus is a no-op on the wire so wiring it now adds nothing but a useless `originNodeId` on every envelope.

```ts
import { createFrickServer, MemoryClusterBus } from "@frick/server";

const server = createFrickServer({
  clusterBus: new MemoryClusterBus(), // optional; unset for true single-node
});
```

## Wiring a production bus

A production adapter wraps Redis / NATS / Kafka / any pub-sub-shaped substrate. Skeleton:

```ts
import { createClient } from "redis";
import type { ClusterEnvelope, ClusterEnvelopeHandler, FrickClusterBus, NodeId } from "@frick/server";

const CHANNEL = "frick.cluster";

export class RedisClusterBus implements FrickClusterBus {
  readonly nodeId: NodeId;
  #pub: ReturnType<typeof createClient>;
  #sub: ReturnType<typeof createClient>;
  #handlers = new Set<ClusterEnvelopeHandler>();

  static async create(url: string, nodeId?: NodeId): Promise<RedisClusterBus> {
    const bus = new RedisClusterBus(nodeId);
    bus.#pub = createClient({ url });
    bus.#sub = bus.#pub.duplicate();
    await Promise.all([bus.#pub.connect(), bus.#sub.connect()]);
    await bus.#sub.subscribe(CHANNEL, (raw) => {
      const envelope = JSON.parse(raw) as ClusterEnvelope;
      if (envelope.originNodeId === bus.nodeId) return;
      for (const h of bus.#handlers) {
        try { h(envelope); } catch { /* isolate */ }
      }
    });
    return bus;
  }

  private constructor(nodeId?: NodeId) {
    this.nodeId = nodeId ?? crypto.randomUUID();
  }

  publish(envelope: ClusterEnvelope): void {
    void this.#pub.publish(CHANNEL, JSON.stringify(envelope));
  }

  subscribe(handler: ClusterEnvelopeHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  async close(): Promise<void> {
    await Promise.all([this.#sub.quit(), this.#pub.quit()]);
  }
}
```

Wiring at server boot:

```ts
const bus = await RedisClusterBus.create(process.env.REDIS_URL!);
const server = createFrickServer({ clusterBus: bus });
```

## Operational notes

- **Sticky sessions are still nice to have.** The cluster bus makes them unnecessary for correctness, but a subscriber that bounces between nodes burns a full handshake on each connect. Configure your load balancer's `ws` upgrade with sticky cookies when you can.
- **No back-pressure on the bus path.** A burst of writes still fans out unthrottled. Adapter implementations can add their own bounded queues if a downstream broker complains.
- **Per-tenant scoping.** The framework filters peer envelopes by tenant in the local fan-out path (same logic as the single-node case). The bus carries `tenantId` on every envelope; adapter-level encryption + scoping is your call. Buses may additionally implement `setSubscribedTenants(tenantIds)` to drop inbound envelopes for tenants this node doesn't serve at the wire boundary — the gateway refcounts connected-client tenants and pushes the live set down on every connect / disconnect. The bundled `MemoryClusterBus` implements this; adapters that omit the method retain the original "every envelope to every node" behaviour, which is fine for small clusters where the filter overhead exceeds the bandwidth saved.
- **What happens on bus failure?** A `publish(...)` that throws will be logged by your adapter but not propagated — the local fan-out has already happened, so the publishing node's clients see the write either way. Peer nodes miss it; clients will catch up on their next reconnect via the existing cursor-replay path.

## Known follow-ups

- **Multi-bus topologies.** The contract is one bus per server. Replicating across regions ("write here, sync to the bus in that other region") is out of scope for v1 — the recommended pattern is to run one bus cluster per region and fail traffic over via your load balancer.
