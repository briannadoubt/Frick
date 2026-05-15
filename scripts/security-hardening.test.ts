import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("release hardening", () => {
  test("npm pack dry-runs ignore lifecycle scripts and scrub publish tokens", () => {
    const source = read("scripts/release-dry-run.ts");

    expect(source).toContain('"--ignore-scripts"');
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

  test("generated artifact verification covers TypeScript core generated files", () => {
    const source = read("scripts/check-generated-artifacts.ts");

    expect(source).toContain("packages/core/src/generated/bindings.ts");
    expect(source).toContain("packages/core/src/generated/errors.ts");
  });

  test("Tilt install is lockfile-driven and disables lifecycle scripts", () => {
    const source = read("Tiltfile");

    expect(source).toContain('cmd="pnpm install --frozen-lockfile --ignore-scripts"');
    expect(source).toContain('"pnpm-lock.yaml"');
  });

  test("GitHub workflows pin action SHAs and gate Android publishing to version tags", () => {
    const ci = read(".github/workflows/ci.yml");
    const publishAndroid = read(".github/workflows/publish-android.yml");
    const workflows = `${ci}\n${publishAndroid}`;

    expect(workflows).not.toMatch(/uses:\s+[-\w/]+@v\d+\b/);
    expect(publishAndroid).not.toContain("workflow_dispatch");
    expect(publishAndroid).toContain("if: ${{ startsWith(github.ref, 'refs/tags/android-v') }}");
    expect(publishAndroid).toContain("android-v${frickVersion}");
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
