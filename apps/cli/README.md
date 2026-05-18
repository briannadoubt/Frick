# @frick/cli

The `frick` operational CLI. A thin wrapper around framework module functions
(`loadFrickConfig`, the migration runner, `FrickStore`, the tenants ledger,
`resetFrickDatabase`) exposed as a single binary.

The CLI is internal-use only — it ships inside the monorepo and still reaches
into some server internals for operational commands. Scaffolded apps import the
framework through the `@frick/server` package entrypoint; publishing `frick` to
npm remains a future slice.

## Invocation

During development:

```
pnpm cli <command> [args]
# e.g.
pnpm cli doctor --db-path ./frick.sqlite --env development
pnpm cli dev --profile redpanda --dry-run
pnpm cli dashboard --endpoint http://127.0.0.1:4099
pnpm cli deploy image --dry-run
pnpm cli deploy --profile compose --dry-run
```

After `pnpm --filter @frick/cli build`:

```
pnpm exec frick <command> [args]
```

## Common flags

- `--db-path <path>` — override `FRICK_DB_PATH`. Defaults to `./frick.sqlite`.
- `--env <development|test|production>` — override `FRICK_ENV`.
- `--pretty` — emit indented JSON instead of single-line JSON Lines.

See `docs/operations.md` for the full list of environment variables.

## Output

Every command emits exactly one JSON record on stdout. Errors go to stderr as
`{ "error": { "code": "...", "message": "...", "details": { ... } } }`.

Exit codes:

| code | meaning                                                                  |
| ---- | ------------------------------------------------------------------------ |
| 0    | success                                                                  |
| 1    | a check failed (doctor red, db unreachable, schema invalid, …)           |
| 2    | usage error (unknown command, missing positional, bad flag)              |
| 3    | framework refused (e.g. `reset` outside development, prod migrate w/o `--confirm-prod`) |

## Commands

### `frick --help`

Lists available commands as a JSON array.

### `frick schema check`

Validates the foundation schema and emits `{ ok, schemaId, schemaVersion, schemaRevision, schemaHash }`.

### `frick schema generate`

Convenience wrapper around `pnpm schema:generate` (regenerates native artifacts).

### `frick init <directory> [--agents all|codex,claude,cursor] [--mcp]`

Scaffolds a new Frick application. With `--agents`, the CLI installs the
Frick Agent Kit into the new app so Codex, Claude Code, and Cursor can work
from the same `docs/frick/spine.md`. With `--mcp`, the final JSON record
includes a read-only stdio MCP config pointing at the scaffolded app's port.

Example:

```
frick init my-app --agents all --mcp
```

### `frick migrate status`

Emits `{ dbPath, env, applied: [...], pending: [...] }`. Open the DB read-only.

### `frick migrate up [--confirm-prod]`

Applies pending framework migrations. Refuses when `env === "production"`
unless `--confirm-prod` is passed (exit code 3).

### `frick doctor`

Composite health check. Emits

```json
{
  "ok": true,
  "env": "development",
  "schema":     { "ok": true, "detail": { ... } },
  "db":         { "ok": true, "detail": { ... } },
  "migrations": { "ok": true, "detail": { ... } },
  "config":     { "ok": true, "detail": { ... } }
}
```

Exit 0 if all green; exit 1 if any check fails.

### `frick inspect server`

Mirrors `/_frick/inspect/server`. Emits schema identity, runtime env, and feature flags.

### `frick inspect db`

Mirrors `/_frick/inspect/db`. Emits ping status, applied-migration count, last
applied row, and idempotency cache stats.

### `frick inspect jobs`

Emits `{ available, counts }` if the jobs framework exposes `countsByStatus`,
otherwise `{ available: false, reason: "jobs framework not detected" }`.

### `frick dashboard [--host <host>] [--port <port>] [--endpoint <url>]`

Serves Fricken Dashboard, the local Firebase-style console for a running Frick
server. Emits a JSON line with `{ ok, url, host, port, endpoint }`, then keeps
the process alive until interrupted.

- `--host` defaults to `127.0.0.1`.
- `--port` defaults to `4299`; use `--port 0` to bind any free port.
- `--endpoint` defaults to `http://127.0.0.1:4099` and is passed into the
  dashboard URL so the UI points at that server on first load.

### `frick dev [--profile sqlite|redpanda] [--dry-run]`

Prints or starts a local Frick runtime profile. The default `sqlite` profile
prints the standard server, web demo, and dashboard loop without starting
Docker. The `redpanda` profile points the platform event pipeline at the local
Redpanda/Kafka broker and exports server OTel to the local collector from
`ops/local/redpanda.compose.yaml`.

- `--profile sqlite` emits `FRICK_PLATFORM_EVENTS_DRIVER=sqlite`.
- `--profile redpanda` emits Kafka/Redpanda and OTel env vars and, without
  `--dry-run`, runs `docker compose -f ops/local/redpanda.compose.yaml up -d
  --wait redpanda otel-collector`.
- `--dry-run` prints the JSON plan without starting any process.

### `frick deploy [--profile compose|lightweight] [--dry-run]`

Prints or starts a standard Docker Compose deployment profile. This deploys
the Frick-owned runtime shape; app source stays focused on schema, handlers,
jobs, projections, and config. The profile expects `FRICK_SERVER_IMAGE` to
point at a built Frick app/runtime image, defaulting to `frick-server:latest`
when Docker Compose runs.

- `--profile compose` is the production-shaped profile. It runs the server
  with the mounted dashboard, Redpanda/Kafka platform events, and the local
  OTel collector.
- `--profile lightweight` runs the same server/dashboard shape with the SQLite
  platform event pipeline and no collector.
- `--dry-run` prints the JSON plan without starting Docker.

### `frick deploy image [--tag <image>] [--dockerfile <path>] [--context <path>] [--push] [--dry-run]`

Builds the server image consumed by `frick deploy` profiles. The default uses
`ops/deploy/server.Dockerfile`, context `.`, and tag `frick-server:latest`.

- `--tag` sets the Docker image tag and should match `FRICK_SERVER_IMAGE` when
  running a deployment profile.
- `--dockerfile` and `--context` let app/runtime images provide their own build
  inputs while keeping the deploy profiles unchanged.
- `--push` runs `docker push <tag>` after a successful build.
- `--dry-run` prints the JSON build/push plan without starting Docker.

### `frick mcp [--endpoint <url>] [--readonly] [--allow-writes] [--tenant <id>] [--user <id>] [--token <bearer>] [--print-config]`

Runs a stdio MCP server for agents that need live Frick runtime context. The
CLI owns the process; agents connect to this command rather than starting a
separate sidecar. Default mode is read-only and exposes documented health,
readiness, inspection, stream-read, jobs, and structured-error tools/resources.

- `--endpoint` defaults to `http://127.0.0.1:4099`.
- `--readonly` is the default and keeps mutating tools unavailable.
- `--allow-writes` exposes write tools, still subject to normal Frick authz.
- `--tenant`, `--user`, and `--token` add scoped headers to runtime requests.
- `--print-config` emits a JSON config record instead of starting stdio mode.

### `frick reset --dev`

Drops every framework-managed table. Refuses unless `--dev` is passed AND
`env === "development"`. Exit code 3 on refusal.

### `frick tenants list [--include-archived]`

Emits `{ tenants: [...] }` from the tenants ledger.

### `frick tenants create <tenantId> [--display-name <name>]`

Inserts a row into the tenants ledger. Exit 1 if the tenant already exists.

### `frick verify`

Runs `pnpm verify:generated` end-to-end (schema + fixtures regen + git diff
check).
