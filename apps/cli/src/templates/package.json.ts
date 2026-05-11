import type { TemplateVariables } from "./index.js";

export function renderPackageJson(vars: TemplateVariables): string {
  const body = {
    name: vars.appName,
    version: vars.version,
    private: true,
    type: "module",
    scripts: {
      dev: "tsx src/server.ts",
      build: "tsc",
      test: "vitest run",
    },
    dependencies: {
      "@frick/protocol": "workspace:*",
      "@frick/server": "workspace:*",
    },
    devDependencies: {
      "@types/node": "^24.10.0",
      tsx: "^4.21.0",
      typescript: "^5.9.3",
      vitest: "^4.0.8",
    },
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}
