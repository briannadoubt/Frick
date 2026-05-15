#!/usr/bin/env tsx
/**
 * Changelog generator.
 *
 * Reads commits since the most recent tag matching `framework-v*`, groups them
 * by conventional-commit prefix, and emits Markdown.
 *
 * Usage:
 *   pnpm changelog
 *   pnpm changelog --output CHANGELOG.next.md
 *   pnpm changelog --since framework-v1.2.0
 *   pnpm changelog --version 1.3.0
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";

interface Options {
  output: string | null;
  since: string | null;
  version: string;
}

interface Commit {
  hash: string;
  subject: string;
}

const GROUPS: { key: string; label: string }[] = [
  { key: "feat", label: "Features" },
  { key: "fix", label: "Fixes" },
  { key: "perf", label: "Performance" },
  { key: "refactor", label: "Refactors" },
  { key: "docs", label: "Documentation" },
  { key: "test", label: "Tests" },
  { key: "chore", label: "Chores" },
];

const OTHER = "Other";
const FRAMEWORK_TAG_RE =
  /^framework-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;

function parseArgs(argv: string[]): Options {
  const opts: Options = { output: null, since: null, version: "Unreleased" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--output" || a === "-o") {
      opts.output = argv[++i] ?? null;
    } else if (a === "--since") {
      opts.since = argv[++i] ?? null;
    } else if (a === "--version") {
      opts.version = argv[++i] ?? "Unreleased";
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: tsx scripts/changelog.ts [--output PATH] [--since REF] [--version LABEL]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`Unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return opts;
}

function die(msg: string): never {
  process.stderr.write(`changelog: ${msg}\n`);
  process.exit(2);
}

function gitOrEmpty(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function verifyFrameworkTag(ref: string): string {
  if (!FRAMEWORK_TAG_RE.test(ref)) {
    die(`expected framework tag like framework-v1.2.3, got: ${ref}`);
  }
  const commit = gitOrEmpty(["rev-parse", "--verify", "--end-of-options", `refs/tags/${ref}^{commit}`]);
  if (!commit) {
    die(`unknown framework tag: ${ref}`);
  }
  return ref;
}

function resolveSince(explicit: string | null): string | null {
  if (explicit) return verifyFrameworkTag(explicit);
  const tag = gitOrEmpty(["describe", "--tags", "--abbrev=0", "--match", "framework-v*"]);
  return tag ? verifyFrameworkTag(tag) : null;
}

function readCommits(since: string | null): Commit[] {
  const range = since ? `refs/tags/${since}..HEAD` : "HEAD";
  const out = gitOrEmpty(["log", "--no-merges", "--pretty=format:%H%x09%s", range]);
  if (!out) return [];
  const commits: Commit[] = [];
  for (const line of out
    .split("\n")
    .filter((l) => l.length > 0)) {
    const [hash, ...rest] = line.split("\t");
    if (!hash) continue;
    commits.push({ hash, subject: rest.join("\t") });
  }
  return commits;
}

function categorize(subject: string): { group: string; scope: string | null; message: string } {
  // Matches: type(scope)!: message, type: message, etc.
  const m = subject.match(/^([a-z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
  if (!m) return { group: OTHER, scope: null, message: subject };
  const type = (m[1] ?? "").toLowerCase();
  const scope = m[2] ?? null;
  const message = m[4] ?? subject;
  const known = GROUPS.find((g) => g.key === type);
  return { group: known ? known.label : OTHER, scope, message };
}

function render(commits: Commit[], version: string, since: string | null): string {
  const buckets = new Map<string, { scope: string | null; message: string; hash: string }[]>();
  for (const c of commits) {
    const { group, scope, message } = categorize(c.subject);
    const arr = buckets.get(group) ?? [];
    arr.push({ scope, message, hash: c.hash });
    buckets.set(group, arr);
  }

  const lines: string[] = [];
  const date = new Date().toISOString().slice(0, 10);
  lines.push(`## ${version} - ${date}`);
  if (since) {
    lines.push("");
    lines.push(`_Commits since \`${since}\`._`);
  }
  lines.push("");

  const order = [...GROUPS.map((g) => g.label), OTHER];
  for (const label of order) {
    const items = buckets.get(label);
    if (!items || items.length === 0) continue;
    lines.push(`### ${label}`);
    lines.push("");
    for (const item of items) {
      const scope = item.scope ? `**${item.scope}:** ` : "";
      lines.push(`- ${scope}${item.message} (${item.hash.slice(0, 7)})`);
    }
    lines.push("");
  }

  if (commits.length === 0) {
    lines.push("_No commits in range._");
    lines.push("");
  }

  return lines.join("\n");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const since = resolveSince(opts.since);
  const commits = readCommits(since);
  const md = render(commits, opts.version, since);
  if (opts.output) {
    writeFileSync(opts.output, md, "utf8");
    process.stderr.write(`Wrote ${commits.length} commits to ${opts.output}\n`);
  } else {
    process.stdout.write(md);
  }
}

main();
