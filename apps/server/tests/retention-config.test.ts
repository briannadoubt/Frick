import { describe, expect, it } from "vitest";

import { loadFrickConfig } from "../src/config.js";

/**
 * FR-68: the growth-prone retention windows (idempotency keys, DevTools events,
 * platform events, and the expired-session grace) are configurable from env /
 * overrides, and unset config reproduces today's defaults. These tests pin both
 * the defaults (backward-compatibility) and the env-driven plumbing.
 */
describe("FR-68 configurable retention policies", () => {
  it("preserves the historical defaults when nothing is configured", () => {
    const config = loadFrickConfig({}, { env: {}, warn: () => {} });
    expect(config.idempotencyKeyRetentionMs).toBe(24 * 60 * 60 * 1000);
    expect(config.devtoolsEventsRetentionMs).toBe(60 * 60 * 1000);
    expect(config.expiredSessionRetentionGraceMs).toBe(0);
    // Pre-existing config-driven windows are unchanged.
    expect(config.platformEventsRetentionMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("reads each retention window from its environment variable", () => {
    const config = loadFrickConfig(
      {},
      {
        env: {
          FRICK_IDEMPOTENCY_KEY_RETENTION_MS: "3600000",
          FRICK_DEVTOOLS_EVENTS_RETENTION_MS: "1800000",
          FRICK_EXPIRED_SESSION_RETENTION_GRACE_MS: "900000",
        },
        warn: () => {},
      },
    );
    expect(config.idempotencyKeyRetentionMs).toBe(3_600_000);
    expect(config.devtoolsEventsRetentionMs).toBe(1_800_000);
    expect(config.expiredSessionRetentionGraceMs).toBe(900_000);
  });

  it("lets explicit overrides win over the environment", () => {
    const config = loadFrickConfig(
      {
        idempotencyKeyRetentionMs: 111,
        devtoolsEventsRetentionMs: 222,
        expiredSessionRetentionGraceMs: 333,
      },
      {
        env: {
          FRICK_IDEMPOTENCY_KEY_RETENTION_MS: "999999",
          FRICK_DEVTOOLS_EVENTS_RETENTION_MS: "999999",
          FRICK_EXPIRED_SESSION_RETENTION_GRACE_MS: "999999",
        },
        warn: () => {},
      },
    );
    expect(config.idempotencyKeyRetentionMs).toBe(111);
    expect(config.devtoolsEventsRetentionMs).toBe(222);
    expect(config.expiredSessionRetentionGraceMs).toBe(333);
  });

  it("allows a zero expired-session grace but rejects a negative one", () => {
    const zero = loadFrickConfig(
      { env: "test" },
      { env: { FRICK_EXPIRED_SESSION_RETENTION_GRACE_MS: "0" }, warn: () => {} },
    );
    expect(zero.expiredSessionRetentionGraceMs).toBe(0);

    expect(() =>
      loadFrickConfig(
        {},
        { env: { FRICK_EXPIRED_SESSION_RETENTION_GRACE_MS: "-1" }, warn: () => {} },
      ),
    ).toThrow(/non-negative integer/);
  });

  it("rejects non-positive idempotency / devtools retention windows", () => {
    expect(() =>
      loadFrickConfig(
        {},
        { env: { FRICK_IDEMPOTENCY_KEY_RETENTION_MS: "0" }, warn: () => {} },
      ),
    ).toThrow(/positive integer/);
    expect(() =>
      loadFrickConfig(
        {},
        { env: { FRICK_DEVTOOLS_EVENTS_RETENTION_MS: "-5" }, warn: () => {} },
      ),
    ).toThrow(/positive integer/);
  });
});
