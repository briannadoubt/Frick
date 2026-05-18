# Operations Runbook

> **New to Frick?** Start with the [onboarding guide](./onboarding.md) — it walks through the mental model and gets a local server, web demo, and WebSocket sync running in about fifteen minutes. Come back here once you need to operate a server in production.

This document describes what `apps/server` looks like to an operator today:
the runtime modes it supports, the environment variables it reads, the HTTP
endpoints exposed for orchestrators, the inspection routes, and the
shutdown contract. Anything aspirational lives under `internal/specs/`
and `internal/plans/` — this file only describes what is in main right now.

The framework ships a `frick` CLI for ops (`frick doctor`, `frick migrate
status`, `frick reset --dev`, `frick tenants list`, …). See
`apps/cli/README.md` for the full command list. The CLI reads the same
environment variables documented below.

Building a new app rather than operating an existing one? Start from the
[Getting Started](./authoring.md#getting-started) section of the app
authoring guide — it walks through `frick init` and the `frick scaffold`
commands that produce a Frick application skeleton compatible with this
runbook.

## Web demo security headers

The Vite dev and preview servers attach the demo app's CSP and browser
security headers automatically. `pnpm --filter @frick/web build` also
emits those strict preview headers to `apps/web/dist/_headers`, which
static hosts such as Netlify and Cloudflare Pages can apply at the site
root. Set `VITE_FRICK_HTTP` and, when the WebSocket endpoint differs from
the derived default, `VITE_FRICK_WS` before building so `connect-src`
matches the production server rather than the local demo defaults. If
your deployment platform ignores `_headers`, copy the generated values
into the web server or CDN configuration before serving the demo to users.

## Runtime modes

The server reads `FRICK_ENV` (defaulting to `development`). Allowed values:

| Mode          | When to use                       | Implies                                                                                                  |
| ------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `development` | Local dev loops                   | Host `127.0.0.1`, demo auth on, inspection routes on, `allowedOrigins=["*"]`, console logger             |
| `test`        | Automated test runs               | Same defaults as development; the server's structured logger is replaced with a no-op so output is quiet |
| `production`  | Anything user-facing or shipped   | Host `0.0.0.0`, demo auth off, inspection off, `allowedOrigins=[]`, `dbPath=":memory:"` is rejected      |

Overrides applied as a partial `FrickConfig` to `createFrickServer({ config })`
beat env vars, which beat the per-mode defaults above.

## Environment variables

All variables are optional. Defaults match the runtime mode.

| Variable                    | Default (dev/test)          | Default (production)                  | Notes                                                                |
| --------------------------- | --------------------------- | ------------------------------------- | -------------------------------------------------------------------- |
| `FRICK_ENV`                 | `development`               | `production` (when set)               | One of `development`, `test`, `production`.                          |
| `FRICK_HOST`                | `127.0.0.1`                 | `0.0.0.0`                             | Host the HTTP server binds to.                                       |
| `FRICK_PORT`                | `4099`                      | `4099`                                | Integer in `[0, 65535]`. `0` asks the kernel to allocate a port.     |
| `FRICK_PUBLIC_URL`          | unset                       | unset                                 | Externally-reachable URL; surfaced in the startup log when set.      |
| `FRICK_ALLOWED_ORIGINS`     | `["*"]`                     | `[]`                                  | Comma-separated allowlist. Enforced for HTTP preflight and WebSocket upgrades; same-origin/server-to-server requests omit `Origin`. |
| `FRICK_DB_PATH`             | `./frick.sqlite`            | `./frick.sqlite`                      | SQLite path. `":memory:"` is rejected in production.                 |
| `FRICK_BLOB_STORAGE_PATH`   | `./frick-blobs/`            | `./frick-blobs/`                      | Parsed for future filesystem blob storage; current blob bytes are SQLite-backed. |
| `FRICK_LOG_LEVEL`           | `info`                      | `info`                                | One of `debug`, `info`, `warn`, `error`.                             |
| `FRICK_DEMO_AUTH_ENABLED`   | `true`                      | `false`                               | Toggles `POST /auth/dev-login`. Forcing on in prod logs a warning.   |
| `FRICK_SESSION_TTL_SECONDS` | `604800` (7d)               | `604800`                              | New sessions get `expiresAt = now + ttl`.                            |
| `FRICK_INSPECTION_ENABLED`  | `true`                      | `false`                               | Gates `/_frick/inspect/*`. Forcing on in prod logs a warning.        |
| `FRICK_ADMIN_TOKEN`         | unset                       | unset                                 | Enables `/_frick/admin/*` and production inspection auth. Must be at least 32 chars in production. |
| `FRICK_IMPLICIT_TENANT_CREATION` | `true`                 | `false`                               | Allows auth routes to create unknown tenants automatically.           |
| `FRICK_PLATFORM_EVENTS_DRIVER` | `sqlite`                  | `sqlite` unless brokers are set       | One of `sqlite` or `kafka`. Kafka uses the built-in KafkaJS adapter. |
| `FRICK_PLATFORM_EVENTS_TOPIC` | `frick.platform.events`    | `frick.platform.events`               | Kafka/Redpanda topic name for platform events.                        |
| `FRICK_PLATFORM_EVENTS_KAFKA_BROKERS` | unset             | unset                                 | Comma-separated Kafka/Redpanda brokers. When set and no driver is forced, the driver defaults to `kafka`. |
| `FRICK_PLATFORM_EVENTS_RETENTION_MS` | `604800000` (7d)    | `604800000`                           | SQLite platform event retention window. Positive integer milliseconds. |
| `FRICK_PLATFORM_EVENTS_MAX_ROWS` | `1000000`               | `1000000`                             | SQLite platform event row cap after retention pruning. Positive integer. |

Validation errors throw `FrickConfigError` at startup, before any port is
opened. Unknown env values (e.g. `FRICK_ENV=staging`) are fatal — the
server refuses to boot.

## Local runtime profiles

`frick dev` prints the standard local runtime plan as JSON. The default
`sqlite` profile is zero-infrastructure and uses the SQLite platform event
pipeline:

```bash
frick dev --dry-run
```

Use the Redpanda profile when you want to test the Kafka-compatible event
pipeline locally:

```bash
frick dev --profile redpanda
```

That command starts only the Redpanda service from
`ops/local/redpanda.compose.yaml` with Docker Compose and waits for it to be
healthy. The profile binds broker access to `127.0.0.1:19092`, sets
`FRICK_PLATFORM_EVENTS_DRIVER=kafka`, points
`FRICK_PLATFORM_EVENTS_KAFKA_BROKERS` and `FRICK_TEST_KAFKA_BROKERS` at the
local broker, and prints the server/web/dashboard commands to run against it.
Use `--dry-run` to inspect the plan without starting Docker.

## Runtime limits

`createFrickServer({ limits })` accepts partial `FrickLimits` overrides. Any
omitted field falls back to the framework default. These limits are enforced
inside the server and should complement, not replace, reverse-proxy request
and connection caps.

| Limit | Default | Applies to |
| --- | ---: | --- |
| `maxHttpBodyBytes` | 5,000,000 | JSON request bodies |
| `maxStreamAppendPayloadBytes` | 256,000 | encoded stream append payloads |
| `maxBlobBytes` | 25,000,000 | blob upload bodies |
| `maxSubscriptionsPerConnection` | 256 | active subscriptions per WebSocket |
| `maxStreamPageSize` | 500 | forward HTTP, SSE, and WebSocket stream pages |
| `maxSearchQueryBytes` | 4,096 | `POST /search` query text |
| `maxSearchFilterFields` | 16 | exact-match search filter field count |
| `maxSearchFilterKeyBytes` | 128 | each search filter key |
| `maxSearchFilterValueBytes` | 512 | each search filter value after stringification |
| `maxPendingAppendsPerClient` | 1,000 | queued appends per WebSocket client |
| `maxWebSocketFrameBytes` | 524,288 | inbound WebSocket frame payloads |
| `maxWebSocketConnections` | 10,000 | concurrently accepted WebSocket connections |
| `maxWebSocketOutboundBufferedBytes` | 1,048,576 | queued outbound bytes per WebSocket client |
| `maxSseConnections` | 10,000 | concurrently open SSE connections |
| `maxSseOutboundBufferedBytes` | 1,048,576 | queued outbound bytes per SSE response |
| `maxAuthAttemptsPerWindow` | 30 | attempts per `/auth/signup`, `/auth/login`, or `/auth/dev-login` route + tenant + identity/IP bucket |
| `authRateLimitWindowMs` | 300,000 | fixed auth-attempt rate-limit window |

Forward stream reads return at most `maxStreamPageSize` events by default and
include `cursor` plus `hasMore` so clients can continue from the last delivered
sequence. Oversized WebSocket frames are rejected by the `ws` parser before
MessagePack decode and the connection is closed. WebSocket connections over
`maxWebSocketConnections` are closed with code `1013`; SSE requests over
`maxSseConnections` return `429 rateLimit.exceeded`. Slow clients whose
WebSocket or SSE outbound buffers exceed their configured caps are closed
rather than allowed to accumulate unbounded queued data. Auth attempts over
`maxAuthAttemptsPerWindow` in the current fixed window also return
`429 rateLimit.exceeded`.

## Health vs. ready

There are two unauthenticated endpoints for orchestrators:

- `GET /health` returns `200 { ok: true, status: "ok", service: "frick-server" }`
  as soon as the process has bound a port. It does not touch the database.
  Wire it to a liveness probe.
- `GET /ready` returns `200 { status: "ready", schemaId, schemaRevision,
  schemaHash, appliedMigrations }` once the migration runner has finished
  AND a `SELECT 1` against the database succeeds. Otherwise it returns
  `503 { status: "not-ready", reason, ... }`. Wire it to a readiness probe
  and gate traffic on it.

A Kubernetes example:

```yaml
livenessProbe:
  httpGet: { path: /health, port: 4099 }
  initialDelaySeconds: 2
readinessProbe:
  httpGet: { path: /ready, port: 4099 }
  initialDelaySeconds: 1
  periodSeconds: 5
```

## Inspection routes

When `inspectionEnabled` is true (the default outside production), the
server exposes these GET endpoints under `/_frick/inspect/`:

- `/_frick/inspect/server` — `{ schemaId, schemaVersion, schemaRevision,
  schemaHash, appId, env, demoAuthEnabled, inspectionEnabled, startedAt }`.
- `/_frick/inspect/apps` — `{ apps: [{ id, basePath, schemaId,
  schemaRevision }, ...] }` for multi-app server routing checks.
- `/_frick/inspect/migrations` — `{ applied: [{ id, schemaRevision,
  appliedAt, checksum, durationMs }, ...] }` read from the
  `frick_migrations` ledger.
- `/_frick/inspect/db` — `{ ready, applied, lastApplied?, idempotencyCache }`.
- `/_frick/inspect/jobs` — `{ registeredHandlers, counts, workerEnabled }`.
- `/_frick/inspect/projections` — registered projection names, sources,
  and whether each projection supports rebuild/read handlers.
- `/_frick/inspect/search` — active search adapter id plus registered
  index names and sources.
- `/_frick/inspect/metrics` — `{ snapshotAt, uptimeSeconds, counters, gauges }`.
  Returns a JSON snapshot of in-process counters and gauges. Counter names
  include `frick.http.requests.total{method,status}`,
  `frick.http.errors.total{code}`, and `frick.ws.frames.total{kind}`. Gauges
  include `frick.ws.connections.current`. No retention or historical
  aggregation — scrape periodically to integrate with a metrics backend.
- `/_frick/inspect/platform-events` — platform event pipeline health:
  `{ adapter, ok, pending, claimed, deadLettered, retained, unclaimed,
  consumers }`. The default adapter is SQLite, with bounded retention and
  row-cap pruning controlled by the platform event env vars above.
- `/_frick/inspect/devtools/events` — newest-first DevTools event feed with
  optional `kind`, `tenantId`, `sinceId`, and `limit` filters.
- `/_frick/inspect/devtools/events/:id` — one DevTools event by numeric id.
- `/_frick/inspect/devtools/summary?windowMs=60000` — event counts by kind
  over a rolling window.

The `idempotencyCache` object reports the in-memory front cache state —
`size` (currently held entries), `capacity` (configured maximum), and
`evictions` (cumulative count since process start). Tune the capacity
with `createFrickServer({ idempotencyCacheCapacity })`. Default 10,000.
The durable `idempotency_keys` SQLite table is separately bounded (see
retention slice).

For local development, `frick dashboard` serves Fricken Dashboard at
`http://127.0.0.1:4299` by default. In the monorepo, run
`pnpm cli dashboard`; once published, run `pnpm exec frick dashboard`. It is a
static console that reads `/health`, `/ready`, and the authenticated
`/_frick/inspect/*` endpoints from the configured Frick HTTP server. Use
`--endpoint <url>` to point it at another server, and use its Dev Login flow or
paste a bearer token before opening inspection-backed panels.

For production deployments, the Frick server can mount Fricken Dashboard at
`/_frick/dashboard`. Mounted mode is the preferred production shape because the
dashboard shares the server origin and security headers. Static dashboard
assets contain no sensitive data and may be served without auth; data-bearing
dashboard APIs under `/_frick/dashboard/api/*` require auth. In production,
those APIs require the configured admin bearer until the dashboard capability
system lands. In development, a valid session bearer from `/auth/dev-login` can
read the dashboard APIs. `/_frick/dashboard/api/platform-events/health`
returns the same platform-event health payload as the inspection route.

The platform event pipeline defaults to SQLite for local and lightweight
deployments. Set `FRICK_PLATFORM_EVENTS_DRIVER=kafka` with
`FRICK_PLATFORM_EVENTS_KAFKA_BROKERS=host:9092` to use the built-in
KafkaJS adapter against Redpanda or Kafka. The Kafka adapter connects lazily
on first publish or claim so server construction remains synchronous. This
baseline commits only contiguous terminal offsets on `ack`, republishes
retried events to the broker, and publishes poison messages to `<topic>.dlq`.
The job worker publishes initial `jobs.lifecycle` events for completed,
retryable failed, and dead-lettered jobs; downstream consumers can claim those
events from the same adapter as analytics and telemetry events. SQLite claims
use a five-minute visibility lease; if a consumer crashes after claiming but
before `ack`, `retry`, or `deadLetter`, the same consumer name can reclaim that
event after the lease expires and the delivery attempt count increments.
Terminal actions are matched against the delivery's `attempt` and `claimedAt`
values so an expired attempt cannot acknowledge, retry, or dead-letter a newer
claim.
Per-consumer health lag is still process-local, and idempotency is enforced by
the active adapter process after it has published or consumed a matching event;
cross-process and post-restart Kafka idempotency require a durable key index in
a follow-up hardening pass.

Product analytics enters through the same pipeline. Authenticated clients can
`POST /analytics/events` with a JSON body containing `name`, optional
`properties`, optional `context`, optional `attributes`, optional `traceId`,
optional `idempotencyKey`, and optional canonical ISO `occurredAt`. The server
derives `tenantId`, `subjectId`, `deviceId`, and `replicaId` from the active
session; clients cannot spoof those identity fields. Accepted events publish as
`analytics.user_event` with source `frick.analytics.ingest` and return
`202 { ok, eventId, sequence, acceptedAt, duplicate }`. The TypeScript SDK
wraps this route as `trackAnalyticsEvent(...)`, `FrickClient.track(...)`, and
`useTrackAnalyticsEvent()`. React browser apps can opt into automatic route
analytics with `<FrickProvider autoAnalytics>`; the tracker starts only when a
session token is available and tears down its history listeners on unmount.

For agents that need live runtime context, `frick mcp` runs a stdio MCP server
owned by the same CLI. It defaults to read-only and exposes documented health,
readiness, inspection, stream-read, job, schema, and structured-error
explanation resources/tools.

```
frick mcp --endpoint http://127.0.0.1:4099
frick mcp --print-config --endpoint http://127.0.0.1:4099
```

Mutating MCP tools are hidden unless `--allow-writes` is provided, and those
writes must still pass normal Frick auth, tenant isolation, schema
compatibility, and policy checks. Do not expose raw SQL or private storage
internals through MCP.

When inspection is disabled (production default), every path under
`/_frick/inspect/` returns `404` — its existence is not advertised. To
opt back in for an on-call session, set `FRICK_INSPECTION_ENABLED=true`.
A startup warning is logged when that override is active in production.

Inspection routes require authentication. Outside production, callers must
send a valid session bearer or `x-frick-session-token` header. In
production, callers must send the configured admin bearer token. The
`sessionToken` query parameter is not accepted for HTTP inspection routes.

## Graceful shutdown

`createFrickServer` returns a `close()` function that:

1. Tells the WebSocket gateway to close its sockets and the SSE registry
   to flush.
2. Stops accepting new HTTP connections.
3. Lets `node:http`'s connection tracker drain in-flight requests.
4. After `shutdownTimeoutMs` (default `5000`), forcibly closes any
   lingering keep-alive sockets with `server.closeAllConnections()`.
5. Closes the SQLite database.
6. Logs `frick.server.closed` and resolves the promise.

`close()` is idempotent — concurrent or repeated calls share the same
underlying promise.

A typical signal-handling pattern in a deployment wrapper:

```ts
const server = createFrickServer();
await server.listen();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
```

## Startup log line

When `listen()` resolves, the server emits a single structured log
record:

```
{
  "level": "info",
  "msg": "frick.server.listen",
  "event": "frick.server.listen",
  "schemaId": "...",
  "schemaRevision": 1,
  "schemaHash": "sha256-...",
  "env": "development",
  "host": "127.0.0.1",
  "port": 4099,
  "publicUrl": null,
  "demoAuthEnabled": true,
  "dbPath": "./frick.sqlite",
  "inspectionEnabled": true
}
```

The logger redacts `sessionToken`, `password`, and `passwordHash` field
values by name as a defense-in-depth check.

## Per-request log line

Every HTTP request emits one `frick.http.request` log line with
`requestId`, `method`, `path`, `status`, `durationMs`, and (when the
request resolves a principal) `tenantId` and `userId`. The
`Authorization` header and any field named `sessionToken`, `password`,
or `passwordHash` are redacted before emission. Set
`FRICK_LOG_LEVEL=info` (the default) or higher to see them.

## Projection delta push

Projections may emit deltas over the sync WebSocket. Clients subscribe
with kind `"projection"` and the projection's registered name (the
optional `key` is reserved for future per-row scoping and is ignored
today). The server pushes `ProjectionDelta` frames whenever a registered
projection's `apply` returns row changes; deltas are scoped to the
producing tenant. Subscribing to an unknown projection nacks with
`auth.forbidden` + `details.reason = "projectionNotFound"`. Today this
is an in-process broadcast; cross-process fan-out is a follow-up.

## Backup and restore

The framework ships a portable dump/restore format. Use it for offline
migrations, pre-deploy snapshots, and copying data between environments.
The format is independent of the underlying driver — today only SQLite
is supported, but a future Postgres adapter will produce dumps the same
shape.

### Format

Dumps are newline-delimited JSON (NDJSON). The first line is a header:

```json
{ "type": "header", "row": {
    "frickFormat": 1,
    "createdAt": "2026-05-11T00:00:00.000Z",
    "schemaId": "frick.foundation",
    "schemaVersion": "0.1.0",
    "schemaRevision": 1,
    "schemaHash": "<sha-256>",
    "appliedMigrations": ["0001_objects", "..."],
    "tenantId": "_default"
} }
```

Every subsequent line is `{ "type": "<table>", "row": { ... } }`. The
`row` shape matches the SQL column layout; binary columns are
base64-encoded under a sibling `<col>_base64` key.

The `tenantId` field is either a specific tenant (per-tenant dump) or
`"all"` (whole-database dump). Per-tenant dumps filter rows where
`tenant_id = <chosen>` and skip framework infra (admin audit log,
migration ledger). Whole-database dumps include both.

### CLI

```
frick backup [--tenant-id <id>|all] [--output <path>] [--db-path <path>]
frick restore --input <path> --confirm yes \
              [--tenant-id <id>] [--overwrite] [--force-schema-drift] \
              [--db-path <path>]
```

`frick backup` defaults to the `_default` tenant; pass `--tenant-id all`
for the whole database. Output goes to stdout unless `--output` is
given. `frick restore` requires `--confirm yes` for safety and refuses
against a production-mode config unless `FRICK_RESTORE_ALLOW_PROD=1`.

### HTTP admin

When `adminEnabled` is on:

- `POST /_frick/admin/backup` (body `{ "tenantId"?: string }`) streams
  NDJSON in the response body.
- `POST /_frick/admin/restore?confirm=yes` (body: raw NDJSON) replays
  the dump and returns a `FrickRestoreReport` JSON. Refused in
  production mode with `auth.forbidden` and
  `details.reason: "restoreNotAllowedInProduction"`.

Both routes audit-log under `backup.dump` and `backup.restore`. These
backup and restore audit writes are fail-closed: if the audit row cannot be
recorded, the admin action is rejected instead of silently continuing.
The same fail-closed policy applies to sensitive admin mutations for tenant
creation, tenant setting writes, account creation, job enqueue, search
rebuild, and projection rebuild. Rebuild routes record the allow intent
before starting work because rebuild side effects are not rollbackable.

### Schema drift and migration parity

Restore compares the source header's `schemaHash` to the target's. A
mismatch is refused unless `--force-schema-drift` (or
`?forceSchemaDrift=true` over HTTP) is passed. The target's applied
migrations must be a superset of the source's, otherwise restore
refuses with `missingMigrations`. Run `frick migrate up` against the
target first when restoring a dump from an older deployment.

### Failure handling

Rows that fail to insert (foreign-key violations, duplicate ids,
unknown table types, parse errors) are reported in the `skipped` array
of the returned report; restore keeps going. This lets operators
inspect what didn't make it without aborting the entire restore.

## Multi-app servers

`createFrickServer({ apps })` mounts multiple Frick schemas on the same
process — each app is `{ id, schema, basePath }`. HTTP requests resolve to
the app whose `basePath` is the longest prefix of the URL (e.g.
`GET /chat/schema` returns the `chat` app's schema). WebSocket clients
self-identify via the schemaId they advertise in the Hello frame; the
gateway routes the connection to the matching app's schema for
compatibility checking and HelloAck. `/_frick/inspect/apps` lists every
registered app and is gated by `inspectionEnabled`. Duplicate `basePath`
throws `FrickConfigError` at construction. **V1 scopes app boundaries to
URL routing and Hello handshake only — storage is server-shared.**
Partitioning the SQLite layer per app (an `app_id` column on relevant
tables and corresponding read/write scoping) is a follow-up slice.

## Schema lint

Use `frick lint` to validate the current foundation schema (`frick lint`)
or to diff it against a previous snapshot (`frick lint --against ./prev.json`).
Findings are JSON Lines with a stable `ruleId` (e.g. `object.removed`,
`field.required.added`) so CI can filter or suppress rules without parsing
free-form messages; the CLI exits 1 when any finding has severity
`breaking`. The same linter is available over HTTP at
`POST /_frick/admin/schema/lint` (admin-only, audit-logged as
`schema.lint`); the body is `{ previous?: FrickSchema }` and the response
is `{ findings, breakingCount }`.

## Known gaps

- CORS is enforced for HTTP preflight requests and WebSocket upgrades.
  Same-origin and server-to-server requests with no `Origin` header bypass
  CORS by browser convention; exact-string origin matching is the only
  supported mode.
- The CLI exists in the monorepo as `pnpm cli <command>` and can be built
  as `frick`, but it is still private and imports server internals directly.
  Publishing a standalone npm CLI remains a release-surface follow-up.
- Blob content is stored in SQLite today. `FRICK_BLOB_STORAGE_PATH` is
  parsed and exposed for a future filesystem driver, but the current server
  does not write blob bytes there.
