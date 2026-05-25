---
name: frick-projections
description: Use when adding or debugging Frick projections, derived views, projection subscriptions, or projection deltas.
---

# Frick Projections

Read `docs/onboarding.md` and `docs/authoring.md`. In scaffolded apps, prefer `frick scaffold projection <name>` or `pnpm cli scaffold projection <name>` with a kebab-case projection name.

Projection guidance:
- Define source objects, streams, and events in the spine before implementation.
- Keep projection computation server-side and deterministic.
- Ensure clients subscribe to projection deltas rather than duplicating server derivation logic.
- Add tests for initial snapshot and live update behavior.

Regenerate schema artifacts when the projection is schema-visible.
