/**
 * Frick server runtime configuration.
 *
 * This module is intentionally narrow: it only covers the runtime-mode and
 * demo-auth knobs needed by slice 5 of the framework hardening spec (typed
 * authorization decisions and demo-auth gating). Storage drivers, blob
 * drivers, public URLs, ports, CORS, and other deployment-shaped config land
 * in a later slice and should be added here when they do.
 */

export type FrickEnv = "development" | "test" | "production";

export interface FrickConfig {
  /** Runtime environment. Drives defaults for the rest of the config. */
  env: FrickEnv;
  /**
   * Whether the demo-only authentication shortcuts (e.g. POST
   * `/auth/dev-login`) are exposed by the HTTP server. Defaults to true in
   * any non-production environment. Forcing this on in production logs a
   * structured warning so operators can spot misconfiguration in CI/log
   * scrapers.
   */
  demoAuthEnabled: boolean;
  /**
   * Session lifetime in seconds. New sessions get `expiresAt = now + ttl`.
   * Zero or negative values mean "expire immediately" — useful for tests
   * exercising the `auth.sessionExpired` envelope.
   */
  sessionTtlSeconds: number;
}

export class FrickConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrickConfigError";
  }
}

const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

const VALID_ENVS: ReadonlySet<FrickEnv> = new Set<FrickEnv>(["development", "test", "production"]);

export type FrickConfigOverrides = Partial<FrickConfig>;

interface LoadConfigContext {
  env: NodeJS.ProcessEnv;
  warn: (line: string) => void;
}

/**
 * Read runtime config from environment variables, then layer explicit
 * overrides on top. Overrides win over environment so tests can opt into a
 * specific mode without mutating `process.env`.
 */
export function loadFrickConfig(
  overrides: FrickConfigOverrides = {},
  context: Partial<LoadConfigContext> = {},
): FrickConfig {
  const env = context.env ?? process.env;
  const warn = context.warn ?? ((line: string) => process.stderr.write(`${line}\n`));

  const runtimeEnv = parseEnv(overrides.env ?? env.FRICK_ENV);
  const demoAuthDefault = runtimeEnv !== "production";
  const demoAuthEnabled =
    overrides.demoAuthEnabled ??
    parseBoolean(env.FRICK_DEMO_AUTH_ENABLED, demoAuthDefault, "FRICK_DEMO_AUTH_ENABLED");
  const sessionTtlSeconds =
    overrides.sessionTtlSeconds ??
    parseSeconds(env.FRICK_SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS, "FRICK_SESSION_TTL_SECONDS");

  if (runtimeEnv === "production" && demoAuthEnabled) {
    warn("[frick.config] demoAuthEnabled=true in production — /auth/dev-login is exposed");
  }

  return {
    env: runtimeEnv,
    demoAuthEnabled,
    sessionTtlSeconds,
  };
}

function parseEnv(value: string | undefined): FrickEnv {
  if (value === undefined || value === "") {
    return "development";
  }
  if (VALID_ENVS.has(value as FrickEnv)) {
    return value as FrickEnv;
  }
  throw new FrickConfigError(
    `FRICK_ENV must be one of development, test, production (got ${JSON.stringify(value)})`,
  );
}

function parseBoolean(value: string | undefined, fallback: boolean, varName: string): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }
  const lowered = value.toLowerCase();
  if (lowered === "true" || lowered === "1" || lowered === "yes") {
    return true;
  }
  if (lowered === "false" || lowered === "0" || lowered === "no") {
    return false;
  }
  throw new FrickConfigError(
    `${varName} must be true/false/1/0/yes/no (got ${JSON.stringify(value)})`,
  );
}

function parseSeconds(value: string | undefined, fallback: number, varName: string): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new FrickConfigError(`${varName} must be a finite number of seconds (got ${JSON.stringify(value)})`);
  }
  return parsed;
}
