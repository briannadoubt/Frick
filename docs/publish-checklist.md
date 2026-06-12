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
  - `android:build` is the stricter local Android script and includes the demo
    `:app`; CI and Android publishing gate only the framework modules
    (`:frick`, `:frick-compose`, `:design`) while the demo is being rebuilt.
- [ ] `cargo test --workspace` and `cargo clippy --workspace --all-targets -- -D warnings`
  exit 0 (the backend gate; the `frick` CLI and sync server are Rust crates)
- [ ] `pnpm release:dry-run` exits 0
  - Runs `pnpm pack --json` per publishable package with lifecycle scripts
    disabled by config, then flags
    suspicious manifest entries (test files, fixtures, large sourcemaps,
    lifecycle hooks, missing README), TypeScript source entrypoints,
    unreplaced `workspace:` runtime dependencies, and relative JS/DTS imports
    missing from the packed tarball. Fix any findings before bumping.

## Bump

- [ ] `pnpm release:bump X.Y.Z`
  - This updates every published TypeScript package, the Android `frickVersion`,
    and the changelog heading in one pass.
  - The Rust backend crates (`frick-server`, `frick-cli`, `frick-mcp`, …) are
    not npm-published and are not part of this bump; they share the workspace
    version in the root `Cargo.toml`.
  - `@fricken/web` remains a private workspace package.
- [ ] Review `CHANGELOG.md` and fill in any missing user-facing release notes
  before committing.
- [ ] Commit: `chore(release): vX.Y.Z`

## Tag and publish

- [ ] Prefer the auto-tag workflow after the `chore(release): vX.Y.Z` commit
  lands on `main`; it creates one bare semver tag, `X.Y.Z`, when the platform
  versions are in lockstep.
- [ ] If tagging manually, push the bare semver tag `X.Y.Z` with credentials
  that trigger workflows.
- [ ] Confirm the `Publish npm Packages` workflow starts for the `X.Y.Z` tag.
  - It must run from `.github/workflows/publish-npm.yml`, verify the tag is
    on `origin/main`, use `id-token: write`, and publish with npm provenance.
  - The bare `X.Y.Z` tag is the release cut marker for npm, Swift mirror, and
    Android publishing.
  - Before the first automated npm release, configure npm trusted publishing
    for each public package in npm (`@fricken/protocol`, `@fricken/core`,
    `@fricken/design`, `@fricken/react`, `@fricken/design-web`,
    `@fricken/devtools`) to trust this repository and workflow filename
    (`publish-npm.yml`).
  - Confirm each package's npm metadata uses the repository URL
    `git+https://github.com/<owner>/<repo>.git` for the repository running
    the workflow and includes the package's workspace directory.
  - Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN`; package publishing is OIDC
    based.
- [ ] Confirm the workflow publishes or explicitly skips each package version
  in dependency order:
  ```
  @fricken/protocol
  @fricken/core
  @fricken/design
  @fricken/react
  @fricken/design-web
  @fricken/devtools
  ```
- [ ] Swift: the same bare `X.Y.Z` tag mirrors `packages/swift` to the
  standalone `FrickSwift` repository and creates the plain `X.Y.Z` tag there.
  SPM consumers depend on `https://github.com/briannadoubt/FrickSwift.git`, not
  the monorepo tag; there is no separate Swift registry push.
- [ ] Android: the same bare `X.Y.Z` tag triggers the `Publish Android SDK`
  workflow, which verifies generated artifacts, runs Android tests/lint/debug
  builds, then publishes the AAR to GitHub Packages at
  `dev.frick:frick-client:X.Y.Z`. Local dry-run:
  `cd apps/android && ./gradlew :frick:publishToMavenLocal`.

## Post-publish

- [ ] Update the GitHub Release notes from `CHANGELOG.md`
- [ ] Smoke-test the published packages:
  ```
  mkdir /tmp/test && cd /tmp/test
  npm init -y
  pnpm add @fricken/protocol@X.Y.Z @fricken/core@X.Y.Z @fricken/react@X.Y.Z
  pnpm add @fricken/design@X.Y.Z @fricken/design-web@X.Y.Z @fricken/devtools@X.Y.Z
  node --input-type=module -e 'await Promise.all([
    import("@fricken/protocol"), import("@fricken/core"), import("@fricken/react"),
    import("@fricken/design"), import("@fricken/design-web"), import("@fricken/devtools")
  ])'
  ```
  Use the exact versions the workflow published; omit packages that were
  already published and skipped for this release.
- [ ] Announce in the team channel with a link to the GitHub Release

## Rollback

If a published version breaks consumers:

1. `npm deprecate @fricken/<pkg>@X.Y.Z "use X.Y.(Z-1)"` for each broken
   package (do **not** unpublish — npm's 72-hour window has consumer
   side-effects).
2. Re-cut a patch release from `main` with the fix.
3. Document the incident in `docs/release.md` post-mortem section.
