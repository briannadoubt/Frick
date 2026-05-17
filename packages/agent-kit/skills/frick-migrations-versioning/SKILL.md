---
name: frick-migrations-versioning
description: Use when changing schema revisions, migration behavior, compatibility rules, package versions, release behavior, or upgrade paths.
---

# Frick Migrations and Versioning

Read `docs/versioning.md`, `docs/release.md`, and `docs/operations.md`.

Guidance:
- Keep schema identity fields coherent: `schemaId`, `schemaVersion`, `schemaRevision`, `schemaHash`, `minimumClientRevision`, and `minimumServerRevision`.
- Use migrations for durable server storage changes.
- Refuse unsafe production migration behavior unless documented confirmation flags are present.
- Update release docs and `CHANGELOG.md` for user-visible behavior.

Verify with `pnpm cli migrate status`, `pnpm verify:generated`, `pnpm test`, and `pnpm typecheck` as appropriate.
