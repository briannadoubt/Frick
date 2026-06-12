# Map 05 — Projections, Durable Jobs, Blobs

Implementation-grade specification for the Rust rewrite. All paths relative to
`/Users/bri/dev/Frick` unless absolute. Line numbers verified against the working tree on
2026-06-10 (post v0.3.0).

Scope: `apps/server/src/projections/**`, `apps/server/src/jobs/**`, `apps/server/src/blobs/**`,
`apps/server/src/storage/{job-store,blob-store,blob-bytes-driver,blob-derivative-store}.ts`,
blob/projection HTTP routes in `apps/server/src/server.ts`, projection frames in
`apps/server/src/sync/gateway.ts` + `packages/protocol/src/frame.ts`, admin/dashboard
introspection.

---

## 1. Projections

### 1.1 Registry model (`apps/server/src/projections/registry.ts`)

- A projection = `{ name, sources, handler }` (`FrickProjection`, registry.ts:116–122).
  `name` is a stable identifier (e.g. `activity-feed`).
- `sources`: readonly array of `{ kind: "object", type }` or `{ kind: "stream", type }`
  (registry.ts:20–34). `type` is the schema object/stream type name.
- Dispatch event `FrickProjectionWriteEvent` (registry.ts:36–55), exact fields:
  - `kind: "objectUpsert" | "objectDelete" | "streamEvent"`
  - `tenantId: string`
  - `appId?: string` (FR-153; conceptually defaults to `"_default"`)
  - object events: `objectType?`, `objectId?`, `object?` (current state after upsert;
    undefined on delete)
  - stream events: `streamType?`, `streamId?`, `streamEvent?`
- Handler interface `FrickProjectionHandler` (registry.ts:88–114):
  - `apply(event, ctx)` — called after each matching source write succeeds; MUST be idempotent
    (framework may replay during rebuild). Returns `void` or `{ changes: ProjectionChange[] }`
    (sync or Promise).
  - optional `rebuild(ctx)` — invoked by the admin rebuild route + `rebuildAll`.
  - optional `read(ctx, query: Record<string,string>)` — wired to `GET /projections/:name`;
    absent → HTTP 405.
- `ProjectionChange` = `{ key: string, value: PlainObject | null }`; `value === null` means
  delete that row (registry.ts:65–70). `ProjectionApplyResult` = `{ changes }` (72–74).
- `ProjectionDeltaNotice` = `{ projection, tenantId, appId?, changes }` (registry.ts:76–86);
  `appId` key is only present when ctx had one (`...(ctx.appId !== undefined ? { appId } : {})`,
  registry.ts:235 — field-presence matters for msgpack-ish fidelity, though this notice is
  internal; the cluster envelope normalizes `appId ?? "_default"`).
- `FrickProjectionContext` = `{ tenantId, appId?, store, logger }` (registry.ts:57–63).

Registry behavior (`createFrickProjectionRegistry`, registry.ts:164–285):

- `register`: duplicate name throws `Error('Projection "<name>" is already registered')`
  (registry.ts:202–208). Registration order is preserved (array + Map).
- Matching (registry.ts:210–217): object source matches `objectUpsert`/`objectDelete` with
  `source.type === event.objectType`; stream source matches `streamEvent` with
  `source.type === event.streamType`.
- `notify(event, ctx)` (registry.ts:219–255): iterates projections **in registration order**;
  for each whose `sources.some(matches)`:
  1. `await handler.apply(event, ctx)`.
  2. If result has `changes.length > 0`: apply to the in-memory snapshot **regardless of
     whether a delta listener is attached** (registry.ts:224–229).
  3. If also a `deltaListener` is set, invoke it with the notice; listener exceptions are
     caught + logged `frick.projection.delta_listener_failed` (registry.ts:230–245).
  4. Handler exceptions are caught + logged `frick.projection.apply_failed` — a projection
     failure NEVER fails the originating write (registry.ts:246–252).
- Snapshot state (registry.ts:170–200): in-memory
  `Map<projectionName, Map<tenantId, Map<rowKey, PlainObject>>>`. `null` change deletes the
  key; empty tenant maps / projection maps are pruned. **NOT persisted** — a restart loses all
  materialized rows; they repopulate only as new writes flow through `apply`. (Rust rewrite:
  this is acceptable-by-design volatile state.)
- `snapshot(name, tenantId)` (registry.ts:277–283): returns
  `[...rows.entries()].map(([key, value]) => ({ key, value }))` — JS Map insertion order;
  `[]` for unknown projection or empty tenant.
- `setDeltaListener(listener|undefined)` — single listener only (v1, the sync gateway);
  `createFrickProjectionRegistry({ onDelta })` sets an initial one (registry.ts:159–169).
- `rebuildAll(ctx)` (registry.ts:257–266): sequentially awaits `rebuild` on each projection
  that has one; returns `{ rebuilt: string[] }` (names actually rebuilt).

### 1.2 Helpers (`apps/server/src/projections/helpers.ts`, FR-134)

- `listProjectionObjects(ctx, type)` = typed
  `ctx.store.listObjects(ctx.tenantId, type, ctx.appId)` (helpers.ts:26–31).
- `singleChange(key, value)` = `{ changes: [{ key, value }] }` (helpers.ts:38–40).
- `projectionSourceObjectTypes(projections)` — de-duped object-source types, stream sources
  ignored (helpers.ts:47–59).

### 1.3 Boot registration & validation (`apps/server/src/server.ts`)

- `registerProjections(registry, options.projections ?? [], runtimeSchema)` at server.ts:538–539,
  function at server.ts:3125–3144: every declared source `type` must exist in the active
  schema's `schema.objects[].name` / `schema.streams[].name`, else boot throws
  `FrickConfigError` with message
  `Projection "<name>" declares an unknown <kind> source "<type>". It must reference a <kind>
  type defined in the active schema "<schemaId>".`
- Per-app registries (FR-153, server.ts:546–580): when any app declares projections or jobs,
  each app gets its own projection + job registries (`apps/per-app-registries.ts`). The default
  app (`_default`) registry carries the server-wide projections; per-app projections register
  only into their app's registry.

### 1.4 Write-path dispatch (`apps/server/src/store.ts`)

- `FrickStore.#notifyProjections(event)` (store.ts:1265–1280): builds ctx
  `{ tenantId, appId: event.appId ?? DEFAULT_APP_ID, store: this, logger }` and routes to
  `perAppRegistries.for(appId).projections` when configured, else the shared
  `store.projections` registry.
- Call sites:
  - legacy positional `upsertObject` 6-arg path → `objectUpsert` with post-write `stored`
    object (store.ts:977–984); 4-arg path uses `DEFAULT_TENANT_ID` and **omits appId**
    (store.ts:1003–1009).
  - `upsertObjectWithPolicy` → `objectUpsert` with re-read stored value (store.ts:1075–1082) —
    this is the path used by HTTP object routes and the WS ObjectUpsert frame.
  - `appendEvent` → `streamEvent` only when `result.created` (idempotent replays don't
    re-notify), with `streamEvent: result.event` = full stored event row (store.ts:1184–1220).
- **SURPRISING / load-bearing**: `deleteObject` (store.ts:1105–1127) fires ONLY the gateway
  write listener (`objectDelete`) — it does **NOT** call `#notifyProjections`. Although the
  registry supports matching `objectDelete` events, no store path emits them to projections.
  A Rust rewrite must preserve this (projections never see deletes) for behavioral parity.
- Search notify + projection notify failures never propagate to the writer; write-listener
  (gateway) throws are also swallowed (store.ts:1293–1299).

### 1.5 HTTP read surface (`apps/server/src/server.ts`)

- `GET /projections` (server.ts:2128–2137) → 200
  `{ schemaHash: store.schema.hash, projections: [{ name, sources }] }`.
  Note: served from the SHARED registry (`store.projections`) — per-app projections do not
  appear here.
- `GET /projections/:name` (server.ts:2139–2185):
  - name = `decodeURIComponent(pathname.slice("/projections/".length))`.
  - unknown → `ProjectionNotFoundError` → HTTP 404, envelope code `sync.protocolError`,
    `details.reason = "projectionNotFound"`, `details.projection = name`
    (class server.ts:3108–3116; status mapping server.ts:3280–3281; details 3308–3311).
  - registered but no `read` → HTTP 405 raw JSON
    `{ error: "method_not_allowed", message: 'Projection "<name>" does not implement read' }`
    (server.ts:2150–2154) — note: NOT the standard error envelope.
  - else: builds `query` from all URL search params; authz via
    `assertCanSubscribe(principal, "projection", name, query.key, ...)` (the `key` query param
    doubles as the subscription key); responds 200
    `{ schemaHash, projection: name, data }` where `data = handler.read(ctx, query)`.
  - **SURPRISING**: (a) `read` result is not awaited before being placed in the body —
    `const data = projection.handler.read(ctx, query)` (server.ts:2175) has no `await`, so an
    async `read` serializes as `{}` (JSON.stringify of a pending Promise). (b) read ctx is
    `{ tenantId, store, logger }` — no `appId` (server.ts:2170–2174).

### 1.6 Live deltas over the sync gateway

Protocol (`packages/protocol/src/frame.ts`):

- Frames are msgpack-encoded 2-element arrays `[kind, payload]` via `@msgpack/msgpack`
  `encode`/`decode` (frame.ts:215–222). `PROTOCOL_VERSION = 1` (frame.ts:13).
- `FrameKind.ProjectionDelta = 19` (frame.ts:35).
- `ProjectionDeltaPayload` = `{ projection: string, changes: ProjectionDeltaChange[] }`;
  `ProjectionDeltaChange` = `{ key: string, value: PlainObject | null }` (frame.ts:177–188).
  Field order in the payload map: `projection`, then `changes` (as constructed at
  gateway.ts:663 and 1385).
- `SubscriptionKind` includes `"projection"` (frame.ts:43); `SubscribePayload` =
  `{ subscriptionId, kind, name, key?, cursor? }` (frame.ts:54–60).

Gateway (`apps/server/src/sync/gateway.ts`) — NOTE this file contains an intentional NUL byte;
search with `rg --text` / `grep -a`:

- Construction wires `projections.setDeltaListener(notice => publishProjectionDelta(notice))`
  (gateway.ts:205–206); per-app mode also installs per-app listeners. Listener cleared on
  gateway close (gateway.ts:345).
- `publishProjectionDelta(notice)` (gateway.ts:625–640): local fan-out, then (if cluster bus)
  publish envelope `{ kind: "projectionDelta", originNodeId, tenantId, appId: notice.appId ??
  DEFAULT_APP_ID, projection, changes }`. Remote nodes re-fan-out via the cluster handler
  (gateway.ts:963–968), local-only (no re-publish loop).
- Local fan-out `#fanOutProjectionDelta` (gateway.ts:642–666): for each subscriber of that
  projection name: skip if no/inactive principal; skip if `principal.tenantId !==
  notice.tenantId`; skip if connection's appId !== `notice.appId ?? "_default"`; filter
  changes via `filterProjectionChangesForPrincipal` (currently a pass-through returning all
  changes — gateway.ts:2342–2350 — a placeholder seam); skip frame when 0 changes; send
  `[FrameKind.ProjectionDelta, { projection, changes }]`.
- Subscribe handling (`#handleSubscribe`, gateway.ts:1307–1388):
  - over-limit subscriptions → Nack `rateLimit.exceeded` with
    `details.limit = "maxSubscriptionsPerConnection"`.
  - `kind === "projection"` with unknown name (resolved against the CONNECTION's app registry,
    `#projectionsFor`, gateway.ts:500–514) → Nack envelope `code: "auth.forbidden"`,
    message `Unknown projection <name>`, `details: { reason: "projectionNotFound",
    projection }` (gateway.ts:1333–1350).
  - authz via `assertCanSubscribe` (same as HTTP).
  - on success, subscription recorded, then **initial snapshot is delivered as a single
    ProjectionDelta frame** whose changes are the registry's materialized rows for the
    principal's tenant (gateway.ts:1371–1387). No cursor; the client treats snapshot rows
    exactly like incremental deltas. Empty snapshot (fresh restart / no rows) sends an empty
    `changes: []` frame.
- Projection deltas have NO durable cursor/catch-up: missed deltas while disconnected are
  recovered only via the snapshot-on-resubscribe (which itself only covers rows the handler
  has declared since process start). `SubscribePayload.cursor` is unused for projections.

### 1.7 Rebuild (admin)

`POST /_frick/admin/projections/:name/rebuild` (server.ts:4751–4817, regex
`/^projections\/([^/]+)\/rebuild$/` on the path after `/_frick/admin/`):

- `tenantId` query param; empty/absent → `DEFAULT_TENANT_ID`; validated by
  `validateTenantId` (audited error on failure).
- Unknown projection → audit `outcome: "deny"`, `detail.reason = "projectionNotFound"`, throws
  `ProjectionNotFoundError` (404).
- No `rebuild` method → audit deny `rebuildNotSupported`, HTTP 405
  `{ error: "method_not_allowed", message: 'Projection "<name>" does not support rebuild' }`.
- Else: audit `outcome: "allow"` with `detail.tenantId`, then calls
  `projection.handler.rebuild(ctx)` — **not awaited** (server.ts:4802; an async rebuild runs
  in the background and rejections escape the try/catch) — and immediately responds 200
  `{ projection: name, tenantId, rebuiltAt: <now ISO> }`.
- ctx = `{ tenantId: normalizeTenantId(tenantId), store, logger }` — again no `appId`.
- All admin audit entries use `action: "projections.rebuild"`, `target: name`.

### 1.8 Admin introspection

`GET /_frick/inspect/projections` (server.ts:1279–1288, gated by `config.inspectionEnabled`;
all `/_frick/inspect/*` is GET-only): 200

```json
{ "projections": [ { "name", "sources", "supportsRebuild": bool, "supportsRead": bool } ] }
```

(`supportsRebuild`/`supportsRead` = `typeof handler.X === "function"`.) Also from the shared
registry only.

---

## 2. Durable jobs

### 2.1 Table schema

SQLite (`apps/server/src/storage/migrations.ts`); Postgres mirror in
`apps/server/src/storage/pg-framework-migrations.ts` (same migration ids; differences:
`packed BYTEA`, `id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY` — pg-framework-
migrations.ts:113–119).

Base table (migration `0001`, migrations.ts:169–175):

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL,
  packed BLOB NOT NULL,        -- msgpack(payload); overwritten with msgpack(result) on complete
  status TEXT NOT NULL,
  created_at TEXT NOT NULL     -- ISO-8601 (new Date().toISOString())
);
```

Additive migrations:

- tenancy (migrations.ts:311–313): `tenant_id TEXT NOT NULL DEFAULT '_default'` + index
  `idx_jobs_tenant (tenant_id, job_type, status, id)`.
- `0006_jobs_lifecycle` (migrations.ts:423–453):
  `available_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'`,
  `max_attempts INTEGER NOT NULL DEFAULT 5`, `attempt_count INTEGER NOT NULL DEFAULT 0`,
  `claimed_at TEXT`, `claimed_by TEXT`, `completed_at TEXT`, `failed_at TEXT`,
  `dead_lettered_at TEXT`, `idempotency_key TEXT`, `last_error_code TEXT`,
  `last_error_message TEXT`.
  Backfills: `available_at = created_at` where epoch-default; legacy `'queued'` → `'ready'`;
  legacy `'running'` → `'ready'` **with `attempt_count += 1`** (crash recovery, at-least-once).
  Indexes: `idx_jobs_status_available_at (tenant_id, status, available_at)`; UNIQUE partial
  `idx_jobs_idempotency_key (tenant_id, job_type, idempotency_key) WHERE idempotency_key IS
  NOT NULL`.
- app partition (migrations.ts:955–959): `app_id TEXT NOT NULL DEFAULT '_default'` + indexes
  `idx_jobs_app_tenant (app_id, tenant_id, job_type, status, id)`,
  `idx_jobs_app_tenant_status_available_at (app_id, tenant_id, status, available_at)`.
- `0022_jobs_idempotency_app_scope` (migrations.ts:986–993): drops and recreates the unique
  idempotency index as `(app_id, tenant_id, job_type, idempotency_key) WHERE idempotency_key
  IS NOT NULL`.

### 2.2 Status model (`apps/server/src/storage/job-store.ts`)

`type JobStatus = "ready" | "running" | "completed" | "dead_lettered"` (job-store.ts:19).
There is NO terminal `failed` status (job-store.ts:6–18): failures either re-arm to `ready`
(with backoff) or short-circuit to `dead_lettered`. `countsByStatus()` adds a **synthetic
`failed` bucket** = `COUNT(*) WHERE last_error_code IS NOT NULL` regardless of status
(job-store.ts:371–403); response shape `{ ready, running, completed, dead_lettered, failed }`
— that key order (job-store.ts:377–384).

`JobRow` (job-store.ts:21–41), camelCase mapping in `mapRow` (job-store.ts:438–460), exact
field insertion order: `id` (Number), `tenantId`, `appId` (`row.app_id ?? "_default"`),
`jobType`, `payload` (= `msgpack.decode(packed)`), `status`, `attemptCount` (Number),
`maxAttempts` (Number), `availableAt`, `createdAt`; then conditionally (only when truthy):
`claimedAt`, `claimedBy`, `completedAt`, `failedAt`, `deadLetteredAt`, `idempotencyKey`,
`lastErrorCode`, `lastErrorMessage`.

### 2.3 Backoff

- `BACKOFF_BASE_MS = 60_000`; `BACKOFF_CAP_MS = 5 * 60 * 1000` (job-store.ts:85–88).
- `jobBackoffMs(attemptCount) = min(60_000 * 2^(max(1, attemptCount) - 1), 300_000)`
  (job-store.ts:116–120). Attempt 1 → 60s, 2 → 120s, 3 → 240s, 4+ → 300s (capped).

### 2.4 Enqueue (job-store.ts:122–187)

`enqueue({ tenantId, appId?, jobType, payload, idempotencyKey?, availableAt?, maxAttempts? })`
(legacy 3-positional-arg overload retained, job-store.ts:134–143):

- `appId` defaults to `DEFAULT_APP_ID = "_default"` (`apps/server/src/app-id.ts`).
- Idempotency pre-check: `SELECT ... WHERE app_id = ? AND tenant_id = ? AND job_type = ? AND
  idempotency_key = ? LIMIT 1`; existing row returned unchanged — **dedupe applies across
  terminal states** (re-enqueueing a completed/dead-lettered job with the same key returns the
  terminal row; pick a new key to actually retry) (job-store.ts:125–155). Note: check-then-
  insert (not atomic); the unique partial index is the real guard — concurrent duplicate
  inserts surface as a constraint error.
- Insert (job-store.ts:163–179): column order
  `(app_id, tenant_id, job_type, packed, status, created_at, available_at, max_attempts,
  attempt_count, idempotency_key)` with `status='ready'`, `attempt_count=0`,
  `created_at = now ISO`, `available_at = input.availableAt ?? now`,
  `max_attempts = input.maxAttempts ?? 5`, `packed = Buffer(msgpack.encode(payload))`,
  `idempotency_key = input.idempotencyKey ?? NULL`. Uses `RETURNING id` then re-reads the row.

### 2.5 Claim / locking (job-store.ts:189–251)

```sql
UPDATE jobs SET
  status = 'running', claimed_at = ?, claimed_by = ?, attempt_count = attempt_count + 1
WHERE id IN (
  SELECT id FROM jobs
  WHERE status = 'ready' AND available_at <= ?  [AND job_type = ?]  [AND app_id = ?]
  ORDER BY available_at ASC, id ASC
  LIMIT ?
  [FOR UPDATE SKIP LOCKED]        -- only when sql.dialect === "postgres" (job-store.ts:231)
)
RETURNING *
```

- Signature `claim(workerId, jobType?, limit = 10, appId?)`. Omitting `jobType`/`appId` claims
  across all types/apps. `available_at <= now` uses ISO-8601 string comparison (lexicographic
  == chronological for this format).
- `attempt_count` increments **at claim time**; the fail-path budget check is therefore
  `row.attemptCount < row.maxAttempts` post-claim (job-store.ts:277–294).
- SQLite relies on its single-writer serialization; Postgres uses `FOR UPDATE SKIP LOCKED`
  (FR-28) so concurrent claimers take disjoint sets.

### 2.6 Complete / fail (job-store.ts:253–320)

- `complete(jobId, result?)`: `UPDATE ... SET status='completed', completed_at=now [, packed =
  msgpack(result)] WHERE id = ? AND status != 'dead_lettered'`. Re-completing completed = no-op;
  completing dead-lettered = rejected (guard). When `result` is provided the original payload
  is **overwritten** in `packed` for operator inspection (job-store.ts:257–268).
- `fail(jobId, errorCode, errorMessage, retryable)`:
  - missing row → silent return.
  - `retryable && attemptCount < maxAttempts` → `status='ready'`,
    `available_at = now + jobBackoffMs(attemptCount)` (ISO), `failed_at = now`,
    `last_error_code/message` set, `claimed_at = NULL`, `claimed_by = NULL`
    (job-store.ts:294–308).
  - else → `status='dead_lettered'`, `dead_lettered_at = failed_at = now`, error columns set;
    claimed_* NOT cleared (job-store.ts:310–319).

### 2.7 List / getById / next

- `list(filter)` (job-store.ts:322–351): optional equality filters `tenant_id`, `app_id`,
  `status`, `job_type`; `ORDER BY id DESC LIMIT ?` (default 100).
- `getById(jobId, tenantId?, appId?)` (job-store.ts:353–369).
- Legacy `next(tenantId, type, appId = "_default")` (job-store.ts:411–420): claims 1 with
  `workerId = "legacy:<tenantId>"`; returns `StoredJob` `{ id, name: jobType, value: payload }`.

### 2.8 Handler registry (`apps/server/src/jobs/registry.ts`)

- `FrickJobContext` = `{ tenantId, appId?, jobId, jobType, payload, attemptCount, store,
  logger }` (registry.ts:17–32).
- `FrickJobResult` = `{ status: "completed" | "failed", result?, errorCode?, errorMessage?,
  retryable? }` (registry.ts:46–52).
- `register` throws `DuplicateJobHandlerError` (`name = "DuplicateJobHandlerError"`,
  `reason = "duplicateJobHandler"`, message
  `A handler is already registered for job type "<type>"`) (registry.ts:62–68).
- `list()` returns handler type names **sorted** (registry.ts:82–84).

### 2.9 Worker (`apps/server/src/jobs/worker.ts`)

Constants (worker.ts:64–66): `DEFAULT_POLL_INTERVAL_MS = 500`,
`DEFAULT_CLAIM_BATCH_SIZE = 5`, `DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000`.
`workerId` default = `worker-` + first 8 chars of `randomUUID()` (worker.ts:81).

Loop (worker.ts:91–126):
- single `setTimeout(tick, pollIntervalMs)` chain, timer `unref()`'d (daemon — must not keep
  the event loop alive).
- tick: `store.jobs.claim(workerId, undefined, claimBatchSize)` — **all job types, all apps**
  (per-app scoping happens at dispatch, not claim). Claimed metric:
  `frick.jobs.claimed.total += claimed.length`.
- Jobs in a batch run **serially**; early-exits between jobs when stop requested.
- A throwing claim/tick logs `frick.jobs.tick_error` (error level) and keeps polling.

Dispatch (`runJob`, worker.ts:128–218):
- handler registry: `perAppRegistries.for(job.appId).jobs` when configured, else shared
  (worker.ts:134–137).
- ctx: `{ tenantId, appId, jobId, jobType, payload, attemptCount, store: store.forApp(job.appId),
  logger: child({jobId, jobType, tenantId, attemptCount}) }` (worker.ts:138–159). `forApp` makes
  legacy store writes default to the job's app partition; `forApp("_default")` returns the store
  itself.
- No handler registered → non-retryable failure `errorCode: "jobs.unknownHandler"`,
  `errorMessage: 'No handler registered for job type "<type>"'` → dead-letter
  (worker.ts:169–181).
- Handler throw → `{ status: "failed", errorCode: "server.internal", errorMessage, retryable:
  true }`, logged `frick.jobs.handler_threw` (worker.ts:184–202).
- Telemetry: `telemetry.startJobRun({jobId, jobType, tenantId, attemptCount, workerId})`;
  span end with `{ status, durationMs, errorCode?, retryable? }`; all telemetry errors are
  swallowed (worker.ts:220–234).

`applyResult` (worker.ts:236–296):
- completed → `store.jobs.complete(job.id, result.result)`; counter
  `frick.jobs.completed.total{jobType}`; devtools event `{ kind: "job.completed", tenantId,
  fields: { jobType, jobId, durationMs } }`; platform event `job.completed`.
- failed → defaults applied: `retryable = result.retryable ?? false`,
  `errorCode = result.errorCode ?? "server.internal"`,
  `errorMessage = result.errorMessage ?? "job handler returned failure"`;
  `store.jobs.fail(...)`; counter `frick.jobs.failed.total{jobType, retryable:"true"|"false"}`.
  Worker then **re-reads the row** (`getById`) to learn whether `fail` dead-lettered it
  (worker.ts:262–267):
  - dead-lettered → counter `frick.jobs.dead_lettered.total{jobType}`; devtools
    `job.dead_lettered` `{ jobType, jobId, errorCode, attemptCount }`; platform event
    `job.dead_lettered`.
  - else → devtools `job.failed` (same fields); platform event `job.failed`.
- Platform events (worker.ts:298–340): `platformEvents.publish({ family: "jobs.lifecycle",
  name, source: "frick.jobs", tenantId, idempotencyKey:
  "jobs.lifecycle:<tenantId>:<jobId>:<name>:<attemptCount>", payload: { jobId, jobType,
  attemptCount, durationMs, errorCode?, retryable? } })`; publish failures logged
  `frick.jobs.platform_event_publish_failed`, never propagate.

Lifecycle:
- `start()`: idempotent; logs `frick.jobs.worker_start{pollIntervalMs, claimBatchSize}`.
- `stop()` (worker.ts:357–384): clears pending timer, returns immediately if nothing in
  flight; otherwise waits for in-flight handlers up to `gracefulShutdownTimeoutMs`
  (logs `frick.jobs.worker_stop_timeout` if exceeded); logs `frick.jobs.worker_stop`.
- `running` getter = `started && !stopRequested`.

Server wiring (server.ts:961–981): worker enabled by default **except under a test runner**
(`workerEnabledDefault = !inTestRunner`); `options.jobs.workerEnabled` overrides;
`options.jobs.pollIntervalMs` plumbs through. The single worker serves all apps.

### 2.10 Recurring scheduler (`apps/server/src/jobs/recurring.ts`)

- `RECURRING_MIN_INTERVAL_MS = 60_000` (recurring.ts:20). `createFrickRecurringRegistry`
  throws at boot for any `intervalMs < 60_000`:
  `Recurring job "<name>" intervalMs must be >= 60000 (got <n>)` (recurring.ts:103–117).
- `FrickRecurringJob` = `{ name, jobType, intervalMs, resolveTargets }`;
  `RecurringTarget` = `{ tenantId, appId?, payload? }` (recurring.ts:22–47).
- Scheduler (recurring.ts:119–182): `setInterval(tick, tickIntervalMs ?? 30_000)`, unref'd.
  Started only when `!inTestRunner && recurringJobs.length > 0` (server.ts:1021–1023).
- Per tick, per job (recurring.ts:124–165):
  - `windowStart = Math.floor(Date.now() / intervalMs) * intervalMs`.
  - idempotency key: `recurring:<job.name>:` + (`<appId>:` only when the target carries an
    appId) + `<tenantId>:<windowStart>` (recurring.ts:140–145). Window dedupe rides the jobs
    unique idempotency index, so multiple ticks per window / restarts are no-ops; the next
    tick after downtime covers the current window.
  - enqueue: `{ tenantId, appId?, jobType, payload: payload ?? {}, idempotencyKey,
    availableAt: new Date(windowStart).toISOString() }`.
  - `resolveTargets` errors → log `frick.recurring.resolve_targets_failed`, skip the job this
    tick; per-target enqueue errors → log `frick.recurring.enqueue_failed`.
  - **SURPRISING**: `store.jobs.enqueue(...)` is invoked without `await` inside the
    synchronous try/catch (recurring.ts:146–162) — an async rejection escapes the catch and
    becomes an unhandled rejection. Rust rewrite should await + handle.
- `eachTenant({ includeArchived = false, filter?, payload? })` helper (recurring.ts:75–89):
  fans out to `store.tenants.list(includeArchived)`; never sets `appId`.

### 2.11 Jobs admin/introspection

- `GET /_frick/inspect/jobs` (server.ts:1323–1330, gated on `config.inspectionEnabled`):
  `{ registeredHandlers: string[] (sorted), counts: { ready, running, completed,
  dead_lettered, failed }, workerEnabled: bool }`.
- Dashboard `GET /_frick/dashboard/api/jobs` (dashboard/routes.ts:190–210 →
  `buildDashboardJobs`, dashboard/jobs.ts:52–77):
  - query params: `tenantId` (admin only; non-admin pinned to their own tenant), `status`
    (must be one of the 4 statuses else ignored), `jobType` (trimmed), `limit`
    (default 50, max 200; invalid → default).
  - fetches `limit + 1` rows to compute `truncated`.
  - response `DashboardJobs`: `{ schemaHash, tenantId?, scope: "tenant"|"admin", status?,
    jobType?, limit, count, truncated, jobs: DashboardJobRow[] }`.
  - `DashboardJobRow` (dashboard/jobs.ts:97–113): `id, tenantId, jobType, status,
    attemptCount, maxAttempts, availableAt, createdAt` + optional `claimedAt, completedAt,
    failedAt, deadLetteredAt, lastErrorCode`. Deliberately omits `payload`, `claimedBy`,
    `lastErrorMessage`, `idempotencyKey`, `appId`.
- There is NO admin route to retry/requeue/cancel a job (no mutation surface beyond enqueue
  via app code). Dead-letter recovery is operator-side SQL.

### 2.12 Framework job types (registration order at boot, server.ts:858–927)

1. `options.jobs.handlers` (app-supplied map).
2. `push.deliver` (`PUSH_DELIVER_JOB_TYPE`) — notification router handler, skipped if app
   already registered one.
3. `blob.process` (`BLOB_PROCESS_JOB_TYPE`) — see §3.6, skipped if already registered.
4. `blob.gc` (`BLOB_GC_JOB_TYPE`) — only when `options.blobGc.enabled === true`.
In per-app mode each non-default app receives the same framework handlers plus its own
declared handlers (duplicates throw at boot) (server.ts:938–959).

---

## 3. Blobs

### 3.1 Tables

`blob_metadata` (migrations.ts:152–160; +tenancy 301–305; +app 945–949; Postgres identical
except no BLOB columns here):

```sql
CREATE TABLE blob_metadata (
  blob_id TEXT PRIMARY KEY,      -- PK is blob_id ALONE (NOT tenant/app-scoped)
  owner_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,    -- "sha256-<64 hex>" by convention (client-supplied on POST)
  byte_length INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  storage_key TEXT,              -- nullable logical path
  created_at TEXT NOT NULL
);
-- + tenant_id TEXT NOT NULL DEFAULT '_default'; app_id TEXT NOT NULL DEFAULT '_default'
-- indexes: idx_blob_metadata_tenant (tenant_id, blob_id);
--          idx_blob_metadata_tenant_owner (tenant_id, owner_id, created_at DESC);
--          idx_blob_metadata_app_tenant (app_id, tenant_id, blob_id);
--          idx_blob_metadata_app_tenant_owner (app_id, tenant_id, owner_id, created_at DESC)
```

`blob_content` (migrations.ts:162–167; +tenant 307–309; +app 951–953; Postgres `content BYTEA`):

```sql
CREATE TABLE blob_content (
  blob_id TEXT PRIMARY KEY,
  content BLOB NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (blob_id) REFERENCES blob_metadata(blob_id) ON DELETE CASCADE
);
```

`blob_derivatives` (migration `0008`, migrations.ts:492–512; Postgres `content BYTEA`,
pg-framework-migrations.ts:368–388). **No app_id column.**

```sql
CREATE TABLE blob_derivatives (
  parent_blob_id TEXT NOT NULL,
  derivative_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT '_default',
  processor_id TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  content BLOB,                  -- derivative bytes INLINE (not in blob_content)
  metadata TEXT,                 -- JSON.stringify'd map, nullable
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, parent_blob_id, derivative_id)
);
CREATE INDEX idx_blob_derivatives_processor
  ON blob_derivatives (tenant_id, processor_id, created_at DESC);
```

### 3.2 BlobStore (`apps/server/src/storage/blob-store.ts`)

- `BlobMetadataInput` = `{ blobId, ownerId, contentHash, byteLength, mimeType, storageKey? }`;
  `BlobMetadata` adds `tenantId, appId, createdAt` (blob-store.ts:9–23). JSON mapping
  (`mapBlobRow`, blob-store.ts:284–296) field order: `tenantId, appId, blobId, ownerId,
  contentHash, byteLength (Number), mimeType, createdAt`, then `storageKey` only when truthy.
- `create(tenantId, metadata, appId = "_default")` (blob-store.ts:63–108):
  - **Cross-app guard (FR-153)**: PK is bare `blob_id`, so first
    `SELECT app_id FROM blob_metadata WHERE blob_id = ?`; if owned by a different app, throw
    `FrickCrossAppAccessError{ requestedAppId, ownerAppId, tenantId, objectType:
    "blob_metadata", objectId }`.
  - Then full UPSERT `ON CONFLICT(blob_id) DO UPDATE SET` over every column including
    `created_at = excluded.created_at` (created_at refreshes on overwrite). Insert column
    order: `(app_id, tenant_id, blob_id, owner_id, content_hash, byte_length, mime_type,
    storage_key, created_at)`; `created_at = now ISO` regardless of caller.
- `read(tenantId, blobId, appId)`: `WHERE app_id = ? AND tenant_id = ? AND blob_id = ?`.
- `list(tenantId, ownerId?, appId)`: `ORDER BY created_at DESC, blob_id ASC`.
- `totalBytesForOwner(tenantId, ownerId, appId)` (blob-store.ts:149–159):
  `SELECT COALESCE(SUM(byte_length), 0)` scoped (app, tenant, owner) — FR-56 quota figure.
- `deleteMetadata` → bool (changes > 0), idempotent (blob-store.ts:169–179).
- GC scan: `listAllOldestFirst` (`created_at ASC, blob_id ASC`);
  `listOldestFirstPage(tenantId, limit, cursor?, appId)` (blob-store.ts:209–233) — keyset
  pagination `(created_at > ? OR (created_at = ? AND blob_id > ?))`, limit sanitized to
  `>= 1` integer.
- `listAppIdsWithBlobs(tenantId)`: `SELECT DISTINCT app_id ... ORDER BY app_id ASC`
  (blob-store.ts:242–248).
- Byte ops delegate to the driver: `writeContent/readContent/deleteContent/hasContent`.

### 3.3 Bytes drivers (`apps/server/src/storage/blob-bytes-driver.ts`, FR-53/FR-54)

`type FrickBlobDriver = "sqlite" | "filesystem" | "s3"` (line 38). Selected by
`FRICK_BLOB_DRIVER` (config.ts:337, validation 640–645: error message
`FRICK_BLOB_DRIVER must be one of sqlite, filesystem, s3 (got ...)`).

- **SqlBlobBytesDriver** (default; lines 78–133): UPSERT into `blob_content`
  `ON CONFLICT (blob_id) DO UPDATE` with `(app_id, blob_id, content, updated_at, tenant_id)`;
  reads/deletes/exists filter `(app_id, tenant_id, blob_id)`. Works on SQLite + Postgres.
- **FilesystemBlobBytesDriver** (lines 158–248):
  - root resolved + `mkdirSync(recursive)`d + must be a writable directory at construction,
    else `FrickBlobStorageError` (fail-fast; messages at lines 169–171, 576–598).
  - path: `<root>/[<appSegment>/]<tenantSegment>/<aa>/<blobSegment>` where `aa` = first 2
    chars of blobSegment; the `_default` app omits the app segment (historical layout
    preserved; lines 234–247).
  - atomic write: temp sibling `<target>.<pid>.<rand8>.tmp` (mode `0o600`) then `renameSync`;
    temp removed best-effort on failure (lines 177–197).
  - read: ENOENT → `undefined`; other errors wrapped in `FrickBlobStorageError`.
  - delete: `rmSync(force: true)` (no-op when absent).
- **Segment encoding** `encodeSegment(id)` (lines 557–565) — load-bearing for on-disk/S3
  compatibility:
  ```
  hash     = hex(sha256(utf8(id)))[0..32]
  readable = lowercase(id).replace(/[^a-z0-9_-]+/g, "-").trim('-').slice(0, 40)
  segment  = readable ? `${readable}.${hash}` : hash
  ```
  Output alphabet `[a-z0-9_-]` + single `.` — traversal structurally impossible.
- **S3BlobBytesDriver** (lines 334–424): key =
  `[prefix/][appSegment/]<tenantSegment>/<aa>/<blobSegment>` (empty parts filtered; prefix
  normalized by splitting on `/`, trimming, dropping empties). `S3LikeClient` contract
  (lines 307–316): `getObject`/`headObject` return `undefined`/`false` for missing keys
  (NoSuchKey / NotFound / HTTP 404 — `isS3NotFound`, lines 538–548); all driver errors wrap in
  `FrickBlobStorageError` with `failed to (write|read|delete|stat) blob bytes for <id>: ...`.
- `createS3BlobBytesDriver(config)` (lines 456–527): requires non-empty `bucket`
  (`FRICK_BLOB_S3_BUCKET`); dynamic `import("@aws-sdk/client-s3")` (optional dep);
  `forcePathStyle = config.forcePathStyle ?? Boolean(config.endpoint)`; static credentials
  only when both `accessKeyId` and `secretAccessKey` provided.
- `createBlobBytesDriver` (lines 259–293): `filesystem` requires non-empty
  `blobStoragePath`; `s3` requires the pre-built injected driver
  (`ServerOptions.blobBytesDriver`, server.ts:433–444) because the store constructor is sync.
- Config env vars (apps/server/src/config.ts): `FRICK_BLOB_DRIVER` (default `sqlite`),
  `FRICK_BLOB_STORAGE_PATH` (default `"./frick-blobs/"`, config.ts:253),
  `FRICK_BLOB_S3_BUCKET`, `FRICK_BLOB_S3_REGION`, `FRICK_BLOB_S3_ENDPOINT`,
  `FRICK_BLOB_S3_PREFIX`. Validation gates (config.ts:477–485): `filesystem` with empty path
  and `s3` with empty bucket throw FrickConfigError at boot.

### 3.4 Limits & error codes

- `DEFAULT_FRICK_LIMITS.maxBlobBytes = 25_000_000`;
  `maxBlobBytesPerPrincipal = Number.MAX_SAFE_INTEGER` (opt-in quota)
  (apps/server/src/limits.ts:88–118). Env override:
  `FRICK_MAX_BLOB_BYTES_PER_PRINCIPAL` (limits.ts:145–151); `maxBlobBytes` has **no env var**
  (code/tenant-settings override only). Per-request limits resolve through
  `resolveTenantLimits(principal.tenantId, store, limits)` (server.ts:1619) — tenant settings
  can override.
- Protocol error codes (`packages/protocol/src/errors.ts:24–26`): `blob.tooLarge`,
  `blob.unsupportedContentType`, `blob.quotaExceeded`.
- HTTP mapping (server.ts:3266–3402):
  - body over `maxBlobBytes` → `FrickLimitError{limit:"maxBlobBytes"}` → HTTP **413**, code
    `blob.tooLarge`, details `{ limit, configuredMax, actualValue }`.
  - quota → `FrickLimitError{limit:"maxBlobBytesPerPrincipal"}` → HTTP **413**, code
    `blob.quotaExceeded`.
  - validation rejection → `BlobValidationRejectedError` → HTTP **415**, code
    `blob.unsupportedContentType`, details `{ reason: "blobValidationRejected", processorId,
    rejectionReason? }` (class server.ts:3096–3106).
  - misc body errors (e.g. byteLength mismatch) → 400 `sync.protocolError`.
- Body reader `readBoundedRawBody` (server.ts:3420–3439): accumulates chunks, throws
  `FrickLimitError` as soon as `total > maxBytes` (pauses the request rather than destroying
  the socket, so the 413 can be written).

### 3.5 Upload flow — `PUT /blobs/:blobId/content`

Route servers.ts:2284–2413; path regex `/^\/blobs\/([^/]+)\/content$/` with
`decodeURIComponent` on the id (server.ts:3585–3589). All `/blobs*` paths require an
authenticated principal (protected-path list, server.ts:5084–5085).

Sequence:
1. `content = readRawBody(request, tenantLimits.maxBlobBytes, "maxBlobBytes")`.
2. `metadata = store.blobs.read(tenantId, blobId, activeAppId)`;
   `contentHash = "sha256-" + hex(sha256(content))` (server.ts:3660–3662; hash of raw bytes,
   no canonicalization).
3. **Existing metadata (declared-then-upload or overwrite)** → response status 200:
   - `assertBlobOwnership(principal, metadata.ownerId, policyHooks)` (authz action
     `"blob.write"`, resource `{ kind: "blob", ownerId }`, authz.ts:1103–1116).
   - `validateBlobContent(blobId, metadata.byteLength, metadata.contentHash, content,
     contentHash)` (server.ts:3664–3677): byte length must equal declared; hash compared ONLY
     when the stored hash starts with `"sha256-"` (other hash schemes pass unchecked).
   - owner/mime resolved from metadata.
4. **New blob** → status 201: `ownerId` required from `?ownerId=` query param or
   `x-frick-owner-id` header; `assertBlobOwnership`; mime =
   `Content-Type` header before any `;`, trimmed, else `"application/octet-stream"`
   (`inferMimeType`, server.ts:3679–3681).
5. Synchronous validation (server.ts:2311–2339):
   `matchingProcessors = store.blobProcessors.matching(resolvedMimeType, content.byteLength)`;
   `preview = content.subarray(0, min(len, 4096))`; each processor with `validate` runs in
   registration order; first `{ ok: false }` throws
   `BlobValidationRejectedError(processor.id, verdict.reason)` (→415). No store writes have
   happened yet. NOTE: `extractedMetadata` returned by validators is **discarded** by the
   route.
6. Quota check (server.ts:2341–2365) only when quota is finite and `< MAX_SAFE_INTEGER`:
   `projected = currentBytes - (metadata?.byteLength ?? 0) + content.byteLength`;
   `projected > quota` → `FrickLimitError` with message
   `blob quota exceeded for owner <ownerId>: <projected> > <quota>`.
7. New blob: `await store.blobs.create(tenantId, { blobId, ownerId, contentHash, byteLength,
   mimeType, createdAt }, activeAppId)` — awaited BEFORE writeContent because
   `blob_content.blob_id` has an FK to `blob_metadata` (server.ts:2367–2382). (The literal
   passes a `createdAt` field but `BlobStore.create` stamps its own `now`.)
8. `await store.blobs.writeContent(tenantId, blobId, content, activeAppId)`.
9. Enqueue one `blob.process` job per matching processor that has a `process` hook
   (server.ts:2386–2401): `{ tenantId, appId: activeAppId, jobType: "blob.process",
   payload: { blobId, processorId }, idempotencyKey: "<blobId>:<processorId>:<contentHash>" }`
   — content-addressed so re-uploading identical bytes does not re-process, while changed
   bytes do.
10. Respond `{ ok: true, blobId, byteLength: content.byteLength, contentHash }` where
    `contentHash` = stored metadata hash on overwrite, computed hash on create
    (server.ts:2403–2408).

All branch errors funnel to `sendErrorWithMetrics(response, error, "blob_content_rejected")`.

### 3.6 Download / metadata / list / derivative routes

Order of route evaluation matters (content → derivative content → derivative list →
metadata GET → POST):

- `GET /blobs` (server.ts:2248–2282):
  - `ownerId` = query param; defaults to `principal.userId` for non-admin, unrestricted for
    admin. Non-admin with explicit ownerId → `assertCanReadBlob` (action `"blob.read"`).
  - 200 `{ schemaHash, data: BlobMetadata[] }`; when owner-scoped also
    `usage: { ownerId, usedBytes, quotaBytes }` with `quotaBytes = null` when unlimited
    (i.e. quota not finite or `>= MAX_SAFE_INTEGER`).
- `GET /blobs/:id/content` (server.ts:2415–2442): both metadata AND content must exist, else
  404 `{ error: "blob_content_not_found" }` (plain JSON, not envelope). Read authz supports
  the sharing-grant cascade: `assertCanReadBlob(principal, ownerId, hooks, blobId,
  cascadeGrantLookup)` — an `ownerMismatch` deny is forgiven when a grant exists for the
  record id == blobId (authz.ts:1069–1101). Response headers exactly:
  `content-type` (metadata.mimeType), `content-length` (byte count),
  `x-frick-blob-id`, `x-frick-content-hash`; body = raw bytes.
  (`x-frick-blob-id`/`x-frick-content-hash` are CORS-exposed, server.ts:3246–3249.)
- `GET /blobs/:id/derivatives/:derivativeId/content` (server.ts:2444–2487; regex
  `/^\/blobs\/([^/]+)\/derivatives\/([^/]+)\/content$/`): parent metadata missing → 404
  `{ error: "blob_not_found" }` (cross-tenant indistinguishable from unknown); derivative
  missing → 404 `{ error: "blob_derivative_not_found" }`. Headers: `content-type`
  (derivative mime), `content-length`, `x-frick-blob-id` (the **parent** id),
  `x-frick-content-hash` (derivative hash), `etag: "\"<contentHash>\""`.
  NOTE: derivative reads are NOT app-scoped (store call passes only tenant), and parent
  metadata IS read with `activeAppId` — parent visibility gates access.
- `GET /blobs/:id/derivatives` (server.ts:2489–2514): 200
  `{ derivatives: DerivativeRow[] }` ordered `derivative_id ASC`. DerivativeRow JSON field
  order (blob-derivative-store.ts:162–183): `parentBlobId, derivativeId, tenantId,
  processorId, mimeType, byteLength, contentHash, storageKey, createdAt` + `metadata` last
  when present (note: `record()`'s return value places `metadata` before `createdAt` —
  blob-derivative-store.ts:106–117 — but that shape isn't surfaced over HTTP).
- `GET /blobs/:id` (server.ts:2516–2536): metadata JSON (BlobMetadata shape in §3.2) or 404
  `{ error: "blob_not_found" }`. Catch-all: any other `GET /blobs/...` falls into this route.
- `POST /blobs` (server.ts:2538–2560): metadata-only declaration (no bytes). Body
  `{ blobId, ownerId, contentHash, byteLength, mimeType, storageKey? }` (string/number
  validation via requireString/requireNumber); ownership asserted; 201
  `{ ok: true, blobId }`. Server does NOT verify the declared `contentHash` format here —
  only `PUT .../content` cross-checks (and only for `sha256-` prefixed hashes).

There is no DELETE blob HTTP route; deletion happens via GC or compliance erasure flows.
There is no chunked/multipart upload: blobs are single-request bodies bounded by
`maxBlobBytes` (default 25 MB).

### 3.7 Processor pipeline (`apps/server/src/blobs/processor.ts`)

- `FrickBlobProcessor` = `{ id, matches: { mimePrefixes?: string[], maxByteLength?: number },
  validate?(ctx), process?(ctx) }` (processor.ts:75–86).
- Matching (processor.ts:131–145): if `mimePrefixes` non-empty, mime must `startsWith` at
  least one; if `maxByteLength` set, `byteLength > maxByteLength` excludes; omitting both
  matches every blob. Registry preserves insertion order (Map values).
- Duplicate id → `DuplicateBlobProcessorError` (`reason = "duplicateBlobProcessor"`,
  processor.ts:94–100).
- validate ctx: `{ tenantId, blobId, ownerId, mimeType, byteLength, preview (first ≤4KB
  Buffer), store, logger }`; result `{ ok, reason?, extractedMetadata? }`.
- process ctx: `{ tenantId, blobId, ownerId, mimeType, byteLength, contentPath
  (= metadata.storageKey ?? blobId), store, logger }`; result
  `{ derivatives?: [{ derivativeId, mimeType, bytes (Buffer), metadata? }] }`.

`blob.process` job handler (`apps/server/src/blobs/processor-job.ts`):

- `BLOB_PROCESS_JOB_TYPE = "blob.process"` (line 33); payload codec
  `encodeBlobProcessPayload` → `{ blobId, processorId }` (lines 50–54), decode requires both
  to be non-empty strings.
- Outcomes (lines 108–192):
  - bad payload → failed, `blob.invalidPayload`, non-retryable.
  - unknown processor id → failed, `blob.unknownProcessor`, non-retryable.
  - processor exists but has no `process` → completed `{ derivatives: 0 }` (stale-job
    tolerance).
  - parent blob missing → failed, `blob.notFound`
    (`Blob <id> not found in tenant <tenant>`), non-retryable.
  - processor throw → failed, `blob.processorError`, **retryable: true**.
  - success → for each derivative: persist (awaited — a floating promise here previously
    risked lost derivatives, lines 82–89), log `frick.blob.processed{blobId, processorId,
    derivatives}`, completed `{ derivatives: N }`.
- **SURPRISING**: handler reads the parent via `store.blobs.read(ctx.tenantId, blobId)` with
  NO appId (line 136) → `_default` partition, even though the upload enqueues with the active
  app id. For non-default apps the parent lookup misses and the job dead-letters with
  `blob.notFound`. (Job ctx.store is `forApp(job.appId)` but the deps-injected `store` is the
  raw one.) Preserve-or-fix decision needed for the rewrite; current wire behavior is the
  miss.
- Derivative persistence (lines 74–101): `storageKey =
  "derivative/<parentBlobId>/<derivativeId>"` (`derivativeStorageKey`,
  blob-derivative-store.ts:60–65); `contentHash = "sha256-" + hex(sha256(bytes))`; bytes
  stored inline.
- `BlobDerivativeStore.record` (blob-derivative-store.ts:75–118): UPSERT
  `ON CONFLICT(tenant_id, parent_blob_id, derivative_id) DO UPDATE` over all columns;
  `metadata` is `JSON.stringify`'d; `created_at = now`. Re-running a processor overwrites.
- `read` returns `{ row, bytes }`, bytes = `Buffer.alloc(0)` when content column NULL
  (lines 144–159). Corrupt `metadata` JSON on read → field silently omitted
  (lines 174–181).
- `deleteForParent(parentBlobId, tenantId)` → count (lines 136–142).

### 3.8 Built-in processors

`imageBlobProcessor` (`apps/server/src/blobs/image-processor.ts`, FR-130/FR-55):

- defaults: id `"frick-image"`, `maxBytes = DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024`,
  `maxPixels = DEFAULT_MAX_IMAGE_PIXELS = 40 * 1024 * 1024`, rejection message
  `"Upload is not a recognised PNG, JPEG, GIF, or WebP image."`, `matches = {}` (everything).
- `validate` (lines 290–332): reject empty (`"Empty upload."`); reject
  `byteLength > maxBytes` (`"Image is <n> bytes; the limit is <max>."`); reject non-`image/*`
  mime; reject unrecognized magic bytes; decompression-bomb guard — parse header dimensions
  from the 4KB preview (`parseImageDimensions`, lines 55–79: PNG IHDR big-endian u32 at
  16/20; GIF u16 LE at 6/8; JPEG SOFn scan; WebP VP8/VP8L/VP8X variants) and reject
  `width*height > maxPixels`; unparseable dimensions are accepted (byte cap still applies).
  On success returns `extractedMetadata: { format, width?, height? }` (discarded by the
  route, see §3.5).
- Magic bytes (`sniffImageFormat`, lines 160–188): PNG `89 50 4E 47` (first 4 of the 8-byte
  sig); JPEG `FF D8 FF`; GIF `47 49 46`; WebP `RIFF....WEBP`.
- `process` attached only when `derivatives` variants are configured (lines 337–393):
  re-checks maxPixels on the FULL bytes (throws → retryable failure); for each variant calls
  the pluggable `derivativeGenerator` (default `copyDerivativeGenerator` = byte copy);
  null/undefined generator result skips the variant; emitted derivative metadata =
  `{ maxEdge?, source: "image-derivative" }`; mime = `variant.mimeType ?? source mime`.
  Missing stored content logs `frick.blob.image.missingContent` and completes with 0
  derivatives.

`mimeSizeValidator` (`apps/server/src/blobs/validation-processor.ts`, lines 70–101):
default id `"frick-mime-size"`; rejects empty (`rejectEmpty` default true), `byteLength >
maxBytes` (`"Upload is <n> bytes; the limit is <max>."`), and mimes outside
`allowedMimeTypes` (entry ending in `/` = prefix match, else exact;
`"MIME type \"<mime>\" is not allowed."`); empty allow-list allows all.

`moderationProcessor` (validation-processor.ts:156–200): default id `"frick-moderation"`,
process-phase only; reads full content, calls the app `BlobModerationHook` →
`{ decision: "allow"|"flag"|"reject", reason?, details? }`; logs `frick.blob.moderated`;
persists the verdict JSON as a derivative (default `derivativeId = "moderation"`,
mime `application/json`, metadata `{ decision, reason? }`). Hook throw → job retry.

### 3.9 Orphaned-blob GC (`apps/server/src/blobs/gc-job.ts`, FR-57)

Constants: `BLOB_GC_JOB_TYPE = "blob.gc"` (line 53); `DEFAULT_BLOB_GC_GRACE_MS =
7 * 24 * 60 * 60 * 1000` (7 days, line 56); `DEFAULT_BLOB_GC_INTERVAL_MS = 60 * 60 * 1000`
(1 h, line 59); `DEFAULT_BLOB_GC_PAGE_SIZE = 500` (line 67).

Safety invariants (module header lines 8–38):
(a) **opt-in only** — `createFrickServer({ blobGc: { enabled: true } })` wires both the
`blob.gc` handler and the recurring sweep (server.ts:910–927, 1000–1011); default servers
never GC. (b) grace window. (c) app `isReferenced` hook — **fail-safe contract**: deletion
allowed only when the hook returns the explicit boolean `false`; `true`, non-boolean,
or a throw → keep, with warn logs `frick.blob.gc.hook_threw` / `frick.blob.gc.hook_non_boolean`
(`hookProtects`, lines 217–251). (d) framework reference scan covers ONLY declared blob-ref
fields (`blobRefFields(schema)` from `@fricken/protocol`: fields with `kind:'ref'` whose
ref ∈ `schema.blobs`).

`runOrphanedBlobGc(args)` (lines 260–386):
- `graceMs >= 0` else throw `blob GC graceMs must be >= 0 (got <n>)`; pageSize sanitized
  (finite, > 0, floored) else 500.
- Reference snapshot once per pass: for every object type with declared blob-ref fields,
  `store.objects.list(tenantId, objectName, appId)` and collect non-empty string values of
  those fields (lines 144–164).
- Keyset-paginated oldest-first scan; per blob:
  1. grace: `Date.parse(createdAt)` non-finite (unparseable) or `> now - graceMs` → kept
     (`keptWithinGrace`).
  2. in reference snapshot → `keptDeclaredRef`.
  3. hook protected → `keptHookProtected`.
  4. `dryRun` → counted in `deleted` (ids reported, nothing deleted, no re-check).
  5. TOCTOU re-check immediately before delete (`recheckOrphanBeforeDelete`, lines 394–433):
     re-read metadata (gone → skip), re-check grace, re-scan declared refs against LIVE
     object state for this one blob (`isDeclaredReferencedNow`, lines 185–204), re-consult
     hook. Any guard → keep.
  6. `deleteBlobConsistently` (lines 450–466), strict order: ① derivative rows (bytes
     inline, and NOT FK-cascaded from blob_metadata, so explicit) ② parent bytes via driver
     (explicit because filesystem/S3 drivers aren't cascade-backed; blob_content FK cascade
     also covers SQL backend) ③ metadata last. Crash mid-delete leaves a re-GC-able orphan,
     never a metadata-less content row.
- Result `{ scanned, keptWithinGrace, keptDeclaredRef, keptHookProtected, deleted: string[] }`;
  logs `frick.blob.gc.swept` only when `deleted.length > 0`.

Job handler (`createBlobGcJobHandler`, lines 479–519): runs the pass for
`(ctx.tenantId, ctx.appId ?? "_default")`; completed result
`{ scanned, deleted: <count>, keptWithinGrace, keptDeclaredRef, keptHookProtected }`;
any error → logs `frick.blob.gc.failed`, returns failed `blob.gcError`,
**retryable: false** (a destructive sweep waits for the next window rather than retrying).

Recurring spec (`createBlobGcRecurringJob`, lines 543–565): `name = "frick.blob.gc"`,
`jobType = "blob.gc"`, `intervalMs` default 1 h (min 60 s via the registry). Fan-out:
for each live tenant (`store.tenants.list(false)`), one target per
`store.blobs.listAppIdsWithBlobs(tenantId)` entry; a tenant with no blobs still gets one
`_default` target. Server passes only `intervalMs` to the recurring spec; `graceMs` and
`isReferenced` live in the handler config (server.ts:917–926, 1006–1008).

### 3.10 Blob admin/introspection

- Dashboard `GET /_frick/dashboard/api/blobs` (dashboard/routes.ts:170–188 →
  `buildDashboardBlobs`, dashboard/blobs.ts:49–77):
  - admin: optional `tenantId` (falls back to the principal's), optional `ownerId`
    (unset = all owners); non-admin: pinned to own tenant AND own `userId` as owner.
  - `limit` default 50, max 200. Loads the full owner/tenant list, slices to `limit`,
    `total` = pre-slice length, `truncated = total > count`.
  - per blob, derivatives summarized: `{ count, totalBytes, processors (unique sorted),
    mimeTypes (unique sorted), hasMetadata, latestCreatedAt? }` (dashboard/blobs.ts:102–118).
  - response `{ schemaHash, tenantId, ownerId?, scope, limit, count, total, truncated,
    blobs: [{ tenantId, blobId, ownerId, contentHash, byteLength, mimeType, derivatives,
    createdAt }] }`.
  - NOTE: store calls pass no appId → `_default` partition only.
- There is no `/_frick/inspect/blobs` route; blob driver identity is visible via config
  inspection. The `GET /blobs?ownerId=` usage block (§3.6) is the operator-facing quota view.
- Compliance flows (`apps/server/src/compliance/*`) export/erase blob metadata + bytes per
  data subject — outside this map's scope (see map 06).

---

## 4. Cross-cutting notes for the rewrite

1. **msgpack everywhere on persisted payloads**: job `packed` and (separately specified)
   stores use `@msgpack/msgpack` default options — JS object key insertion order becomes
   msgpack map order; Rust must use string-keyed maps with preserved insertion order
   (e.g. `rmpv` with ordered maps) to keep byte-identical encodes where hashes/dedupe matter.
   For jobs the bytes are opaque (no hashing), so semantic equality suffices.
2. **ISO-8601 timestamps as TEXT** with lexicographic ordering — always
   `new Date().toISOString()` format (`YYYY-MM-DDTHH:mm:ss.sssZ`, millisecond precision,
   always `Z`).
3. **Hash canonicalization**: blob + derivative content hashes are
   `"sha256-" + lowercase-hex(sha256(raw bytes))` — no canonicalization, raw body bytes.
   Filesystem/S3 segment hashes are `hex(sha256(utf8(id)))[0..32]` (truncated to 32 hex
   chars = 128 bits).
4. **Integer types**: `jobs.id` is i64 (SQLite rowid / PG BIGINT identity); attempt counts,
   byte lengths INTEGER (i64-safe); JS `Number(...)` coercions cap at 2^53.
5. **Single-listener seams**: projection delta listener and store write listener are
   single-slot by design (gateway is sole consumer).
6. **Failure isolation**: projection apply, delta listener, search indexing, write listener,
   telemetry, platform-event publishing — ALL are best-effort and must never fail the
   triggering write/job.
7. Known quirks to decide on (preserve vs fix; flagged inline above):
   - `GET /projections/:name` does not await async `read` (§1.5).
   - admin rebuild does not await async `rebuild` (§1.7).
   - store `deleteObject` never notifies projections (§1.4).
   - recurring scheduler enqueue not awaited (§2.10).
   - `blob.process` handler ignores the job's appId when reading parent metadata (§3.7).
   - dashboards/inspect surfaces are `_default`-app only.
