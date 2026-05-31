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
pnpm cli backup --tenant-id _default --output ./backup.ndjson
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

Most commands emit exactly one JSON record on stdout. Commands that naturally
stream records are explicit exceptions: `frick lint` emits JSON Lines findings
plus a summary, and `frick backup` without `--output` streams NDJSON dump rows
to stdout with its summary on stderr. Errors go to stderr as
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

### `frick lint [--against <previous-schema.json>]`

Runs the schema linter against the foundation schema. With `--against`, the CLI
loads a previous schema snapshot and emits one JSON Lines record per finding
plus a final summary. Exit code is `1` when any finding has
`severity: "breaking"`.

### `frick init <directory> [--agents all|codex,claude,cursor] [--mcp]`

Scaffolds a new Frick application. With `--agents`, the CLI installs the
Frick Agent Kit into the new app so Codex, Claude Code, and Cursor can work
from the same `docs/frick/spine.md`. With `--mcp`, the final JSON record
includes a read-only stdio MCP config pointing at the scaffolded app's port.

Example:

```
frick init my-app --agents all --mcp
```

### `frick scaffold object <Name> [--directory <dir>]`

Appends a PascalCase object stub to `src/schema.ts` in an initialized app.
The scaffold requires the `// frick:objects` marker from `frick init` and
refuses duplicates.

### `frick scaffold stream <Name> [--directory <dir>]`

Appends a PascalCase stream stub to `src/schema.ts`. Like object scaffolding,
it uses the generated marker comments and refuses duplicates.

### `frick scaffold projection <name> [--directory <dir>]`

Creates `src/projections/<name>.ts` for a kebab-case projection name and adds
the import/reference markers to `src/server.ts`. The generated projection is a
stub; app code still wires the handler into the projection registry.

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

### `frick tenants set-push <tenantId> --platform apns --p8 <file> --key-id <id> --team-id <id> --bundle-id <id> [--sandbox]`

Encrypts APNs credentials with `FRICK_PUSH_CRED_KEY` and stores them in
`tenant_settings` for the tenant. The command writes only a JSON status record
to stdout; private key material is read from disk and is not echoed.

### `frick tenants set-push <tenantId> --platform fcm --service-account <file>`

Encrypts a Firebase service-account JSON file with `FRICK_PUSH_CRED_KEY` and
stores it in `tenant_settings`. The file must include `project_id`,
`client_email`, and `private_key`.

### `frick tenants set-push <tenantId> --platform webpush --subject <mailto:|https:> --public-key <b64url> --private-key <pem-file>`

Encrypts Web Push VAPID credentials with `FRICK_PUSH_CRED_KEY` and stores them
in `tenant_settings`. `--subject` must be a `mailto:` or `https://` URI;
`--public-key` is the base64url VAPID application server key; `--private-key`
points at a PEM-encoded EC (P-256) private key file. Private key material is
read from disk and is not echoed.

### `frick backup [--tenant-id <id>|all] [--output <path>]`

Streams a portable NDJSON framework database dump. It defaults to the
`_default` tenant; pass `--tenant-id all` for a whole-database dump. When
`--output` is omitted, the dump is written to stdout and the final summary goes
to stderr so stdout remains clean NDJSON.

### `frick restore --input <path> --confirm yes [--overwrite] [--force-schema-drift]`

Restores a framework NDJSON dump into the configured database. It refuses
without `--confirm yes` and also refuses against production-mode config unless
`FRICK_RESTORE_ALLOW_PROD=1` is set.

### `frick verify`

Runs `pnpm verify:generated` end-to-end (schema + fixtures regen + git diff
check).
