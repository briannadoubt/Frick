<!--
Thanks for the PR! A few notes before you hit submit:
  - Keep the title scope-prefixed (e.g. `fix(server): …`, `feat(swift): …`)
    so it slots cleanly into the CHANGELOG.
  - Run `pnpm test` and `pnpm typecheck` locally. CI runs both plus the
    native test suites on every PR.
  - If you changed the foundation schema or any DTOs, run
    `pnpm schema:generate` and `pnpm fixtures:generate` and commit the
    regenerated artifacts. `pnpm verify:generated` enforces this in CI.
-->

## Summary

<!-- One or two sentences on what this change does and why. -->

## Why

<!-- The motivating context. Link related issues with "Closes #123" / "Fixes #123". -->

## Scope of change

- [ ] Touches the wire protocol (`packages/protocol`)
- [ ] Touches `@frick/server` runtime behavior
- [ ] Touches the React, Swift, or Android client SDK
- [ ] Touches the CLI surface
- [ ] Adds or changes a database migration
- [ ] Documentation only

## Test plan

<!-- How did you verify this? -->

- [ ] `pnpm test` and `pnpm typecheck` pass locally
- [ ] `pnpm verify:generated` passes (if schema or DTOs changed)
- [ ] `pnpm e2e:smoke` passes (if server behavior changed)
- [ ] `pnpm swift:test` passes (if `packages/swift` or schema changed)
- [ ] `pnpm android:build` passes (if `apps/android/frick` or schema changed)

## Compatibility

<!--
If this changes the wire protocol, schema identity, or any persisted
storage layout, call it out here and link to the relevant section of
`docs/versioning.md`. A protocol break should bump `protocolVersion`; a
schema-shape change should bump `schemaRevision`. A pure documentation
or test change can leave this section empty.
-->

## CHANGELOG

<!--
Add an entry under `## Unreleased` in `CHANGELOG.md`, grouped by the
affected package (Protocol / Server / CLI / Swift / Android / Repo).
Skip for docs-only or internal-tooling changes.
-->
