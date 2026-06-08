# Multi-region operations runbook (FR-107)

> Operational guidance for running Frick across regions: health-checking,
> draining/promoting on a regional outage, and the load-balancer / DNS glue that
> routes clients to a healthy region. This is the **FR-107** deliverable; the design
> + seams it operates live in [`multi-region.md`](multi-region.md) (FR-105 federation,
> FR-106 write-region routing) and the code in
> [`apps/server/src/cluster/`](../apps/server/src/cluster/).

This runbook describes what multi-region *operation* looks like today. The
orchestration seam (`RegionFailoverCoordinator`) is deliberately minimal and library-
level — Frick does not ship a control plane that drives it automatically; an operator
(or a thin deployment-specific supervisor) wires health checks to it. Anything below
that describes external infra (your LB, your DNS, your health prober) is **convention,
not Frick-provided code** — Frick gives you the routing/ownership/promotion primitives;
the LB/DNS layer is yours.

## Mental model: two independent routing planes

A multi-region Frick deployment has **two** routing decisions that are easy to
conflate. Keep them separate:

1. **Client → region (LB / DNS).** Which region's ingress does a *client* connect to?
   This is geographic affinity for latency: a client in Europe should land on the
   `eu-west` ingress so its WebSocket round-trips stay local. Handled entirely by your
   LB/DNS — Frick has no opinion here beyond "any healthy region can serve any
   client".
2. **Write → home region (FR-106).** Once a write lands on *some* region's node, which
   region is **authoritative** for applying it? This is `RegionWriteRouter.routeWrite`
   ([FR-106](multi-region.md#write-region-routing--conflict-handling-fr-106)): the
   landing region either accepts locally (it is the tenant's home) or proxies to the
   home.

The key insight: **these planes are decoupled.** A client can be LB-routed to the
nearest region for low-latency reads/realtime even when that region is *not* the home
for its tenant's writes — the write simply proxies home (one extra WAN hop on the
*write* path only), and the authoritative stream fans back via FR-105 federation so
the client's realtime view stays correct and local. You do **not** need DNS to pin a
client to its tenant's write-home; you only need DNS to pin it to a *healthy* region.

## Health-checking regions

Each region exposes the standard server health endpoints (see
[`operations.md`](operations.md) for the per-node liveness/readiness contract). At the
*region* level, treat a region as healthy when a quorum of its nodes are ready and its
intra-region bus (Redis) is reachable.

Recommended prober loop (run from an out-of-band controller, not from within a region
so a region can't mark itself healthy while partitioned):

- Poll each region's ingress readiness on an interval (e.g. every 5s, 3 consecutive
  failures = down — tune to your WAN jitter).
- Feed transitions into the `RegionFailoverCoordinator`:
  - region fails the check → `coordinator.markDown(regionId)`
  - region recovers → `coordinator.markHealthy(regionId)`
  - planned removal (deploy, scale-down, maintenance) → `coordinator.drain(regionId)`
    **before** you pull it from the LB, so its owned write-homes promote away while it
    can still serve in-flight work.

Because promotion is **deterministic** (lowest-`regionId` healthy survivor), every
region/controller that sees the same health map computes the same new home with no
coordination. If you run more than one controller for redundancy, they will agree.

## Draining / promoting on a regional outage

### Graceful drain (planned)

1. `coordinator.drain(regionId)` — the coordinator promotes every write-home owned by
   the draining region to the lowest-id healthy survivor and reassigns ownership.
   Writes for those tenants immediately re-route to the new home via `routeWrite`.
2. Wait for in-flight requests on the draining region to settle (its WebSockets can
   stay up; clients on it keep getting federated updates from the new home).
3. Pull the region from the LB/DNS (remove its A/AAAA records or mark its target group
   unhealthy) so new clients stop landing there.
4. Take the region down.

### Hard outage (unplanned)

1. The prober detects the region failed health checks → `coordinator.markDown(regionId)`.
   Write-homes promote to the lowest-id survivor automatically and deterministically.
2. The LB/DNS health check independently drops the dead region from rotation, so
   clients that were on it reconnect and get LB-routed to a healthy region.
3. Clients reconnect and **re-sync via per-stream cursors** (the same reconnect path
   used for ordinary node failover) — a missed realtime frame during the gap is a
   latency blip, not data loss; the database is the durability layer.

### Rejoin

When a region recovers, `coordinator.markHealthy(regionId)` makes it an eligible
promotion target again, but **does not auto-revert** promotions that happened while it
was down — this avoids write-ownership flapping on a flaky region. To move a home back
(e.g. to restore geographic locality after a long outage), reconcile ownership
deliberately during a low-traffic window: `StaticRegionOwnership.reassign(key, region)`
(or, for claim-based ownership, `release` the key on the current home so the intended
region re-claims). Re-add the region to LB/DNS rotation once it is healthy.

## Load-balancer / DNS glue

Frick does not ship an LB. The conventions below make the two-plane model above work
with a standard global LB (AWS Global Accelerator / GCLB / Cloudflare / etc.) or
latency/geo DNS.

### Region affinity (steady state)

- Use **latency- or geo-based DNS** (or an anycast global LB) so each client resolves
  to its nearest *healthy* region's ingress. This optimizes the client↔region hop only
  — it intentionally does **not** try to match the client to its tenant's write-home.
- Within a region, the existing horizontal-scale LB
  ([`horizontal-scale.md`](horizontal-scale.md)) spreads clients across nodes; sticky
  sessions are **not** required because the cluster bus already fans every write to
  every node, and FR-105 federation extends that across regions.

### Health-based failover (LB layer)

- Point the LB/DNS health check at each region's ingress readiness endpoint. On
  failure the LB drops that region from rotation; clients reconnect and resolve to the
  next-nearest healthy region. Keep the **LB health check** and the **coordinator
  prober** consistent (same endpoint, comparable thresholds) so the client-routing
  plane and the write-ownership plane fail over together rather than fighting.
- Set DNS TTLs low enough (30–60s) that a regional outage clears from client resolvers
  promptly; rely on the in-region LB for sub-TTL failover.

### How LB routing interacts with home-region write routing

- A client LB-routed to a **non-home** region still works: its writes proxy to the
  home (FR-106), the home serializes + applies them, and the authoritative stream
  federates back (FR-105). The only cost is one WAN hop on the *write* path; reads and
  realtime stay region-local.
- During failover, the **write plane** (coordinator promotion) and the **client plane**
  (LB dropping the region) move independently but converge: clients re-home to a
  healthy region via the LB, and writes re-home to a healthy region via deterministic
  promotion. Because promotion is coordination-free and deterministic, you do **not**
  need the LB and the write-ownership layer to share state — they only need to agree on
  *which regions are healthy*, which the shared health endpoint provides.

## Honest limits

- **No global write total order.** Ordering is per-key (serialized at that key's home),
  not global across keys — consistent with FR-105's deliberately-weak cross-region
  ordering.
- **Promotion is availability, not durability.** Promotion lets writes land somewhere
  authoritative during an outage; durable cross-region data convergence is the
  database's job (federation/routing are the realtime + ownership planes, not
  replication).
- **Zero-healthy-region is a hard stop.** If every region is down there is nowhere to
  promote to; the coordinator leaves ownership as-is and re-evaluates on recovery.
