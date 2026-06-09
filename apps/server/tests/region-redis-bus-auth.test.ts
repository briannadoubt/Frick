/**
 * FR-158 multi-region hardening — cross-region transport authentication
 * (finding multi-region-1) and malformed-frame validation (multi-region-4).
 *
 * The cross-region channel is a cross-tenant trust boundary: an inbound
 * RegionEnvelope is re-injected into the local cluster bus and fanned out to
 * WebSocket subscribers on the strength of its self-asserted tenantId. These
 * tests prove that, with a shared region secret configured:
 *
 *   - a genuine peer (same secret) is delivered (signed round-trip),
 *   - a forged frame on the channel (no/ wrong secret) is dropped before any
 *     handler runs — i.e. a rogue region / leaked Redis credential cannot
 *     inject ClusterEnvelopes for arbitrary tenants,
 *   - replayed and stale signed frames are dropped,
 *   - malformed-but-decodable payloads never reach a handler (multi-region-4),
 *   - with NO secret configured, behavior is unchanged (back-compat).
 */
import { afterEach, describe, expect, it } from "vitest";
import { encode } from "@msgpack/msgpack";
import {
  RedisRegionBus,
  type ClusterEnvelope,
  type RedisBusClient,
  type RegionEnvelope,
} from "../src/index.js";

function regionEnvelope(originRegionId: string, tenantId: string): RegionEnvelope {
  const inner: ClusterEnvelope = {
    kind: "objectDeletes",
    originNodeId: "node-x",
    tenantId,
    type: "Conversation",
    ids: ["c1"],
  };
  return { originRegionId, envelope: inner };
}

// ---- In-memory fake Redis pub/sub (binary-safe) ----------------------------
// A tiny binary-safe pub/sub broker. The hub also lets a test inject ARBITRARY
// raw bytes onto the channel, simulating a rogue publisher with channel access.

class FakeRedisHub {
  readonly subscribers = new Set<(channel: Buffer, message: Buffer) => void>();
  channels = new Map<(c: Buffer, m: Buffer) => void, string>();

  publish(channel: string, message: Buffer): void {
    for (const sub of this.subscribers) {
      if (this.channels.get(sub) === channel) {
        queueMicrotask(() => sub(Buffer.from(channel), Buffer.from(message)));
      }
    }
  }
}

class FakeRedisClient implements RedisBusClient {
  #listener: ((channel: Buffer, message: Buffer) => void) | undefined;
  constructor(private readonly hub: FakeRedisHub) {}
  publish(channel: string, message: Buffer): Promise<number> {
    this.hub.publish(channel, message);
    return Promise.resolve(1);
  }
  subscribe(channel: string): Promise<void> {
    if (this.#listener) {
      this.hub.subscribers.add(this.#listener);
      this.hub.channels.set(this.#listener, channel);
    }
    return Promise.resolve();
  }
  on(_event: "messageBuffer", listener: (channel: Buffer, message: Buffer) => void): this {
    this.#listener = listener;
    return this;
  }
  quit(): Promise<void> {
    if (this.#listener) this.hub.subscribers.delete(this.#listener);
    return Promise.resolve();
  }
}

const CHANNEL = "frick:region:test:auth";

function makeBus(
  hub: FakeRedisHub,
  regionId: string,
  opts: { secret?: string; replayWindowMs?: number } = {},
) {
  return new RedisRegionBus({
    publisher: new FakeRedisClient(hub),
    subscriber: new FakeRedisClient(hub),
    regionId,
    channel: CHANNEL,
    ...(opts.secret !== undefined ? { regionSecret: opts.secret } : {}),
    ...(opts.replayWindowMs !== undefined ? { replayWindowMs: opts.replayWindowMs } : {}),
  });
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("RedisRegionBus cross-region authentication (multi-region-1)", () => {
  let buses: RedisRegionBus[] = [];
  afterEach(async () => {
    await Promise.all(buses.map((b) => b.close()));
    buses = [];
  });

  it("delivers a signed frame between regions sharing the same secret", async () => {
    const hub = new FakeRedisHub();
    const a = makeBus(hub, "us-east", { secret: "s3cr3t" });
    const b = makeBus(hub, "eu-west", { secret: "s3cr3t" });
    buses = [a, b];
    await Promise.all([a.ready, b.ready]);

    const received: RegionEnvelope[] = [];
    b.subscribe((e) => received.push(e));

    a.publish(regionEnvelope("us-east", "tenant-1"));
    await tick();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(regionEnvelope("us-east", "tenant-1"));
  });

  it("DROPS a forged frame from a publisher with the WRONG secret (rogue region)", async () => {
    const hub = new FakeRedisHub();
    const victim = makeBus(hub, "eu-west", { secret: "real-secret" });
    const attacker = makeBus(hub, "rogue", { secret: "attacker-secret" });
    buses = [victim, attacker];
    await Promise.all([victim.ready, attacker.ready]);

    const received: RegionEnvelope[] = [];
    victim.subscribe((e) => received.push(e));

    // Attacker tries to inject an objectDeletes for an arbitrary tenant.
    attacker.publish(regionEnvelope("rogue", "victim-tenant"));
    await tick();

    expect(received).toHaveLength(0); // tenant isolation survives federation.
  });

  it("DROPS an UNSIGNED frame injected directly onto the channel when a secret is set", async () => {
    const hub = new FakeRedisHub();
    const victim = makeBus(hub, "eu-west", { secret: "real-secret" });
    buses = [victim];
    await victim.ready;

    const received: RegionEnvelope[] = [];
    victim.subscribe((e) => received.push(e));

    // Rogue publisher with channel access but no knowledge of the signing
    // scheme: a bare encoded RegionEnvelope (what the legacy wire looked like).
    const rogue = new FakeRedisClient(hub);
    void rogue.publish(CHANNEL, Buffer.from(encode(regionEnvelope("rogue", "victim-tenant"))));
    await tick();

    expect(received).toHaveLength(0);
  });

  it("DROPS a replayed signed frame (same nonce twice)", async () => {
    const hub = new FakeRedisHub();
    const a = makeBus(hub, "us-east", { secret: "s3cr3t" });
    const b = makeBus(hub, "eu-west", { secret: "s3cr3t" });
    buses = [a, b];
    await Promise.all([a.ready, b.ready]);

    const received: RegionEnvelope[] = [];
    b.subscribe((e) => received.push(e));

    // Capture the exact signed bytes A puts on the wire, then replay them.
    let capturedFrame: Buffer | undefined;
    const tap = new FakeRedisClient(hub);
    tap.on("messageBuffer", (_c, m) => {
      capturedFrame = Buffer.from(m);
    });
    await tap.subscribe(CHANNEL);

    a.publish(regionEnvelope("us-east", "tenant-replay"));
    await tick();
    expect(received).toHaveLength(1);
    expect(capturedFrame).toBeDefined();

    // Replay the identical signed bytes — must be rejected by the nonce cache.
    hub.publish(CHANNEL, capturedFrame!);
    await tick();
    expect(received).toHaveLength(1);
  });

  it("DROPS a signed frame whose timestamp is outside the replay window (stale)", async () => {
    const hub = new FakeRedisHub();
    // Capture a genuine, correctly-signed frame from a sender on a separate
    // hub so no live receiver consumes its nonce. We then deliver that exact
    // frame to a fresh receiver with a 1ms replay window after sleeping past
    // it — isolating the staleness check from the nonce-replay check.
    const captureHub = new FakeRedisHub();
    const sender = makeBus(captureHub, "us-east", { secret: "s3cr3t" });
    buses = [sender];
    await sender.ready;

    let frame: Buffer | undefined;
    const tap = new FakeRedisClient(captureHub);
    tap.on("messageBuffer", (_c, m) => {
      frame = Buffer.from(m);
    });
    await tap.subscribe(CHANNEL);
    sender.publish(regionEnvelope("us-east", "tenant-stale"));
    await tick();
    expect(frame).toBeDefined();

    // Fresh receiver on a different hub: never saw this nonce, 1ms window.
    const receiver = makeBus(hub, "eu-west", { secret: "s3cr3t", replayWindowMs: 1 });
    buses.push(receiver);
    await receiver.ready;
    const received: RegionEnvelope[] = [];
    receiver.subscribe((e) => received.push(e));

    await new Promise((r) => setTimeout(r, 20)); // age the frame past the window
    hub.publish(CHANNEL, frame!);
    await tick();
    expect(received).toHaveLength(0);
  });
});

describe("RedisRegionBus malformed-frame validation (multi-region-4)", () => {
  let buses: RedisRegionBus[] = [];
  afterEach(async () => {
    await Promise.all(buses.map((b) => b.close()));
    buses = [];
  });

  it("DROPS a decodable-but-malformed payload (no secret) instead of re-injecting null/garbage", async () => {
    const hub = new FakeRedisHub();
    const b = makeBus(hub, "eu-west"); // no secret (legacy mode)
    buses = [b];
    await b.ready;

    const received: RegionEnvelope[] = [];
    b.subscribe((e) => received.push(e));

    const rogue = new FakeRedisClient(hub);
    // Each of these decodes fine but is NOT a well-formed RegionEnvelope.
    void rogue.publish(CHANNEL, Buffer.from(encode({ foo: "bar" })));
    void rogue.publish(CHANNEL, Buffer.from(encode("hello")));
    void rogue.publish(CHANNEL, Buffer.from(encode(null)));
    void rogue.publish(CHANNEL, Buffer.from(encode({ originRegionId: "x" }))); // no inner envelope
    void rogue.publish(CHANNEL, Buffer.from(encode({ originRegionId: "x", envelope: {} }))); // no kind
    await tick();

    expect(received).toHaveLength(0);
  });

  it("still delivers a well-formed envelope alongside malformed ones (no secret)", async () => {
    const hub = new FakeRedisHub();
    const a = makeBus(hub, "us-east");
    const b = makeBus(hub, "eu-west");
    buses = [a, b];
    await Promise.all([a.ready, b.ready]);

    const received: RegionEnvelope[] = [];
    b.subscribe((e) => received.push(e));

    const rogue = new FakeRedisClient(hub);
    void rogue.publish(CHANNEL, Buffer.from(encode({ foo: "bar" })));
    a.publish(regionEnvelope("us-east", "tenant-ok"));
    await tick();

    expect(received).toHaveLength(1);
    expect(received[0]?.envelope.tenantId).toBe("tenant-ok");
  });
});

describe("RedisRegionBus back-compat: no secret = unchanged wire", () => {
  let buses: RedisRegionBus[] = [];
  afterEach(async () => {
    await Promise.all(buses.map((b) => b.close()));
    buses = [];
  });

  it("federates a plain (unsigned) envelope between two no-secret buses", async () => {
    const hub = new FakeRedisHub();
    const a = makeBus(hub, "us-east");
    const b = makeBus(hub, "eu-west");
    buses = [a, b];
    await Promise.all([a.ready, b.ready]);

    const received: RegionEnvelope[] = [];
    b.subscribe((e) => received.push(e));

    a.publish(regionEnvelope("us-east", "tenant-1"));
    await tick();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(regionEnvelope("us-east", "tenant-1"));
  });
});
