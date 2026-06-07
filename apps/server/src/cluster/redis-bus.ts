/**
 * Production Redis-backed {@link FrickClusterBus} (FR-27).
 *
 * Fans cluster envelopes (stream events, object upserts/deletes, signals,
 * projection + presence deltas) across stateless nodes over a single Redis
 * pub/sub channel. Mirrors {@link MemoryClusterBus} semantics exactly:
 *   - every publish is tagged with this node's `originNodeId`; inbound
 *     envelopes from our own node are dropped (the loop guard),
 *   - when the gateway calls `setSubscribedTenants`, inbound envelopes for
 *     tenants this node doesn't serve are dropped before dispatch.
 *
 * Envelopes are msgpack-encoded (not JSON) so binary values inside packed
 * stream-event fields survive the round-trip. Two connections are used because
 * a Redis connection in subscribe mode cannot also issue PUBLISH: a dedicated
 * `subscriber` plus a `publisher`.
 *
 * The adapter is decoupled from any specific client via {@link RedisBusClient}
 * (ioredis satisfies it). Use {@link createRedisClusterBus} for the batteries-
 * included ioredis wiring.
 */
import { decode, encode } from "@msgpack/msgpack";
import {
  randomNodeId,
  type ClusterEnvelope,
  type ClusterEnvelopeHandler,
  type FrickClusterBus,
  type NodeId,
} from "./bus.js";

/**
 * Minimal Redis client surface the bus needs. ioredis (and most Redis clients)
 * satisfy it. `messageBuffer` delivers the raw bytes so msgpack payloads are
 * not corrupted by string decoding.
 */
export interface RedisBusClient {
  publish(channel: string, message: Buffer): Promise<unknown> | unknown;
  subscribe(channel: string): Promise<unknown> | unknown;
  on(
    event: "messageBuffer",
    listener: (channel: Buffer, message: Buffer) => void,
  ): unknown;
  quit(): Promise<unknown> | unknown;
}

export interface RedisClusterBusOptions {
  /** Connection used to PUBLISH. */
  publisher: RedisBusClient;
  /** Dedicated connection placed into subscribe mode. Must NOT be shared with `publisher`. */
  subscriber: RedisBusClient;
  /** Stable node id; defaults to a random one. */
  nodeId?: NodeId;
  /** Pub/sub channel name. Defaults to `frick:cluster`. */
  channel?: string;
  /** Structured logger for best-effort failures (publish/decode/handler). */
  logger?: (event: string, detail: Record<string, unknown>) => void;
}

const DEFAULT_CHANNEL = "frick:cluster";

export class RedisClusterBus implements FrickClusterBus {
  readonly nodeId: NodeId;
  /** Resolves once the subscriber has SUBSCRIBEd and is receiving messages. */
  readonly ready: Promise<void>;

  readonly #publisher: RedisBusClient;
  readonly #subscriber: RedisBusClient;
  readonly #channel: string;
  readonly #handlers = new Set<ClusterEnvelopeHandler>();
  readonly #log: (event: string, detail: Record<string, unknown>) => void;
  #subscribedTenants: ReadonlySet<string> | undefined;
  #closed = false;

  constructor(options: RedisClusterBusOptions) {
    this.nodeId = options.nodeId ?? randomNodeId();
    this.#publisher = options.publisher;
    this.#subscriber = options.subscriber;
    this.#channel = options.channel ?? DEFAULT_CHANNEL;
    this.#log = options.logger ?? (() => {});

    this.#subscriber.on("messageBuffer", (channel, message) => {
      this.#onMessage(channel, message);
    });
    this.ready = Promise.resolve(this.#subscriber.subscribe(this.#channel))
      .then(() => undefined)
      .catch((error) => {
        this.#log("frick.cluster.redis.subscribe_failed", { error: errMsg(error) });
      });
  }

  #onMessage(channel: Buffer, message: Buffer): void {
    if (channel.toString("utf8") !== this.#channel) return;
    let envelope: ClusterEnvelope;
    try {
      envelope = decode(message) as ClusterEnvelope;
    } catch (error) {
      this.#log("frick.cluster.redis.decode_failed", { error: errMsg(error) });
      return;
    }
    // Loop guard: never re-dispatch our own publishes.
    if (envelope.originNodeId === this.nodeId) return;
    // Tenant filter (once the gateway has declared its served tenants).
    if (this.#subscribedTenants && !this.#subscribedTenants.has(envelope.tenantId)) {
      return;
    }
    for (const handler of this.#handlers) {
      try {
        handler(envelope);
      } catch (error) {
        // Isolate per-handler failures so one buggy subscriber can't break
        // peer fan-out for the rest.
        this.#log("frick.cluster.redis.handler_threw", { error: errMsg(error) });
      }
    }
  }

  publish(envelope: ClusterEnvelope): void {
    if (this.#closed) return;
    let payload: Buffer;
    try {
      payload = Buffer.from(encode(envelope));
    } catch (error) {
      this.#log("frick.cluster.redis.encode_failed", { error: errMsg(error) });
      return;
    }
    // Best-effort: failures are logged, not thrown (per the FrickClusterBus
    // contract — publish is fire-and-forget).
    void Promise.resolve(this.#publisher.publish(this.#channel, payload)).catch((error) => {
      this.#log("frick.cluster.redis.publish_failed", { error: errMsg(error) });
    });
  }

  subscribe(handler: ClusterEnvelopeHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  setSubscribedTenants(tenantIds: ReadonlySet<string>): void {
    // Snapshot — the caller may keep mutating the set after handing it over.
    this.#subscribedTenants = new Set(tenantIds);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#handlers.clear();
    await Promise.allSettled([this.#subscriber.quit(), this.#publisher.quit()]);
  }
}

export interface CreateRedisClusterBusOptions {
  /** Redis connection URL, e.g. `redis://localhost:6379`. */
  url: string;
  nodeId?: NodeId;
  channel?: string;
  logger?: (event: string, detail: Record<string, unknown>) => void;
}

/**
 * Batteries-included factory: connects two ioredis clients (a publisher and a
 * duplicated subscriber) and returns a ready {@link RedisClusterBus}. `ioredis`
 * is imported dynamically so it stays an optional dependency for consumers that
 * only use the in-memory bus.
 */
export async function createRedisClusterBus(
  options: CreateRedisClusterBusOptions,
): Promise<RedisClusterBus> {
  let RedisCtor: new (url: string) => RedisBusClient;
  try {
    const mod = (await import("ioredis")) as unknown as {
      default: new (url: string) => RedisBusClient;
    };
    RedisCtor = mod.default;
  } catch (error) {
    throw new Error(
      `createRedisClusterBus requires the optional "ioredis" dependency to be installed: ${errMsg(error)}`,
    );
  }
  const publisher = new RedisCtor(options.url);
  // A subscriber connection cannot also PUBLISH, so use a second connection.
  const subscriber = new RedisCtor(options.url);
  const bus = new RedisClusterBus({
    publisher,
    subscriber,
    ...(options.nodeId !== undefined ? { nodeId: options.nodeId } : {}),
    ...(options.channel !== undefined ? { channel: options.channel } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
  await bus.ready;
  return bus;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
