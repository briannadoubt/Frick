# Publish checklist

Walk through this list end-to-end before cutting a Frick release. The
checklist is consumed by a human operator; clarity matters more than
terseness. Each section is gated on the previous one — do not skip ahead.

Companion docs:

- `docs/versioning.md` — how to choose major/minor/patch
- `docs/release.md` — the wider release process and rollback notes
- `docs/onboarding.md` — bringing a new maintainer onto the rotation

## Pre-flight

- [ ] PR merged to `main` and CI green on the merge commit
- [ ] `CHANGELOG.md` `Unreleased` section reviewed and complete
- [ ] Decide release type (major/minor/patch) per `docs/versioning.md`
- [ ] `pnpm verify:release` exits 0
  - Emits one JSON Lines record per gate (test, typecheck,
    verify:generated, swift:test, android:build) plus a summary
  - Use `pnpm verify:release --skip-mobile` only when the host lacks
    Swift / Android toolchains (e.g. Linux CI)
- [ ] `pnpm frick verify` exits 0 (re-runs the generated-artifact gate
  via the published CLI; useful as a spot check that the CLI still works)
- [ ] `pnpm release:dry-run` exits 0
  - Runs `npm pack --dry-run --json` per publishable package and flags
    suspicious manifest entries (test files, fixtures, large sourcemaps,
    missing README). Fix any findings before bumping.

## Bump

- [ ] `pnpm exec tsx scripts/bump-version.ts --package @frick/protocol --release <type>`
- [ ] Repeat for each affected package (`@frick/core`, `@frick/react`,
  `@frick/design`, `@frick/design-web`, `@frick/cli` if shipping)
- [ ] `pnpm changelog --output CHANGELOG.md` — then manually move the
  `Unreleased` entries under the new version heading
- [ ] Commit: `chore(release): vX.Y.Z`

## Tag and publish

- [ ] `git tag framework-vX.Y.Z`
- [ ] `git push origin main framework-vX.Y.Z`
- [ ] For each TS package, in dependency order:
  ```
  pnpm --filter @frick/protocol publish --access public
  pnpm --filter @frick/core      publish --access public
  pnpm --filter @frick/design    publish --access public
  pnpm --filter @frick/react     publish --access public
  pnpm --filter @frick/design-web publish --access public
  ```
- [ ] Swift: tagging is the publish step. SPM consumers pin to the
  `framework-vX.Y.Z` tag; there is no separate Swift registry push.
- [ ] Android: bump `frickVersion` in `apps/android/frick/build.gradle.kts`,
  commit, push tag `android-vX.Y.Z`. The `Publish Android SDK` workflow
  publishes the AAR to GitHub Packages at
  `dev.frick:frick-client:X.Y.Z`. Local dry-run:
  `cd apps/android && ./gradlew :frick:publishToMavenLocal`.

## Post-publish

- [ ] Update the GitHub Release notes from `CHANGELOG.md`
- [ ] Smoke-test the published packages:
  ```
  mkdir /tmp/test && cd /tmp/test
  pnpm dlx @frick/cli init test-app
  ```
  Confirm the scaffolded project boots and `frick verify` passes.
- [ ] Announce in the team channel with a link to the GitHub Release

## Rollback

If a published version breaks consumers:

1. `npm deprecate @frick/<pkg>@X.Y.Z "use X.Y.(Z-1)"` for each broken
   package (do **not** unpublish — npm's 72-hour window has consumer
   side-effects).
2. Re-cut a patch release from `main` with the fix.
3. Document the incident in `docs/release.md` post-mortem section.
