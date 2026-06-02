#!/usr/bin/env tsx
/**
 * Release dry-run reporter.
 *
 * For each publishable package, run `pnpm pack --json` into a temporary
 * directory and inspect the packed tarball for suspicious entries. Reports to
 * stdout and exits non-zero if any package has findings.
 *
 * "Publishable" = package.json is not `"private": true` AND name starts
 * with `@fricken/`.
 */
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, posix as pathPosix, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import process from "node:process";
import ts from "typescript";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const PACKAGE_GLOBS = ["packages", "apps"];

const SOURCEMAP_BYTES_THRESHOLD = 512 * 1024; // 512 KB
const RUNTIME_DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;
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
  "@fricken/protocol": {
    "fixtures/error-envelope.json": "cross-platform conformance fixture",
    "fixtures/foundation-schema.json": "cross-platform conformance fixture",
    "fixtures/hello-frame.json": "cross-platform conformance fixture",
    // Product-test-schema is the pre-cleanup chat-shaped schema we keep as
    // a non-trivial fixture so framework primitives (codecs, projections,
    // sync gateway, etc.) have something to exercise against. Apps that
    // depend on @fricken/protocol can also import it for their own
    // integration tests. Source lives under src/fixtures/.
    "dist/fixtures/product-test-schema.d.ts": "shipped test-fixture schema",
    "dist/fixtures/product-test-schema.js": "shipped test-fixture schema",
  },
};

const INTENTIONAL_LIFECYCLE_EXCEPTIONS: Record<string, Record<string, string>> = {};

export type PackageJson = {
  name?: string;
  private?: boolean;
  type?: string;
  main?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
  bin?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export type PackFile = { path: string; size?: number };

export type PackEntry = {
  name: string;
  version: string;
  filename: string;
  files: PackFile[];
};

type Finding = {
  package: string;
  kind:
    | "suspicious-file"
    | "large-sourcemap"
    | "missing-readme"
    | "lifecycle-script"
    | "typescript-source-entry"
    | "missing-entrypoint"
    | "workspace-protocol-dependency"
    | "missing-entrypoint-reference";
  detail: string;
};

type PackedPackage = {
  entry: PackEntry;
  manifest: PackageJson;
  textFiles: Map<string, string>;
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
  if (!pkg.name.startsWith("@fricken/")) return { publishable: false, reason: "not scoped @fricken/", name: pkg.name };
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
  // pnpm pack v10 honors lifecycle suppression through npm config env.
  env.npm_config_ignore_scripts = "true";
  env.NPM_CONFIG_IGNORE_SCRIPTS = "true";
  return env;
}

function readTarString(buffer: Buffer, start: number, length: number): string {
  const slice = buffer.subarray(start, start + length);
  const nulIndex = slice.indexOf(0);
  return slice.subarray(0, nulIndex === -1 ? slice.length : nulIndex).toString("utf8");
}

function normalizeTarPackagePath(path: string): string | null {
  if (!path.startsWith("package/")) return null;
  const packagePath = path.slice("package/".length);
  return packagePath.length > 0 ? packagePath : null;
}

function extractPackedFiles(tarballPath: string): Map<string, Buffer> {
  const tar = gunzipSync(readFileSync(tarballPath));
  const files = new Map<string, Buffer>();
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const sizeText = readTarString(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const contentOffset = offset + 512;
    const nextOffset = contentOffset + Math.ceil(size / 512) * 512;

    if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
      const packagePath = normalizeTarPackagePath(fullName);
      if (packagePath) {
        files.set(packagePath, Buffer.from(tar.subarray(contentOffset, contentOffset + size)));
      }
    }

    offset = nextOffset;
  }

  return files;
}

function parsePackEntry(stdout: string): PackEntry | null {
  const parsed = JSON.parse(stdout) as PackEntry | PackEntry[];
  return Array.isArray(parsed) ? (parsed[0] ?? null) : parsed;
}

function resolvePackedTarballPath(filename: string, packDir: string): string {
  return resolve(packDir, filename);
}

function readPackedManifest(files: Map<string, Buffer>): PackageJson {
  const packageJson = files.get("package.json");
  if (!packageJson) {
    throw new Error("packed tarball is missing package.json");
  }
  return JSON.parse(packageJson.toString("utf8")) as PackageJson;
}

function isInspectableEntrypointFile(path: string): boolean {
  return /\.(?:[cm]?js|d\.[cm]?ts)$/.test(path);
}

function collectPackedTextFiles(packedFiles: Map<string, Buffer>): Map<string, string> {
  const textFiles = new Map<string, string>();
  for (const [packedPath, content] of packedFiles) {
    if (!isInspectableEntrypointFile(packedPath)) continue;
    textFiles.set(packedPath, content.toString("utf8"));
  }
  return textFiles;
}

function withTarballFileSizes(entry: PackEntry, packedFiles: Map<string, Buffer>): PackEntry {
  return {
    ...entry,
    files: entry.files.map((file) => ({
      ...file,
      size: file.size ?? packedFiles.get(file.path)?.length,
    })),
  };
}

function pack(pkgDir: string): PackedPackage | null {
  const packDir = mkdtempSync(join(tmpdir(), "frick-release-pack-"));
  try {
    const stdout = execFileSync("pnpm", ["pack", "--json", "--pack-destination", packDir], {
      cwd: pkgDir,
      encoding: "utf8",
      env: scrubbedPackEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const entry = parsePackEntry(stdout);
    if (!entry) return null;

    const packedFiles = extractPackedFiles(resolvePackedTarballPath(entry.filename, packDir));
    const manifest = readPackedManifest(packedFiles);
    return {
      entry: withTarballFileSizes(entry, packedFiles),
      manifest,
      textFiles: collectPackedTextFiles(packedFiles),
    };
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
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

function normalizePackagePath(path: string): string {
  return path.replace(/^\.\//, "");
}

function isRelativePackagePath(value: string): boolean {
  return value.startsWith("./") && !value.includes("*");
}

function isTypeScriptSourceEntrypoint(path: string): boolean {
  return /\.(ts|tsx)$/.test(path) && !/\.d\.ts$/.test(path);
}

function collectEntrypoints(pkg: PackageJson): Array<{ label: string; path: string }> {
  const results: Array<{ label: string; path: string }> = [];

  function add(label: string, value: unknown): void {
    if (typeof value === "string" && isRelativePackagePath(value)) {
      results.push({ label, path: value });
    }
  }

  function walkExports(value: unknown, label: string): void {
    if (typeof value === "string") {
      add(label, value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walkExports(item, `${label}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      walkExports(record[key], `${label}.${key}`);
    }
  }

  add("main", pkg.main);
  add("types", pkg.types);
  add("typings", pkg.typings);

  if (typeof pkg.bin === "string") {
    add("bin", pkg.bin);
  } else if (pkg.bin && typeof pkg.bin === "object" && !Array.isArray(pkg.bin)) {
    for (const [name, value] of Object.entries(pkg.bin as Record<string, unknown>).sort()) {
      add(`bin[${name}]`, value);
    }
  }

  if (typeof pkg.exports === "string") {
    add("exports", pkg.exports);
  } else if (pkg.exports && typeof pkg.exports === "object" && !Array.isArray(pkg.exports)) {
    for (const [subpath, value] of Object.entries(pkg.exports as Record<string, unknown>).sort()) {
      walkExports(value, `exports[${subpath}]`);
    }
  }

  return results;
}

export function inspectPackageEntrypoints(pkg: PackageJson, entry: PackEntry): Finding[] {
  const packageName = pkg.name ?? entry.name;
  const packedPaths = new Set(entry.files.map((file) => file.path));
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const { label, path } of collectEntrypoints(pkg)) {
    const key = `${label}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (isTypeScriptSourceEntrypoint(path)) {
      findings.push({
        package: packageName,
        kind: "typescript-source-entry",
        detail: `${label} points at ${path}`,
      });
      continue;
    }

    const packedPath = normalizePackagePath(path);
    if (!packedPaths.has(packedPath)) {
      findings.push({
        package: packageName,
        kind: "missing-entrypoint",
        detail: `${label} points at ${path}, but it is not packed`,
      });
    }
  }

  return findings;
}

export function inspectPackedPackageManifest(pkg: PackageJson): Finding[] {
  const packageName = pkg.name ?? "(unknown package)";
  const findings: Finding[] = [];

  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    const dependencies = pkg[field];
    if (!dependencies) continue;
    for (const [dependencyName, specifier] of Object.entries(dependencies).sort()) {
      if (!specifier.startsWith("workspace:")) continue;
      findings.push({
        package: packageName,
        kind: "workspace-protocol-dependency",
        detail: `${field}.${dependencyName} still uses ${specifier}`,
      });
    }
  }

  return findings;
}

function isRelativeSpecifier(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../");
}

function isDtsFile(path: string): boolean {
  return /\.d\.[cm]?ts$/.test(path);
}

function isStringLiteralLike(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function collectRelativeSpecifiers(
  filePath: string,
  content: string,
): Array<{ verb: "imports" | "exports"; specifier: string }> {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    isDtsFile(filePath) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const specifiers: Array<{ verb: "imports" | "exports"; specifier: string }> = [];

  function add(verb: "imports" | "exports", node: ts.Node): void {
    if (!isStringLiteralLike(node) || !isRelativeSpecifier(node.text)) return;
    specifiers.push({ verb, specifier: node.text });
  }

  function walk(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      add("imports", node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add("exports", node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [firstArg] = node.arguments;
      if (firstArg) add("imports", firstArg);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument)) {
        add("imports", argument.literal);
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add("imports", node.moduleReference.expression);
    }

    ts.forEachChild(node, walk);
  }

  walk(sourceFile);
  return specifiers;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function declarationMappedTargets(path: string): string[] {
  if (path.endsWith(".js")) return [`${path.slice(0, -".js".length)}.d.ts`];
  if (path.endsWith(".mjs")) return [`${path.slice(0, -".mjs".length)}.d.mts`, `${path.slice(0, -".mjs".length)}.d.ts`];
  if (path.endsWith(".cjs")) return [`${path.slice(0, -".cjs".length)}.d.cts`, `${path.slice(0, -".cjs".length)}.d.ts`];
  return [];
}

function resolutionCandidates(target: string, importerPath: string): string[] {
  if (isDtsFile(importerPath)) {
    return unique([
      target,
      ...declarationMappedTargets(target),
      `${target}.d.ts`,
      `${target}.d.mts`,
      `${target}.d.cts`,
      pathPosix.join(target, "index.d.ts"),
      pathPosix.join(target, "index.d.mts"),
      pathPosix.join(target, "index.d.cts"),
    ]);
  }

  return unique([
    target,
    `${target}.js`,
    `${target}.mjs`,
    `${target}.cjs`,
    `${target}.json`,
    `${target}.node`,
    pathPosix.join(target, "index.js"),
    pathPosix.join(target, "index.mjs"),
    pathPosix.join(target, "index.cjs"),
    pathPosix.join(target, "index.json"),
  ]);
}

function resolvePackedSpecifier(
  importerPath: string,
  specifier: string,
  packedPaths: Set<string>,
): { expectedPath: string; found: boolean } {
  const expectedPath = normalizePackagePath(pathPosix.normalize(pathPosix.join(pathPosix.dirname(importerPath), specifier)));
  const found = resolutionCandidates(expectedPath, importerPath).some((candidate) => packedPaths.has(candidate));
  return { expectedPath, found };
}

export function inspectPackedEntrypointSpecifiers(
  pkg: PackageJson,
  entry: PackEntry,
  contents: ReadonlyMap<string, string>,
): Finding[] {
  const packageName = pkg.name ?? entry.name;
  const packedPaths = new Set(entry.files.map((file) => file.path));
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const [packedPath, content] of contents) {
    if (seen.has(packedPath)) continue;
    seen.add(packedPath);
    if (!isInspectableEntrypointFile(packedPath)) continue;

    for (const { verb, specifier } of collectRelativeSpecifiers(packedPath, content)) {
      const { expectedPath, found } = resolvePackedSpecifier(packedPath, specifier, packedPaths);
      if (found) continue;
      findings.push({
        package: packageName,
        kind: "missing-entrypoint-reference",
        detail: `${packedPath} ${verb} ${specifier}, but ${expectedPath} is not packed`,
      });
    }
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
    if (file.path.endsWith(".map") && typeof file.size === "number" && file.size > SOURCEMAP_BYTES_THRESHOLD) {
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
      const packed = pack(pkgDir);
      if (!packed) {
        allFindings.push(...lifecycleFindings);
        reports.push({
          name: status.name!,
          publishable: true,
          reason: "pnpm pack returned no entries",
          findings: lifecycleFindings,
        });
        continue;
      }
      const findings = [
        ...lifecycleFindings,
        ...inspect(packed.entry),
        ...inspectPackageEntrypoints(packed.manifest, packed.entry),
        ...inspectPackedPackageManifest(packed.manifest),
        ...inspectPackedEntrypointSpecifiers(packed.manifest, packed.entry, packed.textFiles),
      ];
      allFindings.push(...findings);
      reports.push({
        name: packed.entry.name,
        version: packed.entry.version,
        publishable: true,
        fileCount: packed.entry.files.length,
        findings,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      allFindings.push(...lifecycleFindings);
      reports.push({
        name: status.name!,
        publishable: true,
        reason: `pnpm pack failed: ${message}`,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
