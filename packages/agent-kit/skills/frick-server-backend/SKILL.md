---
name: frick-server-backend
description: Use when implementing Frick server app wiring, handlers, policy hooks, extension points, storage-facing behavior, or backend features.
---

# Frick Server Backend

Read `docs/framework-boundaries.md`, `docs/authoring.md`, and `docs/operations.md`.

Guidance:
- Use documented server APIs and app scaffold patterns.
- Do not import server route/storage internals unless the current app is inside the Frick repo and the change is explicitly framework work.
- Keep demo app behavior thin. If real apps need to copy it, promote it to a framework package or document an extension point.
- Preserve tenant isolation, structured error envelopes, schema compatibility checks, and session revalidation.

Verify backend work with focused tests, then `pnpm test` and `pnpm typecheck`.
