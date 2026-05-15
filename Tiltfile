local_resource(
  "install",
  cmd="pnpm install --frozen-lockfile --ignore-scripts",
  deps=[
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "packages/protocol/package.json",
    "packages/core/package.json",
    "packages/react/package.json",
    "apps/server/package.json",
    "apps/web/package.json",
  ],
)

local_resource(
  "schema-generate",
  cmd="pnpm schema:generate",
  deps=[
    "packages/protocol/src/schema.ts",
    "packages/protocol/src/foundation.ts",
    "packages/protocol/src/artifacts.ts",
    "packages/protocol/scripts/generate-native-artifacts.ts",
  ],
  resource_deps=["install"],
)

local_resource(
  "frick-server",
  serve_cmd="pnpm run server",
  resource_deps=["schema-generate"],
  readiness_probe=probe(
    http_get=http_get_action(port=4099, path="/health"),
    initial_delay_secs=2,
    period_secs=2,
  ),
  links=["http://127.0.0.1:4099/health", "http://127.0.0.1:4099/schema"],
)

local_resource(
  "frick-web",
  serve_cmd="pnpm run web",
  resource_deps=["install", "frick-server"],
  links=["http://127.0.0.1:5173"],
)
