#!/usr/bin/env tsx
/**
 * Unified release bump — the whole stack ships ONE version.
 *
 * Sets every published TypeScript package AND the Android `:frick` SDK to the
 * given bare semver version, and stitches the CHANGELOG `## Unreleased` section
 * into a dated `## <version>` header. The Swift package carries no version file
 * — it's published by tag, so the single release tag covers it.
 *
 * Usage:
 *   pnpm release:bump 0.3.0
 *
 * Then commit as a release and let CI cut the tag:
 *   git commit -am "chore(release): v0.3.0"
 *   git push origin HEAD:main          # release-autotag pushes the `0.3.0` tag
 *
 * The single bare `0.3.0` tag fans out to publish-npm / publish-swift /
 * publish-android. There is NO mirror to clone or edit — develop in
 * packages/swift; briannadoubt/FrickSwift is generated release output.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

// The packages published to npm (must match publish-npm.yml's list).
const TS_PACKAGE_DIRS = [
  "packages/protocol",
  "packages/core",
  "packages/design",
  "packages/react",
  "packages/design-web",
  "packages/devtools",
];

const ANDROID_GRADLE = "apps/android/frick/build.gradle.kts";
const CHANGELOG = "CHANGELOG.md";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function die(msg: string): never {
  process.stderr.write(`release-bump: ${msg}\n`);
  process.exit(2);
}

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function bumpTs(root: string, dir: string, version: string): string {
  const path = resolve(root, dir, "package.json");
  const raw = readFileSync(path, "utf8");
  const pj = JSON.parse(raw) as { name?: string; version?: string };
  const from = pj.version ?? "0.0.0";
  pj.version = version;
  writeFileSync(path, JSON.stringify(pj, null, 2) + (raw.endsWith("\n") ? "\n" : ""), "utf8");
  return `${pj.name ?? dir}: ${from} -> ${version}`;
}

function bumpAndroid(root: string, version: string): string {
  const path = resolve(root, ANDROID_GRADLE);
  const raw = readFileSync(path, "utf8");
  const re = /^(\s*val\s+frickVersion\s*=\s*")([^"]+)(")/m;
  const m = raw.match(re);
  if (!m) die(`could not find 'val frickVersion = "..."' in ${ANDROID_GRADLE}`);
  const from = m[2];
  writeFileSync(path, raw.replace(re, `$1${version}$3`), "utf8");
  return `android:frick: ${from} -> ${version}`;
}

function stitchChangelog(root: string, version: string, date: string): string {
  const path = resolve(root, CHANGELOG);
  const raw = readFileSync(path, "utf8");
  const marker = "## Unreleased";
  const idx = raw.indexOf(marker);
  if (idx === -1) die(`'${marker}' not found in ${CHANGELOG}`);
  if (raw.includes(`## ${version} `)) return `CHANGELOG: ## ${version} already present (skipped)`;
  const replacement = `## Unreleased\n\n## ${version} — ${date}`;
  writeFileSync(path, raw.replace(marker, replacement), "utf8");
  return `CHANGELOG: ## Unreleased -> ## ${version} — ${date}`;
}

function main(): void {
  const version = process.argv[2];
  if (!version || version === "-h" || version === "--help") {
    process.stdout.write("Usage: pnpm release:bump <bare-semver>   (e.g. pnpm release:bump 0.3.0)\n");
    process.exit(version ? 0 : 2);
  }
  if (!SEMVER.test(version)) die(`not a bare semver version: '${version}'`);

  const root = repoRoot();
  const date = new Date().toISOString().slice(0, 10);
  const changes: string[] = [];
  for (const dir of TS_PACKAGE_DIRS) changes.push(bumpTs(root, dir, version));
  changes.push(bumpAndroid(root, version));
  changes.push(stitchChangelog(root, version, date));

  for (const c of changes) process.stderr.write(`  ${c}\n`);
  process.stderr.write(
    `\nWhole stack set to ${version}. Next:\n` +
      `  # review the CHANGELOG entry, then:\n` +
      `  git commit -am "chore(release): v${version}"\n` +
      `  git push origin HEAD:main      # release-autotag pushes the ${version} tag\n` +
      `\nThe single ${version} tag publishes npm + Swift (FrickSwift mirror) + Android together.\n`,
  );
  process.stdout.write(`${version}\n`);
}

main();
