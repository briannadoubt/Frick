---
name: frick-web-react
description: Use when building or debugging React web clients for Frick apps with @frick/react, @frick/core, design-web, or the browser demo patterns.
---

# Frick React Web

Read `docs/onboarding.md`, `docs/authoring.md`, and `docs/cross-platform-client-contract.md`.

Guidance:
- Use `@frick/react` hooks and provider patterns over raw sync plumbing.
- Keep UI-specific state separate from the Frick client cache.
- Surface `SyncStatus` fields for connection, auth, schema compatibility, pending mutations, and last error.
- Keep demo app code thin; reusable behavior belongs in packages.
- Use design tokens from `@frick/design-web` when available.

Verify with `pnpm web`, browser testing when UI changes, `pnpm test`, and `pnpm typecheck`.
