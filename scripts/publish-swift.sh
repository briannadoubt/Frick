#!/usr/bin/env bash
#
# Publishes the monorepo's Swift packages to their standalone mirror repos so
# they can be consumed as remote SwiftPM dependencies (Package.swift must sit
# at a repo root — SwiftPM can't resolve a package in a subdirectory). The
# monorepo stays the single source of truth; mirrors are generated output,
# never hand-edited. Parallels publish-npm.yml / publish-android.yml.
#
# Published packages (prefix -> mirror):
#   packages/swift        -> briannadoubt/FrickSwift    (FR-* sync/session client)
#   packages/design-swift -> briannadoubt/FrickDesign   (FR-309 base SwiftUI kit)
#
# Usage:
#   scripts/publish-swift.sh <version>          # e.g. scripts/publish-swift.sh 0.6.0
#
# Env (CI injects tokenized URLs so the push authenticates):
#   FRICK_SWIFT_MIRROR   default https://github.com/briannadoubt/FrickSwift.git
#   FRICK_DESIGN_MIRROR  default https://github.com/briannadoubt/FrickDesign.git
#
set -euo pipefail

version="${1:-}"

if [[ -z "${version}" ]]; then
    echo "usage: scripts/publish-swift.sh <version>  (e.g. 0.6.0)" >&2
    exit 1
fi

if ! [[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    echo "version must be semver (got: ${version})" >&2
    exit 1
fi

swift_mirror="${FRICK_SWIFT_MIRROR:-https://github.com/briannadoubt/FrickSwift.git}"
design_mirror="${FRICK_DESIGN_MIRROR:-https://github.com/briannadoubt/FrickDesign.git}"

repo_root="$(git rev-parse --show-toplevel)"
cd "${repo_root}"

# Each entry: "<subtree prefix>|<mirror push URL>|<split-branch slug>"
packages=(
    "packages/swift|${swift_mirror}|frickswift"
    "packages/design-swift|${design_mirror}|frickdesign"
)

cleanup() {
    for entry in "${packages[@]}"; do
        IFS='|' read -r _ _ slug <<<"${entry}"
        git branch -D "__${slug}_publish_${version}" >/dev/null 2>&1 || true
    done
}
trap cleanup EXIT

for entry in "${packages[@]}"; do
    IFS='|' read -r prefix mirror slug <<<"${entry}"
    split_branch="__${slug}_publish_${version}"

    echo "==> [${prefix}] splitting subtree (root-level Package.swift)"
    git branch -D "${split_branch}" >/dev/null 2>&1 || true
    git subtree split --prefix="${prefix}" -b "${split_branch}"

    echo "==> [${prefix}] pushing subtree to mirror main"
    git push "${mirror}" "${split_branch}:refs/heads/main"

    echo "==> [${prefix}] tagging mirror ${version}"
    git push "${mirror}" "${split_branch}:refs/tags/${version}"

    echo "==> Published ${prefix} -> ${mirror} @ ${version}"
done
