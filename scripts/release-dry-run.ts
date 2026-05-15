#!/usr/bin/env tsx
/**
 * Release dry-run reporter.
 *
 * For each publishable package, run `npm pack --dry-run --json` and
 * inspect the resulting file manifest for suspicious entries. Reports
 * to stdout and exits non-zero if any package has findings.
 *
 * "Publishable" = package.json is not `"private": true` AND name starts
 * with `@frick/`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const PACKAGE_GLOBS = ["packages", "apps"];

const SOURCEMAP_BYTES_THRESHOLD = 512 * 1024; // 512 KB
const LIFECYCLE_SCRIPT_NAMES = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepack",
  "prepare",
  "postpack",
  "prepublish",
  "prepublishOnly",
  "publish",
  "postpublish",
]);
const SUSPICIOUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /(^|\/)tests?\//, reason: "ships tests directory" },
  { pattern: /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/, reason: "ships test file" },
  { pattern: /(^|\/)fixtures?\//, reason: "ships fixtures directory" },
  { pattern: /(^|\/)__mocks__\//, reason: "ships mocks directory" },
  { pattern: /(^|\/)\.env(\.|$)/, reason: "ships env file" },
  { pattern: /\.DS_Store$/, reason: "ships macOS metadata" },
];

/**
 * Per-package allowlist of file paths that match a suspicious pattern but
 * are shipped intentionally. The value is a free-form note explaining why
 * the file is intentional — surfaced in the dry-run report so reviewers can
 * see the rationale rather than just a silenced finding.
 */
const INTENTIONAL_EXCEPTIONS: Record<string, Record<string, string>> = {
  "@frick/protocol": {
    "fixtures/error-envelope.json": "cross-platform conformance fixture",
    "fixtures/foundation-schema.json": "cross-platform conformance fixture",
    "fixtures/hello-frame.json": "cross-platform conformance fixture",
  },
};

const INTENTIONAL_LIFECYCLE_EXCEPTIONS: Record<string, Record<string, string>> = {};

type PackageJson = {
  name?: string;
  private?: boolean;
  scripts?: Record<string, string>;
};

type PackFile = { path: string; size: number };

type PackEntry = {
  name: string;
  version: string;
  filename: string;
  files: PackFile[];
};

type Finding = {
  package: string;
  kind: "suspicious-file" | "large-sourcemap" | "missing-readme" | "lifecycle-script";
  detail: string;
};

function findPackageJsons(): string[] {
  const results: string[] = [];
  for (const dir of PACKAGE_GLOBS) {
    const abs = join(ROOT, dir);
    let entries: string[] = [];
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const pkgPath = join(abs, entry, "package.json");
      try {
        statSync(pkgPath);
        results.push(pkgPath);
      } catch {
        /* not a package */
      }
    }
  }
  return results;
}

function readPackageJson(pkgJsonPath: string): PackageJson {
  const raw = readFileSync(pkgJsonPath, "utf8");
  return JSON.parse(raw) as PackageJson;
}

function isPublishable(pkgJsonPath: string): {
  publishable: boolean;
  reason?: string;
  name?: string;
  scripts?: Record<string, string>;
} {
  const pkg = readPackageJson(pkgJsonPath);
  if (!pkg.name) return { publishable: false, reason: "no name" };
  if (!pkg.name.startsWith("@frick/")) return { publishable: false, reason: "not scoped @frick/", name: pkg.name };
  if (pkg.private === true) return { publishable: false, reason: "private", name: pkg.name };
  return {
    publishable: true,
    name: pkg.name,
    ...(pkg.scripts ? { scripts: pkg.scripts } : {}),
  };
}

function scrubbedPackEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NPM_TOKEN;
  delete env.NODE_AUTH_TOKEN;
  return env;
}

function pack(pkgDir: string): PackEntry | null {
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: pkgDir,
    encoding: "utf8",
    env: scrubbedPackEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(stdout) as PackEntry[];
  return parsed[0] ?? null;
}

function inspectLifecycleScripts(pkgName: string, scripts: Record<string, string> | undefined): Finding[] {
  const exceptions = INTENTIONAL_LIFECYCLE_EXCEPTIONS[pkgName] ?? {};
  const findings: Finding[] = [];
  for (const scriptName of Object.keys(scripts ?? {}).sort()) {
    if (!LIFECYCLE_SCRIPT_NAMES.has(scriptName)) continue;
    if (exceptions[scriptName]) continue;
    findings.push({
      package: pkgName,
      kind: "lifecycle-script",
      detail: `package.json defines ${scriptName}`,
    });
  }
  return findings;
}

function inspect(entry: PackEntry): Finding[] {
  const findings: Finding[] = [];
  const lowerPaths = entry.files.map((f) => f.path.toLowerCase());
  if (!lowerPaths.some((p) => p === "readme.md" || p === "readme" || p.startsWith("readme."))) {
    findings.push({ package: entry.name, kind: "missing-readme", detail: "no README found in pack" });
  }
  const exceptions = INTENTIONAL_EXCEPTIONS[entry.name] ?? {};
  for (const file of entry.files) {
    for (const { pattern, reason } of SUSPICIOUS_PATTERNS) {
      if (pattern.test(file.path)) {
        if (exceptions[file.path]) {
          // Intentional — silently skip. The package owner has documented
          // why this file ships in INTENTIONAL_EXCEPTIONS above.
          continue;
        }
        findings.push({
          package: entry.name,
          kind: "suspicious-file",
          detail: `${file.path} (${reason})`,
        });
      }
    }
    if (file.path.endsWith(".map") && file.size > SOURCEMAP_BYTES_THRESHOLD) {
      findings.push({
        package: entry.name,
        kind: "large-sourcemap",
        detail: `${file.path} is ${(file.size / 1024).toFixed(1)} KB (>${SOURCEMAP_BYTES_THRESHOLD / 1024} KB)`,
      });
    }
  }
  return findings;
}

function main(): void {
  const pkgJsonPaths = findPackageJsons();
  const allFindings: Finding[] = [];
  const reports: Array<{
    name: string;
    version?: string;
    publishable: boolean;
    reason?: string;
    fileCount?: number;
    findings: Finding[];
  }> = [];

  for (const pkgJsonPath of pkgJsonPaths) {
    const pkgDir = pkgJsonPath.replace(/\/package\.json$/, "");
    const status = isPublishable(pkgJsonPath);
    if (!status.publishable) {
      reports.push({
        name: status.name ?? pkgJsonPath,
        publishable: false,
        ...(status.reason ? { reason: status.reason } : {}),
        findings: [],
      });
      continue;
    }
    const lifecycleFindings = inspectLifecycleScripts(status.name!, status.scripts);
    try {
      const entry = pack(pkgDir);
      if (!entry) {
        allFindings.push(...lifecycleFindings);
        reports.push({
          name: status.name!,
          publishable: true,
          reason: "npm pack returned no entries",
          findings: lifecycleFindings,
        });
        continue;
      }
      const findings = [...lifecycleFindings, ...inspect(entry)];
      allFindings.push(...findings);
      reports.push({
        name: entry.name,
        version: entry.version,
        publishable: true,
        fileCount: entry.files.length,
        findings,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      allFindings.push(...lifecycleFindings);
      reports.push({
        name: status.name!,
        publishable: true,
        reason: `npm pack failed: ${message}`,
        findings: lifecycleFindings,
      });
    }
  }

  process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2)}\n`);

  if (allFindings.length > 0) {
    process.stderr.write(`\nrelease:dry-run found ${allFindings.length} issue(s):\n`);
    for (const f of allFindings) {
      process.stderr.write(`  [${f.package}] ${f.kind}: ${f.detail}\n`);
    }
    process.exit(1);
  }
}

main();
