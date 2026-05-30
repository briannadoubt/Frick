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
  - `verify:generated` regenerates schema DTOs, protocol fixtures, and
    design-token outputs before checking for drift
  - Use `pnpm verify:release --skip-mobile` only when the host lacks
    Swift / Android toolchains (e.g. Linux CI)
- [ ] `pnpm frick verify` exits 0 (re-runs the generated-artifact gate
  via the published CLI; useful as a spot check that the CLI still works)
- [ ] `pnpm release:dry-run` exits 0
  - Runs `pnpm pack --json` per publishable package with lifecycle scripts
    disabled by config, then flags
    suspicious manifest entries (test files, fixtures, large sourcemaps,
    lifecycle hooks, missing README), TypeScript source entrypoints,
    unreplaced `workspace:` runtime dependencies, and relative JS/DTS imports
    missing from the packed tarball. Fix any findings before bumping.

## Bump

- [ ] `pnpm exec tsx scripts/bump-version.ts --package @frick/protocol --release <type>`
- [ ] Repeat for each affected package (`@frick/core`, `@frick/react`,
  `@frick/design`, `@frick/design-web`, `@frick/devtools`,
  `@frick/agent-kit`, `@frick/mcp`)
  - `@frick/cli`, `@frick/server`, and `@frick/web` remain private workspace
    packages and are excluded from npm publishing until deliberately made
    public.
- [ ] `pnpm changelog --output CHANGELOG.md` — then manually move the
  `Unreleased` entries under the new version heading
- [ ] Commit: `chore(release): vX.Y.Z`

## Tag and publish

- [ ] `git tag framework-vX.Y.Z`
- [ ] `git push origin main framework-vX.Y.Z`
- [ ] Confirm the `Publish npm Packages` workflow starts for the
  `framework-vX.Y.Z` tag.
  - It must run from `.github/workflows/publish-npm.yml`, verify the tag is
    on `origin/main`, use `id-token: write`, and publish with npm provenance.
  - The `framework-vX.Y.Z` tag is the release cut marker for automation and
    changelog ranges; independently versioned npm packages do not have to use
    `X.Y.Z` unless that package is being bumped to the same version.
  - Before the first automated npm release, configure npm trusted publishing
    for each public package in npm (`@frick/protocol`, `@frick/core`,
    `@frick/design`, `@frick/react`, `@frick/design-web`,
    `@frick/devtools`, `@frick/agent-kit`, `@frick/mcp`) to trust this
    repository and workflow filename (`publish-npm.yml`).
  - Confirm each package's npm metadata uses the repository URL
    `git+https://github.com/<owner>/<repo>.git` for the repository running
    the workflow and includes the package's workspace directory.
  - Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN`; package publishing is OIDC
    based.
- [ ] Confirm the workflow publishes or explicitly skips each package version
  in dependency order:
  ```
  @frick/protocol
  @frick/core
  @frick/design
  @frick/react
  @frick/design-web
  @frick/devtools
  @frick/agent-kit
  @frick/mcp
  ```
- [ ] Swift: tagging is the publish step. SPM consumers pin to the
  `framework-vX.Y.Z` tag; there is no separate Swift registry push.
- [ ] Android: bump `frickVersion` in `apps/android/frick/build.gradle.kts`,
  commit, push tag `android-vX.Y.Z`. The `Publish Android SDK` workflow
  verifies generated artifacts, runs Android tests/lint/debug builds, then
  publishes the AAR to GitHub Packages at
  `dev.frick:frick-client:X.Y.Z`. Local dry-run:
  `cd apps/android && ./gradlew :frick:publishToMavenLocal`.

## Post-publish

- [ ] Update the GitHub Release notes from `CHANGELOG.md`
- [ ] Smoke-test the published packages:
  ```
  mkdir /tmp/test && cd /tmp/test
  npm init -y
  pnpm add @frick/protocol@X.Y.Z @frick/core@X.Y.Z @frick/react@X.Y.Z
  pnpm add @frick/design@X.Y.Z @frick/design-web@X.Y.Z @frick/devtools@X.Y.Z
  pnpm add @frick/agent-kit@X.Y.Z @frick/mcp@X.Y.Z
  node --input-type=module -e 'await Promise.all([
    import("@frick/protocol"), import("@frick/core"), import("@frick/react"),
    import("@frick/design"), import("@frick/design-web"), import("@frick/devtools"),
    import("@frick/agent-kit"), import("@frick/mcp")
  ])'
  ```
  Use the exact versions the workflow published; omit packages that were
  already published and skipped for this release.
- [ ] Announce in the team channel with a link to the GitHub Release

## Rollback

If a published version breaks consumers:

1. `npm deprecate @frick/<pkg>@X.Y.Z "use X.Y.(Z-1)"` for each broken
   package (do **not** unpublish — npm's 72-hour window has consumer
   side-effects).
2. Re-cut a patch release from `main` with the fix.
3. Document the incident in `docs/release.md` post-mortem section.
