#!/usr/bin/env tsx
/**
 * Version-bump helper.
 *
 * Usage:
 *   pnpm exec tsx scripts/bump-version.ts --package <name> --release <major|minor|patch>
 *   pnpm exec tsx scripts/bump-version.ts --package @frick/protocol --release minor
 *   pnpm exec tsx scripts/bump-version.ts --package frick-swift --release patch --no-commit
 *
 * Supported package names:
 *   - TS packages by their package.json `name` field (e.g. @frick/protocol).
 *   - Android modules: `android:frick`, `android:design` — edits build.gradle.kts.
 *   - Swift packages: `swift:frick`, `swift:design` — emits a tag suggestion only.
 *
 * Emits the new version on stdout.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

type Release = "major" | "minor" | "patch";

interface Options {
  pkg: string;
  release: Release;
  commit: boolean;
}

interface TsTarget {
  kind: "ts";
  path: string;
}

interface AndroidTarget {
  kind: "android";
  path: string;
  tagPrefix: string;
}

interface SwiftTarget {
  kind: "swift";
  tagPrefix: string;
}

type Target = TsTarget | AndroidTarget | SwiftTarget;

const TS_PACKAGE_PATHS = [
  "packages/protocol",
  "packages/core",
  "packages/react",
  "packages/design",
  "packages/design-web",
  "apps/server",
  "apps/web",
  "apps/cli",
];

const ANDROID_PACKAGES: Record<string, AndroidTarget> = {
  "android:frick": {
    kind: "android",
    path: "apps/android/frick/build.gradle.kts",
    tagPrefix: "android-frick-v",
  },
  "android:design": {
    kind: "android",
    path: "apps/android/design/build.gradle.kts",
    tagPrefix: "android-design-v",
  },
};

const SWIFT_PACKAGES: Record<string, SwiftTarget> = {
  "swift:frick": { kind: "swift", tagPrefix: "swift-v" },
  "swift:design": { kind: "swift", tagPrefix: "swift-design-v" },
};

function parseArgs(argv: string[]): Options {
  const opts: Partial<Options> = { commit: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--package" || a === "-p") {
      opts.pkg = argv[++i];
    } else if (a === "--release" || a === "-r") {
      const v = argv[++i];
      if (v !== "major" && v !== "minor" && v !== "patch") {
        die(`--release must be major|minor|patch, got: ${v}`);
      }
      opts.release = v;
    } else if (a === "--no-commit") {
      opts.commit = false;
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: tsx scripts/bump-version.ts --package <name> --release <major|minor|patch> [--no-commit]\n",
      );
      process.exit(0);
    } else {
      die(`Unknown argument: ${a}`);
    }
  }
  if (!opts.pkg) die("--package is required");
  if (!opts.release) die("--release is required");
  return opts as Options;
}

function die(msg: string): never {
  process.stderr.write(`bump-version: ${msg}\n`);
  process.exit(2);
}

function repoRoot(): string {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}

function resolveTarget(root: string, pkg: string): Target {
  if (ANDROID_PACKAGES[pkg]) return ANDROID_PACKAGES[pkg];
  if (SWIFT_PACKAGES[pkg]) return SWIFT_PACKAGES[pkg];

  for (const rel of TS_PACKAGE_PATHS) {
    const pjPath = resolve(root, rel, "package.json");
    if (!existsSync(pjPath)) continue;
    const pj = JSON.parse(readFileSync(pjPath, "utf8")) as { name?: string };
    if (pj.name === pkg) return { kind: "ts", path: pjPath };
  }
  die(`unknown package: ${pkg}`);
}

function nextVersion(current: string, release: Release): string {
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) die(`current version is not semver: ${current}`);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (release === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (release === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

function bumpTs(target: TsTarget, release: Release): { current: string; next: string } {
  const raw = readFileSync(target.path, "utf8");
  const pj = JSON.parse(raw) as { version?: string; name?: string };
  const current = pj.version ?? "0.0.0";
  const next = nextVersion(current, release);
  pj.version = next;
  // Preserve trailing newline if present.
  const trailing = raw.endsWith("\n") ? "\n" : "";
  writeFileSync(target.path, JSON.stringify(pj, null, 2) + trailing, "utf8");
  return { current, next };
}

function bumpAndroid(
  root: string,
  target: AndroidTarget,
  release: Release,
): { current: string; next: string } {
  const fullPath = resolve(root, target.path);
  const raw = readFileSync(fullPath, "utf8");
  const versionLine = /^version\s*=\s*"([^"]+)"$/m;
  const match = raw.match(versionLine);
  const current = match ? match[1] : "0.0.0";
  const next = nextVersion(current, release);
  let updated: string;
  if (match) {
    updated = raw.replace(versionLine, `version = "${next}"`);
  } else {
    // Insert at the top so it's discoverable.
    updated = `version = "${next}"\n\n${raw}`;
  }
  writeFileSync(fullPath, updated, "utf8");
  return { current, next };
}

function currentSwiftTag(prefix: string): string {
  try {
    return execSync(`git describe --tags --abbrev=0 --match '${prefix}*'`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function bumpSwift(target: SwiftTarget, release: Release): { current: string; next: string } {
  const latest = currentSwiftTag(target.tagPrefix);
  const current = latest ? latest.slice(target.tagPrefix.length) : "0.0.0";
  const next = nextVersion(current, release);
  return { current, next };
}

function commit(root: string, files: string[], pkg: string, version: string): void {
  if (files.length === 0) return;
  execSync(`git add ${files.map((f) => JSON.stringify(f)).join(" ")}`, {
    cwd: root,
    stdio: "inherit",
  });
  const msg = `chore(release): ${pkg}@${version}`;
  execSync(`git commit -m ${JSON.stringify(msg)}`, { cwd: root, stdio: "inherit" });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const target = resolveTarget(root, opts.pkg);

  if (target.kind === "ts") {
    const { current, next } = bumpTs(target, opts.release);
    process.stderr.write(`${opts.pkg}: ${current} -> ${next}\n`);
    if (opts.commit) commit(root, [target.path], opts.pkg, next);
    process.stdout.write(`${next}\n`);
    return;
  }

  if (target.kind === "android") {
    const { current, next } = bumpAndroid(root, target, opts.release);
    process.stderr.write(`${opts.pkg}: ${current} -> ${next}\n`);
    if (opts.commit) commit(root, [target.path], opts.pkg, next);
    process.stderr.write(`Suggested tag: ${target.tagPrefix}${next}\n`);
    process.stdout.write(`${next}\n`);
    return;
  }

  // swift
  const { current, next } = bumpSwift(target, opts.release);
  process.stderr.write(`${opts.pkg}: ${current} -> ${next} (no version file)\n`);
  process.stderr.write(
    `Swift packages are tag-only. After your release commit lands, run:\n` +
      `  git tag ${target.tagPrefix}${next}\n` +
      `  git push origin ${target.tagPrefix}${next}\n`,
  );
  if (opts.commit) {
    process.stderr.write(`--no-commit was implied: nothing to commit for Swift\n`);
  }
  process.stdout.write(`${next}\n`);
}

main();
