import { describe, expect, it } from "vitest";
import { FrickConfigError, loadFrickConfig } from "../src/config.js";

describe("loadFrickConfig", () => {
  it("defaults to development with demo auth enabled and sensible deployment defaults", () => {
    const config = loadFrickConfig({}, { env: {}, warn: () => {} });
    expect(config).toEqual({
      env: "development",
      demoAuthEnabled: true,
      sessionTtlSeconds: 7 * 24 * 60 * 60,
      host: "127.0.0.1",
      port: 4099,
      publicUrl: undefined,
      allowedOrigins: ["*"],
      dbDriver: "sqlite",
      dbPath: "./frick.sqlite",
      databaseUrl: undefined,
      blobStoragePath: "./frick-blobs/",
      logLevel: "info",
      inspectionEnabled: true,
      adminToken: undefined,
      adminEnabled: false,
      implicitTenantCreation: true,
      otelEnabled: false,
      otelServiceName: "frick-server",
      otelExporterOtlpEndpoint: undefined,
      otelExporterOtlpTracesEndpoint: undefined,
      otelExporterOtlpMetricsEndpoint: undefined,
      otelMetricExportIntervalMs: 60_000,
      platformEventsDriver: "sqlite",
      platformEventsTopic: "frick.platform.events",
      platformEventsKafkaBrokers: [],
      platformEventsRetentionMs: 7 * 24 * 60 * 60 * 1000,
      platformEventsMaxRows: 1_000_000,
      idempotencyReplayWindowMs: 24 * 60 * 60 * 1000,
    });
  });

  it("disables demo auth and inspection by default in production and binds to 0.0.0.0", () => {
    const config = loadFrickConfig(
      { dbPath: "/var/lib/frick.sqlite" },
      { env: { FRICK_ENV: "production" }, warn: () => {} },
    );
    expect(config.env).toBe("production");
    expect(config.demoAuthEnabled).toBe(false);
    expect(config.inspectionEnabled).toBe(false);
    expect(config.host).toBe("0.0.0.0");
    expect(config.allowedOrigins).toEqual([]);
  });

  it("reads overrides for env, demoAuthEnabled, and session ttl", () => {
    const config = loadFrickConfig(
      { env: "test", demoAuthEnabled: false, sessionTtlSeconds: 30 },
      { env: {}, warn: () => {} },
    );
    expect(config.env).toBe("test");
    expect(config.demoAuthEnabled).toBe(false);
    expect(config.sessionTtlSeconds).toBe(30);
  });

  it("reads env vars for the new deployment fields", () => {
    const config = loadFrickConfig(
      {},
      {
        env: {
          FRICK_ENV: "test",
          FRICK_HOST: "0.0.0.0",
          FRICK_PORT: "5000",
          FRICK_PUBLIC_URL: "https://frick.example.com",
          FRICK_ALLOWED_ORIGINS: "https://a.example, https://b.example",
          FRICK_DB_DRIVER: "sqlite",
          FRICK_DB_PATH: "/tmp/frick.sqlite",
          FRICK_BLOB_STORAGE_PATH: "/tmp/frick-blobs",
          FRICK_LOG_LEVEL: "debug",
          FRICK_OTEL_ENABLED: "true",
          FRICK_OTEL_SERVICE_NAME: "frick-api",
          FRICK_OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
          FRICK_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector:4318/v1/traces",
          FRICK_OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://collector:4318/v1/metrics",
          FRICK_OTEL_METRIC_EXPORT_INTERVAL_MS: "10000",
          FRICK_PLATFORM_EVENTS_DRIVER: "kafka",
          FRICK_PLATFORM_EVENTS_TOPIC: "frick.events",
          FRICK_PLATFORM_EVENTS_KAFKA_BROKERS: "localhost:9092, localhost:19092",
          FRICK_PLATFORM_EVENTS_RETENTION_MS: "60000",
          FRICK_PLATFORM_EVENTS_MAX_ROWS: "5000",
          FRICK_IDEMPOTENCY_REPLAY_WINDOW_MS: "120000",
        },
        warn: () => {},
      },
    );
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(5000);
    expect(config.publicUrl).toBe("https://frick.example.com");
    expect(config.allowedOrigins).toEqual(["https://a.example", "https://b.example"]);
    expect(config.dbDriver).toBe("sqlite");
    expect(config.dbPath).toBe("/tmp/frick.sqlite");
    expect(config.blobStoragePath).toBe("/tmp/frick-blobs");
    expect(config.logLevel).toBe("debug");
    expect(config.otelEnabled).toBe(true);
    expect(config.otelServiceName).toBe("frick-api");
    expect(config.otelExporterOtlpEndpoint).toBe("http://collector:4318");
    expect(config.otelExporterOtlpTracesEndpoint).toBe("http://collector:4318/v1/traces");
    expect(config.otelExporterOtlpMetricsEndpoint).toBe("http://collector:4318/v1/metrics");
    expect(config.otelMetricExportIntervalMs).toBe(10_000);
    expect(config.platformEventsDriver).toBe("kafka");
    expect(config.platformEventsTopic).toBe("frick.events");
    expect(config.platformEventsKafkaBrokers).toEqual(["localhost:9092", "localhost:19092"]);
    expect(config.platformEventsRetentionMs).toBe(60000);
    expect(config.platformEventsMaxRows).toBe(5000);
    expect(config.idempotencyReplayWindowMs).toBe(120000);
  });

  it("defaults the idempotency replay window to 24h and rejects non-positive values", () => {
    const defaulted = loadFrickConfig({}, { env: {}, warn: () => {} });
    expect(defaulted.idempotencyReplayWindowMs).toBe(24 * 60 * 60 * 1000);

    expect(() =>
      loadFrickConfig(
        {},
        { env: { FRICK_IDEMPOTENCY_REPLAY_WINDOW_MS: "0" }, warn: () => {} },
      ),
    ).toThrow(FrickConfigError);
    expect(() =>
      loadFrickConfig(
        {},
        { env: { FRICK_IDEMPOTENCY_REPLAY_WINDOW_MS: "-5" }, warn: () => {} },
      ),
    ).toThrow(FrickConfigError);
  });

  it("defaults platform events to kafka when brokers are configured", () => {
    const config = loadFrickConfig(
      {},
      {
        env: {
          FRICK_PLATFORM_EVENTS_KAFKA_BROKERS: "redpanda:9092",
        },
        warn: () => {},
      },
    );
    expect(config.platformEventsDriver).toBe("kafka");
    expect(config.platformEventsKafkaBrokers).toEqual(["redpanda:9092"]);
  });

  it("enables OTel when an OTLP endpoint is configured", () => {
    const config = loadFrickConfig(
      {},
      {
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
          OTEL_SERVICE_NAME: "custom-service",
        },
        warn: () => {},
      },
    );
    expect(config.otelEnabled).toBe(true);
    expect(config.otelServiceName).toBe("custom-service");
    expect(config.otelExporterOtlpEndpoint).toBe("http://collector:4318");
  });

  it("enables OTel when signal-specific OTLP endpoints are configured", () => {
    const config = loadFrickConfig(
      {},
      {
        env: {
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector:4318/v1/traces",
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://collector:4318/v1/metrics",
        },
        warn: () => {},
      },
    );
    expect(config.otelEnabled).toBe(true);
    expect(config.otelExporterOtlpEndpoint).toBeUndefined();
    expect(config.otelExporterOtlpTracesEndpoint).toBe("http://collector:4318/v1/traces");
    expect(config.otelExporterOtlpMetricsEndpoint).toBe("http://collector:4318/v1/metrics");
  });

  it("reads env vars when no overrides are provided", () => {
    const config = loadFrickConfig(
      {},
      {
        env: {
          FRICK_ENV: "test",
          FRICK_DEMO_AUTH_ENABLED: "false",
          FRICK_SESSION_TTL_SECONDS: "60",
        },
        warn: () => {},
      },
    );
    expect(config.env).toBe("test");
    expect(config.demoAuthEnabled).toBe(false);
    expect(config.sessionTtlSeconds).toBe(60);
  });

  it("throws FrickConfigError when demoAuthEnabled is forced on in production", () => {
    expect(() =>
      loadFrickConfig(
        { env: "production", demoAuthEnabled: true, dbPath: "/var/lib/frick.sqlite" },
        { env: {}, warn: () => {} },
      ),
    ).toThrow(FrickConfigError);
  });

  it("throws FrickConfigError when dbPath is ':memory:' in production", () => {
    expect(() =>
      loadFrickConfig(
        { env: "production", dbPath: ":memory:" },
        { env: {}, warn: () => {} },
      ),
    ).toThrow(FrickConfigError);
  });

  it("throws FrickConfigError on unrecognized env values", () => {
    expect(() => loadFrickConfig({}, { env: { FRICK_ENV: "staging" }, warn: () => {} })).toThrow(
      FrickConfigError,
    );
  });

  it("throws FrickConfigError on invalid boolean values", () => {
    expect(() =>
      loadFrickConfig({}, { env: { FRICK_DEMO_AUTH_ENABLED: "maybe" }, warn: () => {} }),
    ).toThrow(FrickConfigError);
  });

  it("throws FrickConfigError on non-numeric session ttl", () => {
    expect(() =>
      loadFrickConfig({}, { env: { FRICK_SESSION_TTL_SECONDS: "forever" }, warn: () => {} }),
    ).toThrow(FrickConfigError);
  });

  it("throws FrickConfigError on out-of-range port", () => {
    expect(() =>
      loadFrickConfig({}, { env: { FRICK_PORT: "99999" }, warn: () => {} }),
    ).toThrow(FrickConfigError);
  });

  it("throws FrickConfigError on unrecognized log level", () => {
    expect(() =>
      loadFrickConfig({}, { env: { FRICK_LOG_LEVEL: "trace" }, warn: () => {} }),
    ).toThrow(FrickConfigError);
  });

  it("throws FrickConfigError on invalid platform events config", () => {
    expect(() =>
      loadFrickConfig({}, { env: { FRICK_PLATFORM_EVENTS_DRIVER: "redis" }, warn: () => {} }),
    ).toThrow(FrickConfigError);
    expect(() =>
      loadFrickConfig({}, { env: { FRICK_PLATFORM_EVENTS_RETENTION_MS: "0" }, warn: () => {} }),
    ).toThrow(FrickConfigError);
    expect(() =>
      loadFrickConfig({}, { env: { FRICK_PLATFORM_EVENTS_MAX_ROWS: "-1" }, warn: () => {} }),
    ).toThrow(FrickConfigError);
    expect(() =>
      loadFrickConfig({}, { env: { FRICK_OTEL_METRIC_EXPORT_INTERVAL_MS: "0" }, warn: () => {} }),
    ).toThrow(FrickConfigError);
  });
});

describe("loadFrickConfig storage driver", () => {
  it("defaults the db driver to sqlite", () => {
    const config = loadFrickConfig({}, { env: {}, warn: () => {} });
    expect(config.dbDriver).toBe("sqlite");
    expect(config.databaseUrl).toBeUndefined();
    expect(config.dbPath).toBe("./frick.sqlite");
  });

  it("accepts an explicit sqlite driver and keeps FRICK_DB_PATH working", () => {
    const config = loadFrickConfig(
      {},
      {
        env: { FRICK_DB_DRIVER: "sqlite", FRICK_DB_PATH: "/var/lib/frick.sqlite" },
        warn: () => {},
      },
    );
    expect(config.dbDriver).toBe("sqlite");
    expect(config.dbPath).toBe("/var/lib/frick.sqlite");
  });

  it("parses FRICK_DATABASE_URL into config for future postgres use", () => {
    const config = loadFrickConfig(
      {},
      {
        env: { FRICK_DATABASE_URL: "postgres://user:pass@localhost:5432/frick" },
        warn: () => {},
      },
    );
    // Driver stays sqlite; the URL is parsed but inert until FR-22.
    expect(config.dbDriver).toBe("sqlite");
    expect(config.databaseUrl).toBe("postgres://user:pass@localhost:5432/frick");
  });

  it("throws FrickConfigError on an invalid db driver value", () => {
    expect(() =>
      loadFrickConfig({}, { env: { FRICK_DB_DRIVER: "mysql" }, warn: () => {} }),
    ).toThrow(FrickConfigError);
  });

  it("rejects the postgres driver as not yet implemented (FR-22)", () => {
    expect(() =>
      loadFrickConfig({}, { env: { FRICK_DB_DRIVER: "postgres" }, warn: () => {} }),
    ).toThrow(/postgres storage driver is not yet implemented \(FR-22\)/);
  });

  it("rejects the postgres driver even via overrides", () => {
    expect(() => loadFrickConfig({ dbDriver: "postgres" }, { env: {}, warn: () => {} })).toThrow(
      FrickConfigError,
    );
  });

  it("still guards dbPath ':memory:' in production when the sqlite driver is selected", () => {
    expect(() =>
      loadFrickConfig(
        {},
        {
          env: { FRICK_ENV: "production", FRICK_DB_DRIVER: "sqlite", FRICK_DB_PATH: ":memory:" },
          warn: () => {},
        },
      ),
    ).toThrow(/dbPath ':memory:' is forbidden in production/);
  });
});
