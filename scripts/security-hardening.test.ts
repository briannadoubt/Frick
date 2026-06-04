import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const PUBLIC_NPM_PACKAGE_DIRS = [
  "packages/protocol",
  "packages/core",
  "packages/design",
  "packages/react",
  "packages/design-web",
  "packages/devtools",
  "packages/agent-kit",
  "packages/mcp",
  "apps/server",
];

const PRIVATE_WORKSPACE_PACKAGE_DIRS = ["apps/cli", "apps/web"];
const PUBLIC_REPOSITORY_URL = "git+https://github.com/briannadoubt/Frick.git";

function workflowPackageDirs(workflow: string): string[] {
  const match = workflow.match(/package_dirs=\(\n(?<body>[\s\S]*?)\n\s*\)/);
  if (!match?.groups?.body) return [];
  return match.groups.body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function workflowActionUses(workflows: string): string[] {
  return Array.from(workflows.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm), (match) => match[1] ?? "");
}

describe("release hardening", () => {
  test("npm pack dry-runs ignore lifecycle scripts and scrub publish tokens", () => {
    const source = read("scripts/release-dry-run.ts");

    expect(source).toContain("NPM_CONFIG_IGNORE_SCRIPTS");
    expect(source).toContain("NPM_TOKEN");
    expect(source).toContain("NODE_AUTH_TOKEN");
  });

  test("git-backed release scripts avoid shell-string execution", () => {
    const changelog = read("scripts/changelog.ts");
    const bumpVersion = read("scripts/bump-version.ts");

    expect(changelog).not.toContain("execSync");
    expect(bumpVersion).not.toContain("execSync");
    expect(changelog).toContain("execFileSync");
    expect(bumpVersion).toContain("execFileSync");
    expect(changelog).toContain("rev-parse");
    expect(bumpVersion).toContain("rev-parse");
  });

  test("generated artifact verification regenerates and gates the whole tracked tree", () => {
    const source = read("scripts/check-generated-artifacts.ts");

    // Runs the generators that (re)produce the TypeScript core generated files
    // (packages/core/src/generated/{bindings,errors}.ts) plus the native and
    // design artifacts.
    expect(source).toContain("schema:generate");
    expect(source).toContain("fixtures:generate");
    expect(source).toContain("design:generate");
    // Then fails on ANY generator-introduced tracked-file drift rather than a
    // hardcoded path allowlist, so generated output anywhere in the tree —
    // including the core generated files — is covered (FR-108).
    expect(source).toContain("status");
    expect(source).toContain("process.exit(1)");
  });

  test("Tilt install is lockfile-driven and disables lifecycle scripts", () => {
    const source = read("Tiltfile");

    expect(source).toContain('cmd="pnpm install --frozen-lockfile --ignore-scripts"');
    expect(source).toContain('"pnpm-lock.yaml"');
  });

  test("GitHub workflows pin action SHAs and gate Android publishing to version tags", () => {
    const ci = read(".github/workflows/ci.yml");
    const publishAndroid = read(".github/workflows/publish-android.yml");
    const publishNpm = read(".github/workflows/publish-npm.yml");
    const workflows = `${ci}\n${publishAndroid}\n${publishNpm}`;

    expect(workflowActionUses(workflows).filter((use) => !/@[0-9a-f]{40}$/.test(use))).toEqual([]);
    expect(publishAndroid).not.toContain("workflow_dispatch");
    expect(publishAndroid).toContain("if: ${{ startsWith(github.ref, 'refs/tags/android-v') }}");
    expect(publishAndroid).toContain("android-v${frickVersion}");
  });

  test("npm publishing uses trusted provenance on framework version tags", () => {
    const publishNpm = read(".github/workflows/publish-npm.yml");

    expect(publishNpm).not.toContain("workflow_dispatch");
    expect(publishNpm).toContain("tags:");
    expect(publishNpm).toContain("'framework-v*'");
    expect(publishNpm).toContain("id-token: write");
    expect(publishNpm).toContain("contents: read");
    expect(publishNpm).not.toContain("NPM_TOKEN");
    expect(publishNpm).not.toContain("NODE_AUTH_TOKEN");
    expect(publishNpm).toContain("version: 10.0.0");
    expect(publishNpm).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(publishNpm).toContain("semverPattern");
    expect(publishNpm).toContain("pnpm --dir \"${package_dir}\" pack");
    expect(publishNpm).toContain("Array.isArray(parsed) ? parsed[0] : parsed");
    expect(publishNpm).toContain('npm publish "${tarball}" --provenance --access public');
    expect(publishNpm).toContain("Verify npm release tag");
    expect(publishNpm).toContain("must point at a commit on origin/main");
    expect(publishNpm).toContain("publishConfig.provenance");
    expect(publishNpm).toContain("EXPECTED_REPOSITORY_URL");
  });

  test("publishable npm packages opt in to provenance metadata", () => {
    for (const packageDir of PUBLIC_NPM_PACKAGE_DIRS) {
      const manifest = JSON.parse(read(`${packageDir}/package.json`)) as {
        private?: boolean;
        publishConfig?: { access?: string; provenance?: boolean };
        repository?: { type?: string; url?: string; directory?: string };
      };

      expect(manifest.private).not.toBe(true);
      expect(manifest.publishConfig?.access).toBe("public");
      expect(manifest.publishConfig?.provenance).toBe(true);
      expect(manifest.repository).toEqual({
        type: "git",
        url: PUBLIC_REPOSITORY_URL,
        directory: packageDir,
      });
    }
  });

  test("npm publish workflow package list matches the public TypeScript package set", () => {
    const publishNpm = read(".github/workflows/publish-npm.yml");

    expect(workflowPackageDirs(publishNpm)).toEqual(PUBLIC_NPM_PACKAGE_DIRS);
    for (const packageDir of PRIVATE_WORKSPACE_PACKAGE_DIRS) {
      expect(publishNpm).not.toContain(packageDir);
    }
  });

  test("Android version bump tags match the publish workflow guard", () => {
    const source = read("scripts/bump-version.ts");

    expect(source).toContain('tagPrefix: "android-v"');
    expect(source).toContain("frickVersionLine");
    expect(source).toContain('val frickVersion = "${next}"');
  });

  test("Gradle wrapper distribution is checksum-pinned", () => {
    const properties = read("apps/android/gradle/wrapper/gradle-wrapper.properties");

    expect(properties).toContain("validateDistributionUrl=true");
    expect(properties).toMatch(/^distributionSha256Sum=[0-9a-f]{64}$/m);
  });

  test("Android lint does not fail builds on volatile latest-version detectors", () => {
    const modules = [
      "apps/android/app/build.gradle.kts",
      "apps/android/frick/build.gradle.kts",
      "apps/android/design/build.gradle.kts",
      "apps/android/frick-compose/build.gradle.kts",
    ];

    for (const module of modules) {
      const source = read(module);
      expect(source).toContain('disable += "AndroidGradlePluginVersion"');
      expect(source).toContain('disable += "NewerVersionAvailable"');
    }
  });

  test("current WebSocket clients do not put session tokens in URLs", () => {
    const runtime = read("packages/core/src/runtime.ts");
    const swiftSocket = read("packages/swift/Sources/FrickSwift/FrickSyncSocket.swift");
    const androidSocket = read("apps/android/frick/src/main/java/dev/frick/client/FrickSyncSocket.kt");

    expect(runtime).not.toContain('searchParams.set("sessionToken"');
    expect(swiftSocket).not.toContain('queryItems = [URLQueryItem(name: "sessionToken"');
    expect(androidSocket).not.toContain("?sessionToken=");
    expect(runtime).toContain("sessionToken: this.#sessionToken");
    expect(swiftSocket).toContain('(.string("sessionToken"), .string(sessionToken))');
    expect(androidSocket).toContain('put("sessionToken", token)');
  });

  test("server WebSocket auth does not accept session tokens from URLs", () => {
    const gateway = read("apps/server/src/sync/gateway.ts");
    const contract = read("docs/cross-platform-client-contract.md");
    const changelog = read("CHANGELOG.md");

    expect(gateway).not.toContain('searchParams.get("sessionToken"');
    expect(gateway).toContain("bearerTokenFromRequest(request)");
    expect(contract).toContain(
      "The server does not authenticate `sessionToken` values from the WebSocket URL query string.",
    );
    expect(`${contract}\n${changelog}`).not.toContain("server still accepts");
    expect(`${contract}\n${changelog}`).not.toContain("legacy `sessionToken` query");
  });

  test("dev dashboard CSP no longer depends on inline script or style", () => {
    const html = read("apps/dev-dashboard/index.html");
    const server = read("apps/dev-dashboard/serve.mjs");

    expect(html).not.toContain("<style>");
    expect(html).not.toContain("<script>");
    expect(server).not.toContain("'unsafe-inline'");
    expect(server).toContain("\"script-src-attr 'none'\"");
    expect(server).toContain("\"style-src-attr 'none'\"");
  });
});
