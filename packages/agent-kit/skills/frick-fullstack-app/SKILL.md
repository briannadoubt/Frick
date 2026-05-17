---
name: frick-fullstack-app
description: Use when a user asks to create, scaffold, design, or implement a fullstack Frick application across backend and one or more clients.
---

# Frick Fullstack App

Start by creating or updating `docs/frick/spine.md`. Treat it as the shared app contract for schema, server, web, iOS, Android, debugging, and verification work.

Workflow:
1. Read `docs/frick/spine.md` if it exists, then read Frick app docs: `README.md`, `docs/onboarding.md`, `docs/authoring.md`, and `docs/framework-boundaries.md`.
2. Define the app's schema primitives first: objects, streams, events, presence, signals, projections, jobs, blobs, and indexes.
3. Decide which clients are in scope: TypeScript core, React web, Swift/iOS, Kotlin/Android.
4. Scaffold with `frick init` or the repo-local `pnpm cli init`, then keep app logic thin and promote reusable behavior to framework extension points.
5. Split work by ownership: backend owns schema/server; clients consume generated contract; debugger/reviewer owns parity and generated drift.
6. Verify with the narrow platform command first, then `pnpm test`, `pnpm typecheck`, and `pnpm verify:generated`.

Never hand-edit generated Frick artifacts. Regenerate schema outputs with `pnpm schema:generate` and design outputs with `pnpm design:generate`.
