/**
 * Frick server runtime configuration.
 *
 * Slice 6 expanded this beyond the original demo-auth/session knobs to cover
 * deployment-shaped settings: host, port, public URL, allowed origins, db and
 * blob storage paths, and log level. A storage-driver selector (`dbDriver`)
 * now lets a future Postgres driver be chosen; SQLite stays the default and the
 * only implemented driver, with `postgres` rejected at validation time until
 * FR-22 lands. The local-filesystem blob driver and CORS enforcement itself
 * still land in a later slice — this module just parses, validates, and exposes
 * the values.
 */

export type FrickEnv = "development" | "test" | "production";

export type FrickLogLevel = "debug" | "info" | "warn" | "error";

export type FrickPlatformEventsDriver = "sqlite" | "kafka";

/**
 * Durable-storage driver selector. SQLite is the default and, today, the only
 * implemented driver — every `*Store` under `src/storage/` is backed by
 * single-writer `node:sqlite`. `postgres` is reserved for a future driver
 * (FR-22) and is rejected at config-validation time until that lands; see the
 * gate in {@link loadFrickConfig}.
 */
export type FrickDbDriver = "sqlite" | "postgres";

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
  /**
   * Durable-storage driver. Defaults to `sqlite`, which is the only driver
   * implemented today. Selecting `postgres` fails fast at config validation
   * until the Postgres driver lands (FR-22).
   */
  dbDriver: FrickDbDriver;
  /** SQLite database path. Used by the `sqlite` driver. Tests pass `":memory:"`. */
  dbPath: string;
  /**
   * Connection string for the future `postgres` driver (FR-22), parsed from
   * `FRICK_DATABASE_URL`. Unused by the `sqlite` driver and `undefined` when
   * the env var is unset.
   */
  databaseUrl: string | undefined;
  /** Filesystem directory for blob storage (current driver is local fs). */
  blobStoragePath: string;
  /** Threshold for the structured logger. */
  logLevel: FrickLogLevel;
  /**
   * Enables the OpenTelemetry runtime. Defaults to true when an OTLP endpoint
   * is configured through Frick or standard OTel env vars.
   */
  otelEnabled: boolean;
  /** Service name attached to Frick server spans and metrics. */
  otelServiceName: string;
  /** Base OTLP HTTP endpoint, usually the collector endpoint on port 4318. */
  otelExporterOtlpEndpoint: string | undefined;
  /** Signal-specific OTLP HTTP traces endpoint. */
  otelExporterOtlpTracesEndpoint: string | undefined;
  /** Signal-specific OTLP HTTP metrics endpoint. */
  otelExporterOtlpMetricsEndpoint: string | undefined;
  /** How often the OTel metric reader exports accumulated metrics. */
  otelMetricExportIntervalMs: number;
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
  /**
   * Platform event pipeline driver. Defaults to `sqlite` unless Kafka brokers
   * are configured, in which case it defaults to `kafka`.
   */
  platformEventsDriver: FrickPlatformEventsDriver;
  /** Topic used by Kafka/Redpanda platform event adapters. */
  platformEventsTopic: string;
  /** Kafka/Redpanda broker list for the platform event pipeline. */
  platformEventsKafkaBrokers: string[];
  /** Retention window for local SQLite platform events. */
  platformEventsRetentionMs: number;
  /** Hard row cap for local SQLite platform events. */
  platformEventsMaxRows: number;
  /**
   * Replay window (ms) for `requestId` idempotency. On lookup, an
   * `(tenantId, replicaId, requestId)` record whose `created_at` is older than
   * this window is no longer treated as idempotent — a retry beyond the window
   * produces a fresh event. Enforced at lookup time, independent of durable
   * retention/pruning, so beyond-window requestIds are not deduped even before
   * a prune pass has removed the row. Defaults to 24h.
   */
  idempotencyReplayWindowMs: number;
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
const DEFAULT_PLATFORM_EVENTS_TOPIC = "frick.platform.events";
const DEFAULT_PLATFORM_EVENTS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PLATFORM_EVENTS_MAX_ROWS = 1_000_000;
const DEFAULT_IDEMPOTENCY_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_OTEL_SERVICE_NAME = "frick-server";
const DEFAULT_OTEL_METRIC_EXPORT_INTERVAL_MS = 60_000;

const VALID_ENVS: ReadonlySet<FrickEnv> = new Set<FrickEnv>(["development", "test", "production"]);
const VALID_LOG_LEVELS: ReadonlySet<FrickLogLevel> = new Set<FrickLogLevel>([
  "debug",
  "info",
  "warn",
  "error",
]);
const VALID_PLATFORM_EVENTS_DRIVERS: ReadonlySet<FrickPlatformEventsDriver> =
  new Set<FrickPlatformEventsDriver>(["sqlite", "kafka"]);
const VALID_DB_DRIVERS: ReadonlySet<FrickDbDriver> = new Set<FrickDbDriver>([
  "sqlite",
  "postgres",
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
  const dbDriver = overrides.dbDriver ?? parseDbDriver(env.FRICK_DB_DRIVER);
  const dbPath = overrides.dbPath ?? parseString(env.FRICK_DB_PATH) ?? DEFAULT_DB_PATH;
  const databaseUrl =
    "databaseUrl" in overrides ? overrides.databaseUrl : parseString(env.FRICK_DATABASE_URL);
  const blobStoragePath =
    overrides.blobStoragePath ?? parseString(env.FRICK_BLOB_STORAGE_PATH) ?? DEFAULT_BLOB_STORAGE_PATH;
  const logLevel = overrides.logLevel ?? parseLogLevel(env.FRICK_LOG_LEVEL, "info");
  const otelExporterOtlpEndpoint =
    "otelExporterOtlpEndpoint" in overrides
      ? overrides.otelExporterOtlpEndpoint
      : parseString(env.FRICK_OTEL_EXPORTER_OTLP_ENDPOINT) ??
        parseString(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const otelExporterOtlpTracesEndpoint =
    "otelExporterOtlpTracesEndpoint" in overrides
      ? overrides.otelExporterOtlpTracesEndpoint
      : parseString(env.FRICK_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) ??
        parseString(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  const otelExporterOtlpMetricsEndpoint =
    "otelExporterOtlpMetricsEndpoint" in overrides
      ? overrides.otelExporterOtlpMetricsEndpoint
      : parseString(env.FRICK_OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) ??
        parseString(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT);
  const otelEndpointConfigured =
    otelExporterOtlpEndpoint !== undefined ||
    otelExporterOtlpTracesEndpoint !== undefined ||
    otelExporterOtlpMetricsEndpoint !== undefined;
  const otelEnabledDefault = otelEndpointConfigured && env.OTEL_SDK_DISABLED?.toLowerCase() !== "true";
  const otelEnabled =
    overrides.otelEnabled ??
    parseBoolean(env.FRICK_OTEL_ENABLED, otelEnabledDefault, "FRICK_OTEL_ENABLED");
  const otelServiceName = validateNonEmptyString(
    overrides.otelServiceName ??
      parseString(env.FRICK_OTEL_SERVICE_NAME) ??
      parseString(env.OTEL_SERVICE_NAME) ??
      DEFAULT_OTEL_SERVICE_NAME,
    "FRICK_OTEL_SERVICE_NAME",
  );
  const otelMetricExportIntervalMs = validatePositiveInteger(
    overrides.otelMetricExportIntervalMs ??
      parsePositiveInteger(
        env.FRICK_OTEL_METRIC_EXPORT_INTERVAL_MS,
        DEFAULT_OTEL_METRIC_EXPORT_INTERVAL_MS,
        "FRICK_OTEL_METRIC_EXPORT_INTERVAL_MS",
      ),
    "otelMetricExportIntervalMs",
  );
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
  const platformEventsKafkaBrokers =
    overrides.platformEventsKafkaBrokers ??
    parseCommaSeparated(env.FRICK_PLATFORM_EVENTS_KAFKA_BROKERS);
  const platformEventsDriver =
    overrides.platformEventsDriver ??
    parsePlatformEventsDriver(env.FRICK_PLATFORM_EVENTS_DRIVER, platformEventsKafkaBrokers);
  const platformEventsTopic = validateNonEmptyString(
    overrides.platformEventsTopic ??
      parseString(env.FRICK_PLATFORM_EVENTS_TOPIC) ??
      DEFAULT_PLATFORM_EVENTS_TOPIC,
    "FRICK_PLATFORM_EVENTS_TOPIC",
  );
  const platformEventsRetentionMs = validatePositiveInteger(
    overrides.platformEventsRetentionMs ??
      parsePositiveInteger(
        env.FRICK_PLATFORM_EVENTS_RETENTION_MS,
        DEFAULT_PLATFORM_EVENTS_RETENTION_MS,
        "FRICK_PLATFORM_EVENTS_RETENTION_MS",
      ),
    "platformEventsRetentionMs",
  );
  const platformEventsMaxRows = validatePositiveInteger(
    overrides.platformEventsMaxRows ??
      parsePositiveInteger(
        env.FRICK_PLATFORM_EVENTS_MAX_ROWS,
        DEFAULT_PLATFORM_EVENTS_MAX_ROWS,
        "FRICK_PLATFORM_EVENTS_MAX_ROWS",
      ),
    "platformEventsMaxRows",
  );
  const idempotencyReplayWindowMs = validatePositiveInteger(
    overrides.idempotencyReplayWindowMs ??
      parsePositiveInteger(
        env.FRICK_IDEMPOTENCY_REPLAY_WINDOW_MS,
        DEFAULT_IDEMPOTENCY_REPLAY_WINDOW_MS,
        "FRICK_IDEMPOTENCY_REPLAY_WINDOW_MS",
      ),
    "idempotencyReplayWindowMs",
  );

  if (dbDriver === "postgres") {
    throw new FrickConfigError(
      "postgres storage driver is not yet implemented (FR-22) — set FRICK_DB_DRIVER=sqlite (the default) to start the server",
    );
  }
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
    dbDriver,
    dbPath,
    databaseUrl,
    blobStoragePath,
    logLevel,
    otelEnabled,
    otelServiceName,
    otelExporterOtlpEndpoint,
    otelExporterOtlpTracesEndpoint,
    otelExporterOtlpMetricsEndpoint,
    otelMetricExportIntervalMs,
    inspectionEnabled,
    adminToken,
    adminEnabled,
    implicitTenantCreation,
    platformEventsDriver,
    platformEventsTopic,
    platformEventsKafkaBrokers,
    platformEventsRetentionMs,
    platformEventsMaxRows,
    idempotencyReplayWindowMs,
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

function validateNonEmptyString(value: string, varName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new FrickConfigError(`${varName} must not be empty`);
  }
  return trimmed;
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

function parseDbDriver(value: string | undefined): FrickDbDriver {
  if (value === undefined || value === "") {
    return "sqlite";
  }
  if (VALID_DB_DRIVERS.has(value as FrickDbDriver)) {
    return value as FrickDbDriver;
  }
  throw new FrickConfigError(
    `FRICK_DB_DRIVER must be one of sqlite, postgres (got ${JSON.stringify(value)})`,
  );
}

function parsePlatformEventsDriver(
  value: string | undefined,
  brokers: readonly string[],
): FrickPlatformEventsDriver {
  if (value === undefined || value === "") {
    return brokers.length > 0 ? "kafka" : "sqlite";
  }
  if (VALID_PLATFORM_EVENTS_DRIVERS.has(value as FrickPlatformEventsDriver)) {
    return value as FrickPlatformEventsDriver;
  }
  throw new FrickConfigError(
    `FRICK_PLATFORM_EVENTS_DRIVER must be one of sqlite, kafka (got ${JSON.stringify(value)})`,
  );
}

function parseCommaSeparated(value: string | undefined): string[] {
  if (value === undefined || value === "") return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parsePositiveInteger(value: string | undefined, fallback: number, varName: string): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new FrickConfigError(`${varName} must be a positive integer (got ${JSON.stringify(value)})`);
  }
  return parsed;
}

function validatePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new FrickConfigError(`${fieldName} must be a positive integer`);
  }
  return value;
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
