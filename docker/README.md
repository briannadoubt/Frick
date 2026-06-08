# Frick Docker recipes

Reference Dockerfile recipes for containerizing a Frick server **outside** the
monorepo — i.e. when you depend on the published `@fricken/server` package or
scaffold an app with `frick init`.

> The canonical **monorepo** server image lives at
> `ops/deploy/server.Dockerfile` and is built via `frick deploy image`. Use the
> recipes here when you do **not** have a Frick monorepo checkout.

Full walkthrough: [`docs/docker-recipes.md`](../docs/docker-recipes.md).

| Recipe | For | Entrypoint |
| ------ | --- | ---------- |
| [`published-server/`](published-server) | A server built from the published `@fricken/server` package | `entrypoint.mjs` → `createFrickServer().listen()` |
| [`scaffolded-app/`](scaffolded-app) | An app created with `frick init` (ships its own schema) | compiled `dist/server.js` |

Both recipes use a multi-stage `node:24-bookworm-slim` build, run as the
non-root `node` user, expose `4099`, declare a `/var/lib/frick` data volume,
and `HEALTHCHECK` against `GET /ready`.

## Quick start — published-package server

```bash
# from this docker/published-server directory
docker build -t my-frick-server .
docker run --rm -p 4099:4099 -v frick-data:/var/lib/frick my-frick-server
# or with Compose (SQLite by default; --profile postgres for Postgres):
docker compose -f compose.yaml up --build
```

## Quick start — scaffolded app

```bash
frick init my-app
cp docker/scaffolded-app/Dockerfile docker/scaffolded-app/.dockerignore my-app/
cd my-app
docker build -t my-app .
docker run --rm -p 4099:4099 -v frick-data:/var/lib/frick -e PORT=4099 my-app
```

## Storage

- **SQLite (default):** mount a volume at `/var/lib/frick`. The recipes set
  `FRICK_DB_PATH=/var/lib/frick/frick.sqlite` and, for filesystem blobs,
  `FRICK_BLOB_STORAGE_PATH=/var/lib/frick/blobs`.
- **Postgres:** set `FRICK_DB_DRIVER=postgres` and `FRICK_DATABASE_URL=...`.
  See the Postgres caveat in [`docs/docker-recipes.md`](../docs/docker-recipes.md).

See [`docs/operations.md`](../docs/operations.md) for the full `FRICK_*` env reference.
