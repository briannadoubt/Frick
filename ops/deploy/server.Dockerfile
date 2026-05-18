FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.0.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY apps/server ./apps/server
COPY apps/dev-dashboard ./apps/dev-dashboard

RUN pnpm install --frozen-lockfile
RUN pnpm exec tsc -b packages/protocol apps/server

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV FRICK_ENV=production
ENV FRICK_HOST=0.0.0.0
ENV FRICK_PORT=4099
ENV FRICK_DB_PATH=/var/lib/frick/frick.sqlite
ENV FRICK_BLOB_STORAGE_PATH=/var/lib/frick/blobs

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol ./packages/protocol
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/dev-dashboard ./apps/dev-dashboard

RUN mkdir -p /var/lib/frick/blobs \
  && chown -R node:node /app /var/lib/frick

USER node

EXPOSE 4099

CMD ["node", "apps/server/dist/dev.js"]
