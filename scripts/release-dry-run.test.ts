import { describe, expect, test } from "vitest";
import {
  inspectPackedEntrypointSpecifiers,
  inspectPackedPackageManifest,
  inspectPackageEntrypoints,
  type PackEntry,
  type PackageJson,
} from "./release-dry-run.js";

function packEntry(files: string[]): PackEntry {
  return {
    name: "@frick/example",
    version: "0.0.0",
    filename: "frick-example-0.0.0.tgz",
    files: files.map((path) => ({ path, size: 1 })),
  };
}

describe("release dry-run package entrypoint checks", () => {
  test("flags workspace protocols in packed runtime dependency manifests", () => {
    const manifest: PackageJson = {
      name: "@frick/example",
      dependencies: {
        "@frick/core": "workspace:*",
      },
      peerDependencies: {
        "@frick/react": "workspace:^",
      },
      optionalDependencies: {
        "@frick/native-cache": "workspace:../native-cache",
      },
      devDependencies: {
        "@frick/test-utils": "workspace:*",
      },
    };

    expect(inspectPackedPackageManifest(manifest)).toEqual([
      {
        package: "@frick/example",
        kind: "workspace-protocol-dependency",
        detail: "dependencies.@frick/core still uses workspace:*",
      },
      {
        package: "@frick/example",
        kind: "workspace-protocol-dependency",
        detail: "optionalDependencies.@frick/native-cache still uses workspace:../native-cache",
      },
      {
        package: "@frick/example",
        kind: "workspace-protocol-dependency",
        detail: "peerDependencies.@frick/react still uses workspace:^",
      },
    ]);
  });

  test("flags source entrypoints and missing packed entrypoint targets", () => {
    const pkg: PackageJson = {
      name: "@frick/example",
      type: "module",
      main: "./src/index.ts",
      types: "./src/index.ts",
      exports: {
        ".": {
          types: "./src/index.ts",
          import: "./src/index.ts",
        },
        "./chat": "./dist/chat.js",
      },
    };
    const entry = packEntry(["README.md", "dist/index.js", "dist/index.d.ts"]);

    expect(inspectPackageEntrypoints(pkg, entry)).toEqual([
      {
        package: "@frick/example",
        kind: "typescript-source-entry",
        detail: "main points at ./src/index.ts",
      },
      {
        package: "@frick/example",
        kind: "typescript-source-entry",
        detail: "types points at ./src/index.ts",
      },
      {
        package: "@frick/example",
        kind: "typescript-source-entry",
        detail: "exports[.].import points at ./src/index.ts",
      },
      {
        package: "@frick/example",
        kind: "typescript-source-entry",
        detail: "exports[.].types points at ./src/index.ts",
      },
      {
        package: "@frick/example",
        kind: "missing-entrypoint",
        detail: "exports[./chat] points at ./dist/chat.js, but it is not packed",
      },
    ]);
  });

  test("flags missing relative side-effect imports from packed JS entrypoints", () => {
    const pkg: PackageJson = {
      name: "@frick/example",
      type: "module",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      },
    };
    const entry = packEntry(["README.md", "dist/index.js", "dist/index.d.ts", "dist/client.js", "dist/client.d.ts"]);
    const contents = new Map([
      ["dist/index.js", `import "./index.css";\nexport { createClient } from "./client.js";\n`],
      ["dist/index.d.ts", `export type { Client } from "./client";\n`],
      ["dist/client.js", `export const createClient = () => undefined;\n`],
      ["dist/client.d.ts", `export type Client = {};\n`],
    ]);

    expect(inspectPackedEntrypointSpecifiers(pkg, entry, contents)).toEqual([
      {
        package: "@frick/example",
        kind: "missing-entrypoint-reference",
        detail: "dist/index.js imports ./index.css, but dist/index.css is not packed",
      },
    ]);
  });

  test("flags missing relative imports from files reached by entrypoints", () => {
    const pkg: PackageJson = {
      name: "@frick/example",
      type: "module",
      exports: {
        ".": {
          import: "./dist/index.js",
        },
      },
    };
    const entry = packEntry(["README.md", "dist/index.js", "dist/widget.js"]);
    const contents = new Map([
      ["dist/index.js", `export { Widget } from "./widget.js";\n`],
      ["dist/widget.js", `import "./widget.css";\nexport const Widget = {};\n`],
    ]);

    expect(inspectPackedEntrypointSpecifiers(pkg, entry, contents)).toEqual([
      {
        package: "@frick/example",
        kind: "missing-entrypoint-reference",
        detail: "dist/widget.js imports ./widget.css, but dist/widget.css is not packed",
      },
    ]);
  });
});
