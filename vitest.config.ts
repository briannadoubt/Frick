import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/dist-types/**", "**/build/**", "**/.build/**", "**/.claude/**"],
    // Many suites are black-box: they spawn the CLI / server entry via a cold
    // `tsx` process per test. On a loaded CI runner that cold start can exceed
    // vitest's 5s default, producing spurious timeouts (the recurring red on
    // main). A genuinely hung process still trips this bound; it only tolerates
    // slow-but-progressing spawns.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
