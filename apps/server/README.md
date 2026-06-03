# @fricken/server

Node runtime for Frick apps. The package owns the HTTP API, MessagePack sync
gateway, durable stores, migrations, jobs, projections, sharing grants,
identity routes, push/email adapters, telemetry, inspection/admin routes, and
mounted dashboard APIs behind the public `createFrickServer` entrypoint.

## Install

```bash
pnpm add @fricken/server @fricken/protocol
```

Use the workspace CLI while developing this repository:

```bash
pnpm server
pnpm cli dashboard
pnpm --filter @fricken/server test
```

## Public Surface

- `createFrickServer(options)` and `ServerOptions`
- `FrickStore` plus exported store write-event types
- app extension options: `appRoutes`, `jobs.handlers`, `recurring.jobs`,
  `policyHooks`, projections, search, blob processors, push adapters,
  cluster bus, and outbound email
- push adapters through `@fricken/server/push/apns-adapter`,
  `@fricken/server/push/fcm-adapter`, and
  `@fricken/server/push/web-push-adapter`
- email adapter types/router/test adapter from the package root, plus the
  Resend reference adapter at `@fricken/server/email/resend-adapter`
- migration/reset, telemetry, project/module, auth, sharing, compliance, and
  dashboard-support types exported from the package root when documented

Route handlers, storage implementations, sync gateway internals, and
dashboard helper modules under `apps/server/src/*` remain framework internals
unless they are exported from the package entrypoint or documented in
[`docs/framework-boundaries.md`](../../docs/framework-boundaries.md).

## Runtime Notes

The active server runtime uses SQLite-backed stores. `FRICK_DB_DRIVER=postgres`
and `FRICK_DATABASE_URL` currently cover the standalone Postgres migration and
schema runner while the full runtime store port is in progress.

Blob bytes default to SQLite and can use the local filesystem with
`FRICK_BLOB_DRIVER=filesystem` plus a writable `FRICK_BLOB_STORAGE_PATH`; blob
metadata remains in SQLite.

See [`docs/operations.md`](../../docs/operations.md) for environment
variables, routes, deployment profiles, observability, and operational limits.
