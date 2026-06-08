# Docker recipes for published-package and scaffolded apps

This page covers containerizing a Frick server **without** a monorepo checkout:
you either depend on the published [`@fricken/server`](https://www.npmjs.com/package/@fricken/server)
package, or you scaffolded an app with `frick init`. The recipes themselves
live under [`docker/`](../docker); this page explains how to build, run, and
configure them.

For the in-monorepo server image and the full self-hosted Compose profiles
(Redpanda platform events + OTel collector), see "Deployment profiles" in
[`operations.md`](operations.md) and `frick deploy` — those build
`ops/deploy/server.Dockerfile`, which is a different recipe meant for repo
developers.

## Which recipe

| You have… | Recipe | Image entrypoint |
| --------- | ------ | ---------------- |
| A dependency on `@fricken/server` (no app schema, or you add one) | [`docker/published-server`](../docker/published-server) | `entrypoint.mjs` calls `createFrickServer().listen()` |
| An app from `frick init` (ships its own `src/schema.ts`) | [`docker/scaffolded-app`](../docker/scaffolded-app) | compiled `dist/server.js` |

Both images:

- build on `node:24-bookworm-slim` in two stages (install/compile → slim runtime),
- run as the non-root `node` user,
- `EXPOSE 4099` and declare a `VOLUME` at `/var/lib/frick`,
- `HEALTHCHECK` against `GET /ready` (returns `200` once the schema is applied
  and the server can serve sync — see the readiness probe section in
  `operations.md`).

## Recipe A — published-package server

`docker/published-server` is a self-contained build context: a `package.json`
pinning `@fricken/server`, a tiny `entrypoint.mjs`, and a `Dockerfile`.

```bash
docker build -t my-frick-server docker/published-server
docker run --rm -p 4099:4099 -v frick-data:/var/lib/frick my-frick-server
```

The entrypoint is intentionally minimal — the package barrel is export-only (no
side-effect listen), so the supported way to boot a standalone server is to
import it and call `.listen()`:

```js
import { createFrickServer } from "@fricken/server";
const app = createFrickServer();
await app.listen();
```

`createFrickServer()` reads host, port, and storage configuration from `FRICK_*`
environment variables, so the Dockerfile only sets sensible container defaults
(`FRICK_HOST=0.0.0.0`, `FRICK_PORT=4099`, a SQLite path under the data volume).
The entrypoint also installs `SIGTERM`/`SIGINT` handlers that call `app.close()`
so the store closes cleanly on container stop.

**Shipping your own schema:** copy this recipe, add your compiled schema to the
image, and pass it through: `createFrickServer({ schema })`. For a TypeScript
app that owns a schema, recipe B is usually the better starting point.

### Compose (SQLite or Postgres)

`docker/published-server/compose.yaml` shows both storage modes:

```bash
# SQLite, single container, persistent named volume
docker compose -f docker/published-server/compose.yaml up --build

# Postgres-backed server container (stateless)
docker compose -f docker/published-server/compose.yaml --profile postgres up --build
```

## Recipe B — scaffolded app

`frick init` produces an app with `src/server.ts` (which calls
`createFrickServer({ schema, port })` and reads its port from `PORT`),
`src/schema.ts`, a `tsconfig.json` compiling `src/ → dist/`, and `build`/`test`
scripts. Drop the recipe into the app root:

```bash
frick init my-app
cp docker/scaffolded-app/Dockerfile docker/scaffolded-app/.dockerignore my-app/
cd my-app
docker build -t my-app .
docker run --rm -p 4099:4099 -v frick-data:/var/lib/frick -e PORT=4099 my-app
```

The build stage runs `npm install` + `npm run build` (`tsc`), prunes dev
dependencies, and the runtime stage runs `node dist/server.js`. Because the
scaffolded `server.ts` reads `PORT`, the Dockerfile sets both `PORT` and
`FRICK_PORT` to `4099` to keep the bound port and the healthcheck aligned.

> A scaffold uses `workspace:*` for its Frick deps when created inside the
> monorepo. For a standalone image, replace those with the published versions
> (e.g. `"@fricken/server": "^0.1.1"`) and commit a lockfile before building.

## Storage and volumes

| Mode | Env | Persistence |
| ---- | --- | ----------- |
| SQLite (default) | `FRICK_DB_PATH=/var/lib/frick/frick.sqlite` | Mount a volume at `/var/lib/frick`. |
| Filesystem blobs | `FRICK_BLOB_DRIVER=filesystem`, `FRICK_BLOB_STORAGE_PATH=/var/lib/frick/blobs` | Same volume; otherwise blob bytes are lost on restart. |
| SQLite blobs (default) | `FRICK_BLOB_DRIVER=sqlite` | Stored inside the SQLite file. |
| Postgres | `FRICK_DB_DRIVER=postgres`, `FRICK_DATABASE_URL=postgres://…` | Server container is stateless; Postgres holds state. |
| S3 blobs | `FRICK_BLOB_DRIVER=s3`, `FRICK_BLOB_S3_BUCKET=…` | Object store holds blob bytes. |

> **Postgres caveat (pre-1.0).** `FRICK_DB_DRIVER=postgres` requires
> `FRICK_DATABASE_URL`, but the runtime store ports are still in progress: the
> server runtime currently constructs SQLite-backed stores, and Postgres covers
> the standalone migration/schema runner. Track this in `operations.md`'s env
> table before relying on a stateless Postgres container in production.

## Common environment variables

See [`operations.md`](operations.md) for the complete table. The ones that
matter most for a container:

| Var | Recipe default | Purpose |
| --- | -------------- | ------- |
| `FRICK_HOST` | `0.0.0.0` | Bind address (must be `0.0.0.0` to be reachable). |
| `FRICK_PORT` | `4099` | HTTP/WS port. |
| `PORT` | `4099` (recipe B) | Scaffolded `server.ts` reads this. |
| `FRICK_ENV` | `production` | Runtime profile. |
| `FRICK_DB_PATH` | `/var/lib/frick/frick.sqlite` | SQLite location (under the volume). |
| `FRICK_DATABASE_URL` | unset | Postgres connection string. |
| `FRICK_BLOB_STORAGE_PATH` | `/var/lib/frick/blobs` | Filesystem blob root. |
| `FRICK_ALLOWED_ORIGINS` | unset | CORS / WebSocket origin allowlist. |
| `FRICK_ADMIN_TOKEN` | unset | Admin-scope bearer token. |
| `FRICK_PUBLIC_URL` | unset | Public origin for absolute links. |

## Notes

- These are reference recipes, not a turnkey production deployment. Put a
  reverse proxy in front for TLS and request/connection caps (see "Runtime
  limits" in `operations.md`).
- The recipes don't ship a lockfile, so the resolved `@fricken/server` version
  follows the semver range. Pin it and commit a lockfile for reproducible
  builds.
- Migrations: a fresh SQLite database is created and migrated on first boot. If
  you pre-seed a database that is behind the bundled schema, run
  `frick migrate up` (see `operations.md`).
