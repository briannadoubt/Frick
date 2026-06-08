import { afterEach, describe, expect, it } from "vitest";
import {
  RedisRegionBus,
  createRedisRegionBus,
  type ClusterEnvelope,
  type RedisBusClient,
  type RegionEnvelope,
} from "../src/index.js";

// FR-157: production Redis-backed FrickRegionBus — the real WAN cross-region
// transport deferred by FR-105. The fake-client suite always runs and covers
// the bus logic (encode/decode round-trip, cross-region loop guard, fan-out,
// close unsubscribes). The ioredis integration suite runs only when
// FRICK_REDIS_URL points at a live Redis (e.g.
// `docker run -p 6380:6379 redis:7-alpine` →
// FRICK_REDIS_URL=redis://localhost:6380).

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
// Mirrors the fake from redis-cluster-bus.test.ts: a tiny binary-safe pub/sub
// broker so the bus logic is exercised deterministically without real infra.

class FakeRedisHub {
  readonly subscribers = new Set<(channel: Buffer, message: Buffer) => void>();
  channels = new Map<(c: Buffer, m: Buffer) => void, string>();

  publish(channel: string, message: Buffer): void {
    for (const sub of this.subscribers) {
      if (this.channels.get(sub) === channel) {
        // Deliver asynchronously like a real broker.
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

function makeFakeBus(hub: FakeRedisHub, regionId: string) {
  return new RedisRegionBus({
    publisher: new FakeRedisClient(hub),
    subscriber: new FakeRedisClient(hub),
    regionId,
    channel: "frick:region:test",
  });
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("RedisRegionBus (fake client)", () => {
  let buses: RedisRegionBus[] = [];
  afterEach(async () => {
    await Promise.all(buses.map((b) => b.close()));
    buses = [];
  });

  it("federates an envelope from region A to a subscriber in region B", async () => {
    const hub = new FakeRedisHub();
    const a = makeFakeBus(hub, "us-east");
    const b = makeFakeBus(hub, "eu-west");
    buses = [a, b];
    await Promise.all([a.ready, b.ready]);

    const received: RegionEnvelope[] = [];
    b.subscribe((e) => received.push(e));

    a.publish(regionEnvelope("us-east", "tenant-1"));
    await tick();

    expect(received).toHaveLength(1);
    expect(received[0]?.originRegionId).toBe("us-east");
    expect(received[0]?.envelope).toMatchObject({
      kind: "objectDeletes",
      tenantId: "tenant-1",
      ids: ["c1"],
    });
  });

  it("drops envelopes that originated in the receiver's own region (loop guard)", async () => {
    const hub = new FakeRedisHub();
    const a = makeFakeBus(hub, "us-east");
    buses = [a];
    await a.ready;

    const received: RegionEnvelope[] = [];
    a.subscribe((e) => received.push(e));
    a.publish(regionEnvelope("us-east", "tenant-1"));
    await tick();

    expect(received).toHaveLength(0);
  });

  it("round-trips a RegionEnvelope through encode/decode", async () => {
    const hub = new FakeRedisHub();
    const a = makeFakeBus(hub, "us-east");
    const b = makeFakeBus(hub, "eu-west");
    buses = [a, b];
    await Promise.all([a.ready, b.ready]);

    const received: RegionEnvelope[] = [];
    b.subscribe((e) => received.push(e));

    const sent = regionEnvelope("us-east", "tenant-rt");
    a.publish(sent);
    await tick();

    expect(received).toHaveLength(1);
    // Byte-for-byte structural equality survived the msgpack round-trip.
    expect(received[0]).toEqual(sent);
  });

  it("close() unsubscribes so no further envelopes are delivered", async () => {
    const hub = new FakeRedisHub();
    const a = makeFakeBus(hub, "us-east");
    const b = makeFakeBus(hub, "eu-west");
    buses = [a];
    await Promise.all([a.ready, b.ready]);

    const received: RegionEnvelope[] = [];
    b.subscribe((e) => received.push(e));

    // Two buses are attached (a + b); closing b must remove exactly b's
    // subscriber connection from the broker, leaving a's intact.
    expect(hub.subscribers.size).toBe(2);
    await b.close();
    expect(hub.subscribers.size).toBe(1);

    a.publish(regionEnvelope("us-east", "tenant-1"));
    await tick();

    expect(received).toHaveLength(0);
  });
});

const REDIS_URL = process.env.FRICK_REDIS_URL;
const integration = REDIS_URL ? describe : describe.skip;

integration("RedisRegionBus (ioredis integration)", () => {
  let buses: RedisRegionBus[] = [];
  const channel = `frick:region:test:${process.pid}`;
  afterEach(async () => {
    await Promise.all(buses.map((b) => b.close()));
    buses = [];
  });

  it("federates an envelope A→B across two real Redis connections, with loop guard", async () => {
    const a = await createRedisRegionBus({ url: REDIS_URL!, regionId: "us-east", channel });
    const b = await createRedisRegionBus({ url: REDIS_URL!, regionId: "eu-west", channel });
    buses = [a, b];

    const onB: RegionEnvelope[] = [];
    const onA: RegionEnvelope[] = [];
    b.subscribe((e) => onB.push(e));
    a.subscribe((e) => onA.push(e));

    a.publish(regionEnvelope("us-east", "tenant-1"));
    // Real pub/sub has network latency; poll briefly.
    for (let i = 0; i < 40 && onB.length === 0; i++) await new Promise((r) => setTimeout(r, 25));

    expect(onB).toHaveLength(1);
    expect(onB[0]?.originRegionId).toBe("us-east");
    expect(onB[0]?.envelope).toMatchObject({ tenantId: "tenant-1", ids: ["c1"] });
    expect(onA).toHaveLength(0); // loop guard: A never sees its own publish
  });
});
