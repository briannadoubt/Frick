import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as serverModule from "../src/index.js";

/**
 * Static-consistency tests for the published-package and scaffolded-app Docker
 * recipes under `docker/` (FR-51).
 *
 * We can't build images in CI, so instead we assert the recipes reference
 * things that actually exist in the codebase: the entrypoint imports a real
 * export, the env vars are ones the server config understands, the
 * healthcheck/CMD paths line up, and the dependency manifest points at the
 * real package. This catches drift if an export is renamed or an env var is
 * removed.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dockerRoot = resolve(repoRoot, "docker");

function read(relative: string): string {
  return readFileSync(resolve(dockerRoot, relative), "utf8");
}

// Env vars the server's config parser reads (config.ts). Keep this list small:
// it only needs to cover the ones the recipes set so we'd notice a rename.
const configSource = readFileSync(resolve(repoRoot, "apps/server/src/config.ts"), "utf8");

describe("docker recipes — published-server", () => {
  const entrypoint = read("published-server/entrypoint.mjs");
  const dockerfile = read("published-server/Dockerfile");
  const pkg = JSON.parse(read("published-server/package.json")) as {
    dependencies: Record<string, string>;
    scripts: Record<string, string>;
  };

  it("entrypoint imports a real @fricken/server export", () => {
    expect(entrypoint).toContain('from "@fricken/server"');
    expect(entrypoint).toContain("createFrickServer");
    // The export the entrypoint relies on must actually exist on the barrel.
    expect(typeof serverModule.createFrickServer).toBe("function");
  });

  it("entrypoint calls listen() and closes on container signals", () => {
    expect(entrypoint).toMatch(/await app\.listen\(\)/);
    expect(entrypoint).toContain("SIGTERM");
    expect(entrypoint).toContain("app.close()");
  });

  it("package.json depends on @fricken/server and starts the entrypoint", () => {
    expect(pkg.dependencies["@fricken/server"]).toBeTruthy();
    expect(pkg.scripts.start).toContain("entrypoint.mjs");
  });

  it("Dockerfile CMD runs the entrypoint that exists in the build context", () => {
    expect(dockerfile).toContain('CMD ["node", "entrypoint.mjs"]');
    expect(dockerfile).toContain("COPY package.json entrypoint.mjs");
  });

  it("Dockerfile runs as non-root, exposes the port, and declares the data volume", () => {
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain("EXPOSE 4099");
    expect(dockerfile).toContain('VOLUME ["/var/lib/frick"]');
  });

  it("healthcheck targets the real /ready readiness route", () => {
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain("/ready");
  });

  it("only sets FRICK_* env vars the server config understands", () => {
    for (const name of frickEnvVarsIn(dockerfile)) {
      expect(configSource).toContain(name);
    }
  });
});

describe("docker recipes — scaffolded-app", () => {
  const dockerfile = read("scaffolded-app/Dockerfile");

  it("builds with the scaffold's own toolchain and runs the compiled entry", () => {
    expect(dockerfile).toContain("npm run build");
    // tsconfig outDir is `dist`, so src/server.ts compiles to dist/server.js.
    expect(dockerfile).toContain('CMD ["node", "dist/server.js"]');
  });

  it("sets PORT (read by the scaffolded server.ts) alongside FRICK_PORT", () => {
    expect(dockerfile).toMatch(/\bPORT=4099\b/);
    expect(dockerfile).toMatch(/\bFRICK_PORT=4099\b/);
  });

  it("runs as non-root with a healthcheck and data volume", () => {
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain('VOLUME ["/var/lib/frick"]');
    expect(dockerfile).toContain("/ready");
  });

  it("only sets FRICK_* env vars the server config understands", () => {
    for (const name of frickEnvVarsIn(dockerfile)) {
      expect(configSource).toContain(name);
    }
  });
});

/** Extract `FRICK_*` identifiers assigned in a Dockerfile (`ENV FRICK_x=…`). */
function frickEnvVarsIn(dockerfile: string): string[] {
  const names = new Set<string>();
  for (const match of dockerfile.matchAll(/\b(FRICK_[A-Z0-9_]+)=/g)) {
    names.add(match[1]!);
  }
  return [...names];
}
