# Multi-region bus federation

> Status: FR-105 (federation seam) **+** FR-106 (write-region routing + conflict
> handling) **+** FR-107 (region-aware failover + LB integration) **delivered** —
> the FR-20 multi-region epic's routing/failover layer is in place.
> FR-105 shipped the cross-region fan-out transport; FR-106 layered the
> per-region-primary ownership/routing model on top; FR-107 added health-aware
> failover + the [operations runbook](multi-region-operations.md). See
> [Write-region routing (FR-106)](#write-region-routing--conflict-handling-fr-106)
> and [Failover (FR-107)](#region-aware-failover-fr-107).

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

## Write-region routing + conflict handling (FR-106)

FR-105 carries realtime fan-out across regions but takes **no position on
ownership**: two regions can accept writes to the same key "simultaneously" and the
federated streams can interleave differently per region. That is fine for realtime
*hints* (consumers reconcile via per-stream cursors) but it is not a conflict story.

FR-106 supplies the conflict story by adopting **topology option C — per-region
primary (write-region routing)** from [Topology options](#c-per-region-primary-write-region-routing):
every write key has exactly one **home region** that owns its writes.

### Ownership model: per-region primary, tenant-home

- **Granularity.** Home is assigned **per tenant** (`tenantId → homeRegionId`).
  Tenant-home is the simplest correct default and matches how the rest of the stack
  is already tenant-partitioned (object/stream/presence/signal stores are all
  tenant-scoped). `writeKeyForTenant(tenantId)` centralizes how a routing key is
  derived, so a future tenant+object granularity is a one-line change — but the
  conflict guarantee only needs *a* single home per key, not finer keys.
- **Assignment.** Two strategies behind one `RegionOwnershipResolver` interface
  ([`region-router.ts`](../apps/server/src/cluster/region-router.ts)):
  - **`StaticRegionOwnership`** (recommended default) — a config map
    `tenantId → homeRegionId` plus a `defaultHomeRegionId` fallback. Ownership is a
    deployment decision (place a tenant's home near its users); zero coordination,
    trivially correct.
  - **`ClaimRegionOwnership`** (opt-in, dynamic) — claim-based assignment over a
    region control channel, **mirroring FR-154's `ClusterMediaPlacement`** one level
    up (region instead of node): the first region to route a write for an unowned
    tenant **claims** home and announces it; concurrent claims converge by a
    deterministic **lowest-`regionId`-wins** tie-break (total + symmetric, exactly
    like FR-154's lowest-`nodeId` rule); a **TTL** backstops a missed release so a
    crashed home self-heals.

### Routing

`RegionWriteRouter.routeWrite(tenantId)` resolves the home and returns either:

- **`{ kind: "local" }`** — this region *is* the home → apply the write here (the
  authoritative serialization point) and federate it outward via FR-105 as today; or
- **`{ kind: "proxy", homeRegionId }`** — this region is *not* the home → forward the
  write to the home region, which applies it; the authoritative stream then flows
  back to every region via FR-105 federation.

The in-memory proxy transport (`RegionProxyTransport` / `MemoryRegionProxy` over a
shared `MemoryRegionRouterFabric`) is the routing analogue of `MemoryRegionBus`:
**addressed** (point-to-point to the home) rather than broadcast. Production supplies
a WAN request/response adapter (HTTP to the home's ingress, or a cross-region queue)
implementing the same interface.

### Convergence guarantee: home-region-authoritative

Because all writes to a key funnel through a single home region, the home
**serializes** concurrent cross-region writes to that key — that is the
coherent-ordering win [option C](#c-per-region-primary-write-region-routing) calls
out. The convergence guarantee is therefore **home-region-authoritative**: the
home's applied order is the order every region eventually observes. Conflicts are
resolved by *serialization at the home*, not by a merge rule. (The alternative —
accept-anywhere-then-converge with a region-stamped deterministic rule such as
"home-region wins, else lowest-`regionId`" — was considered and rejected;
home-authoritative routing is preferred and simpler.)

### Additive & backward-compatible

A single-region deployment sets its one region as the `defaultHomeRegionId`, so every
key is home-local → `routeWrite` **always** returns `local` → zero proxying → behaves
exactly as today. The router is opt-in; an unwired server publishes through its
`FrickClusterBus` (possibly a `FederatingClusterBus`) unchanged.

## Region-aware failover (FR-107)

The per-region-primary model makes a key's home a per-key availability dependency: if
a key's home region goes down, writes have nowhere authoritative to land. FR-107
closes that gap with minimal, testable orchestration
([`region-failover.ts`](../apps/server/src/cluster/region-failover.ts)).

- **Health states.** `RegionFailoverCoordinator` tracks each region as `healthy`
  (serving; eligible to own writes and be promoted to), `draining` (graceful
  pre-removal — finishing in-flight work, accepting no new home assignments, owned
  keys promoted away), or `down` (failed health checks — unavailable, owned keys
  promoted away). The FR-105 seam is failover-friendly: regions attach/detach from
  the fabric cleanly.
- **Deterministic promotion.** When a key's home becomes unavailable, the new home is
  the **lowest-`regionId` healthy region** among the survivors — mirroring the
  FR-106/FR-154 lowest-id tie-break, so it is total + symmetric: from the same
  `{ownership snapshot} × {health map}` every region computes the identical promotion
  with **no coordination messages**. Writes then re-route to the promoted home via
  the unchanged `routeWrite` path (routing reads ownership live, so promotion is just
  an ownership reassignment).
- **Rejoin without flapping.** A recovered region (`down`/`draining` → `healthy`)
  does **not** auto-revert a promotion — the promoted home stays home until an
  operator (or a static-config reconcile) moves it back, avoiding write-ownership
  flapping on a flaky region. The recovered region simply becomes an eligible
  promotion target again.
- **Honest degraded state.** With zero healthy survivors there is nowhere to promote
  to, so ownership is left as-is and re-evaluated when a region comes back up.

**Operational runbook + load-balancer/DNS glue:** see
[`docs/multi-region-operations.md`](multi-region-operations.md) — health-checking,
drain/promote on regional outage, and how client-facing LB/DNS region affinity
interacts with home-region write routing.

### Additive & opt-in

A single-region server wires none of this: one region, always healthy, home for
everything, no promotion ever fires. Multi-region deployments opt in by constructing
a `RegionFailoverCoordinator` over their ownership model.
