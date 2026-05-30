---
name: frick-server-backend
description: Use when implementing Frick server app wiring, handlers, policy hooks, extension points, storage-facing behavior, or backend features.
---

# Frick Server Backend

Read `docs/framework-boundaries.md`, `docs/authoring.md`, and `docs/operations.md`.

Guidance:
- Use documented server APIs and app scaffold patterns.
- Prefer exported `@frick/server` extension points for app behavior:
  `appRoutes` for product HTTP endpoints, `jobs.handlers` for durable work,
  `recurring.jobs` for scheduled enqueue, `policyHooks` for authorization
  tightening, and registries/options for projections, search, blobs, push, and
  cluster fan-out.
- Do not import server route/storage internals unless the current app is inside the Frick repo and the change is explicitly framework work.
- Do not tell scaffolded apps to import `apps/server/src/email/*`; outbound email helpers exist internally but are not a documented `@frick/server` surface yet.
- Keep demo app behavior thin. If real apps need to copy it, promote it to a framework package or document an extension point.
- Preserve tenant isolation, structured error envelopes, schema compatibility checks, and session revalidation.
- Sharing routes are framework-owned (`/share/invite`, `/share/accept`,
  `/share/grants`, `/share/grants/:id`) and grant object-record access only.
  Product-level sharing semantics such as cascading, collaborator lists, or
  grantee leave flows belong in app code or a documented extension point.

Verify backend work with focused tests, then `pnpm test` and `pnpm typecheck`.
