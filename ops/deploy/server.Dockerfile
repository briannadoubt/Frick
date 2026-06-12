# Canonical monorepo image for the standalone Rust `frick-server` binary.
#
# Built via `frick deploy image` (default `--dockerfile`) and consumed by
# ops/deploy/compose.yaml + ops/deploy/lightweight.compose.yaml as
# `frick-server:latest`. Build from the repository root (the default
# `frick deploy image` context):
#
#   docker build -f ops/deploy/server.Dockerfile -t frick-server:latest .
#
# The server serves the empty foundation schema by default. An app overrides
# `FRICK_SCHEMA_PATH` (pointing at a serialized FrickSchema JSON file mounted
# into the container) to serve its own schema instead.

# ---- Stage 1: build ---------------------------------------------------------
# Pinned to the toolchain in rust-toolchain.toml (channel 1.95.0). rusqlite is
# bundled (no system libsqlite needed); the slim image plus a C toolchain for
# the bundled SQLite amalgamation is enough to build the workspace.
FROM rust:1.95-slim AS build
WORKDIR /build

# Copy the whole workspace and build only the standalone server binary in
# release mode. (The workspace crates are path-interdependent, so the simplest
# correct build copies the full source tree.)
COPY . .
RUN cargo build --release -p frick-server --bin frick-server

# ---- Stage 2: runtime -------------------------------------------------------
FROM debian:bookworm-slim AS runtime

# rusqlite is statically bundled, so there is no libsqlite dependency. We add
# ca-certificates (outbound TLS) and curl (the container healthcheck below and
# the compose healthchecks hit /ready with it — the runtime has no Node).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /build/target/release/frick-server /usr/local/bin/frick-server

# SQLite + blob data live here; compose.yaml mounts a named volume at this path
# and sets FRICK_DB_PATH=/var/lib/frick/frick.sqlite.
RUN mkdir -p /var/lib/frick
VOLUME ["/var/lib/frick"]

EXPOSE 4099

# Defaults match the compose contract; operators override FRICK_* (env,
# database path, allowed origins, admin token, schema path, …) at runtime.
ENV FRICK_HOST=0.0.0.0 \
    FRICK_PORT=4099

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD curl -fsS "http://127.0.0.1:${FRICK_PORT}/ready" || exit 1

CMD ["frick-server"]
