# Docker recipe for the Frick server

This page covers containerizing the Frick sync server. After the Rust cutover
the backend is the standalone `frick-server` binary (Rust), and the canonical
image is built from [`ops/deploy/server.Dockerfile`](../ops/deploy/server.Dockerfile).

For the full in-monorepo deployment Compose profiles (Redpanda platform events +
OTel collector wired around the server image), see "Deployment profiles" in
[`operations.md`](operations.md) and `frick deploy`.

## Canonical server image

`ops/deploy/server.Dockerfile` is a multi-stage build: it compiles the
`frick-server` binary on `rust:1.95-slim` and copies it into a
`debian:bookworm-slim` runtime. SQLite is statically bundled (rusqlite), so the
runtime needs no database libraries — only `ca-certificates` and `curl` (for the
container `HEALTHCHECK`). The image `EXPOSE`s `4099`, declares a `/var/lib/frick`
volume, and runs `frick-server`.

Build it from the repository root (the default `frick deploy image` context):

```bash
docker build -f ops/deploy/server.Dockerfile -t frick-server:latest .
# or:
frick deploy image            # builds with the same dockerfile + context
```

Run it:

```bash
docker run --rm -p 4099:4099 \
  -v frick-data:/var/lib/frick \
  -e FRICK_DB_PATH=/var/lib/frick/frick.sqlite \
  frick-server:latest
```

The image `HEALTHCHECK`s against `GET /ready` (returns `200` once the schema is
applied and the server can serve sync — see the readiness probe section in
[`operations.md`](operations.md)).

## Serving an app's schema

By default the server serves the empty **foundation** schema, which is enough
for health checks and the framework's own routes. A real app supplies its
schema as a serialized `FrickSchema` JSON file and points the server at it:

```bash
docker run --rm -p 4099:4099 \
  -v frick-data:/var/lib/frick \
  -v "$PWD/schema.json:/etc/frick/schema.json:ro" \
  -e FRICK_SCHEMA_PATH=/etc/frick/schema.json \
  frick-server:latest
```

Exporting an app's `src/schema.ts` to `schema.json` for `FRICK_SCHEMA_PATH` is
follow-up work (`frick` will gain a schema-export command); see the scaffolded
app's `README.md` produced by `frick init`.

## Compose profiles

Two Compose files in `ops/deploy/` wire the same `frick-server:latest` image:

- [`lightweight.compose.yaml`](../ops/deploy/lightweight.compose.yaml) — SQLite,
  OTel off, a single `frick-server` service.
- [`compose.yaml`](../ops/deploy/compose.yaml) — Redpanda (Kafka-compatible
  platform events) + an OTel collector alongside the server.

```bash
docker compose -f ops/deploy/lightweight.compose.yaml up -d --wait
# or the full profile:
docker compose -f ops/deploy/compose.yaml up -d --wait
# or via the CLI (emits the plan with --dry-run):
frick deploy --profile lightweight --dry-run
```

Both set the `FRICK_*` env contract (see below) and healthcheck the server on
`GET /ready` with `curl`.

## Storage and volumes

| Mode | Env | Persistence |
| ---- | --- | ----------- |
| SQLite (default) | `FRICK_DB_PATH=/var/lib/frick/frick.sqlite` | the `/var/lib/frick` volume |
| Postgres | `FRICK_DB_DRIVER=postgres`, `FRICK_DATABASE_URL=postgres://…` | the external database |

Mount a named volume at `/var/lib/frick` so the SQLite database and blob content
survive container restarts. The full `FRICK_*` configuration surface (host, port,
env, allowed origins, admin token, push credentials, platform-events driver, …)
is documented in [`operations.md`](operations.md).
