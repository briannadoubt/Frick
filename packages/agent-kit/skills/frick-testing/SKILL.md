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
- Android SDK and demo: `pnpm android:build`.
- Release gates: `pnpm verify:release --skip-mobile` when mobile toolchains are unavailable.

Run the smallest command that proves the changed behavior first, then broaden before claiming completion.
