# Multi-region bus federation

> Status: design + adapter seam (FR-105, first deliverable of the FR-20 multi-region epic).
> Write-region routing/conflict handling (FR-106) and region-aware failover + LB
> integration (FR-107) are explicit follow-ups — see [Follow-ups](#follow-ups).

## The problem: the bus is single-region today

[Horizontal scale](horizontal-scale.md) gave us node-to-node fan-out. A write
that lands on node A reaches a subscriber connected to node B because both nodes
share an intra-region [`FrickClusterBus`](../apps/server/src/cluster/bus.ts) —
`MemoryClusterBus` in tests/single-node, `RedisClusterBus` in production. Every
node in the cluster subscribes to one Redis pub/sub channel, and the per-node
`originNodeId` loop guard keeps a node from re-emitting its own publishes.

That contract assumes **one region**: every node shares one bus. The moment you
run nodes in two regions, each region gets its own Redis (you do not want
WebSocket fan-out latency gated on a cross-ocean Redis round-trip, and you do not
want a single regional Redis outage to take down both regions). Two regions = two
intra-region buses that don't know about each other:

| Path | Single region | Two regions, no federation | Two regions, federated (FR-105) |
|---|---|---|---|
| Write in `us-east`, subscriber in `us-east` | ✓ | ✓ | ✓ |
| Write in `us-east`, subscriber in `eu-west` | n/a | ✗ never arrives | ✓ |
| Presence / signals / projection + presence deltas | ✓ | ✗ region-local only | ✓ |

FR-105 closes the cross-region fan-out gap with a clean, testable seam. It does
**not** attempt durable cross-region replication, write ownership, or failover —
those are FR-106/FR-107.

## Topology options

We need messages produced in one region to reach subscribers in every other
region. Three shapes were considered.

### A. Hub-and-spoke
One designated hub region; every other region federates only to the hub, and the
hub re-broadcasts to the rest.

- **+** O(N) connections; one place to observe/meter cross-region traffic.
- **+** Trivial loop story (spokes never talk to each other).
- **−** The hub is a SPOF and a latency tax: `eu-west → us-east(hub) → ap-southeast`
  doubles the WAN hop for any two non-hub regions.
- **−** Hub failover is its own project (drifts into FR-107).

### B. Full mesh
Every region federates directly to every other region.

- **+** Minimum cross-region latency (one WAN hop, always).
- **+** No SPOF — losing a region degrades only that region's reachability.
- **−** O(N²) connections; only sane for a handful of regions (which is the
  realistic case — you have 2–5 regions, not 200).
- **−** Loop prevention is mandatory: without an origin tag a mesh cycles forever.

### C. Per-region primary (write-region routing)
Each tenant/object has a "home" region that owns its writes; other regions proxy
writes home and subscribe to the home region's stream.

- **+** Gives you a coherent ordering + conflict story for free.
- **−** That **is** FR-106. It is a routing/ownership model, not a fan-out
  transport, and pulling it into FR-105 would couple the transport seam to a
  consistency model we haven't designed yet.

### Choice
**Mesh transport for FR-105**, with the loop guard baked into the seam so the
*same* seam also supports hub-and-spoke (a hub is just a mesh where spokes only
peer with the hub). We pick mesh because the realistic region count is small and
mesh has no SPOF and the lowest latency. The seam does **not** encode topology —
it is "publish to peers / subscribe from peers" — so the wiring (who peers with
whom) is a deployment concern, and FR-106's per-region-primary model can layer on
top without changing the transport interface.

## Message flow, origin tagging, and loop prevention

The cluster bus already has a one-hop loop guard: every `ClusterEnvelope` carries
`originNodeId`, and a bus never delivers a node its own publish. Federation adds a
**second** guard one level up: every federated message carries `originRegionId`,
and a region's federation bus never delivers an envelope back to the region it
originated in.

```
                      region us-east                         region eu-west
   client─┐        ┌───────────────────┐                 ┌───────────────────┐
          │ write  │  node east-1      │   RegionEnvelope │  node west-1      │
          └───────▶│  FederatingClusterBus                │  FederatingClusterBus
                   │   │1. local.publish ─▶ east-2 (same region, via Redis)   │
                   │   │2. region.publish ────────────────▶ region.subscribe  │
                   │   └ {originRegionId: us-east, envelope}│   └▶ local.publish ─▶ west-1 subscribers
                   └───────────────────┘                 └───────────────────┘
```

1. A client write lands on `east-1`. The gateway calls `publish(envelope)` on what
   it thinks is an ordinary `FrickClusterBus`.
2. That bus is actually a [`FederatingClusterBus`](../apps/server/src/cluster/region-bus.ts).
   It (a) forwards to the **local** intra-region bus (unchanged node-to-node
   fan-out — `east-2` receives it via Redis), and (b) **only if the envelope
   originated on this node** (`originNodeId === local.nodeId`), wraps it as a
   `RegionEnvelope` stamped `originRegionId: "us-east"` and federates it.
3. `eu-west`'s region bus receives the `RegionEnvelope`. Its `originRegionId`
   (`us-east`) ≠ its own region id, so it is delivered. The `FederatingClusterBus`
   in `eu-west` **re-injects the inner envelope into its local cluster bus**, so it
   fans out to every node in `eu-west` exactly as a local write would.

Two properties fall out of this:

- **No cross-region loop.** `eu-west` never federates an envelope whose
  `originRegionId` is `us-east` back toward `us-east`, because (a) the region bus
  drops anything tagged with its own region, and (b) the re-injected envelope keeps
  its original `originNodeId`, which is **not** any `eu-west` node id, so the
  federation step in `eu-west` (which only federates *its own* nodes' publishes) is
  skipped. The envelope is federated exactly once, at its true origin.
- **No intra-region double-ship.** When `east-2` receives the federated... no:
  when `east-2` receives `east-1`'s write over the local Redis channel and the
  gateway re-publishes anything, the `originNodeId !== east-2.nodeId` check stops
  `east-2` from re-federating an envelope that `east-1` already federated. Only the
  originating node crosses the WAN, so a write fans out once per node, in every
  region.

## Ordering & consistency expectations

Federation inherits the cluster bus's contract and is **deliberately weak**:

- **Best-effort, at-most-once-per-region delivery.** Like `RedisClusterBus`,
  `publish` is fire-and-forget; a dropped WAN message is not retried by this layer.
  Clients already reconcile via per-stream cursors and re-sync on reconnect, so a
  missed realtime frame is a latency blip, not data loss — the database (which is
  the durability layer) is unaffected.
- **No cross-region total order.** Two regions writing "simultaneously" can deliver
  in different orders in different regions. Consumers tolerate out-of-order `Delta`
  frames today (per-stream cursors), so realtime ordering is best-effort and
  eventual.
- **Federation is not replication.** It carries *realtime fan-out*, not durable
  state. Durable cross-region convergence (and what happens when two regions accept
  conflicting writes) is **FR-106**, not this layer. Treat the federated stream as
  a hint that accelerates convergence, with the database as the source of truth.

This is the honest trade-off: we get cheap, additive, low-latency cross-region
realtime without committing to a global consistency model. The cost is that
"which region wins a conflict" is explicitly out of scope until FR-106.

## The seam shape

The federation seam mirrors `FrickClusterBus` exactly, one level up
(node↔node becomes region↔region):

```ts
interface FrickRegionBus {
  readonly regionId: RegionId;
  publish(envelope: RegionEnvelope): void;          // ship to peer regions
  subscribe(handler: RegionEnvelopeHandler): () => void; // receive from peers
  close(): Promise<void>;
}

interface RegionEnvelope {
  readonly originRegionId: RegionId;   // cross-region loop guard
  readonly envelope: ClusterEnvelope;  // the existing intra-region payload, unchanged
}
```

Key decisions:

- **Compose, don't replace.** `FederatingClusterBus implements FrickClusterBus` and
  wraps `{ local: FrickClusterBus, region: FrickRegionBus }`. The gateway keeps
  talking to one `FrickClusterBus` and is entirely unaware federation exists. The
  intra-region bus (`MemoryClusterBus` / `RedisClusterBus`) is reused verbatim.
- **`RegionEnvelope` wraps, doesn't fork, `ClusterEnvelope`.** The inner payload is
  byte-for-byte the existing union, so the receiving region hands it straight to
  `local.publish` with no translation, and adding a new envelope kind requires no
  federation changes.
- **Additive & backward-compatible.** A single-region server wires no
  `FrickRegionBus`, never constructs `FederatingClusterBus`, and behaves exactly as
  today. Wiring `MemoryRegionBus`/`MemoryRegionFabric` adds a deterministic,
  infra-free multi-region test harness — the federation analogue of
  `MemoryClusterBus`/`MemoryClusterChannel`.

### Implementations shipped in FR-105
- `MemoryRegionBus` + `MemoryRegionFabric` — in-memory federation harness wiring N
  region buses together; makes federation testable deterministically without real
  infra. The exact analogue of `MemoryClusterBus` + `MemoryClusterChannel`.
- `FederatingClusterBus` — the composition adapter that presents a `FrickClusterBus`
  to the gateway while federating across regions underneath.

A production WAN transport (cross-region Redis stream, NATS super-cluster, or Kafka
MirrorMaker) implements the same `FrickRegionBus` interface, the same way
`RedisClusterBus` implements `FrickClusterBus`. That adapter is intentionally **not**
part of FR-105 (no real cross-region infra in this deliverable).

## Follow-ups

- **FR-106 — write-region routing + conflict handling.** Defines which region owns a
  write, how cross-region writes are routed/proxied, and how conflicting concurrent
  writes converge. This is the "per-region primary" topology layered *on top of* the
  FR-105 transport. FR-105 deliberately stays a best-effort fan-out transport and
  takes no position on ownership.
- **FR-107 — region-aware failover + LB integration.** Health-checking regions,
  draining/promoting on regional outage, and the load-balancer/DNS glue that routes
  clients to a healthy region. The FR-105 seam is failover-friendly (regions attach
  and detach from the fabric/transport cleanly), but the orchestration is FR-107.
