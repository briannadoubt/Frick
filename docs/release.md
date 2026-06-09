# Release Runbook

This is the operator-facing checklist for cutting a Frick release. The policy (semver rules, deprecation windows, surface stability) lives in [`versioning.md`](versioning.md).

**The whole stack ships as one version.** Every published TypeScript package, the Swift SDK, and the Android `:frick` SDK move together on a single **bare semver tag** (e.g. `0.3.0`). That one tag triggers all three publish workflows — there is no per-platform tag and no per-package desync to reason about. Think of `0.3.0` as "Frick 0.3.0," not "this-package@0.3.0."

## Flow

1. **PR opened** against `main` with the change; **CI green** (`pnpm test`, `pnpm typecheck`, `pnpm verify:generated`, Swift + Android module checks, the Postgres migration-runner suite, release dry-run, smoke test).
2. On a clean `main` checkout after the PR lands, **bump the whole stack** to the new version:
   ```sh
   pnpm release:bump 0.3.0
   ```
   This sets every published package + the Android `frickVersion` to `0.3.0` and stitches the `CHANGELOG.md` `## Unreleased` section into a dated `## 0.3.0` header. Review the changelog entry.
3. **Commit + push** the release:
   ```sh
   git commit -am "chore(release): v0.3.0"
   git push origin HEAD:main
   ```
4. **Auto-tag fires.** `release-autotag.yml` sees the `chore(release):` commit, reads the version, verifies the Android version is in lockstep, and pushes a single bare **`0.3.0`** tag (via `RELEASE_TAG_TOKEN`, so the publish workflows trigger).
5. **Publish.** The `0.3.0` tag fans out to:
   - `publish-npm.yml` → npm trusted publishing (provenance), publishing any missing package versions.
   - `publish-swift.yml` → mirrors `packages/swift` to the `FrickSwift` repo and tags it `0.3.0`.
   - `publish-android.yml` → GitHub Packages Maven artifact.

Do **not** publish from a feature branch. You can also push the bare tag by hand instead of relying on auto-tag.

## Swift: the monorepo is the source; the mirror is output

SwiftPM cannot resolve a package nested in a subdirectory — `Package.swift` must sit at a repo root. So `packages/swift` is mirrored (with history) to **`briannadoubt/FrickSwift`**, whose root *is* the package. Consumers depend on the mirror:

```swift
.package(url: "https://github.com/briannadoubt/FrickSwift.git", from: "0.3.0")
```

**Develop in `packages/swift` / `packages/design-swift`. Never clone or edit the FrickSwift mirror** — it is generated, publish-only output with no source of truth.

The mirror push authenticates with an **SSH deploy key** (no expiry, no account scopes), not a PAT.

## Required one-time secrets

- **`RELEASE_TAG_TOKEN`** — a PAT (classic `repo`, or fine-grained with Contents: read & write on this repo). Tags pushed by the default `GITHUB_TOKEN` do **not** trigger downstream workflows, so the auto-tagger needs this to fire the publishes.
- **`SWIFT_MIRROR_DEPLOY_KEY`** — the **private** half of an SSH deploy key added (with **write** access) to `briannadoubt/FrickSwift` (Settings → Deploy keys). Deploy keys never expire and need no account scopes.
  ```sh
  ssh-keygen -t ed25519 -f frick_mirror -N "" -C "frick-swift-mirror"
  # add frick_mirror.pub as a write-enabled deploy key on briannadoubt/FrickSwift
  gh secret set SWIFT_MIRROR_DEPLOY_KEY < frick_mirror   # the PRIVATE key
  rm frick_mirror frick_mirror.pub
  ```
- npm **trusted publishing** must be configured for each public package (`@fricken/protocol`, `@fricken/core`, `@fricken/design`, `@fricken/react`, `@fricken/design-web`, `@fricken/devtools`, `@fricken/agent-kit`, `@fricken/mcp`, `@fricken/server`) to trust this repo + the `publish-npm.yml` workflow. No long-lived `NPM_TOKEN`.

## Manual tagging (if not using auto-tag)

After the `chore(release): v0.3.0` commit is on `main`:

```sh
git tag 0.3.0
git push origin 0.3.0   # push with a token/credential that triggers workflows
```

## Pre-publish sanity checklist

- [ ] `pnpm test` + `pnpm typecheck` pass on a clean checkout of the release commit.
- [ ] `pnpm verify:generated` reports no schema/fixture/design-token drift.
- [ ] `pnpm release:dry-run` passes.
- [ ] `CHANGELOG.md` has a `## <version>` header for the version you're tagging.
- [ ] Every published package + Android `frickVersion` equals the release version (`pnpm release:bump` keeps them in lockstep).
- [ ] If `schemaRevision` was bumped, `@fricken/protocol` and every dependent package were rebuilt.
- [ ] Deprecated APIs being removed were marked deprecated at least one full minor ago.

## Rolling back

If a published version is broken, deprecate (don't unpublish) and ship a patch. npm's unpublish window is 72h but consumers may already have it cached — the safer path is always `0.3.1` with the fix.
