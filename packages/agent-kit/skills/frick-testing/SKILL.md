---
name: frick-testing
description: Use when deciding which Frick tests or verification commands to run for framework, server, client, generated artifact, or release changes.
---

# Frick Testing

Read `CONTRIBUTING.md` and `docs/status.md`.

Command map:
- TypeScript packages and apps: `pnpm test`, `pnpm typecheck`.
- Generated schema, fixtures, and design drift: `pnpm verify:generated`.
- Swift packages: `pnpm swift:test`.
- Android framework modules: generate schema/design artifacts, then run the
  Gradle module set used by CI (`:frick`, `:frick-compose`, `:design`).
  `pnpm android:build` is the stricter local full-demo check and includes
  `:app`.
- Release gates: `pnpm verify:release --skip-mobile` when mobile toolchains are unavailable.

Run the smallest command that proves the changed behavior first, then broaden before claiming completion.
