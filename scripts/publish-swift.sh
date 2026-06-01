#!/usr/bin/env bash
#
# Publishes packages/swift to the standalone FrickSwift repo so it can be
# consumed as a remote SwiftPM dependency (XCRemoteSwiftPackageReference).
#
# SwiftPM cannot resolve a remote package that lives in a subdirectory of a
# repo — Package.swift must sit at the repo root. This monorepo keeps the
# Swift sources at packages/swift/, so we mirror that subtree (with history)
# to a publish-only repo whose root IS the package. The monorepo remains the
# single source of truth; the mirror is never edited by hand. This parallels
# publish-npm.yml (npm registry) and publish-android.yml (GitHub Packages).
#
# Usage:
#   scripts/publish-swift.sh <version>          # e.g. scripts/publish-swift.sh 0.1.0
#
# Env:
#   FRICK_SWIFT_MIRROR  push URL for the mirror repo
#                       (default: https://github.com/briannadoubt/FrickSwift.git)
#                       CI injects a tokenized URL so the push authenticates.
#
set -euo pipefail

version="${1:-}"

if [[ -z "${version}" ]]; then
    echo "usage: scripts/publish-swift.sh <version>  (e.g. 0.1.0)" >&2
    exit 1
fi

if ! [[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    echo "version must be semver (got: ${version})" >&2
    exit 1
fi

prefix="packages/swift"
mirror="${FRICK_SWIFT_MIRROR:-https://github.com/briannadoubt/FrickSwift.git}"
split_branch="__frickswift_publish_${version}"

repo_root="$(git rev-parse --show-toplevel)"
cd "${repo_root}"

cleanup() {
    git branch -D "${split_branch}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Splitting ${prefix} subtree (root-level Package.swift)"
git branch -D "${split_branch}" >/dev/null 2>&1 || true
git subtree split --prefix="${prefix}" -b "${split_branch}"

echo "==> Pushing subtree to mirror main"
git push "${mirror}" "${split_branch}:refs/heads/main"

echo "==> Tagging mirror ${version}"
git push "${mirror}" "${split_branch}:refs/tags/${version}"

echo "==> Published FrickSwift ${version}"
