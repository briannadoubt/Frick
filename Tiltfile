local_resource(
  "install",
  cmd="pnpm install",
  deps=[
    "package.json",
    "pnpm-workspace.yaml",
    "packages/protocol/package.json",
    "packages/core/package.json",
    "packages/react/package.json",
    "apps/server/package.json",
    "apps/web/package.json",
  ],
)

local_resource(
  "frick-server",
  serve_cmd="pnpm run server",
  resource_deps=["install"],
  readiness_probe=probe(
    http_get=http_get_action(port=4099, path="/health"),
    initial_delay_secs=2,
    period_secs=2,
  ),
  links=["http://127.0.0.1:4099/health", "http://127.0.0.1:4099/manifest"],
)

local_resource(
  "frick-web",
  serve_cmd="pnpm run web",
  resource_deps=["install", "frick-server"],
  links=["http://127.0.0.1:5173"],
)
