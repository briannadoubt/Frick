# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Reference recipe (a): a standalone Frick server image built from the
# PUBLISHED `@fricken/server` npm package. No Frick monorepo checkout required.
#
# Build context is this directory (docker/published-server). Copy it next to
# your own project, adjust the pinned version in package.json, and:
#
#   docker build -t my-frick-server docker/published-server
#   docker run --rm -p 4099:4099 -v frick-data:/var/lib/frick my-frick-server
#
# The server is configured entirely through FRICK_* env vars (see
# docs/operations.md and docs/docker-recipes.md). SQLite is the default; point
# FRICK_DATABASE_URL at Postgres for a stateless container.
# ─────────────────────────────────────────────────────────────────────────────

# ---- Stage 1: install production dependencies from the npm registry ----------
FROM node:24-bookworm-slim AS deps

WORKDIR /app

# Copy only the manifest first so the dependency layer caches across rebuilds
# that only touch the entrypoint.
COPY package.json ./

# No lockfile is shipped with the recipe so the resolved version follows the
# semver range in package.json. Pin it (and commit a package-lock.json) for a
# reproducible image in your own repo.
RUN npm install --omit=dev --no-audit --no-fund

# ---- Stage 2: minimal runtime ------------------------------------------------
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    FRICK_ENV=production \
    FRICK_HOST=0.0.0.0 \
    FRICK_PORT=4099 \
    FRICK_DB_PATH=/var/lib/frick/frick.sqlite \
    FRICK_BLOB_STORAGE_PATH=/var/lib/frick/blobs

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json entrypoint.mjs ./

# Writable data directory for the default SQLite store + filesystem blobs.
# Mount a named volume here to persist data. When FRICK_DATABASE_URL points at
# Postgres the container is stateless and this volume is unused.
RUN mkdir -p /var/lib/frick/blobs && chown -R node:node /app /var/lib/frick

USER node

EXPOSE 4099

VOLUME ["/var/lib/frick"]

# /ready returns 200 once the schema is applied and the server can serve sync.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FRICK_PORT||4099)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "entrypoint.mjs"]
