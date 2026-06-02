#!/usr/bin/env tsx
/**
 * Version-bump helper.
 *
 * Usage:
 *   pnpm exec tsx scripts/bump-version.ts --package <name> --release <major|minor|patch>
 *   pnpm exec tsx scripts/bump-version.ts --package @fricken/protocol --release minor
 *   pnpm exec tsx scripts/bump-version.ts --package frick-swift --release patch --no-commit
 *
 * Supported package names:
 *   - TS packages by their package.json `name` field (e.g. @fricken/protocol).
 *   - Android modules: `android:frick`, `android:design` — edits build.gradle.kts.
 *   - Swift packages: `swift:frick`, `swift:design` — emits a tag suggestion only.
 *
 * Emits the new version on stdout.
 */

import { execFileSync } from "node:child_process";
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
  "packages/devtools",
  "packages/agent-kit",
  "packages/mcp",
  "apps/server",
  "apps/web",
  "apps/cli",
];

const ANDROID_PACKAGES: Record<string, AndroidTarget> = {
  "android:frick": {
    kind: "android",
    path: "apps/android/frick/build.gradle.kts",
    tagPrefix: "android-v",
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

const TAG_PREFIX_RE = /^(?:android|android-design|swift|swift-design)-v$/;
const SEMVER_PATTERN =
  "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)*)?(?:\\+[0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)*)?";

function parseArgs(argv: string[]): Options {
  const opts: Partial<Options> = { commit: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--package" || a === "-p") {
      const value = argv[i + 1];
      if (!value) die("--package requires a value");
      i++;
      opts.pkg = value;
    } else if (a === "--release" || a === "-r") {
      const v = argv[i + 1];
      if (!v) die("--release requires a value");
      i++;
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

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitOrEmpty(args: string[], cwd?: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "inherit" });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateTagPrefix(prefix: string): string {
  if (!TAG_PREFIX_RE.test(prefix)) {
    die(`unexpected release tag prefix: ${prefix}`);
  }
  return prefix;
}

function verifyVersionTag(prefix: string, tag: string): string {
  const safePrefix = validateTagPrefix(prefix);
  const tagRe = new RegExp(`^${escapeRegExp(safePrefix)}${SEMVER_PATTERN}$`);
  if (!tagRe.test(tag)) {
    die(`expected ${safePrefix}<semver> tag, got: ${tag}`);
  }
  const commit = gitOrEmpty(["rev-parse", "--verify", "--end-of-options", `refs/tags/${tag}^{commit}`]);
  if (!commit) {
    die(`unknown release tag: ${tag}`);
  }
  return tag;
}

function versionTag(prefix: string, version: string): string {
  return `${validateTagPrefix(prefix)}${version}`;
}

function repoRoot(): string {
  return git(["rev-parse", "--show-toplevel"]);
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
  const frickVersionLine = /^val\s+frickVersion\s*=\s*"([^"]+)"$/m;
  const versionLine = /^version\s*=\s*"([^"]+)"$/m;
  const frickVersionMatch = raw.match(frickVersionLine);
  const versionMatch = raw.match(versionLine);
  const match = frickVersionMatch ?? versionMatch;
  const current = match?.[1] ?? "0.0.0";
  const next = nextVersion(current, release);
  let updated: string;
  if (frickVersionMatch) {
    updated = raw.replace(frickVersionLine, `val frickVersion = "${next}"`);
  } else if (versionMatch) {
    updated = raw.replace(versionLine, `version = "${next}"`);
  } else {
    // Insert at the top so it's discoverable.
    updated = `version = "${next}"\n\n${raw}`;
  }
  writeFileSync(fullPath, updated, "utf8");
  return { current, next };
}

function currentSwiftTag(prefix: string): string {
  const safePrefix = validateTagPrefix(prefix);
  const tag = gitOrEmpty(["describe", "--tags", "--abbrev=0", "--match", `${safePrefix}*`]);
  return tag ? verifyVersionTag(safePrefix, tag) : "";
}

function bumpSwift(target: SwiftTarget, release: Release): { current: string; next: string } {
  const latest = currentSwiftTag(target.tagPrefix);
  const current = latest ? latest.slice(target.tagPrefix.length) : "0.0.0";
  const next = nextVersion(current, release);
  return { current, next };
}

function commit(root: string, files: string[], pkg: string, version: string): void {
  if (files.length === 0) return;
  runGit(["add", "--", ...files], root);
  const msg = `chore(release): ${pkg}@${version}`;
  runGit(["commit", "-m", msg], root);
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
    process.stderr.write(`Suggested tag: ${versionTag(target.tagPrefix, next)}\n`);
    process.stdout.write(`${next}\n`);
    return;
  }

  // swift
  const { current, next } = bumpSwift(target, opts.release);
  process.stderr.write(`${opts.pkg}: ${current} -> ${next} (no version file)\n`);
  const tag = versionTag(target.tagPrefix, next);
  process.stderr.write(
    `Swift packages are tag-only. After your release commit lands, run:\n` +
      `  git tag ${tag}\n` +
      `  git push origin ${tag}\n`,
  );
  if (opts.commit) {
    process.stderr.write(`--no-commit was implied: nothing to commit for Swift\n`);
  }
  process.stdout.write(`${next}\n`);
}

main();
