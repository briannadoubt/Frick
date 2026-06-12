# Map 06 — Cluster bus, push adapters, admin/dashboard API (Rust-rewrite spec)

Scope: distributed + ops surfaces of `apps/server` — the `FrickClusterBus` contract and its
Memory/Redis implementations, the cross-region federation layer, the push-notification
subsystem (APNs / FCM / Web Push / test adapter, per-tenant credential storage, telemetry,
the frozen `FrickPushPayload` wire contract), and the admin/dashboard HTTP surface consumed
by `apps/dev-dashboard`.

All file paths are relative to repo root `/Users/bri/dev/Frick`. Line numbers are from the
working tree at audit time (branch `main`, post-v0.3.0).

> NOTE: `apps/server/src/sync/gateway.ts` contains an intentional NUL byte; grep treats it
> as binary. Use `rg --text` / `grep -a` when searching it.

---

## 1. FrickClusterBus — intra-region fan-out

Reference doc: `docs/horizontal-scale.md`. Source of truth: `apps/server/src/cluster/bus.ts`.

### 1.1 Purpose

N stateless server nodes share one database; durability is unaffected by node count. What the
bus adds is **realtime fan-out**: a write accepted on node A must reach WebSocket subscribers
connected to node B (`docs/horizontal-scale.md:3-19`). The bus is optional — `clusterBus` is an
optional `createFrickServer` option; unset means true single-node (gateway checks
`if (this.#clusterBus)` at every publish site).

### 1.2 The contract (`bus.ts:127-148`)

```ts
interface FrickClusterBus {
  readonly nodeId: NodeId;                                   // string
  publish(envelope: ClusterEnvelope): void;                  // fire-and-forget; MUST NOT throw (log instead)
  subscribe(handler: ClusterEnvelopeHandler): () => void;    // returns unsubscribe fn
  close(): Promise<void>;                                    // tear down peer connections
  setSubscribedTenants?(tenantIds: ReadonlySet<string>): void; // OPTIONAL inbound tenant filter
}
```

Guarantees the contract requires (and the ONLY ones):
- Every publish is tagged with `originNodeId`; a bus must never deliver a node's own publish
  back to that node's subscribers (loop guard). (`bus.ts:17-21`)
- Ordering across nodes is **best-effort**; consumers cope with out-of-order Delta frames via
  per-stream cursors. (`bus.ts:20-21`, `docs/horizontal-scale.md:34`)
- `publish` failures are logged, never propagated; peer nodes simply miss the frame and clients
  catch up on reconnect via cursor replay (`docs/horizontal-scale.md:82`).
- No back-pressure on the bus path (`docs/horizontal-scale.md:80`).

`NodeId` default: `randomNodeId()` (`bus.ts:243-247`) = two concatenations of
`Math.random().toString(36).slice(2, 10)` → ~16 base36 chars, ~64 bits entropy. Any unique
string is acceptable in Rust (it is compared lexicographically by media placement — see §1.7).

### 1.3 ClusterEnvelope — every message kind (`bus.ts:44-122`)

Tagged union, discriminated by string field `kind`. Eight variants. **Field names and
insertion order below are exactly what the TS code constructs** — when msgpack-encoded
(Redis adapter), `@msgpack/msgpack` emits a msgpack *map* with string keys in object insertion
order. Decoders read by key, so order is not load-bearing for interop with the TS peer, but a
byte-identical Rust encoder should preserve it.

`appId` (FR-153 / tenant-app-isolation-1): present on all six sync kinds. Optional on the wire
for back-compat — an envelope from an older peer decodes with `appId === undefined`, which the
gateway treats as `DEFAULT_APP_ID = "_default"` (`apps/server/src/app-id.ts:37`). The gateway
**always sets it** when publishing (`?? DEFAULT_APP_ID`), so new nodes never emit envelopes
without it.

| # | `kind` | Fields, in publish insertion order | Publish site |
|---|---|---|---|
| 1 | `"streamEvent"` | `kind`, `originNodeId`, `tenantId`, `appId`, `stream` (string name), `streamId` (string), `sequence` (number, integer), `packed` (PackedStreamEvent) | `gateway.ts:716-728` (`publishStreamEvent`) |
| 2 | `"objects"` | `kind`, `originNodeId`, `tenantId`, `appId`, `type` (object type name), `objects` (`PlainObject[]`, copied with `[...objects]`) | `gateway.ts:735-744` (`publishObjects`) |
| 3 | `"objectDeletes"` | `kind`, `originNodeId`, `tenantId`, `appId`, `type`, `ids` (`string[]`, copied) | `gateway.ts:754-763` (`publishObjectDeletes`, FR-142) |
| 4 | `"signal"` | `kind`, `originNodeId`, `tenantId`, `appId`, `name`, `key`, `value` (PlainObject), `requestId` (string; `"http"` default for HTTP-originated signals) | `gateway.ts:1006-1017` (`publishSignal`) |
| 5 | `"projectionDelta"` | `kind`, `originNodeId`, `tenantId`, `appId`, `projection`, `changes` (array of `{ key: string; value: PlainObject \| null }`) | `gateway.ts:627-639` (`publishProjectionDelta`) |
| 6 | `"presenceDelta"` | `kind`, `originNodeId`, `tenantId`, `appId`, `name`, `records` (array of `{ key, value: PlainObject \| null }`), `cleared` (`string[]`) | set: `gateway.ts:1677-1687`; clear: `gateway.ts:1713-1723` (records `[]`, cleared `[key]`) |
| 7 | `"mediaPlacementClaim"` (FR-154) | `kind`, `originNodeId`, `tenantId` (always the sentinel `"_media_placement"`), `callId`, `homeNodeId` (== originNodeId), `announcedIp` | `cluster-media-placement.ts:177-186` |
| 8 | `"mediaPlacementRelease"` (FR-154) | `kind`, `originNodeId`, `tenantId` (sentinel), `callId` | `cluster-media-placement.ts:142-149` |

`PackedStreamEvent` (`packages/protocol/src/codec.ts:21-28`) is a positional **array** (msgpack
array), not a map:

```
[streamTypeId: number, streamKey: string, sequence: number,
 eventId: string, eventTypeId: number, fields: PackedField[]]
```

`PackedField = [fieldId: number, value: unknown]` (`packages/protocol/src/schema.ts:183`).
The packed form may contain binary values — this is why the Redis adapter uses msgpack, not
JSON (`redis-bus.ts:12-13`).

### 1.4 Gateway integration (publish, dispatch, tenant refcount)

All in `apps/server/src/sync/gateway.ts` (NUL byte — use `rg --text`).

**Subscription** — constructor wires `clusterBus.subscribe(envelope => #handleClusterEnvelope(envelope))`
(`gateway.ts:218-222`).

**Cluster→local dispatch** `#handleClusterEnvelope` (`gateway.ts:916-989`): runs the same local
fan-out paths as the originating node's `publish*` methods but **never republishes to the bus**
(the origin already did). Switch over `kind`:
- `streamEvent` → `#fanOutStreamEvent({tenantId, appId ?? "_default", stream, streamId, sequence}, packed)`
- `objects` → `#fanOutObjects(type, objects, tenantId, appId ?? "_default")`
- `objectDeletes` → `#fanOutObjectDeletes(type, ids, tenantId, appId ?? "_default")`
- `signal` → `routeSignal(store, subs, {requestId, name, key, value}, tenantId, {maxBufferedAmount}, appId ?? "_default")`
- `projectionDelta` → `#fanOutProjectionDelta({...})`
- `presenceDelta` → picks "primary" key = `records[0]?.key ?? cleared[0]`; if both empty, the
  envelope is silently ignored (`gateway.ts:972-988`). Fans out once under that key.
- **No `default` arm** — `mediaPlacementClaim`/`mediaPlacementRelease` fall through and are
  ignored by the gateway; only `ClusterMediaPlacement` subscribers handle them
  (`bus.ts:101-105`).

Local fan-out applies per-subscriber filters: principal active, `principal.tenantId === envelope.tenantId`,
and app pinning `#appIdFor(subscriber) === appId` (FR-153) — e.g. `gateway.ts:643-667`
(projection), `gateway.ts:1739-1760` (presence). Object fan-out additionally runs per-record
read-authz; delete fan-out does NOT (row is gone; tenant scoping is the boundary —
`gateway.ts:766-780`).

**Single broadcast funnel (FR-114)**: the store's write listener routes server-originated writes
(jobs, HTTP routes) through `publishObjects` / `publishObjectDeletes` / `publishStreamEvent`
(`gateway.ts:678-697`), so server writes get the same cluster forwarding as client mutations.
Note `publishObjects`/`publishObjectDeletes` only publish to the bus when `tenantId !== undefined`
(`gateway.ts:735, 754`).

**Tenant refcount → `setSubscribedTenants`** (`gateway.ts:460-481`): the gateway keeps
`#tenantSubscriberCounts: Map<tenantId, count>` of connected clients. `#bumpTenantCount(tenantId, ±1)`
is called on principal attach (+1 at `gateway.ts:271` and `gateway.ts:2220`) and disconnect (−1 at
`gateway.ts:318`). Only when a tenant transitions between absent↔present does it push
`new Set(counts.keys())` down via `clusterBus.setSubscribedTenants?.(...)`. Adapters without the
method keep "every envelope everywhere" semantics.

### 1.5 MemoryClusterBus + MemoryClusterChannel (`bus.ts:150-241`)

- `MemoryClusterChannel`: a `Set<handler>`; `publish` iterates handlers, catching (and
  swallowing) per-handler exceptions. `attach(handler)` returns a detach fn.
- `MemoryClusterBus`:
  - `nodeId` = option or `randomNodeId()`.
  - `channel` = option or a fresh private channel (i.e., no peers).
  - On channel message: drop if `envelope.originNodeId === this.nodeId`; drop if a subscribed-tenant
    set exists and `!set.has(envelope.tenantId)`; else dispatch to local handlers, isolating
    per-handler exceptions silently (`bus.ts:204-219`).
  - `#subscribedTenants` starts `undefined` = pass-through ("back-compat"); becomes filtering
    after the first `setSubscribedTenants` call. **An empty set means drop everything**
    (pinned by `tests/cluster-bus.test.ts:111-121`).
  - `setSubscribedTenants` **snapshots** the set (`new Set(tenantIds)`) — later caller mutation
    must not leak in (pinned by `tests/cluster-bus.test.ts:131-146`).
  - `close()` detaches from the channel and clears local handlers; publishes after close are
    still forwarded to the channel (only inbound is detached) but there are no subscribers.

Behavior pinned by `apps/server/tests/cluster-bus.test.ts`: cross-bus delivery; self-publish
loop guard (a node's own subscriber never sees its own publish); handler-exception isolation;
close detaches; random distinct nodeIds with `length > 8`; tenant filtering incl. empty-set and
snapshot semantics; every envelope kind carried.

### 1.6 RedisClusterBus (FR-27) — `apps/server/src/cluster/redis-bus.ts`

Production adapter. Mirrors MemoryClusterBus semantics exactly.

**Wire format on Redis:** a single pub/sub channel, default name **`frick:cluster`**
(`redis-bus.ts:58`, overridable via `channel` option). Each message is the
**`@msgpack/msgpack` `encode(envelope)` bytes of one `ClusterEnvelope`** — a msgpack map with
string keys in the insertion orders of §1.3; `packed` is a nested msgpack array. No framing,
no compression, no signature, no version field. Binary-safe by construction (msgpack, and the
subscriber listens on ioredis's `messageBuffer` event so payloads arrive as raw `Buffer`s,
never UTF-8-decoded — `redis-bus.ts:30-43`).

**Two connections** are mandatory: a Redis connection in subscribe mode cannot also `PUBLISH`
(`redis-bus.ts:13-15`). Options: `publisher`, `subscriber` (must not be the same client),
`nodeId?`, `channel?`, `logger?: (event, detail) => void` (default no-op).

`RedisBusClient` minimal client surface (`redis-bus.ts:35-43`): `publish(channel, message: Buffer)`,
`subscribe(channel)`, `on("messageBuffer", (channel: Buffer, message: Buffer) => void)`, `quit()` —
all may be sync or Promise-returning.

Inbound path `#onMessage` (`redis-bus.ts:90-114`), in order:
1. Channel guard: `channel.toString("utf8") !== this.#channel` → ignore (pattern-sub leakage guard).
2. msgpack decode; on failure log `frick.cluster.redis.decode_failed` and drop. **No shape
   validation** beyond decode — the decoded value is trusted as a `ClusterEnvelope` (contrast
   with the region bus, §2.3, which validates).
3. Loop guard: `envelope.originNodeId === this.nodeId` → drop.
4. Tenant filter: if `setSubscribedTenants` has ever been called and the set lacks
   `envelope.tenantId` → drop. (Same snapshot semantics as Memory bus, `redis-bus.ts:137-140`.)
5. Dispatch to each handler; per-handler exceptions logged as `frick.cluster.redis.handler_threw`.

Outbound `publish` (`redis-bus.ts:116-130`): no-op after `close()`; encode failures log
`frick.cluster.redis.encode_failed` and drop; the async `publisher.publish` rejection logs
`frick.cluster.redis.publish_failed`. Never throws.

`ready: Promise<void>` resolves once `subscriber.subscribe(channel)` settles; a subscribe
failure logs `frick.cluster.redis.subscribe_failed` and still resolves (the bus is degraded,
not crashed) (`redis-bus.ts:83-88`).

`close()` (`redis-bus.ts:142-146`): sets closed flag, clears handlers,
`Promise.allSettled([subscriber.quit(), publisher.quit()])`.

Factory `createRedisClusterBus({url, nodeId?, channel?, logger?})` (`redis-bus.ts:163-189`):
dynamically imports `ioredis` (optional dependency; throws
`createRedisClusterBus requires the optional "ioredis" dependency to be installed: …` if
missing), creates two clients from the URL, awaits `bus.ready`, returns the bus. Server boot
example in `docs/horizontal-scale.md:62-69`; note **`server.close()` does NOT close an injected
bus** — callers must `await bus.close()` themselves.

Log event names (stable, used by ops): `frick.cluster.redis.subscribe_failed`,
`.decode_failed`, `.handler_threw`, `.encode_failed`, `.publish_failed` — detail payload is
`{ error: string }` (or `{}`).

### 1.7 ClusterMediaPlacement (FR-154) — `apps/server/src/calls/cluster-media-placement.ts`

Bus-coordinated `callId → home node` registry for multi-box SFU placement. Rides the existing
bus; the gateway ignores its two kinds (§1.4).

- Sentinel: `MEDIA_PLACEMENT_TENANT = "_media_placement"` (`cluster-media-placement.ts:63`) —
  placement is keyed by `callId`, not tenant; the sentinel keeps the bus's tenant machinery
  uniform. Underscore prefix matches the reserved-namespace convention (`_default`).
- TTL: `DEFAULT_PLACEMENT_TTL_MS = 3_600_000` (1 h); an entry older than `ttlMs` is treated as
  absent on the next resolve and evicted (`#liveEntry`, lines 165-175). Self-heals a missed
  release (crashed home).
- `placeFor(callId)`: live local/peer entry → return it; else claim locally
  (`{nodeId, announcedIp}`), record with `now()`, publish `mediaPlacementClaim`, return.
- `release(callId)`: deletes the local entry; publishes `mediaPlacementRelease` **only when the
  local entry's `home.nodeId === this.nodeId`** (a non-home node releasing would lie to peers).
- Peer claim handling `#onPeerClaim` (lines 204-228):
  - unknown call → adopt peer home (and refresh TTL timestamp);
  - same home → refresh TTL only;
  - conflict → **lowest `homeNodeId` (lexicographic, JS `<` on strings = UTF-16 code-unit
    order) wins**. If the peer wins and *we* had claimed locally, fire the injected
    `onYieldHome(callId)` hook (best-effort; exceptions swallowed) to release our orphaned
    router. If we hold the lower id, keep ours — the peer adopts ours when our claim arrives.
    Rule is total + symmetric → all nodes converge with no extra messages.
- Defensive origin re-check `envelope.originNodeId === this.#nodeId → return` even though the
  bus already filters self-publishes (line 190).
- `nodeId` defaults to `bus.nodeId`; `now` injectable; `close()` only unsubscribes.

**Surprising/undocumented interaction (likely bug to preserve or fix consciously):** the
node-level buses' tenant filter has **no exemption for the `_media_placement` sentinel** —
`MemoryClusterBus` (`bus.ts:206`) and `RedisClusterBus` (`redis-bus.ts:102`) drop any inbound
envelope whose `tenantId` is not in the gateway-supplied set, and the gateway's refcount only
ever contains real client tenants (`gateway.ts:479`). So on a node where any client has ever
connected (set non-empty and sentinel absent), inbound `mediaPlacementClaim`/`Release`
envelopes are dropped before `ClusterMediaPlacement` sees them. The **region** layer fixed
exactly this (`region-bus.ts:248-258` always serves the sentinel, with a test pinning it —
`tests/region-bus.test.ts:317-322`), but the intra-region buses did not. A wire-compatible
Rust port must decide: replicate the inconsistency, or exempt the sentinel in the node-level
filter (recommended; matches the region bus's documented intent).

### 1.8 Known follow-ups (from docs)

One bus per server; cross-region replication is explicitly out of scope for the bus itself
(`docs/horizontal-scale.md:84-86`) — it is layered on top, §2.

---

## 2. Cross-region federation (FR-105/106/107/157) — `apps/server/src/cluster/region-*.ts`

These compose around `FrickClusterBus` without changing it; the gateway is unaware federation
exists. Status note: memory file says FR-20 multi-region "remains (design-first)", but the
code below ships and is tested.

### 2.1 Seam (`region-bus.ts`)

```ts
interface RegionEnvelope { originRegionId: RegionId /* string */; envelope: ClusterEnvelope }
interface FrickRegionBus {
  readonly regionId: RegionId;
  publish(envelope: RegionEnvelope): void;     // best-effort fire-and-forget
  subscribe(handler: (e: RegionEnvelope) => void): () => void;
  close(): Promise<void>;
}
```
`originRegionId` is the cross-region loop guard, mirroring `originNodeId` one level up
(`region-bus.ts:29-36, 58-67`). `randomRegionId()` = `"region-" + randomNodeId()`.

### 2.2 FederatingClusterBus (`region-bus.ts:~200-290`)

Wraps a local `FrickClusterBus` + a `FrickRegionBus`; itself implements `FrickClusterBus`.
- `publish(envelope)`: (1) always publish on the local intra-region bus; (2) federate to peer
  regions **only when `envelope.originNodeId === local.nodeId`** — envelopes that arrived from a
  peer node in our own region were already fanned region-wide; re-federating would double-ship
  across the WAN.
- Inbound from region bus: defensively skip malformed inner envelopes (must be an object with
  string `kind` — finding multi-region-4); apply the federation-hop tenant filter
  `#servesTenant(inner.tenantId)`; then `local.publish(inner)` (so it fans to all nodes in this
  region, each applying its own node-level filter + loop guard).
- `#servesTenant`: pass-through until `setSubscribedTenants` has been called; **always serves
  `MEDIA_PLACEMENT_TENANT`** (`region-bus.ts:248-258`); otherwise set membership.
- `setSubscribedTenants` snapshots and also delegates to the wrapped local bus.
- `nodeId` delegates to the local bus. `close()` = `Promise.allSettled([region.close(), local.close()])`.

### 2.3 RedisRegionBus (FR-157) — `region-redis-bus.ts`

Cross-region WAN transport; mirrors `RedisClusterBus` one level up. Channel default
**`frick:region`** (`region-redis-bus.ts:104`); same `RedisBusClient` surface, same two-connection
rule, same logger pattern with event prefix `frick.region.redis.*`.

**Wire format (unauthenticated / legacy mode, no `regionSecret`):** msgpack `encode(RegionEnvelope)`
— a map `{ originRegionId: string, envelope: <ClusterEnvelope map> }`.

**Wire format (authenticated mode, `regionSecret` set — FR-158, finding multi-region-1):** the
frame is msgpack `encode(SignedRegionFrame)` where (`region-redis-bus.ts:115-126`):

```
SignedRegionFrame (msgpack map, insertion order):
  v:       number   — wire version, MUST be 1 (SIGNED_FRAME_VERSION)
  ts:      number   — unix-ms timestamp when signed
  nonce:   bin      — 16 random bytes (randomBytes(16))
  payload: bin      — the msgpack-encoded RegionEnvelope bytes (MAC covers exact bytes; no re-encode ambiguity)
  mac:     bin      — HMAC-SHA256(secret, header || nonce || payload)
```

MAC preimage header is **12 bytes**: `u32be(v)`, then the 53-bit-safe ms timestamp split
big-endian across two u32s — `u32be(floor(ts / 2^32))`, `u32be(ts mod 2^32)`
(`#computeMac`, `region-redis-bus.ts:266-277`). Secret: `string` (UTF-8-encoded) or bytes; the
empty string disables signing (treated as undefined).

Inbound verification order (`#onMessage` + `#verifySignedFrame`, lines 169-264): channel guard →
msgpack decode → if we have a secret: structural signed-frame check (log
`frick.region.redis.unsigned_frame`), version check (`bad_frame_version`), **timing-safe** MAC
compare (`timingSafeEqual`, log `bad_mac`), freshness `|now − ts| ≤ replayWindowMs` (default
**5 min**, log `stale_frame` with `skewMs`), nonce replay de-dupe (base64 nonce key in a Map
pruned by the same window; log `replayed_frame`). If we have **no** secret but receive a
signed-looking frame: drop + log `unexpected_signed_frame` — refuse to silently downgrade.
Then: decode inner envelope bytes; structural validation `isWellFormedRegionEnvelope` (non-empty
string `originRegionId`, object `envelope` with string `kind`; log `malformed_envelope`); loop
guard `originRegionId === regionId`; dispatch with handler isolation (`handler_threw`).

Factory `createRedisRegionBus({url, regionId?, channel?, regionSecret?, replayWindowMs?, logger?})`
— same dynamic-ioredis pattern as §1.6. Security posture: HMAC is defense-in-depth, NOT a
substitute for mTLS/private networking (`region-redis-bus.ts:50-58`); the cross-region channel is
a cross-tenant trust boundary (a forger could fabricate envelopes for any tenant).

### 2.4 RegionWriteRouter (FR-106) and RegionFailoverCoordinator (FR-107)

`region-router.ts`: per-region-primary ownership — every write key (granularity: **per
tenant**) has one home region; non-home regions proxy writes to the home; home serializes.
Two `RegionOwnershipResolver` strategies: `StaticRegionOwnership` (config map + default) and
`ClaimRegionOwnership` (claim/TTL/lowest-`regionId`-wins tie-break over the region bus,
mirroring FR-154). `region-failover.ts`: health states `healthy | draining | down`; on home-down,
deterministic promotion to the **lowest-regionId healthy survivor** computed from the full known
region universe (ownership map ∪ configured regions ∪ health-reported regions; absent = healthy);
rejoin does NOT auto-revert (no flapping). These are control-plane-local (no new wire format
beyond the claims riding the region bus) — port the algorithms, not bytes.

---

## 3. Push notification subsystem

Reference docs: `docs/push-adapters.md`, `docs/push-receive.md`. Sources:
`apps/server/src/push/*.ts`, `apps/server/src/storage/push-registration-store.ts`.

### 3.1 Core types (`push/types.ts`)

```ts
interface FrickNotificationIntent {
  intent: string;                       // semantic id, convention "<noun>.<verb>" e.g. "message.new"
  tenantId: string;
  recipientUserIds: readonly string[];  // explicit list; broadcast out of scope v1
  body: { title?: string; body?: string; data?: Record<string, unknown> };
  threadId?: string;
  deepLink?: string;
}

interface FrickPushDelivery {
  registration: PushDeviceRegistration;
  attemptedAt: string;                  // ISO-8601
  status: "delivered" | "failed" | "skipped";
  error?: { code: string; message: string };
  receiptId?: string;
}

interface FrickPushAdapter {
  platform: PushPlatform;              // "apns" | "fcm" | "webPush" | "test"
  send(intent, registration, ctx): Promise<FrickPushDelivery>;  // MUST be idempotent per (intent, registration)
}
```

Revocation error codes (`types.ts:108-112`):
`PUSH_REVOCATION_ERROR_CODES = { "push.badDeviceToken", "push.unregistered", "push.tokenExpired" }`.
The router revokes the registration when a failed delivery carries one of these.

### 3.2 Device registrations (`storage/push-registration-store.ts`)

```ts
type PushPlatform   = "apns" | "fcm" | "webPush" | "test";   // PUSH_PLATFORMS, same order (line 54)
type PushEnvironment = "production" | "sandbox";

interface PushDeviceRegistration {
  registrationId: string;   // "push-" + randomUUID()
  tenantId: string; userId: string; deviceId: string;
  platform: PushPlatform; token: string;
  environment: PushEnvironment;
  createdAt: string; lastSeenAt: string;   // ISO-8601
  revokedAt?: string;                      // tombstone
}
```

Table `push_device_registrations`, snake_case columns. Uniqueness: **partial unique index over
active rows only** (`(tenant_id,user_id,device_id,platform) WHERE revoked_at IS NULL`,
migration 0007). `register()` semantics: if an active row exists for the tuple → UPDATE
token/environment/last_seen_at in place, **registrationId stays stable**; else INSERT a fresh
row (revoked tombstones are never reactivated — preserves the original revocation timestamp;
one extra row per re-registration cycle). `revoke()` is idempotent, tenant-scoped, returns
true only when a row actually transitioned. `listByUser` = active rows ordered `created_at ASC`.
`touch()` bumps `last_seen_at` after a successful delivery.

### 3.3 Client-facing HTTP routes (session-authenticated; `server.ts`)

- `POST /push/registrations` (`server.ts:1862-1896`): body
  `{ deviceId: string, platform: string, token: string, environment?: "production"|"sandbox" }`.
  Validations: platform must be one of `apns, fcm, webPush, test` (error text:
  `platform must be one of apns, fcm, webPush, test (got "...")`); for `webPush` the token must
  parse as PushSubscription JSON with a **public https** endpoint
  (`validateWebPushRegistrationToken`, §3.8); environment defaults `"production"`, else must be
  exactly `"production"` or `"sandbox"`. tenant/user come from the session principal. Response
  `201 { registration: PushDeviceRegistration }`. Errors via `sendErrorWithMetrics(...,
  "push_registration_rejected")`.
- `DELETE /push/registrations/{registrationId}` (`server.ts:1898-1921`): 404
  `{ error: "push_registration_not_found" }` when missing **or owned by another user in the
  same tenant** (no cross-user existence disclosure); else revoke + `204` empty.
- Both paths are in `isProtectedPath` (`server.ts:5090-5100`).

### 3.4 Notification router (`push/router.ts`)

- `PUSH_DELIVER_JOB_TYPE = "push.deliver"` (line 44). The router is a job handler registered
  under that type at boot (unless the app already registered one — `server.ts:888-891`); in
  multi-app servers the same framework handler is replicated into every app's job registry
  (`server.ts:929-960`).
- `enqueueIntent(intent)` → `store.jobs.enqueue({ tenantId, jobType: "push.deliver", payload: encodeIntent(intent) })`.
  `encodeIntent` (lines 210-219) writes keys in order `intent, tenantId, recipientUserIds, body[, threadId][, deepLink]`,
  omitting absent optionals.
- `deliver(intent)`: for each recipient userId → `listByUser` active registrations → de-dupe by
  `registrationId` across the whole intent (repeated userIds can't double-send, lines 75-79) →
  `deliverOne` per registration, sequentially.
- `deliverOne` (lines 88-163):
  1. `resolveAdapter(platform)`; none → `skipped` with
     `error.code = "push.unknownAdapter"`, message `No adapter registered for platform "X"`.
  2. Build ctx with child logger fields `{intent, tenantId, registrationId, platform}`.
  3. `adapter.send(...)`; a thrown exception → synthetic `failed` with
     `error.code = "adapter.threw"` + log `frick.push.adapter_threw`.
  4. `delivered` → `pushRegistrations.touch(...)`; `failed` + revocation code →
     `pushRegistrations.revoke(...)` + log `frick.push.revoked` `{reason: code}`.
  5. **Telemetry (always, fire-and-forget):** DevTools event
     `kind: "frick.push.delivery"`, `tenantId`, fields
     `{intent, platform, registrationId, userId, status[, errorCode][, receiptId]}`
     (lines 147-161). Queryable via
     `/_frick/inspect/devtools/events?kind=frick.push.delivery&tenantId=...`
     (`docs/push-adapters.md:189-208`). DevTools event retention defaults: 1 h / 10 000 rows /
     60 s prune (`devtools/event-store.ts:57-62`).
- Job handler: undecodable payload → `{status:"failed", errorCode:"push.invalidIntent",
  retryable:false}`; `deliver` success → `{status:"completed", result:{intent, tenantId,
  deliveries: serializeDelivery[]}}` where `serializeDelivery` =
  `{registrationId, userId, deviceId, platform, attemptedAt, status[, error][, receiptId]}`;
  router-level throw → `{status:"failed", errorCode:"push.routerError", retryable:true}`.
  **Partial delivery is intentional** — the job completes even if every delivery failed;
  retrying the whole job would multiply successes.
- `decodeIntent` validation (lines 221-259): payload must be a non-array object; `intent` and
  `tenantId` non-empty strings; `recipientUserIds` an array of non-empty strings; `body`
  defaults `{}` and only string `title`/`body` and plain-object `data` are kept; string
  `threadId`/`deepLink` copied if present.

### 3.5 Adapter registry (`push/registry.ts`)

Map keyed by platform string. `registerAdapter` throws `DuplicatePushAdapterError`
(`reason = "duplicatePushAdapter"`, message
`A push adapter is already registered for platform "X"`) — boot crash preferred over silent
shadowing. `list()` returns adapters sorted by platform (localeCompare). Boot wiring
(`server.ts:870-879`): app adapters first, then the default test adapter unless an app adapter
already claims platform `"test"`. On server close, every adapter with a `close()` is closed,
failures logged `frick.push.adapter_close_failed` (`server.ts:2840-2848`).

### 3.6 Per-tenant credential storage (`push/credentials.ts`)

Storage keys in `tenant_settings`:
`APNS_SETTINGS_KEY = "push.apns.encrypted"`, `FCM_SETTINGS_KEY = "push.fcm.encrypted"`,
`WEB_PUSH_SETTINGS_KEY = "push.webPush.encrypted"` (lines 37-39).

Credential record shapes (JSON, then encrypted):
- APNs: `{ keyId, teamId, bundleId, privateKeyPem, useSandbox?: boolean }` — keyId/teamId are
  Apple's 10-char ids; `bundleId` becomes the `apns-topic` header; `useSandbox` default false.
- FCM: `{ projectId, clientEmail, privateKey, tokenUri? }` — verbatim from a Google
  service-account JSON (`project_id`, `client_email`, `private_key`).
- WebPush: `{ subject, publicKey, privateKey }` — `subject` must be `mailto:` or `https:`;
  `publicKey` is the base64url VAPID application-server key (`k=` param); `privateKey` is a
  PEM EC P-256 key.

**Encryption envelope:** AES-256-GCM (`ENCRYPTION_ALGO = "aes-256-gcm"`), IV 12 bytes random,
auth tag 16 bytes. Stored value = `base64( iv(12) || ciphertext || tag(16) )` of
`JSON.stringify(record)` UTF-8 (lines 139-159). Minimum decodable length: strictly greater
than 28 bytes.

**Keys:** primary from env `FRICK_PUSH_CRED_KEY` (base64, exactly 32 bytes after decode;
anything else = disabled). Rotation (FR-61): `FRICK_PUSH_CRED_KEY_PREVIOUS` is a
comma-separated list of previous base64 32-byte keys; decryption tries primary first then each
previous in order (GCM tag mismatch ⇒ try next); blank/invalid entries silently skipped; all
new writes use the primary (lines 105-132, 161-207). The key is deliberately never stored in
the DB.

Error union `PushCredentialError`:
- `push.credentials.disabled` — key env unset/invalid; message
  `FRICK_PUSH_CRED_KEY is unset or not a base64-encoded 32-byte value`.
- `push.credentials.missing` — no `tenant_settings` row; message
  `No <key> stored for tenant <tenantId>`.
- `push.credentials.corrupt` — `not base64` / `envelope too short` /
  `decrypted blob is not JSON` / `decryption failed` (every key failed).

Helpers: `load/saveApnsCredentials`, `load/saveFcmCredentials`, `load/saveWebPushCredentials` —
all return `{ok:true,...} | {ok:false,error}` (never throw).

### 3.7 APNs adapter (`push/apns-adapter.ts`)

One **global** adapter instance serves every tenant; per-tenant state cached on the instance:
- HTTP/2 sessions: one persistent `node:http2` session per cache key `"<tenantId>:<endpoint>"`;
  evicted on session `close`/`error` events. APNs requires HTTP/2.
- JWTs: cache key `"<tenantId>:<keyId>"`; `JWT_REFRESH_MS = 50 * 60 * 1000` (Apple accepts up
  to 60 min; refresh at 50 to absorb skew).

Endpoints: production `https://api.push.apple.com`; sandbox
`https://api.sandbox.push.apple.com` when creds set `useSandbox: true`; test override via
`options.endpoint`.

**JWT (ES256)** — `signApnsJwt` (lines 278-287):
- header: `{"alg":"ES256","kid":"<keyId>","typ":"JWT"}` (exact key order)
- claims: `{"iss":"<teamId>","iat":<unix seconds>}` (no `exp`)
- signature: ECDSA P-256/SHA-256 over `base64url(header) + "." + base64url(claims)`, emitted in
  **IEEE P1363 raw r||s form** (`dsaEncoding: "ieee-p1363"`) — NOT DER. base64url = standard
  base64 with `+→-`, `/→_`, padding stripped.

**Request** per delivery (lines 140-152): HTTP/2 `POST /3/device/<token>` with headers
`authorization: bearer <jwt>` (lowercase "bearer"), `apns-topic: <bundleId>`,
`apns-push-type: alert` (`DEFAULT_PUSH_TYPE`), `content-type: application/json`,
`content-length`.

**Body** — `encodeApnsBody` (lines 248-268), frozen wire contract (§3.10):
```jsonc
{
  "aps": {
    "alert": { "title": ..., "body": ... },   // only when title or body present; keys omitted when absent
    "thread-id": "<threadId>",                 // only when intent.threadId set
    "sound": "default"                          // ALWAYS set
  },
  // every intent.body.data entry hoisted to TOP LEVEL (key "aps" skipped if present in data)
  "deepLink": "<deepLink>",                     // only when set
  "intent": "<intent>"                          // ALWAYS last-assigned top-level key
}
```

**Result translation** (lines 202-240): 200 → `delivered`, `receiptId` = `apns-id` response
header if present. Otherwise parse body JSON `{reason}` and map (`mapApnsReason`):
status 410 or reason `Unregistered` → `push.unregistered`; `BadDeviceToken` →
`push.badDeviceToken`; `ExpiredProviderToken` → `push.tokenExpired`; 413 →
`push.payloadTooLarge`; 429 → `push.rateLimited`; ≥500 → `push.serverError`; else
`push.deliveryFailed`. Failure message: `APNs <status> <reason|unknown>`. Missing/bad creds →
`skipped` with the credential error code. `close()` closes all cached sessions (call at
shutdown — HTTP/2 sessions keep the process alive).

### 3.8 FCM v1 adapter (`push/fcm-adapter.ts`)

Constants: `DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token"`,
`DEFAULT_FCM_BASE = "https://fcm.googleapis.com"`,
`FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"`.

OAuth2 flow per tenant (cache key `"<tenantId>:<clientEmail>"`): sign a service-account JWT
(`signServiceAccountJwt`, lines 229-250) — header `{"alg":"RS256","typ":"JWT"}`, payload
`{iss: clientEmail, scope: FCM_SCOPE, aud: <tokenUri>, iat, exp: iat+3600}`, RSA-SHA256 (PKCS#1
v1.5, DER as Node default), base64url segments — POST it as
`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>`
(`application/x-www-form-urlencoded`) to `tokenUri` (options override > creds.tokenUri >
default). Cache `access_token` until `expires_in` (default 3600 s) minus a **60 s** early-refresh
margin. Non-2xx or missing `access_token` → `FcmTokenExchangeError`
(`FCM token exchange failed: <status> <body[..200]>`) → delivery `failed` with
`push.tokenExchangeFailed`.

Send: `POST <fcmBase>/v1/projects/<encodeURIComponent(projectId)>/messages:send` with
`authorization: Bearer <accessToken>` (capital B here), JSON body
`{ "message": encodeFcmMessage(...) }`.

**Message encoding** (lines 150-172), frozen wire contract (§3.10):
```jsonc
{
  "token": "<registration.token>",
  "notification": { "title": ..., "body": ... },   // only when title or body present
  "data": {                                          // ALWAYS present; ALL VALUES STRINGS (FCM v1 requirement)
    "intent": "<intent>",                            // always first
    "threadId": "...",                               // when set
    "deepLink": "...",                               // when set
    // each intent.body.data entry: strings verbatim, non-strings JSON.stringify'd
  }
}
```
Note `body.data` keys can overwrite the reserved `intent`/`threadId`/`deepLink` keys (data is
spread after them) — undocumented edge.

Result translation (lines 174-222): 2xx → `delivered`, `receiptId` = response `name` field.
Else parse `{error:{status,message,details:[{errorCode}]}}`; `errorCode` =
`details[0].errorCode ?? error.status ?? ""`. Mapping (`mapFcmErrorCode`): status 404 or
`UNREGISTERED` → `push.unregistered`; `INVALID_ARGUMENT` or `SENDER_ID_MISMATCH` →
`push.badDeviceToken`; `QUOTA_EXCEEDED` or status 429 → `push.rateLimited`; ≥500 →
`push.serverError`; else `push.deliveryFailed`. Message: `FCM <status>: <error.message|body[..200]>`.

### 3.9 Web Push adapter (FR-60) (`push/web-push-adapter.ts`)

Registration `token` is a JSON-encoded browser `PushSubscription`:
`{ endpoint, keys: { p256dh, auth } }`. Parse failure or unsafe endpoint → `failed` with
`push.badDeviceToken`, message
`Registration token is not a valid PushSubscription JSON` (also used for ECDH/encrypt failure).

**SSRF guard** (registration-time and send-time): endpoint must be `https:`; hostname must not
be `localhost`/`*.localhost`/`metadata.google.internal`; literal IPs and **DNS-resolved
addresses (all of them, `dns.lookup all:true verbatim:true`)** must not fall in: IPv4
0/8, 10/8, 127/8, 100.64/10, 169.254/16, 172.16/12, 192.168/16, 198.18/15, 224/4, ≥240/4
(`isUnsafeIpv4`, lines 417-435); IPv6 loopback/unspecified (::, ::1), fc00::/7, fe80::/10,
ff00::/8, plus embedded-IPv4 re-check; unparseable IPv6 = unsafe. Hostname normalization:
lowercase, strip `[...]`, strip trailing dot. Literal-IP endpoints skip DNS but were already
screened by `isUnsafeHost`. Send-time DNS resolution failure → unsafe.
NOTE (subtle): in `isSafeWebPushEndpointForSend`, `isIP(host)` true → `return true` directly
(the literal was screened in `isSafeWebPushEndpoint` via `isUnsafeHost`).

**VAPID auth** (lines 84-95, 502-511): JWT header `{"typ":"JWT","alg":"ES256"}`, payload
`{aud: <endpoint origin>, exp: now+12h, sub: creds.subject}`, ES256 with **IEEE-P1363 r||s**
(same as APNs). Cached per `"<publicKey>\x00<audience>"` for `JWT_REFRESH_MS = 12h` (validity
24 h max; refresh at half). Header: `authorization: vapid t=<jwt>, k=<publicKey>`. Also always
header `ttl: "2419200"` (seconds; `WEB_PUSH_TTL`, = 4 weeks).

**Payload encryption — RFC 8291 + RFC 8188 `aes128gcm`** (`encryptWebPushPayload`, lines
240-286), used when the intent has any of title/body/data AND the subscription has both
`p256dh` and `auth`:
1. Decode base64url `p256dh` (must be 65-byte uncompressed P-256 point starting `0x04`) and
   `auth` (non-empty; spec says 16 bytes, code only checks non-empty).
2. Ephemeral P-256 ECDH (`prime256v1`) → 32-byte shared secret.
3. IKM = HKDF-SHA256(salt=authSecret, ikm=sharedSecret,
   info=`"WebPush: info\0" || ua_public || as_public`, len 32).
4. Random 16-byte content-encoding salt; CEK = HKDF(salt, IKM,
   `"Content-Encoding: aes128gcm\0"`, 16); NONCE = HKDF(salt, IKM,
   `"Content-Encoding: nonce\0"`, 12). (Single-block HKDF: `T(1)` only — fine for ≤32 bytes.)
5. AES-128-GCM over single record `plaintext || 0x02` (last-record delimiter, no padding);
   ciphertext = enc || 16-byte tag.
6. Body = `salt(16) || rs(4, big-endian u32) || idlen(1) || keyid(=65-byte ephemeral pubkey) || ciphertext`.
   **`rs` is written as `max(ciphertext.length, 4096)`** (line 283) — quirk: always ≥4096.
7. Headers `content-encoding: aes128gcm`, `content-length`. Encrypted body > 4096 octets →
   `failed` `push.payloadTooLarge` (message includes byte count) without dispatching.

Plaintext JSON (`encodeNotificationPayload`, lines 201-213; key order):
`{ intent[, title][, body][, data][, threadId][, deepLink] }`; returns nothing when
title+body+data all absent → **empty-body wake-up** fallback (`content-length: 0`, no
content-encoding header) — also used when subscription keys are missing (pre-FR-60 compat).

POST to the subscription endpoint. Result mapping (`mapStatus`): 2xx → `delivered` (no
receiptId); 404/410 → `push.unregistered`; 413 → `push.payloadTooLarge`; 429 →
`push.rateLimited`; ≥500 → `push.serverError`; else `push.deliveryFailed`. Message
`Web push <status>`.

### 3.10 FrickPushPayload — FROZEN wire contract (server adapters ↔ native SDK decoders)

Pinned end-to-end by `apps/server/tests/push-wire-contract.test.ts` (drives the *real* adapters
and asserts the exact key paths the Swift/Kotlin decoders read). Decoders:
`packages/swift/Sources/FrickSwift/Push/FrickPushPayload.swift` and
`apps/android/frick/src/main/java/dev/frick/client/FrickPushReceiver.kt`. Docs:
`docs/push-receive.md`.

Decoded client shape (Swift, `FrickPushPayload.swift:21-45`):
`intent: String` (required — payload without top-level `intent` is rejected/`nil`),
`title?`, `body?`, `threadId?`, `deepLink?`, `data: [String: String]`.

- **APNs (Swift `from(userInfo:)`)**: reads `userInfo["aps"]["alert"]["title"|"body"]`,
  `userInfo["aps"]["thread-id"]`, top-level `userInfo["intent"]` and `userInfo["deepLink"]`.
  `data` = every top-level key except `aps`/`intent`/`deepLink`, keeping string values and
  stringifying NSNumber values; other types dropped.
- **FCM (Kotlin `from(notification, data)`)**: `notification.title/body`; `data` map must be
  all-string; reserved keys `intent`, `threadId`, `deepLink` read out of `data`; remaining
  entries are custom data.

Any Rust adapter MUST reproduce §3.7's APNs JSON and §3.8's FCM message byte-for-byte in shape
(key paths + string-valued FCM data) or both mobile SDKs break.

### 3.11 Test adapter (`push/test-adapter.ts`)

`platform: "test"`; always `delivered` with `receiptId = "test-receipt-" + randomUUID()`;
records deliveries in-order on `adapter.delivered`; `reset()` clears. Registered by default at
boot for platform `test` unless overridden.

### 3.12 Admin push routes (`/_frick/admin/*`, admin-token auth, §5.2)

- `POST /_frick/admin/push/deliver` (`server.ts:4516-4567`): body
  `{ tenantId?, intent, recipientUserIds: string[], body?: {title?,body?,data?}, threadId?, deepLink? }`
  (tenantId resolved via `resolveAuthTenantId`, default tenant `_default`; tenant must be
  allowed). Builds the intent with the same string/shape filters as the router decode, audits
  `push.deliver` (strict — audit write failure aborts), enqueues, responds
  `201 { jobId: row.id (number), jobType: "push.deliver", status: row.status }`.
- `PUT /_frick/admin/tenants/{tenantId}/push/apns` (`server.ts:4940-4970`): body
  `{ keyId, teamId, bundleId, privateKeyPem, useSandbox?: boolean }` → `saveApnsCredentials`;
  `204` empty on success; credential errors → `400 { error: <code>, message }`
  (`sendPushCredentialError`, `server.ts:3353-3356` — both branches 400). Audit
  `push.apns.credentials.set`.
- `PUT /_frick/admin/tenants/{tenantId}/push/fcm` (`server.ts:4972-5003`): body
  `{ projectId, clientEmail, privateKey, tokenUri? }`. Audit `push.fcm.credentials.set`.
- `PUT /_frick/admin/tenants/{tenantId}/push/webpush` (`server.ts:5005-5033`): body
  `{ subject, publicKey, privateKey }`. Audit `push.webPush.credentials.set`.
  (Note the URL segment is lowercase `webpush`; the platform enum value is `webPush`.)

CLI equivalents: `frick tenants set-push --platform apns|fcm|webpush …`
(`docs/push-adapters.md:139-187`).

---

## 4. Admin / dashboard API surface (what `apps/dev-dashboard` consumes)

The dev-dashboard is a single-page vanilla-JS console (`apps/dev-dashboard/dashboard.js`,
`index.html`) served by the server itself at `/_frick/dashboard/` (assets) and talking to three
families of endpoints: public health probes, `/_frick/inspect/*`, `/_frick/dashboard/api/*`,
plus `POST /auth/dev-login`. Complete fetch inventory (from `dashboard.js`):

| Dashboard fetch (path, line) | Auth | Notes |
|---|---|---|
| `GET /health` (289) | none | |
| `GET /ready` (290) | none | |
| `GET /_frick/inspect/server` (291) | bearer | |
| `GET /_frick/inspect/apps` (292) | bearer | |
| `GET /_frick/inspect/db` (293) | bearer | |
| `GET /_frick/inspect/migrations` (294) | bearer | |
| `GET /_frick/inspect/metrics` (295) | bearer | |
| `GET /_frick/inspect/jobs` (296) | bearer | |
| `GET /_frick/inspect/projections` (297) | bearer | |
| `GET /_frick/inspect/search` (298) | bearer | |
| `GET /_frick/inspect/devtools/summary?windowMs=300000` (302) | bearer | |
| `GET /_frick/inspect/devtools/events?limit=50[&kind=…]` (303-307) | bearer | |
| `GET /_frick/dashboard/api/metadata` (383) | bearer | only when mounted |
| `GET /_frick/dashboard/api/analytics/summary?windowMs=86400000` or `GET /_frick/inspect/analytics/summary?windowMs=86400000` (386-391) | bearer | mounted vs standalone |
| `GET /_frick/dashboard/api/platform-events/health` or `GET /_frick/inspect/platform-events` (393-398) | bearer | mounted vs standalone |
| `GET /_frick/dashboard/api/data/objects/{type}?limit=25[&tenantId=…]` (400-407) | bearer | |
| `GET /_frick/dashboard/api/accounts?limit=25[&tenantId=…]` (409-414) | bearer | |
| `GET /_frick/dashboard/api/tenants?includeArchived=true&limit=50` (416-420) | bearer | |
| `GET /_frick/dashboard/api/tenant-settings?[tenantId=…]` (422-427) | bearer | |
| `GET /_frick/dashboard/api/blobs?limit=25[&tenantId=…][&ownerId=…]` (429-435) | bearer | |
| `GET /_frick/dashboard/api/jobs?limit=25[&tenantId=…][&status=…][&jobType=…]` (437-444) | bearer | |
| `POST /auth/dev-login` `{userId}` (446-464) | none | reads `body.sessionToken \|\| body.token` |

Bearer = `authorization: Bearer <token>` (`dashboard.js:263-264`). Static text also references
`/schema`, `/_frick/admin/backup`, `/_frick/admin/restore` as launch targets/links but the SPA
never fetches them programmatically.

### 4.1 Mount, method policy, security headers (`dashboard/routes.ts`)

Prefix `/_frick/dashboard` (line 35). `handleDashboardRoute` claims any path equal to or under
the prefix, **unconditionally** (no config gate; it runs after CORS, before app-path
resolution — `server.ts:1137-1153`). Only `GET`/`HEAD` allowed; other methods → 405 with
`allow: GET, HEAD`, `text/plain` body `method not allowed`. Bare `/_frick/dashboard` → 302 to
`/_frick/dashboard/`. Unknown paths under the prefix → 404 `{ error: "not_found" }`.

Every dashboard response (incl. assets) carries the security header set (lines 37-58):
CSP `default-src 'self'; script-src 'self'; script-src-attr 'none'; style-src 'self';
style-src-attr 'none'; img-src 'self' data:; connect-src 'self'; frame-src 'none';
object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
`x-frame-options: DENY`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`,
`cross-origin-opener-policy: same-origin`, `cross-origin-resource-policy: same-origin`,
`permissions-policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`, plus
`cache-control: no-store` on API responses. HEAD requests to API endpoints return status +
`content-type: application/json; charset=utf-8` and no body (lines 292-306).

**Assets** (`dashboard/assets.ts`): allowlist map only — `""`/`"/"`/`"/index.html"` →
`index.html`, `"/dashboard.css"`, `"/dashboard.js"`; anything else falls through to 404. Asset
root resolved by probing `../dev-dashboard`, `../../dev-dashboard`, `../../../dev-dashboard`
relative to the module (packaged vs source layouts); throws
`dashboard assets were not found` if absent. Content types: html/js/css with charset=utf-8;
`cache-control: no-store`; `content-length` set.

**Limit query param** (`optionalLimit`, routes.ts:266-271): non-numeric/≤0 → ignored (builder
default applies).

### 4.2 Authentication

Dashboard API + inspect endpoints authenticate via `inspectionPrincipalFromRequest`
(`server.ts:3821-3840`):
- `config.env === "production"` → **admin token only** (else 401
  `AuthenticationError("Missing or invalid admin token")`).
- otherwise: admin token if it matches; else a session bearer
  (`authorization: Bearer …` or `x-frick-session-token` header) resolved to an active-session
  principal (archived tenant → 401 `Tenant is archived`).

Admin principal (`adminPrincipalFromRequest`, `server.ts:3848-3868`): requires
`config.adminEnabled && config.adminToken` and an exactly-equal bearer; yields
`{userId:"_admin", deviceId:"_admin", replicaId:"_admin", tenantId:"_default", scope:"admin"}`.
Config: `adminToken` from `FRICK_ADMIN_TOKEN`; `adminEnabled` defaults to `!!adminToken`; in
production the token must be ≥32 chars (`config.ts:394-396, 500-504`). `/_frick/inspect/*` is
additionally gated by `config.inspectionEnabled` (off → routes simply don't exist; production
default off, warning if enabled — `config.ts:391-392, 497-498`). `/_frick/admin/*` returns 404
when `adminEnabled` is false; 401 vs 403 disambiguation: a valid *session* token on an admin
route → 403 `Admin scope required`, otherwise 401 (`server.ts:1387-1419`).

Every dashboard builder computes `scope = principal.scope === "admin" ? "admin" : "tenant"`;
tenant-scoped principals are pinned to their own `principal.tenantId` (any `tenantId` query
param ignored), admin may select `tenantId` (falling back to `_default`).

**HTTP error JSON shape** (all `sendError` paths, `server.ts:3344-3351`):
`{ error: <FrickErrorEnvelope>, code, message, requestId, retryable }` where the envelope also
carries `details?`, `schemaHash`, `schemaRevision`. Auth failures map to codes
`auth.unauthenticated` (401) / `auth.forbidden` (403) / `auth.sessionExpired`.

### 4.3 `/_frick/dashboard/api/*` endpoints (GET/HEAD; response shapes)

All builders fetch `limit + 1` rows and report `truncated = rows.length > kept.length`.
Default limit 50, max 200 (per-endpoint constants), `Math.floor` applied; invalid → default.
Every response includes `schemaHash` (the store schema's canonical hash) except `metadata` and
`platform-events/health`.

1. **`GET /api/metadata`** → `DashboardMetadata` (`dashboard/metadata.ts:13-63`):
   ```jsonc
   {
     "project": { "id", "name", "version"?, "displayName"?, "schemaId", "schemaVersion",
                  "schemaRevision": number, "schemaHash" },
     "resources": [ { "kind": "object"|"stream"|"event"|"presence"|"signal"|"blob"|"job"|"projection",
                      "name", "fieldCount": number, "indexCount"?: number } ],
     "apps": [ { "id", "basePath", "schemaId", "schemaRevision": number } ],
     "platformEvents"?: PlatformEventHealth
   }
   ```
   Resource enumeration order: objects, streams, events, presences, signals, blobs, jobs,
   projections (schema declaration order within each). fieldCount per kind: object `fields.length`
   (+`indexCount`); stream `keyFields.length`; event `fields.length`; presence
   `fields.length + keyFields.length`; signal same; blob `metadataFields.length`; job
   `fields.length`; projection `fields.length` (+`indexCount`).

2. **`GET /api/analytics/summary?windowMs&limit`** → `AnalyticsSummary`
   (`analytics/summary.ts:10-49`): `{ family: "analytics.user_event", generatedAt, since,
   windowMs, scope: {kind:"admin"}|{kind:"tenant",tenantId}, totals: {events, uniqueUsers,
   uniqueTenants}, topEvents: [{name,count}], topRoutes: [{path,count}],
   recentEvents: [{eventId,name,tenantId|null,accountId|null,subjectId|null,traceId|null,
   occurredAt,acceptedAt,properties,context}] }`. windowMs clamped to
   [60 000, 2 592 000 000], default 86 400 000; default result limit 10.

3. **`GET /api/accounts?tenantId&limit`** → (`dashboard/accounts.ts`)
   `{ schemaHash, tenantId, scope, limit, count, truncated, accounts: StoredAccount[] }`;
   `StoredAccount = { tenantId, userId, handle, displayName, createdAt }`.

4. **`GET /api/tenants?includeArchived&limit`** → (`dashboard/tenants.ts`)
   `{ schemaHash, scope, includeArchived, limit, count, truncated, tenants: TenantRow[] }`;
   `TenantRow = { tenantId, displayName?, createdAt, archivedAt? }`. Tenant scope sees only its
   own row (empty if archived and `includeArchived` not `"true"`).

5. **`GET /api/tenant-settings?tenantId`** → (`dashboard/tenant-settings.ts`)
   ```jsonc
   { "schemaHash", "tenantId", "scope",
     "settings": {
       "limits": { /* subset of maxBlobBytes, maxStreamAppendPayloadBytes,
                      maxSubscriptionsPerConnection, maxPendingAppendsPerClient —
                      finite numbers ≥ 0 only */ },
       "retentionMs"?: number,
       "push": { "apns": {"configured": bool}, "fcm": {...}, "webPush": {...} },
       "configuredKeys": [sorted raw setting keys],
       "redactedKeys":   [keys ending ".encrypted"],
       "otherKeys":      [keys not in {limits, retentionMs, push.*.encrypted}]
     } }
   ```
   `configured` = stored value is a non-empty string. **Ciphertext never leaves the server.**

6. **`GET /api/blobs?tenantId&ownerId&limit`** → (`dashboard/blobs.ts`)
   `{ schemaHash, tenantId, ownerId?, scope, limit, count, total, truncated, blobs: [...] }`;
   blob row `{ tenantId, blobId, ownerId, contentHash, byteLength, mimeType, derivatives,
   createdAt }`; derivatives summary `{ count, totalBytes, processors: sorted-unique[],
   mimeTypes: sorted-unique[], hasMetadata: bool, latestCreatedAt? }`. Tenant scope forces
   `ownerId = principal.userId`; only admin may pass `ownerId`/leave it unset.

7. **`GET /api/jobs?tenantId&status&jobType&limit`** → (`dashboard/jobs.ts`)
   `{ schemaHash, tenantId?, scope, status?, jobType?, limit, count, truncated, jobs: [...] }`;
   job row `{ id: number, tenantId, jobType, status, attemptCount, maxAttempts, availableAt,
   createdAt, claimedAt?, completedAt?, failedAt?, deadLetteredAt?, lastErrorCode? }` —
   deliberately excludes `payload`, `lastErrorMessage`, `claimedBy`, `idempotencyKey`, `appId`.
   `status` filter validated against `{"ready","running","completed","dead_lettered"}` (else
   ignored); jobType trimmed. Admin with no `tenantId` lists across tenants.

8. **`GET /api/data/objects/{type}?tenantId&limit`** → (`dashboard/data.ts`)
   unknown type → 404 `{ error: "unknown_object_type", type }` (also returned for empty/multi-segment
   or undecodable type segments, which parse to `""`). Else
   `{ schemaHash, type, tenantId, scope, limit, count, total, truncated, rows: PlainObject[] }`.
   Admin lists all rows; tenant scope lists only rows visible to the user
   (`listObjectsForUser`). **Rows pass through `redactRecords` masking schema fields classified
   `secret`/`pii`/`content`** (unannotated = `private`, NOT masked; `public` untouched).

9. **`GET /api/platform-events/health`** → `PlatformEventHealth`
   (`platform-events/types.ts:77-92`): `{ adapter: "memory"|"sqlite"|"kafka", ok, pending,
   claimed, deadLettered, retained, unclaimed, consumers: [{name, pending, claimed,
   deadLettered, lag}] }`.

### 4.4 `/_frick/inspect/*` endpoints consumed by the dashboard (`server.ts:1211-1385`)

GET only; gated by `config.inspectionEnabled`; auth per §4.2. Shapes:

- `server` → `{ schemaId, schemaVersion, schemaRevision, schemaHash, appId, env,
  demoAuthEnabled, inspectionEnabled, startedAt }` (active-app schema).
- `apps` → `{ apps: [{ id, basePath, schemaId, schemaRevision }] }`.
- `migrations` → `{ applied: [{ id, schemaRevision, appliedAt, checksum, durationMs }] }`.
- `metrics` → `{ snapshotAt, uptimeSeconds, counters: [{name, fields?, value}],
  gauges: [...] }` — entries sorted by (name, fieldKey) (`metrics.ts:139-161`). Dashboard
  reads `frick.http.requests.total` (field `status`), `frick.ws.frames.total` (field `kind`),
  gauge `frick.ws.connections.current`.
- `platform-events` → `PlatformEventHealth` (same as §4.3.9).
- `analytics/summary` → same as §4.3.2.
- `projections` → `{ projections: [{ name, sources, supportsRebuild, supportsRead }] }`.
- `search` → `{ adapter: <id>, indexes: [{ name, source }] }`.
- `db` → `{ ready: bool, applied: number, lastApplied?: { id, schemaRevision, appliedAt },
  idempotencyCache: { size, capacity, evictions } }`.
- `jobs` → `{ registeredHandlers: string[], counts: Record<JobStatus, number>, workerEnabled }`.
- `devtools/events?kind&tenantId&sinceId&limit` →
  `{ events: [{ id: number, occurredAt, kind, tenantId: string|null, fields: object }] }`
  newest-first; default limit 200, hard cap 1000.
- `devtools/summary?windowMs` (default 60 000) → `{ windowMs, total, byKind: Record<string, number> }`.
- `devtools/events/{id}` → `{ event: row }` or 404 `{ error: "not_found" }`.
- anything else → 404 `{ error: "not_found" }`.

### 4.5 Public + auth endpoints the dashboard uses

- `GET /health` → `200 { ok: true, service: "frick-server", status: "ok" }` (`server.ts:1174-1177`).
- `GET /ready` → ready: `200 { status: "ready", schemaId, schemaRevision, schemaHash,
  appliedMigrations }`; not ready: `503 { status: "not-ready",
  reason: "database_unresponsive"|"migrations_unavailable", …same fields… }`
  (`server.ts:1186-1209`).
- `GET /schema` → the full active-app `FrickSchema` JSON (`server.ts:1438-1441`).
- `POST /auth/dev-login` (`server.ts:1525-1581`): gated by `config.demoAuthEnabled` (403
  `Demo authentication is disabled in this environment` when off; forbidden in production).
  Body `{ userId, tenantId?, platform?, deviceId?, replicaId? }`. Auto-creates the account if
  missing (handle via `devHandleFromUserId` — globally unique per userId; see memory note),
  rate-limited per identity+IP. Response 200
  `{ schemaHash, sessionToken, tenantId, userId, deviceId, replicaId, expiresAt }`. The
  dashboard accepts `sessionToken` or legacy `token`.

### 4.6 Full `/_frick/admin/*` route inventory (context; admin-token auth, JSON, audited)

From the `handleAdminRoute` dispatcher (`server.ts:3967-5068`): `GET audit-log`,
`POST sessions/revoke`, `GET|POST tenants`, `POST tenants/{id}/archive`,
`GET tenants/{id}/settings`, `PUT tenants/{id}/settings/{key}`, `GET tenants/{id}`,
`GET|POST accounts`, `POST accounts/move`, `POST jobs/{jobType}` (enqueue),
`POST push/deliver` (§3.12), `POST backup` (NDJSON stream,
`application/x-ndjson`), `POST restore`, `POST search/{index}/rebuild`,
`POST projections/{name}/rebuild`, `GET data-subject`, `POST data-subject/erase`,
`GET compliance/manifest`, `GET compliance/audit/verify` (200/409 by chain validity),
`PUT tenants/{id}/push/apns|fcm|webpush` (§3.12), `POST schema/lint`; fallback 404
`{ error: "not_found" }`. The dev-dashboard does not call these programmatically.

---

## 5. Gotchas / surprises checklist (for the Rust port)

1. **msgpack everywhere on the bus** — `@msgpack/msgpack` `encode`/`decode` of plain objects
   (string-keyed maps, insertion order per §1.3) and tuples-as-arrays (`PackedStreamEvent`,
   `PackedField`). JSON would corrupt binary packed-field values.
2. **Redis cluster channel `frick:cluster`; region channel `frick:region`** — both single
   channels, two connections each (subscriber can't PUBLISH), `messageBuffer` (raw bytes).
3. **Empty subscribed-tenant set means drop everything**, and `undefined` (never called) means
   pass everything — three-state behavior, snapshot on set.
4. **`_media_placement` sentinel is NOT exempted from the node-level tenant filter** (it IS
   exempted at the region-federation hop) — see §1.7; decide consciously.
5. **Media placement tie-break: lexicographically lowest `nodeId` wins**; losing claimant
   fires `onYieldHome`; 1 h TTL self-heal; release only announced by the owning home.
6. **Signed region frames**: HMAC-SHA256 over `u32be(v) || u32be(ts_hi) || u32be(ts_lo) ||
   nonce(16) || payload`, v=1, 5-min replay window, timing-safe compare, nonce de-dupe;
   asymmetric-config frames are dropped (no silent downgrade in either direction).
7. **APNs/VAPID ES256 signatures must be IEEE-P1363 raw r||s (64 bytes)**, not DER; FCM JWT is
   RS256/DER (Node default). base64url = strip padding, `+→-`, `/→_`.
8. **APNs JWT has no `exp`** (only `iss`/`iat`), refresh at 50 min; FCM token cache refreshes
   60 s early; VAPID JWT exp = +12 h, cached 12 h per (publicKey, origin).
9. **Push payload is a frozen contract** (§3.10): APNs hoists custom data to top level next to
   `aps`/`intent`/`deepLink`, always sets `aps.sound = "default"`; FCM `data` values must all
   be strings (non-strings JSON-stringified) and custom data can shadow reserved keys.
10. **Credential envelope** = base64(iv12 ‖ ct ‖ tag16), AES-256-GCM, key =
    base64-32-bytes `FRICK_PUSH_CRED_KEY`, multi-key decrypt via `FRICK_PUSH_CRED_KEY_PREVIOUS`
    (primary-first order). Unset key = adapters return `skipped` (`push.credentials.disabled`),
    never plaintext fallback.
11. **Web Push SSRF guard resolves DNS at send time** and rejects private/special ranges for
    every resolved address; `rs` field in the aes128gcm header is `max(len, 4096)`.
12. **`push.deliver` jobs complete even when all deliveries fail** — partial fan-out is by
    design; only payload-decode (`push.invalidIntent`, non-retryable) and router infra errors
    (`push.routerError`, retryable) fail the job.
13. **Dashboard is mounted unconditionally** at `/_frick/dashboard` (no config flag) but every
    API call authenticates; in production only the admin token works. `/_frick/inspect/*` is
    config-gated (`inspectionEnabled`); `/_frick/admin/*` is 404 unless an admin token is set.
14. **Dashboard list endpoints fetch limit+1** to compute `truncated`; limits clamp to
    [1, 200] with default 50; object rows pass `redactRecords` (secret/pii/content masked,
    private NOT masked).
15. Dashboard/inspect JSON deliberately omits sensitive columns: job rows drop
    payload/lastErrorMessage/claimedBy; tenant-settings reports only `configured: true/false`
    for `*.encrypted` keys.
16. `server.close()` does **not** close an injected cluster bus; APNs adapter `close()` must be
    called separately too (HTTP/2 sessions otherwise keep the process alive).
17. The HTTP error body shape is `{ error: envelope, code, message, requestId, retryable }` —
    the dashboard parses `body.error.message || body.message || body.error`.
