---
name: frick-typescript-core
description: Use when working with the UI-agnostic TypeScript Frick client runtime, cache, subscriptions, commands, offline appends, or sync status.
---

# Frick TypeScript Core

Read `docs/cross-platform-client-contract.md`.

Guidance:
- Keep runtime behavior UI-agnostic.
- Preserve local cache metadata compatibility checks.
- Preserve typed structured error surfaces and retry predicates.
- Keep object upserts, stream appends, presence, signals, and diagnostics aligned with Swift and Kotlin semantics.

Add focused tests for runtime behavior and run `pnpm test` plus `pnpm typecheck`.
