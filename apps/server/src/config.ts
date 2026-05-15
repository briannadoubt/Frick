/**
 * Frick server runtime configuration.
 *
 * Slice 6 expanded this beyond the original demo-auth/session knobs to cover
 * deployment-shaped settings: host, port, public URL, allowed origins, db and
 * blob storage paths, and log level. Storage drivers other than the existing
 * SQLite/local-filesystem pair, and CORS enforcement itself, still land in a
 * later slice — this module just parses, validates, and exposes the values.
 */

export type FrickEnv = "development" | "test" | "production";

export type FrickLogLevel = "debug" | "info" | "warn" | "error";

export interface FrickConfig {
  /** Runtime environment. Drives defaults for the rest of the config. */
  env: FrickEnv;
  /**
   * Whether the demo-only authentication shortcuts (e.g. POST
   * `/auth/dev-login`) are exposed by the HTTP server. Defaults to true in
   * any non-production environment. Production mode refuses to start when
   * this is enabled.
   */
  demoAuthEnabled: boolean;
  /**
   * Session lifetime in seconds. New sessions get `expiresAt = now + ttl`.
   * Zero or negative values mean "expire immediately" — useful for tests
   * exercising the `auth.sessionExpired` envelope.
   */
  sessionTtlSeconds: number;
  /**
   * Host the HTTP server binds to. Defaults to `127.0.0.1` in development and
   * test (so casual `pnpm dev` runs aren't exposed on the LAN) and `0.0.0.0`
   * in production (the typical container/orchestrator case).
   */
  host: string;
  /** TCP port the HTTP server binds to. */
  port: number;
  /**
   * Externally-reachable URL of this server, when known. Logged at startup
   * and surfaced to inspection routes; never required for the server to run.
   */
  publicUrl: string | undefined;
  /**
   * Origins allowed for CORS, parsed from a comma-separated env var. HTTP
   * preflight requests and WebSocket upgrades are rejected when the request's
   * `Origin` is not on this list. Requests without an `Origin` header are
   * treated as same-origin/server-to-server traffic.
   */
  allowedOrigins: string[];
  /** SQLite database path. Tests pass `":memory:"`. */
  dbPath: string;
  /** Filesystem directory for blob storage (current driver is local fs). */
  blobStoragePath: string;
  /** Threshold for the structured logger. */
  logLevel: FrickLogLevel;
  /**
   * Whether inspection routes under `/_frick/inspect/*` are enabled. Defaults
   * to true when `env !== "production"`, off otherwise. Set
   * `FRICK_INSPECTION_ENABLED=true` to force them on in production.
   */
  inspectionEnabled: boolean;
  /**
   * Static bearer token that, when supplied in the `Authorization: Bearer`
   * header, authenticates the request as a cross-tenant admin principal
   * (see {@link Principal.scope}). Sourced from `FRICK_ADMIN_TOKEN`. When
   * unset, admin functionality is completely disabled — admin routes return
   * 404 and the bearer is never matched against this value.
   */
  adminToken: string | undefined;
  /**
   * Derived from {@link FrickConfig.adminToken}: true when an admin token is
   * configured, false otherwise. The admin routes block under
   * `/_frick/admin/*` is gated on this flag.
   */
  adminEnabled: boolean;
  /**
   * When true (the default in development/test), the `/auth/*` handlers
   * implicitly add unknown `tenantId` values to the tenants ledger so apps
   * don't need an explicit admin step before signing up. When false, the
   * handlers reject unknown tenants with `auth.forbidden` + `details.reason:
   * "unknownTenant"` so an admin must pre-create the tenant.
   */
  implicitTenantCreation: boolean;
}

export class FrickConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrickConfigError";
  }
}

const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const DEFAULT_PORT = 4099;
const DEFAULT_DB_PATH = "./frick.sqlite";
const DEFAULT_BLOB_STORAGE_PATH = "./frick-blobs/";

const VALID_ENVS: ReadonlySet<FrickEnv> = new Set<FrickEnv>(["development", "test", "production"]);
const VALID_LOG_LEVELS: ReadonlySet<FrickLogLevel> = new Set<FrickLogLevel>([
  "debug",
  "info",
  "warn",
  "error",
]);

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

  const host = overrides.host ?? parseString(env.FRICK_HOST) ?? defaultHost(runtimeEnv);
  const port = overrides.port ?? parsePort(env.FRICK_PORT, DEFAULT_PORT);
  const publicUrl = overrides.publicUrl ?? parseString(env.FRICK_PUBLIC_URL);
  const allowedOrigins =
    overrides.allowedOrigins ?? parseAllowedOrigins(env.FRICK_ALLOWED_ORIGINS, runtimeEnv);
  const dbPath = overrides.dbPath ?? parseString(env.FRICK_DB_PATH) ?? DEFAULT_DB_PATH;
  const blobStoragePath =
    overrides.blobStoragePath ?? parseString(env.FRICK_BLOB_STORAGE_PATH) ?? DEFAULT_BLOB_STORAGE_PATH;
  const logLevel = overrides.logLevel ?? parseLogLevel(env.FRICK_LOG_LEVEL, "info");
  const inspectionDefault = runtimeEnv !== "production";
  const inspectionEnabled =
    overrides.inspectionEnabled ??
    parseBoolean(env.FRICK_INSPECTION_ENABLED, inspectionDefault, "FRICK_INSPECTION_ENABLED");
  const adminToken =
    "adminToken" in overrides ? overrides.adminToken : parseString(env.FRICK_ADMIN_TOKEN);
  const adminEnabled = overrides.adminEnabled ?? !!adminToken;
  const implicitTenantDefault = runtimeEnv !== "production";
  const implicitTenantCreation =
    overrides.implicitTenantCreation ??
    parseBoolean(
      env.FRICK_IMPLICIT_TENANT_CREATION,
      implicitTenantDefault,
      "FRICK_IMPLICIT_TENANT_CREATION",
    );

  if (runtimeEnv === "production" && demoAuthEnabled) {
    throw new FrickConfigError(
      "demoAuthEnabled=true is forbidden in production — unset FRICK_DEMO_AUTH_ENABLED or use a non-production FRICK_ENV",
    );
  }
  if (runtimeEnv === "production" && dbPath === ":memory:") {
    throw new FrickConfigError(
      "dbPath ':memory:' is forbidden in production — set FRICK_DB_PATH to a durable filesystem path",
    );
  }
  if (runtimeEnv === "production" && inspectionEnabled) {
    warn("[frick.config] inspectionEnabled=true in production — /_frick/inspect/* is enabled and requires admin auth");
  }
  if (runtimeEnv === "production" && adminEnabled) {
    if (!adminToken || adminToken.length < 32) {
      throw new FrickConfigError(
        "FRICK_ADMIN_TOKEN must be at least 32 characters in production when admin is enabled",
      );
    }
  }

  return {
    env: runtimeEnv,
    demoAuthEnabled,
    sessionTtlSeconds,
    host,
    port,
    publicUrl,
    allowedOrigins,
    dbPath,
    blobStoragePath,
    logLevel,
    inspectionEnabled,
    adminToken,
    adminEnabled,
    implicitTenantCreation,
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

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new FrickConfigError(
      `FRICK_PORT must be an integer in [0, 65535] (got ${JSON.stringify(value)})`,
    );
  }
  return parsed;
}

function parseString(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  return value;
}

function parseLogLevel(value: string | undefined, fallback: FrickLogLevel): FrickLogLevel {
  if (value === undefined || value === "") return fallback;
  if (VALID_LOG_LEVELS.has(value as FrickLogLevel)) {
    return value as FrickLogLevel;
  }
  throw new FrickConfigError(
    `FRICK_LOG_LEVEL must be one of debug, info, warn, error (got ${JSON.stringify(value)})`,
  );
}

function parseAllowedOrigins(value: string | undefined, env: FrickEnv): string[] {
  if (value === undefined || value === "") {
    return env === "production" ? [] : ["*"];
  }
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function defaultHost(env: FrickEnv): string {
  return env === "production" ? "0.0.0.0" : "127.0.0.1";
}
