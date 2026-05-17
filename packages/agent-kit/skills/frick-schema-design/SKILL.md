---
name: frick-schema-design
description: Use when designing or changing a Frick schema, including objects, streams, events, presence, signals, projections, jobs, blobs, indexes, or schema identity.
---

# Frick Schema Design

Read `docs/schema-author-tutorial.md`, `docs/authoring.md`, `docs/versioning.md`, and `docs/cross-platform-client-contract.md`.

Rules:
- Design schema once and let generated artifacts drive every client.
- Preserve stable ids and field ids once shipped.
- Treat events as immutable after release.
- Update `schemaRevision` for compatible schema evolution and follow `docs/versioning.md` for breaking changes.
- Include tenancy and permission implications in the spine.

After schema edits run `pnpm schema:generate` and `pnpm verify:generated`. Update public docs and `CHANGELOG.md` for user-visible framework behavior changes.
