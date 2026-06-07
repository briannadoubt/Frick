import { afterEach, describe, expect, it } from "vitest";
import {
  RedisClusterBus,
  createRedisClusterBus,
  type ClusterEnvelope,
  type RedisBusClient,
} from "../src/index.js";

// FR-27: production Redis-backed FrickClusterBus. The fake-client suite always
// runs and covers the bus logic (encode/decode, loop guard, tenant filter,
// fan-out). The ioredis integration suite runs only when FRICK_REDIS_URL points
// at a live Redis (e.g. `docker run -p 6380:6379 redis:7-alpine` →
// FRICK_REDIS_URL=redis://localhost:6380).

function streamEnvelope(originNodeId: string, tenantId: string): ClusterEnvelope {
  return {
    kind: "objectDeletes",
    originNodeId,
    tenantId,
    type: "Conversation",
    ids: ["c1"],
  };
}

// ---- In-memory fake Redis pub/sub (binary-safe) ----------------------------

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

function makeFakeBus(hub: FakeRedisHub, nodeId: string) {
  return new RedisClusterBus({
    publisher: new FakeRedisClient(hub),
    subscriber: new FakeRedisClient(hub),
    nodeId,
    channel: "frick:test",
  });
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("RedisClusterBus (fake client)", () => {
  let buses: RedisClusterBus[] = [];
  afterEach(async () => {
    await Promise.all(buses.map((b) => b.close()));
    buses = [];
  });

  it("fans an envelope from one node to another", async () => {
    const hub = new FakeRedisHub();
    const a = makeFakeBus(hub, "node-a");
    const b = makeFakeBus(hub, "node-b");
    buses = [a, b];
    await Promise.all([a.ready, b.ready]);

    const received: ClusterEnvelope[] = [];
    b.subscribe((e) => received.push(e));

    a.publish(streamEnvelope("node-a", "tenant-1"));
    await tick();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ kind: "objectDeletes", tenantId: "tenant-1", ids: ["c1"] });
  });

  it("drops a node's own publishes (loop guard)", async () => {
    const hub = new FakeRedisHub();
    const a = makeFakeBus(hub, "node-a");
    buses = [a];
    await a.ready;

    const received: ClusterEnvelope[] = [];
    a.subscribe((e) => received.push(e));
    a.publish(streamEnvelope("node-a", "tenant-1"));
    await tick();

    expect(received).toHaveLength(0);
  });

  it("drops envelopes for tenants this node does not serve", async () => {
    const hub = new FakeRedisHub();
    const a = makeFakeBus(hub, "node-a");
    const b = makeFakeBus(hub, "node-b");
    buses = [a, b];
    await Promise.all([a.ready, b.ready]);

    b.setSubscribedTenants(new Set(["tenant-keep"]));
    const received: ClusterEnvelope[] = [];
    b.subscribe((e) => received.push(e));

    a.publish(streamEnvelope("node-a", "tenant-drop"));
    a.publish(streamEnvelope("node-a", "tenant-keep"));
    await tick();

    expect(received.map((e) => e.tenantId)).toEqual(["tenant-keep"]);
  });
});

const REDIS_URL = process.env.FRICK_REDIS_URL;
const integration = REDIS_URL ? describe : describe.skip;

integration("RedisClusterBus (ioredis integration)", () => {
  let buses: RedisClusterBus[] = [];
  const channel = `frick:test:${process.pid}`;
  afterEach(async () => {
    await Promise.all(buses.map((b) => b.close()));
    buses = [];
  });

  it("fans envelopes across two real Redis connections, with loop guard", async () => {
    const a = await createRedisClusterBus({ url: REDIS_URL!, nodeId: "node-a", channel });
    const b = await createRedisClusterBus({ url: REDIS_URL!, nodeId: "node-b", channel });
    buses = [a, b];

    const onB: ClusterEnvelope[] = [];
    const onA: ClusterEnvelope[] = [];
    b.subscribe((e) => onB.push(e));
    a.subscribe((e) => onA.push(e));

    a.publish(streamEnvelope("node-a", "tenant-1"));
    // Real pub/sub has network latency; poll briefly.
    for (let i = 0; i < 40 && onB.length === 0; i++) await new Promise((r) => setTimeout(r, 25));

    expect(onB).toHaveLength(1);
    expect(onB[0]).toMatchObject({ tenantId: "tenant-1", ids: ["c1"] });
    expect(onA).toHaveLength(0); // loop guard: A never sees its own publish
  });
});
