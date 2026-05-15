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
      dbPath: "./frick.sqlite",
      blobStoragePath: "./frick-blobs/",
      logLevel: "info",
      inspectionEnabled: true,
      adminToken: undefined,
      adminEnabled: false,
      implicitTenantCreation: true,
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
          FRICK_DB_PATH: "/tmp/frick.sqlite",
          FRICK_BLOB_STORAGE_PATH: "/tmp/frick-blobs",
          FRICK_LOG_LEVEL: "debug",
        },
        warn: () => {},
      },
    );
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(5000);
    expect(config.publicUrl).toBe("https://frick.example.com");
    expect(config.allowedOrigins).toEqual(["https://a.example", "https://b.example"]);
    expect(config.dbPath).toBe("/tmp/frick.sqlite");
    expect(config.blobStoragePath).toBe("/tmp/frick-blobs");
    expect(config.logLevel).toBe("debug");
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
});
