import type { TemplateVariables } from "./index.js";

/**
 * Black-box smoke test: boot the scaffolded server in-process, hit /health,
 * shut it down. Kept dependency-free so a fresh scaffold can run `pnpm test`
 * before the developer touches anything else.
 */
export function renderSmokeTestTs(_vars: TemplateVariables): string {
  return `import { describe, expect, it } from "vitest";
import { createFrickServer } from "@fricken/server";
import { schema } from "../src/schema.js";

describe("smoke", () => {
  it("boots the server and answers /health", async () => {
    const app = createFrickServer({
      schema,
      port: 0,
      dbPath: ":memory:",
      config: { env: "test" },
      jobs: { workerEnabled: false },
    });
    await app.listen();
    try {
      const response = await fetch(\`\${app.httpUrl}/health\`);
      expect(response.status).toBe(200);
      expect(app.store.schema.schemaId).toBe(schema.schemaId);
    } finally {
      await app.close();
    }
  });
});
`;
}
