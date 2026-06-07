/**
 * Cluster bus for horizontal scale.
 *
 * The sync gateway broadcasts every stream event, object upsert,
 * signal, and projection delta to its locally-connected WebSocket
 * subscribers. To run more than one server node behind a load
 * balancer we also need each publish to reach peer nodes so a client
 * connected to node B sees writes that originated on node A.
 *
 * `FrickClusterBus` is the pluggable interface every node implements
 * to share publishes with its peers. The framework ships a
 * `MemoryClusterBus` for in-process fan-out (single-node deployments
 * + tests); apps that scale horizontally wire a Redis / NATS / Kafka
 * adapter — the contract is intentionally tiny so any pub/sub-like
 * substrate works.
 *
 * Correctness: every publish carries an `originNodeId`. The gateway's
 * subscriber dedupes against its own `nodeId` so it doesn't re-emit
 * messages it just sent. That's the only guarantee the bus has to
 * provide — ordering across nodes is best-effort, and consumers
 * already cope with out-of-order Delta frames via per-stream cursors.
 */

import type { PlainObject, PackedStreamEvent } from "@fricken/protocol";

/** Stable identifier for a server instance. Defaults to a per-process UUID. */
export type NodeId = string;

/**
 * Wire shape of every fan-out message. Mirrors the gateway's local
 * publish methods one-to-one so the subscriber on a peer node can
 * dispatch back into the right local publish path.
 */
export type ClusterEnvelope =
  | {
      kind: "streamEvent";
      originNodeId: NodeId;
      tenantId: string;
      stream: string;
      streamId: string;
      sequence: number;
      packed: PackedStreamEvent;
    }
  | {
      kind: "objects";
      originNodeId: NodeId;
      tenantId: string;
      type: string;
      objects: PlainObject[];
    }
  | {
      kind: "objectDeletes";
      originNodeId: NodeId;
      tenantId: string;
      type: string;
      ids: string[];
    }
  | {
      kind: "signal";
      originNodeId: NodeId;
      tenantId: string;
      name: string;
      key: string;
      value: PlainObject;
      requestId: string;
    }
  | {
      kind: "projectionDelta";
      originNodeId: NodeId;
      tenantId: string;
      projection: string;
      changes: ReadonlyArray<{ key: string; value: PlainObject | null }>;
    }
  | {
      kind: "presenceDelta";
      originNodeId: NodeId;
      tenantId: string;
      name: string;
      records: ReadonlyArray<{ key: string; value: PlainObject | null }>;
      cleared: readonly string[];
    };

/** Handler the gateway registers to receive peer publishes. */
export type ClusterEnvelopeHandler = (envelope: ClusterEnvelope) => void;

export interface FrickClusterBus {
  /** Stable node identifier the bus uses to tag outbound publishes. */
  readonly nodeId: NodeId;
  /** Publish a fan-out envelope. Best-effort — failures are logged, not thrown. */
  publish(envelope: ClusterEnvelope): void;
  /** Register a subscriber. Returns an unsubscribe fn. */
  subscribe(handler: ClusterEnvelopeHandler): () => void;
  /** Tear down peer connections. Called from `server.close()`. */
  close(): Promise<void>;
  /**
   * Optional inbound filter: declares the set of tenants this node
   * currently has subscribers for. Adapters that implement this drop
   * inbound envelopes whose `tenantId` is not in the set before they
   * reach the gateway, saving the parse + dispatch cost on nodes that
   * don't serve that tenant. The gateway recomputes + calls this on
   * every subscription add / remove. Adapters that don't implement it
   * (or implement as a no-op) keep the original "every envelope
   * everywhere" behaviour — fine for small clusters where the filter
   * overhead exceeds the bandwidth saved.
   */
  setSubscribedTenants?(tenantIds: ReadonlySet<string>): void;
}

export interface MemoryClusterBusOptions {
  readonly nodeId?: NodeId;
  /**
   * Optional cross-instance channel. Pass the same `MemoryClusterChannel`
   * to multiple `MemoryClusterBus` instances and they fan out to each
   * other — useful for integration tests that exercise the multi-node
   * publish path without a real broker.
   */
  readonly channel?: MemoryClusterChannel;
}

/**
 * Shared in-process channel: a tiny pub/sub used by multiple
 * `MemoryClusterBus` instances to mimic a real broker. Each
 * subscription is keyed by a per-bus handler reference.
 */
export class MemoryClusterChannel {
  readonly #handlers = new Set<ClusterEnvelopeHandler>();

  publish(envelope: ClusterEnvelope): void {
    for (const handler of this.#handlers) {
      try {
        handler(envelope);
      } catch {
        // Subscriber threw — isolate so one buggy handler can't
        // poison the rest. Logged at the gateway layer.
      }
    }
  }

  attach(handler: ClusterEnvelopeHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }
}

/**
 * Default in-process bus. Suitable for single-node deployments + the
 * framework's own test harness. Production multi-node deployments
 * supply a Redis / NATS adapter that conforms to the same interface.
 */
export class MemoryClusterBus implements FrickClusterBus {
  readonly nodeId: NodeId;
  readonly #channel: MemoryClusterChannel;
  readonly #localHandlers = new Set<ClusterEnvelopeHandler>();
  #channelDetach: (() => void) | undefined;
  // `undefined` = pass-through (back-compat). Once the gateway calls
  // `setSubscribedTenants` even once, we filter against the stored set.
  #subscribedTenants: ReadonlySet<string> | undefined;

  constructor(options: MemoryClusterBusOptions = {}) {
    this.nodeId = options.nodeId ?? randomNodeId();
    this.#channel = options.channel ?? new MemoryClusterChannel();
    // Funnel cross-bus traffic into our local handlers.
    this.#channelDetach = this.#channel.attach((envelope) => {
      if (envelope.originNodeId === this.nodeId) return;
      if (this.#subscribedTenants && !this.#subscribedTenants.has(envelope.tenantId)) {
        return;
      }
      for (const handler of this.#localHandlers) {
        try {
          handler(envelope);
        } catch {
          // Isolate per-handler failures so one buggy gateway subscriber
          // can't break peer fan-out for the rest. Production adapters
          // (e.g. a Redis bus) log here via their own observability;
          // the in-memory implementation is silent by design.
        }
      }
    });
  }

  publish(envelope: ClusterEnvelope): void {
    this.#channel.publish(envelope);
  }

  subscribe(handler: ClusterEnvelopeHandler): () => void {
    this.#localHandlers.add(handler);
    return () => this.#localHandlers.delete(handler);
  }

  setSubscribedTenants(tenantIds: ReadonlySet<string>): void {
    // Snapshot — caller may keep mutating the set after handing it over.
    this.#subscribedTenants = new Set(tenantIds);
  }

  async close(): Promise<void> {
    this.#channelDetach?.();
    this.#channelDetach = undefined;
    this.#localHandlers.clear();
  }
}

function randomNodeId(): NodeId {
  // 64 bits of entropy, base36 — short enough to fit in log lines, long
  // enough to avoid collisions across a cluster.
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}
