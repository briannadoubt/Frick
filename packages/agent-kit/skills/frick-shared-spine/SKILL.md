---
name: frick-shared-spine
description: Use when creating or updating the shared Frick app spine that backend and platform agents coordinate from.
---

# Frick Shared Spine

Use `docs/frick/spine.md` as the shared implementation contract. If it is missing, create it from `docs/frick/agent-kit/spine-template.md`.

The spine must cover:
- Product shape and realtime workflow.
- Schema primitives: objects, streams, events, presence, signals, projections, jobs, blobs, indexes.
- Auth, tenancy, session source, and permission checks.
- Platform contracts for web, TypeScript core, iOS, Android, push, and design tokens.
- Verification commands for generated artifacts, TypeScript, Swift, and Android.
- Agent ownership when work is parallelized.

Update the spine before changing schema or generated artifacts. Client agents should treat the spine and generated code as their contract, not infer behavior from demo app internals.
