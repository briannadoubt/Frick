/**
 * Shared helpers for command handlers: turn `--db-path`/`--env` flags into a
 * loaded `FrickConfig` and (optionally) an opened `FrickStore`.
 *
 * The CLI consumes `@fricken/server` through its published public entrypoint —
 * it never reaches into the server's `src/` tree.
 */
import { loadFrickConfig, FrickStore, type FrickConfig, type FrickEnv } from "@fricken/server";
import { requireString } from "./argv.js";

export interface ContextFlags {
  dbPath?: string | undefined;
  env?: FrickEnv | undefined;
}

export function contextFlagsFrom(flags: Record<string, string | boolean>): ContextFlags {
  const dbPath = requireString(flags, "db-path");
  const envFlag = requireString(flags, "env");
  const env = envFlag === "development" || envFlag === "test" || envFlag === "production" ? envFlag : undefined;
  return {
    ...(dbPath !== undefined ? { dbPath } : {}),
    ...(env !== undefined ? { env } : {}),
  };
}

/**
 * Load config using the same precedence as the server: CLI flags >
 * environment variables > built-in defaults. We never write to process.env
 * — the override object is passed to `loadFrickConfig` directly.
 */
export function loadConfig(ctx: ContextFlags): FrickConfig {
  const overrides: Parameters<typeof loadFrickConfig>[0] = {};
  if (ctx.dbPath !== undefined) overrides.dbPath = ctx.dbPath;
  if (ctx.env !== undefined) overrides.env = ctx.env;
  return loadFrickConfig(overrides);
}

/**
 * Open a store against the configured DB. Caller is responsible for calling
 * `store.close()` (commands wrap this in try/finally).
 *
 * `seed: false` is important: the CLI must never silently mutate a DB it
 * was asked to read, and the store's default `seed: true` writes default
 * sentinel rows on construction.
 */
export function openStore(config: FrickConfig): FrickStore {
  return new FrickStore({
    path: config.dbPath,
    seed: false,
    idempotencyKeyPruneIntervalMs: 0,
  });
}
