/**
 * Production Redis-backed {@link FrickRegionBus} (FR-157) — the real WAN
 * cross-region transport deferred by FR-105.
 *
 * FR-105 shipped the cross-region federation SEAM ({@link FrickRegionBus})
 * with an in-memory {@link MemoryRegionBus} for tests and explicitly left the
 * production WAN transport for later: "A production WAN transport (cross-region
 * Redis stream, NATS super-cluster, or Kafka MirrorMaker) implements the same
 * `FrickRegionBus` interface, the same way `RedisClusterBus` implements
 * `FrickClusterBus`." This is that transport.
 *
 * It mirrors {@link RedisClusterBus} exactly, one level up
 * (node↔node → region↔region): it fans {@link RegionEnvelope}s across regions
 * over a single cross-region Redis pub/sub channel.
 *   - every publish carries this region's `originRegionId`; inbound envelopes
 *     from our own region are dropped (the cross-region loop guard, the regional
 *     analogue of `RedisClusterBus`'s per-node `originNodeId` drop),
 *   - envelopes are msgpack-encoded (not JSON) so binary values inside packed
 *     stream-event fields survive the round-trip,
 *   - two connections are used because a Redis connection in subscribe mode
 *     cannot also issue PUBLISH: a dedicated `subscriber` plus a `publisher`.
 *
 * The adapter is decoupled from any specific client via the SAME
 * {@link RedisBusClient} surface the intra-region bus uses (ioredis satisfies
 * it), so operators wire the identical client type. Use
 * {@link createRedisRegionBus} for the batteries-included ioredis wiring.
 *
 * Additive + backward-compatible: single-region and memory-fabric deployments
 * are unchanged — they never construct this. It plugs into
 * {@link FederatingClusterBus} exactly where {@link MemoryRegionBus} does.
 */
import { decode, encode } from "@msgpack/msgpack";
import type { RedisBusClient } from "./redis-bus.js";
import {
  randomRegionId,
  type FrickRegionBus,
  type RegionEnvelope,
  type RegionEnvelopeHandler,
  type RegionId,
} from "./region-bus.js";

export interface RedisRegionBusOptions {
  /** Connection used to PUBLISH. */
  publisher: RedisBusClient;
  /** Dedicated connection placed into subscribe mode. Must NOT be shared with `publisher`. */
  subscriber: RedisBusClient;
  /** Stable region id; defaults to a random one. */
  regionId?: RegionId;
  /** Cross-region pub/sub channel name. Defaults to `frick:region`. */
  channel?: string;
  /** Structured logger for best-effort failures (publish/decode/handler). */
  logger?: (event: string, detail: Record<string, unknown>) => void;
}

const DEFAULT_CHANNEL = "frick:region";

export class RedisRegionBus implements FrickRegionBus {
  readonly regionId: RegionId;
  /** Resolves once the subscriber has SUBSCRIBEd and is receiving messages. */
  readonly ready: Promise<void>;

  readonly #publisher: RedisBusClient;
  readonly #subscriber: RedisBusClient;
  readonly #channel: string;
  readonly #handlers = new Set<RegionEnvelopeHandler>();
  readonly #log: (event: string, detail: Record<string, unknown>) => void;
  #closed = false;

  constructor(options: RedisRegionBusOptions) {
    this.regionId = options.regionId ?? randomRegionId();
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
        this.#log("frick.region.redis.subscribe_failed", { error: errMsg(error) });
      });
  }

  #onMessage(channel: Buffer, message: Buffer): void {
    if (channel.toString("utf8") !== this.#channel) return;
    let envelope: RegionEnvelope;
    try {
      envelope = decode(message) as RegionEnvelope;
    } catch (error) {
      this.#log("frick.region.redis.decode_failed", { error: errMsg(error) });
      return;
    }
    // Cross-region loop guard: never re-deliver an envelope that originated
    // in our own region (the regional analogue of RedisClusterBus's per-node
    // originNodeId drop).
    if (envelope.originRegionId === this.regionId) return;
    for (const handler of this.#handlers) {
      try {
        handler(envelope);
      } catch (error) {
        // Isolate per-handler failures so one buggy subscriber can't break
        // peer-region fan-out for the rest.
        this.#log("frick.region.redis.handler_threw", { error: errMsg(error) });
      }
    }
  }

  publish(envelope: RegionEnvelope): void {
    if (this.#closed) return;
    let payload: Buffer;
    try {
      payload = Buffer.from(encode(envelope));
    } catch (error) {
      this.#log("frick.region.redis.encode_failed", { error: errMsg(error) });
      return;
    }
    // Best-effort: failures are logged, not thrown (per the FrickRegionBus
    // contract — publish is fire-and-forget).
    void Promise.resolve(this.#publisher.publish(this.#channel, payload)).catch((error) => {
      this.#log("frick.region.redis.publish_failed", { error: errMsg(error) });
    });
  }

  subscribe(handler: RegionEnvelopeHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#handlers.clear();
    await Promise.allSettled([this.#subscriber.quit(), this.#publisher.quit()]);
  }
}

export interface CreateRedisRegionBusOptions {
  /** Redis connection URL, e.g. `redis://localhost:6379`. */
  url: string;
  regionId?: RegionId;
  channel?: string;
  logger?: (event: string, detail: Record<string, unknown>) => void;
}

/**
 * Batteries-included factory: connects two ioredis clients (a publisher and a
 * duplicated subscriber) and returns a ready {@link RedisRegionBus}. `ioredis`
 * is imported dynamically so it stays an optional dependency for consumers that
 * only use the in-memory region fabric.
 */
export async function createRedisRegionBus(
  options: CreateRedisRegionBusOptions,
): Promise<RedisRegionBus> {
  let RedisCtor: new (url: string) => RedisBusClient;
  try {
    const mod = (await import("ioredis")) as unknown as {
      default: new (url: string) => RedisBusClient;
    };
    RedisCtor = mod.default;
  } catch (error) {
    throw new Error(
      `createRedisRegionBus requires the optional "ioredis" dependency to be installed: ${errMsg(error)}`,
    );
  }
  const publisher = new RedisCtor(options.url);
  // A subscriber connection cannot also PUBLISH, so use a second connection.
  const subscriber = new RedisCtor(options.url);
  const bus = new RedisRegionBus({
    publisher,
    subscriber,
    ...(options.regionId !== undefined ? { regionId: options.regionId } : {}),
    ...(options.channel !== undefined ? { channel: options.channel } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
  await bus.ready;
  return bus;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
