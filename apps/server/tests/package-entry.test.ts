import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { FrickSchema } from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = resolve(repoRoot, "apps/server");
const packageJsonPath = resolve(packageRoot, "package.json");
const sourceIndexPath = resolve(packageRoot, "src/index.ts");

describe("@fricken/server package entry", () => {
  it("can be imported without starting a server listener", async () => {
    const { stdout } = await execFileAsync(
      "pnpm",
      [
        "exec",
        "tsx",
        "-e",
        `
          (async () => {
            const mod = await import(${JSON.stringify(sourceIndexPath)});
            console.log(JSON.stringify({
              createFrickServer: typeof mod.createFrickServer,
              MemoryClusterBus: typeof mod.MemoryClusterBus,
              createFrickWebPushAdapter: typeof mod.createFrickWebPushAdapter
            }));
          })();
        `,
      ],
      {
        cwd: repoRoot,
        timeout: 20_000,
      },
    );

    expect(JSON.parse(stdout.trim())).toEqual({
      createFrickServer: "function",
      MemoryClusterBus: "function",
      createFrickWebPushAdapter: "function",
    });
  }, 30_000);

  it("re-exports the web push adapter factory from the documented subpath source", async () => {
    const webPushSource = resolve(packageRoot, "src/push/web-push-adapter.ts");
    const { stdout } = await execFileAsync(
      "pnpm",
      [
        "exec",
        "tsx",
        "-e",
        `
          (async () => {
            const mod = await import(${JSON.stringify(webPushSource)});
            const adapter = mod.createFrickWebPushAdapter();
            console.log(JSON.stringify({
              createFrickWebPushAdapter: typeof mod.createFrickWebPushAdapter,
              validateWebPushRegistrationToken: typeof mod.validateWebPushRegistrationToken,
              platform: adapter.platform,
              send: typeof adapter.send
            }));
          })();
        `,
      ],
      {
        cwd: repoRoot,
        timeout: 20_000,
      },
    );

    expect(JSON.parse(stdout.trim())).toEqual({
      createFrickWebPushAdapter: "function",
      validateWebPushRegistrationToken: "function",
      platform: "webPush",
      send: "function",
    });
  }, 30_000);

  it("declares dist exports for the package root and documented push adapter subpaths", () => {
    const body = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      main?: string;
      types?: string;
      exports?: Record<string, { import?: string; types?: string; default?: string }>;
      scripts?: Record<string, string>;
    };

    expect(body.main).toBe("./dist/index.js");
    expect(body.types).toBe("./dist/index.d.ts");
    expect(body.exports?.["."]).toMatchObject({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });
    expect(body.exports?.["./push/apns-adapter"]).toMatchObject({
      types: "./dist/push/apns-adapter.d.ts",
      import: "./dist/push/apns-adapter.js",
    });
    expect(body.exports?.["./push/fcm-adapter"]).toMatchObject({
      types: "./dist/push/fcm-adapter.d.ts",
      import: "./dist/push/fcm-adapter.js",
    });
    expect(body.exports?.["./push/web-push-adapter"]).toMatchObject({
      types: "./dist/push/web-push-adapter.d.ts",
      import: "./dist/push/web-push-adapter.js",
    });
    expect(body.scripts?.dev).toBe("tsx src/dev.ts");
    expect(body.scripts?.build).toBe("tsc -b");
  });

  it("does not seed foundation objects into custom-schema servers", async () => {
    const schema: FrickSchema = {
      name: "empty-app",
      schemaId: "empty-app",
      schemaVersion: "0.1.0",
      schemaRevision: 1,
      minimumClientRevision: 1,
      minimumServerRevision: 1,
      protocol: "frick.realtime",
      protocolVersion: 1,
      compatibility: "greenfield-cutover",
      hash: "empty-app-test",
      objects: [],
      streams: [],
      events: [],
      presences: [],
      signals: [],
      blobs: [],
      jobs: [],
      projections: [],
    };

    const app = createFrickServer({
      schema,
      port: 0,
      dbPath: ":memory:",
      config: { env: "test" },
    });
    try {
      expect(app.store.schema.schemaId).toBe("empty-app");
      expect(app.store.listObjects("User")).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
