import type { TemplateVariables } from "./index.js";

/**
 * Black-box smoke test: boot the scaffolded server in-process, hit /health,
 * shut it down. Kept dependency-free so a fresh scaffold can run `pnpm test`
 * before the developer touches anything else.
 */
export function renderSmokeTestTs(_vars: TemplateVariables): string {
  return `import { describe, expect, it } from "vitest";
import { createFrickServer } from "@frick/server";
import { schema } from "../src/schema.js";

describe("smoke", () => {
  it("boots the server and answers /health", async () => {
    const app = createFrickServer({ schema, port: 0 });
    const started = typeof app.start === "function" ? await app.start() : app;
    try {
      const address = (started as { address?: () => { port: number } }).address?.();
      const port = address?.port ?? 0;
      const response = await fetch(\`http://127.0.0.1:\${port}/health\`);
      expect(response.status).toBe(200);
    } finally {
      if (typeof (started as { stop?: () => Promise<void> }).stop === "function") {
        await (started as { stop: () => Promise<void> }).stop();
      }
    }
  });
});
`;
}
