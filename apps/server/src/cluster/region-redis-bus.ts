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
 *
 * ## Cross-region trust boundary (FR-158 hardening — finding multi-region-1)
 *
 * The cross-region pub/sub channel is a **cross-tenant trust boundary**: every
 * inbound {@link RegionEnvelope} is re-injected into the local cluster bus and
 * fanned out to WebSocket subscribers on the strength of its self-asserted
 * `tenantId` alone. Anyone able to PUBLISH to the channel (a compromised peer
 * region, a leaked/shared Redis credential, a misconfigured network) could
 * therefore forge stream events, object deletes, presence, and signals for
 * ANY tenant in EVERY subscribing region — defeating tenant isolation across
 * the WAN.
 *
 * To close that, this bus authenticates the transport **at the application
 * layer**: when a {@link RedisRegionBusOptions.regionSecret per-deployment
 * shared secret} is configured, every outbound frame is wrapped in a signed
 * envelope carrying an HMAC-SHA256 over the encoded {@link RegionEnvelope}
 * bytes plus a per-frame nonce and a timestamp for replay resistance. Inbound
 * frames are verified (timing-safe) BEFORE any handler dispatch; frames that
 * fail the MAC, are stale, or replay a recently-seen nonce are dropped + logged.
 *
 * This is **defense in depth, not a substitute** for a mutually-authenticated
 * transport: the region channel SHOULD still run over mTLS / a dedicated
 * private network / per-region ACLs even with the HMAC. See
 * `docs/multi-region.md` → "Cross-region trust boundary".
 *
 * Backward-compatible: with no `regionSecret`, behavior is unchanged — frames
 * are the bare encoded `RegionEnvelope` as before, and single-region /
 * memory-fabric deployments (which never construct this) are unaffected.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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
  /**
   * Per-deployment shared secret for application-layer authentication of the
   * cross-region channel (finding multi-region-1). When set, every outbound
   * frame is HMAC-SHA256 signed (over the encoded {@link RegionEnvelope} plus
   * a per-frame nonce + timestamp), and inbound frames are verified BEFORE any
   * handler dispatch — unsigned, forged, stale, or replayed frames are dropped.
   *
   * MUST be identical across every region in the deployment. Omit it (the
   * default) to preserve the legacy unauthenticated behavior — only safe on a
   * fully-trusted, single-tenant-domain transport. SHOULD be combined with a
   * mutually-authenticated transport (mTLS / private network) regardless.
   */
  regionSecret?: string | Buffer;
  /**
   * Replay window in ms: a signed frame whose timestamp is older than this (or
   * more than this far in the future, allowing for clock skew) is rejected.
   * Also bounds how long seen nonces are remembered. Defaults to 5 minutes.
   * Ignored when no `regionSecret` is configured.
   */
  replayWindowMs?: number;
  /** Structured logger for best-effort failures (publish/decode/handler). */
  logger?: (event: string, detail: Record<string, unknown>) => void;
}

const DEFAULT_CHANNEL = "frick:region";
/** Default replay window for signed frames: 5 minutes. */
const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000;
/** Wire version for the signed-frame envelope. */
const SIGNED_FRAME_VERSION = 1;

/**
 * The on-wire shape of an authenticated frame. The inner {@link RegionEnvelope}
 * is kept as opaque pre-encoded bytes (`payload`) so the MAC covers the exact
 * bytes the peer will decode — there is no ambiguity from re-encoding.
 */
interface SignedRegionFrame {
  /** Wire version; rejects frames from an incompatible signing scheme. */
  readonly v: number;
  /** Unix-ms timestamp the frame was signed (replay freshness). */
  readonly ts: number;
  /** Per-frame random nonce (replay de-duplication). */
  readonly nonce: Uint8Array;
  /** msgpack-encoded {@link RegionEnvelope} bytes — what the MAC covers. */
  readonly payload: Uint8Array;
  /** HMAC-SHA256(secret, v || ts || nonce || payload). */
  readonly mac: Uint8Array;
}

export class RedisRegionBus implements FrickRegionBus {
  readonly regionId: RegionId;
  /** Resolves once the subscriber has SUBSCRIBEd and is receiving messages. */
  readonly ready: Promise<void>;

  readonly #publisher: RedisBusClient;
  readonly #subscriber: RedisBusClient;
  readonly #channel: string;
  readonly #handlers = new Set<RegionEnvelopeHandler>();
  readonly #log: (event: string, detail: Record<string, unknown>) => void;
  /** Shared secret for frame authentication, or undefined for legacy mode. */
  readonly #secret: Buffer | undefined;
  readonly #replayWindowMs: number;
  /** Recently-seen frame nonces → first-seen timestamp, for replay drop. */
  readonly #seenNonces = new Map<string, number>();
  #closed = false;

  constructor(options: RedisRegionBusOptions) {
    this.regionId = options.regionId ?? randomRegionId();
    this.#publisher = options.publisher;
    this.#subscriber = options.subscriber;
    this.#channel = options.channel ?? DEFAULT_CHANNEL;
    this.#log = options.logger ?? (() => {});
    this.#secret =
      options.regionSecret === undefined || options.regionSecret === ""
        ? undefined
        : Buffer.isBuffer(options.regionSecret)
          ? options.regionSecret
          : Buffer.from(options.regionSecret, "utf8");
    this.#replayWindowMs = options.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;

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
    let raw: unknown;
    try {
      raw = decode(message);
    } catch (error) {
      this.#log("frick.region.redis.decode_failed", { error: errMsg(error) });
      return;
    }

    // Application-layer authentication (finding multi-region-1). When a region
    // secret is configured, only verified frames are trusted; everything else
    // is dropped before it can reach a handler.
    let envelopeBytes: Uint8Array | undefined;
    if (this.#secret) {
      envelopeBytes = this.#verifySignedFrame(raw);
      if (!envelopeBytes) return; // dropped + logged inside the verifier.
    } else if (isSignedFrame(raw)) {
      // A peer is signing but we are not — refuse to silently downgrade.
      this.#log("frick.region.redis.unexpected_signed_frame", {});
      return;
    } else {
      try {
        envelopeBytes = encode(raw);
      } catch (error) {
        this.#log("frick.region.redis.decode_failed", { error: errMsg(error) });
        return;
      }
    }

    let envelope: unknown;
    try {
      envelope = decode(envelopeBytes);
    } catch (error) {
      this.#log("frick.region.redis.decode_failed", { error: errMsg(error) });
      return;
    }

    // Shape validation (finding multi-region-4): a malformed-but-decodable
    // payload must NOT slip past the loop guard and be re-injected as a
    // null/garbage envelope. Require a well-formed RegionEnvelope before trust.
    if (!isWellFormedRegionEnvelope(envelope)) {
      this.#log("frick.region.redis.malformed_envelope", {});
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

  /**
   * Verify a signed frame and return the inner encoded {@link RegionEnvelope}
   * bytes, or `undefined` (and log) if it fails authentication, freshness, or
   * replay checks. Only called when a region secret is configured.
   */
  #verifySignedFrame(raw: unknown): Uint8Array | undefined {
    if (!isSignedFrame(raw)) {
      this.#log("frick.region.redis.unsigned_frame", {});
      return undefined;
    }
    if (raw.v !== SIGNED_FRAME_VERSION) {
      this.#log("frick.region.redis.bad_frame_version", { version: raw.v });
      return undefined;
    }
    const expected = this.#computeMac(raw.v, raw.ts, raw.nonce, raw.payload);
    const actual = Buffer.from(raw.mac);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      this.#log("frick.region.redis.bad_mac", {});
      return undefined;
    }
    // Replay resistance: reject stale/future timestamps and de-dupe nonces.
    const now = Date.now();
    if (Math.abs(now - raw.ts) > this.#replayWindowMs) {
      this.#log("frick.region.redis.stale_frame", { skewMs: now - raw.ts });
      return undefined;
    }
    const nonceKey = Buffer.from(raw.nonce).toString("base64");
    this.#pruneNonces(now);
    if (this.#seenNonces.has(nonceKey)) {
      this.#log("frick.region.redis.replayed_frame", {});
      return undefined;
    }
    this.#seenNonces.set(nonceKey, now);
    return raw.payload;
  }

  #computeMac(v: number, ts: number, nonce: Uint8Array, payload: Uint8Array): Buffer {
    const header = Buffer.alloc(12);
    header.writeUInt32BE(v >>> 0, 0);
    // 53-bit-safe big-endian ms timestamp split across two 32-bit words.
    header.writeUInt32BE(Math.floor(ts / 0x1_0000_0000), 4);
    header.writeUInt32BE(ts >>> 0, 8);
    return createHmac("sha256", this.#secret!)
      .update(header)
      .update(nonce)
      .update(payload)
      .digest();
  }

  #pruneNonces(now: number): void {
    if (this.#seenNonces.size === 0) return;
    for (const [key, seenAt] of this.#seenNonces) {
      if (now - seenAt > this.#replayWindowMs) this.#seenNonces.delete(key);
    }
  }

  publish(envelope: RegionEnvelope): void {
    if (this.#closed) return;
    let frame: Buffer;
    try {
      const payload = encode(envelope);
      if (this.#secret) {
        const ts = Date.now();
        const nonce = randomBytes(16);
        const mac = this.#computeMac(SIGNED_FRAME_VERSION, ts, nonce, payload);
        const signed: SignedRegionFrame = { v: SIGNED_FRAME_VERSION, ts, nonce, payload, mac };
        frame = Buffer.from(encode(signed));
      } else {
        frame = Buffer.from(payload);
      }
    } catch (error) {
      this.#log("frick.region.redis.encode_failed", { error: errMsg(error) });
      return;
    }
    // Best-effort: failures are logged, not thrown (per the FrickRegionBus
    // contract — publish is fire-and-forget).
    void Promise.resolve(this.#publisher.publish(this.#channel, frame)).catch((error) => {
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
  /**
   * Per-deployment shared secret authenticating the cross-region channel
   * (finding multi-region-1). See {@link RedisRegionBusOptions.regionSecret}.
   * Strongly recommended for any genuinely multi-region / federated deployment.
   */
  regionSecret?: string | Buffer;
  /** Replay window in ms for signed frames. See {@link RedisRegionBusOptions.replayWindowMs}. */
  replayWindowMs?: number;
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
    ...(options.regionSecret !== undefined ? { regionSecret: options.regionSecret } : {}),
    ...(options.replayWindowMs !== undefined ? { replayWindowMs: options.replayWindowMs } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
  await bus.ready;
  return bus;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True if `value` has the structural shape of a {@link SignedRegionFrame}. */
function isSignedFrame(value: unknown): value is SignedRegionFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    typeof frame.v === "number" &&
    typeof frame.ts === "number" &&
    frame.nonce instanceof Uint8Array &&
    frame.payload instanceof Uint8Array &&
    frame.mac instanceof Uint8Array
  );
}

/**
 * Validate a decoded value is a well-formed {@link RegionEnvelope} before it is
 * trusted (finding multi-region-4): a non-null object with a string
 * `originRegionId` and a non-null `envelope` object carrying a string `kind`.
 * Mirrors the implicit rigor `RedisClusterBus` relies on for its own dispatch.
 */
function isWellFormedRegionEnvelope(value: unknown): value is RegionEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.originRegionId !== "string" || candidate.originRegionId === "") return false;
  const inner = candidate.envelope;
  if (typeof inner !== "object" || inner === null) return false;
  return typeof (inner as Record<string, unknown>).kind === "string";
}
