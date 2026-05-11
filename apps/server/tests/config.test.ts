import { describe, expect, it } from "vitest";
import { FrickConfigError, loadFrickConfig } from "../src/config.js";

describe("loadFrickConfig", () => {
  it("defaults to development with demo auth enabled and a 7-day session ttl", () => {
    const config = loadFrickConfig({}, { env: {}, warn: () => {} });
    expect(config).toEqual({
      env: "development",
      demoAuthEnabled: true,
      sessionTtlSeconds: 7 * 24 * 60 * 60,
    });
  });

  it("disables demo auth by default in production", () => {
    const config = loadFrickConfig({}, { env: { FRICK_ENV: "production" }, warn: () => {} });
    expect(config.env).toBe("production");
    expect(config.demoAuthEnabled).toBe(false);
  });

  it("reads overrides for env, demoAuthEnabled, and session ttl", () => {
    const config = loadFrickConfig(
      { env: "test", demoAuthEnabled: false, sessionTtlSeconds: 30 },
      { env: {}, warn: () => {} },
    );
    expect(config).toEqual({ env: "test", demoAuthEnabled: false, sessionTtlSeconds: 30 });
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
    expect(config).toEqual({ env: "test", demoAuthEnabled: false, sessionTtlSeconds: 60 });
  });

  it("logs a warning when demoAuthEnabled is forced on in production", () => {
    const warnings: string[] = [];
    const config = loadFrickConfig(
      { env: "production", demoAuthEnabled: true },
      { env: {}, warn: (line) => warnings.push(line) },
    );
    expect(config.demoAuthEnabled).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[frick.config]");
    expect(warnings[0]).toContain("demoAuthEnabled=true in production");
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
});
