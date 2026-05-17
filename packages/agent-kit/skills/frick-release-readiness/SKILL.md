---
name: frick-release-readiness
description: Use when preparing Frick package publishing, release checks, changelog updates, version bumps, provenance, or release documentation.
---

# Frick Release Readiness

Read `docs/release.md`, `docs/versioning.md`, and `docs/publish-checklist.md`.

Guidance:
- Public packages must include repository metadata and `publishConfig` with public provenance.
- npm publishing runs from framework version tags and trusted publishing.
- Keep `CHANGELOG.md` current for user-visible changes.
- Run dry-run packaging checks before publishing.

Verify with `pnpm release:dry-run`, `pnpm test`, `pnpm typecheck`, and `pnpm verify:generated`.
