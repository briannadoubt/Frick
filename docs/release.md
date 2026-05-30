# Release Runbook

This is the operator-facing checklist for cutting a Frick framework release. The policy (semver rules, deprecation windows, surface stability) lives in [`versioning.md`](versioning.md).

Frick has independent per-package versions. A release usually covers one or a few packages, not all of them. The `framework-v*` tag is a repository cut marker for changelog and automation; it does not require every npm package version to equal the tag version.

## Flow

1. **PR opened** against `main` with the change.
2. **CI green** — `pnpm test`, `pnpm typecheck`, native build matrices (Swift, Android), generated-artifact drift check for schema, fixtures, and design tokens.
3. **Bump version** for each package that changed. See the CLI commands below.
4. **Regenerate the changelog** entry for the upcoming version.
5. **Tag** the release in git.
6. **Publish** by pushing the release tag. The npm workflow publishes missing TS package versions through npm trusted publishing with provenance; native artifacts are released through their own channels.

Steps 3-5 are also done by the release operator on a clean `main` checkout after the PR lands. Do **not** publish from a feature branch.

## CLI commands

All commands run from the repo root.

### Bump a TypeScript package

```sh
pnpm exec tsx scripts/bump-version.ts --package @frick/protocol --release minor
```

This rewrites `packages/protocol/package.json` and creates a commit named `chore(release): @frick/protocol@<version>`. Pass `--no-commit` if you want to stage other changes alongside.

Valid packages match the `name` field in any workspace `package.json`. Valid release types are `major`, `minor`, `patch` (see `docs/versioning.md`).

### Bump an Android module

```sh
pnpm exec tsx scripts/bump-version.ts --package android:frick --release patch
```

This edits `apps/android/frick/build.gradle.kts`, replacing `val frickVersion = "X.Y.Z"` when present or inserting a top-level `version = "X.Y.Z"` line, and emits a tag suggestion on stderr. The publish workflow accepts only `android-vX.Y.Z` tags that match `frickVersion`.

Supported Android packages: `android:frick`, `android:design`.

### Bump a Swift package

```sh
pnpm exec tsx scripts/bump-version.ts --package swift:frick --release patch
```

Swift Package Manager carries no version field — releases are tag-only. The script computes the next version from the latest matching tag (`swift-v*` or `swift-design-v*`) and prints the recommended `git tag` command. Nothing is committed.

### Regenerate the changelog

```sh
pnpm changelog --version 1.4.0 --output CHANGELOG.next.md
```

Reads commits since the most recent `framework-v*` tag, groups them by conventional-commit prefix, and writes Markdown. Stitch the result into `CHANGELOG.md` under a new release header above `Unreleased`. Pipe to stdout (no `--output`) to preview.

For a one-off range, pass `--since <ref>`:

```sh
pnpm changelog --since framework-v1.3.0 --version 1.4.0
```

### Tag

After the version-bump commit lands on `main`:

```sh
git tag framework-v1.4.0
git tag @frick/protocol@1.4.0   # per-package tags optional but recommended
git push origin framework-v1.4.0 @frick/protocol@1.4.0
```

The `framework-v*` tag is what `scripts/changelog.ts` keys on for the next release. Keep tagging it on every release that ships any TS package so the next changelog has a clean cutover.

## Publishing

TypeScript packages publish from `.github/workflows/publish-npm.yml` when a `framework-v*` tag is pushed. The workflow:

- accepts only strict SemVer `framework-v<version>` tags that point at a commit on `origin/main`,
- has `contents: read` and `id-token: write` permissions only,
- uses pinned GitHub Actions,
- runs the same TypeScript/generated-artifact/pack hygiene gates as CI, and
- packs each missing package with `pnpm pack` so workspace dependencies are rewritten, then publishes that tarball with `npm publish --provenance`.

Before the first automated npm release, configure npm trusted publishing for each public package (`@frick/protocol`, `@frick/core`, `@frick/design`, `@frick/react`, `@frick/design-web`, `@frick/devtools`, `@frick/agent-kit`, `@frick/mcp`) to trust this repository and workflow path:

```text
publish-npm.yml
```

npm's trusted-publisher form asks for the workflow filename, not the full `.github/workflows/` path. Each public package manifest must include repository metadata for the GitHub repository running the workflow (`git+https://github.com/<owner>/<repo>.git`) plus its workspace directory; the workflow fails before publishing if it does not match. Do not use long-lived `NPM_TOKEN` or `NODE_AUTH_TOKEN` secrets for framework package publishing. For Swift, push the tag — SwiftPM consumers resolve from git. For Android, push the matching `android-v*` tag and let the Android publish workflow release the Maven artifact.

## Pre-publish sanity checklist

- [ ] `pnpm test` passes locally on a clean checkout of the tagged commit.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm verify:generated` reports no schema, fixture, or design-token drift.
- [ ] `pnpm release:dry-run` passes.
- [ ] `CHANGELOG.md` has a header for the version you are about to tag.
- [ ] Every package being shipped has the intended bumped version; Android `build.gradle.kts` versions still match their `android-v*` tags.
- [ ] npm trusted publishing is configured for every public TypeScript package being shipped.
- [ ] If `schemaRevision` was bumped, `@frick/protocol` got at least a minor bump and every other TS package that imports protocol types was rebuilt at least once.
- [ ] Deprecated APIs being removed in this release were marked deprecated at least one full minor ago.

## Rolling back

If a published version is broken, deprecate (don't unpublish) and ship a patch release. npm's unpublish window is 72 hours but consumers may already have it cached. The safer path is always `1.4.1` with the fix.
