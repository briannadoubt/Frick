# @frick/cli

The `frick` operational CLI. A thin wrapper around framework module functions
(`loadFrickConfig`, the migration runner, `FrickStore`, the tenants ledger,
`resetFrickDatabase`) exposed as a single binary.

The CLI is internal-use only — it ships inside the monorepo and reaches into
`apps/server/src/` via relative imports. Extracting `@frick/server` into a
published library and shipping `frick` to npm is a future slice.

## Invocation

During development:

```
pnpm cli <command> [args]
# e.g.
pnpm cli doctor --db-path ./frick.sqlite --env development
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
