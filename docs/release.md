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
pnpm exec tsx scripts/bump-version.ts --package @fricken/protocol --release minor
```

This rewrites `packages/protocol/package.json` and creates a commit named `chore(release): @fricken/protocol@<version>`. Pass `--no-commit` if you want to stage other changes alongside.

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
git tag @fricken/protocol@1.4.0   # per-package tags optional but recommended
git push origin framework-v1.4.0 @fricken/protocol@1.4.0
```

The `framework-v*` tag is what `scripts/changelog.ts` keys on for the next release. Keep tagging it on every release that ships any TS package so the next changelog has a clean cutover.

## Automatic release (the normal path)

Releases are cut by `.github/workflows/release.yml`. When a `chore(release): vX.Y.Z` commit lands on `main`, it runs automatically; you can also trigger it from the Actions tab or `gh workflow run release.yml --ref main` (with an optional `version` input). In one run it:

- resolves the version from `packages/protocol/package.json` (or the `version` input) and validates it is strict SemVer,
- verifies `apps/android/frick/build.gradle.kts` `frickVersion` is in lockstep,
- **calls** the three publish workflows as reusable workflows (`publish-npm.yml`, `publish-swift.yml`, `publish-android.yml`) in the same run, then
- pushes the marker tags `framework-v<version>`, `swift-v<version>`, `android-v<version>` (with the built-in token; skips any that already exist).

Because publishing happens in-run, nothing depends on tag-push events — so there is **no tagging PAT**. The whole flow is therefore: bump versions → `chore(release):` commit → merge to `main` → it ships.

### One-time setup: two repository secrets

| Secret | Used by | Notes |
| --- | --- | --- |
| `NPM_TOKEN` | npm publish | npm **automation** token with publish rights to the `@fricken/*` packages. setup-node wires it into `.npmrc` as `NODE_AUTH_TOKEN`; publishes still attach `--provenance`. |
| `SWIFT_MIRROR_TOKEN` | Swift mirror | PAT (classic `repo`, or fine-grained Contents: read & write) scoped to `briannadoubt/FrickSwift`. |

Android publishes to GitHub Packages with the built-in `GITHUB_TOKEN` — no secret needed.

> Trade-off: this uses a single long-lived `NPM_TOKEN` instead of per-package OIDC trusted publishing, in exchange for zero per-package setup. Rotate the token periodically. To return to trusted publishing, restore the OIDC publish step in `publish-npm.yml` and the corresponding `security-hardening.test.ts` assertions.

## Manual / fallback publishing

Each publish workflow still fires on its own pushed tag, so you can publish a single platform by hand: push `framework-v<version>`, `swift-v<version>`, or `android-v<version>` (see [Tag](#tag)). The npm and Android workflows keep their SemVer + `origin/main` ancestor guards on that tag-push path.

## Pre-publish sanity checklist

- [ ] `pnpm test` passes locally on a clean checkout of the release commit.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm verify:generated` reports no schema, fixture, or design-token drift.
- [ ] `pnpm release:dry-run` passes.
- [ ] `CHANGELOG.md` has a header for the version you are about to release.
- [ ] Every package being shipped has the intended bumped version; Android `frickVersion` matches the release version.
- [ ] `NPM_TOKEN` and `SWIFT_MIRROR_TOKEN` secrets exist.
- [ ] If `schemaRevision` was bumped, `@fricken/protocol` got at least a minor bump and every other TS package that imports protocol types was rebuilt at least once.
- [ ] Deprecated APIs being removed in this release were marked deprecated at least one full minor ago.

## Rolling back

If a published version is broken, deprecate (don't unpublish) and ship a patch release. npm's unpublish window is 72 hours but consumers may already have it cached. The safer path is always `1.4.1` with the fix.
