# Docker recipe for a scaffolded app

This page covers containerizing an app scaffolded with `frick init`. The recipe
itself lives at [`docker/scaffolded-app/`](../docker/scaffolded-app); this page
explains how to build, run, and configure it.

For the in-monorepo deployment Compose profiles (Redpanda platform events + OTel
collector wired around a prebuilt server image), see "Deployment profiles" in
[`operations.md`](operations.md) and `frick deploy`.

> **Status note.** The backend is the Rust workspace under `crates/`. The
> `frick-server` sync runtime is an embeddable library with no standalone server
> binary, and `frick init` currently scaffolds a **TypeScript** app that depends
> on the `@fricken/server` package. That package is no longer part of the npm
> publish set, so the scaffolded-app recipe below works inside the monorepo
> workspace (where `@fricken/server` resolves via `workspace:*`) but is **not**
> a standalone published-package recipe yet. A turnkey Dockerfile for the Rust
> server, and migrating the `frick init` template off `@fricken/server`, are
> follow-up work. The build/run mechanics and the `FRICK_*` storage contract
> below still apply.

## Scaffolded-app recipe

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

The image:

- builds on `node:24-bookworm-slim` in two stages (install/compile → slim runtime),
- runs as the non-root `node` user,
- `EXPOSE 4099` and declares a `VOLUME` at `/var/lib/frick`,
- `HEALTHCHECK`s against `GET /ready` (returns `200` once the schema is applied
  and the server can serve sync — see the readiness probe section in
  `operations.md`).

The build stage runs `npm install` + `npm run build` (`tsc`), prunes dev
dependencies, and the runtime stage runs `node dist/server.js`. Because the
scaffolded `server.ts` reads `PORT`, the Dockerfile sets both `PORT` and
`FRICK_PORT` to `4099` to keep the bound port and the healthcheck aligned.

> A scaffold uses `workspace:*` for its Frick deps when created inside the
> monorepo. Standalone images would need those replaced with resolvable
> published versions and a committed lockfile — which is blocked until the
> scaffold template is migrated off the unpublished `@fricken/server` package
> (see the status note above).

## Storage and volumes

| Mode | Env | Persistence |
| ---- | --- | ----------- |
| SQLite (default) | `FRICK_DB_PATH=/var/lib/frick/frick.sqlite` | Mount a volume at `/var/lib/frick`. |
| Filesystem blobs | `FRICK_BLOB_DRIVER=filesystem`, `FRICK_BLOB_STORAGE_PATH=/var/lib/frick/blobs` | Same volume; otherwise blob bytes are lost on restart. |
| SQLite blobs (default) | `FRICK_BLOB_DRIVER=sqlite` | Stored inside the SQLite file. |
| Postgres | `FRICK_DB_DRIVER=postgres`, `FRICK_DATABASE_URL=postgres://…` | `frick-store` ships a Postgres backend; see operations.md for current coverage. |
| S3 blobs | `FRICK_BLOB_DRIVER=s3`, `FRICK_BLOB_S3_BUCKET=…` | Object store holds blob bytes. |

## Common environment variables

See [`operations.md`](operations.md) for the complete table. The ones that
matter most for a container:

| Var | Recipe default | Purpose |
| --- | -------------- | ------- |
| `FRICK_HOST` | `0.0.0.0` | Bind address (must be `0.0.0.0` to be reachable). |
| `FRICK_PORT` | `4099` | HTTP/WS port. |
| `PORT` | `4099` | Scaffolded `server.ts` reads this. |
| `FRICK_ENV` | `production` | Runtime profile. |
| `FRICK_DB_PATH` | `/var/lib/frick/frick.sqlite` | SQLite location (under the volume). |
| `FRICK_DATABASE_URL` | unset | Postgres connection string. |
| `FRICK_BLOB_STORAGE_PATH` | `/var/lib/frick/blobs` | Filesystem blob root. |
| `FRICK_ALLOWED_ORIGINS` | unset | CORS / WebSocket origin allowlist. |
| `FRICK_ADMIN_TOKEN` | unset | Admin-scope bearer token. |
| `FRICK_PUBLIC_URL` | unset | Public origin for absolute links. |

## Notes

- This is a reference recipe, not a turnkey production deployment. Put a
  reverse proxy in front for TLS and request/connection caps (see "Runtime
  limits" in `operations.md`).
- Migrations: a fresh SQLite database is created and migrated on first boot. If
  you pre-seed a database that is behind the bundled schema, run
  `frick migrate up` (see `operations.md`).
