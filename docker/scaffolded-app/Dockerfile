# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Reference recipe (b): a Frick server image for an app scaffolded with
# `frick init` (the `@fricken/cli` `frick` bin). This Dockerfile lives at the
# ROOT of the scaffolded app and uses the app's own package.json scripts.
#
# A scaffolded app has this shape (see `frick init`):
#   <app>/
#   ├── package.json     # scripts: dev (tsx), build (tsc), test (vitest)
#   ├── tsconfig.json    # outDir: dist, rootDir: src
#   ├── frick.config.json
#   └── src/
#       ├── schema.ts
#       └── server.ts     # createFrickServer({ schema, port }); app.listen()
#
# Copy this file to your scaffolded app root, then:
#
#   docker build -t my-app docker/scaffolded-app   # (or `.` if copied to root)
#   docker run --rm -p 4099:4099 -v frick-data:/var/lib/frick \
#     -e PORT=4099 my-app
#
# The scaffolded `src/server.ts` reads its port from `PORT` (falling back to
# the value baked in at `frick init` time). All other knobs are the standard
# FRICK_* env vars — see docs/operations.md and docs/docker-recipes.md.
# ─────────────────────────────────────────────────────────────────────────────

# ---- Stage 1: install full deps + compile TypeScript -------------------------
FROM node:24-bookworm-slim AS build

WORKDIR /app

# Manifest first for layer caching. A real scaffolded app ships a lockfile
# (package-lock.json / pnpm-lock.yaml); copy it too for reproducible installs.
COPY package*.json ./
RUN npm install --no-audit --no-fund

# Compile src/ -> dist/ with the app's own tsconfig.
COPY tsconfig.json frick.config.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies so only the runtime closure ships in the final image.
RUN npm prune --omit=dev

# ---- Stage 2: minimal runtime ------------------------------------------------
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    FRICK_ENV=production \
    FRICK_HOST=0.0.0.0 \
    PORT=4099 \
    FRICK_PORT=4099 \
    FRICK_DB_PATH=/var/lib/frick/frick.sqlite \
    FRICK_BLOB_STORAGE_PATH=/var/lib/frick/blobs

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json /app/frick.config.json ./

RUN mkdir -p /var/lib/frick/blobs && chown -R node:node /app /var/lib/frick

USER node

EXPOSE 4099

VOLUME ["/var/lib/frick"]

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4099)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The compiled entrypoint. tsconfig outDir is `dist`, rootDir is `src`, so
# src/server.ts compiles to dist/server.js.
CMD ["node", "dist/server.js"]
