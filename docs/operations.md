# Operations Runbook

This document describes what `apps/server` looks like to an operator today:
the runtime modes it supports, the environment variables it reads, the HTTP
endpoints exposed for orchestrators, the inspection routes, and the
shutdown contract. Anything aspirational lives in
`docs/superpowers/framework-hardening-spec.md` — this file only describes
what is in main right now.

The framework ships a `frick` CLI for ops (`frick doctor`, `frick migrate
status`, `frick reset --dev`, `frick tenants list`, …). See
`apps/cli/README.md` for the full command list. The CLI reads the same
environment variables documented below.

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
| `FRICK_ALLOWED_ORIGINS`     | `["*"]`                     | `[]`                                  | Comma-separated. Parsed and stored; CORS enforcement is a known gap. |
| `FRICK_DB_PATH`             | `./frick.sqlite`            | `./frick.sqlite`                      | SQLite path. `":memory:"` is rejected in production.                 |
| `FRICK_BLOB_STORAGE_PATH`   | `./frick-blobs/`            | `./frick-blobs/`                      | Local filesystem directory for the current blob driver.              |
| `FRICK_LOG_LEVEL`           | `info`                      | `info`                                | One of `debug`, `info`, `warn`, `error`.                             |
| `FRICK_DEMO_AUTH_ENABLED`   | `true`                      | `false`                               | Toggles `POST /auth/dev-login`. Forcing on in prod logs a warning.   |
| `FRICK_SESSION_TTL_SECONDS` | `604800` (7d)               | `604800`                              | New sessions get `expiresAt = now + ttl`.                            |
| `FRICK_INSPECTION_ENABLED`  | `true`                      | `false`                               | Gates `/_frick/inspect/*`. Forcing on in prod logs a warning.        |

Validation errors throw `FrickConfigError` at startup, before any port is
opened. Unknown env values (e.g. `FRICK_ENV=staging`) are fatal — the
server refuses to boot.

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
server exposes three additional GET endpoints under `/_frick/inspect/`:

- `/_frick/inspect/server` — `{ schemaId, schemaVersion, schemaRevision,
  schemaHash, env, demoAuthEnabled, inspectionEnabled, startedAt }`.
- `/_frick/inspect/migrations` — `{ applied: [{ id, schemaRevision,
  appliedAt, checksum, durationMs }, ...] }` read from the
  `frick_migrations` ledger.
- `/_frick/inspect/db` — `{ ready, applied, lastApplied?, idempotencyCache }`.
- `/_frick/inspect/metrics` — `{ snapshotAt, uptimeSeconds, counters, gauges }`.
  Returns a JSON snapshot of in-process counters and gauges. Counter names
  include `frick.http.requests.total{method,status}`,
  `frick.http.errors.total{code}`, and `frick.ws.frames.total{kind}`. Gauges
  include `frick.ws.connections.current`. No retention or historical
  aggregation — scrape periodically to integrate with a metrics backend.

The `idempotencyCache` object reports the in-memory front cache state —
`size` (currently held entries), `capacity` (configured maximum), and
`evictions` (cumulative count since process start). Tune the capacity
with `createFrickServer({ idempotencyCacheCapacity })`. Default 10,000.
The durable `idempotency_keys` SQLite table is separately bounded (see
retention slice).

When inspection is disabled (production default), every path under
`/_frick/inspect/` returns `404` — its existence is not advertised. To
opt back in for an on-call session, set `FRICK_INSPECTION_ENABLED=true`.
A startup warning is logged when that override is active in production.

These routes share the same session bearer as the rest of the protected
API. There is no separate "ops principal" or admin role today.

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

Both routes audit-log under `backup.dump` and `backup.restore`.

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

- CORS is parsed (`allowedOrigins`) but not yet enforced in HTTP
  handlers. The current handler responds with `Access-Control-Allow-Origin: *`.
- No CLI binary yet (`frick schema check`, `frick doctor`, etc.). The
  underlying functions (`runFrameworkMigrations`, `listAppliedMigrations`,
  `loadFrickConfig`) are exported and stable; a CLI slice can wrap them.
- Blob storage is SQLite-backed today; the `FRICK_BLOB_STORAGE_PATH`
  variable is parsed for forward compatibility with a future filesystem
  driver.
