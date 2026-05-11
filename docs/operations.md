# Operations Runbook

This document describes what `apps/server` looks like to an operator today:
the runtime modes it supports, the environment variables it reads, the HTTP
endpoints exposed for orchestrators, the inspection routes, and the
shutdown contract. Anything aspirational lives in
`docs/superpowers/framework-hardening-spec.md` — this file only describes
what is in main right now.

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

## Known gaps

- CORS is parsed (`allowedOrigins`) but not yet enforced in HTTP
  handlers. The current handler responds with `Access-Control-Allow-Origin: *`.
- No CLI binary yet (`frick schema check`, `frick doctor`, etc.). The
  underlying functions (`runFrameworkMigrations`, `listAppliedMigrations`,
  `loadFrickConfig`) are exported and stable; a CLI slice can wrap them.
- Blob storage is SQLite-backed today; the `FRICK_BLOB_STORAGE_PATH`
  variable is parsed for forward compatibility with a future filesystem
  driver.
