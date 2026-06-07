import { describe, expect, it } from "vitest";
import {
  DEFAULT_FRICK_LIMITS,
  FrickLimitError,
  clampTtlSeconds,
  limitsFromEnv,
  mergeLimits,
} from "../src/limits.js";
import { FrickConfigError } from "../src/config.js";

describe("FrickLimits", () => {
  it("returns a copy of defaults when no overrides are supplied", async () => {
    const limits = mergeLimits();
    expect(limits).toEqual(DEFAULT_FRICK_LIMITS);
    expect(limits).not.toBe(DEFAULT_FRICK_LIMITS);
  });

  it("exposes the expected set of limit keys with numeric values", async () => {
    const numericKeys: ReadonlyArray<keyof typeof DEFAULT_FRICK_LIMITS> = [
      "maxHttpBodyBytes",
      "maxStreamAppendPayloadBytes",
      "maxBlobBytes",
      "maxBlobBytesPerPrincipal",
      "maxSubscriptionsPerConnection",
      "maxStreamPageSize",
      "maxSearchQueryBytes",
      "maxSearchFilterFields",
      "maxSearchFilterKeyBytes",
      "maxSearchFilterValueBytes",
      "maxPendingAppendsPerClient",
      "maxWebSocketFrameBytes",
      "maxWebSocketConnections",
      "maxConnectionsPerPrincipal",
      "maxWebSocketOutboundBufferedBytes",
      "maxSseConnections",
      "maxSseOutboundBufferedBytes",
      "maxAuthAttemptsPerWindow",
      "authRateLimitWindowMs",
      "presenceTtlMinSeconds",
      "presenceTtlMaxSeconds",
      "signalTtlMinSeconds",
      "signalTtlMaxSeconds",
      "heartbeatIntervalSeconds",
      "heartbeatTimeoutSeconds",
    ];
    // FR-32: opt-in server-side device binding is a boolean toggle, not a
    // numeric limit, so it is asserted separately below.
    const booleanKeys: ReadonlyArray<keyof typeof DEFAULT_FRICK_LIMITS> = ["bindSessionDevice"];
    expect(Object.keys(DEFAULT_FRICK_LIMITS).sort()).toEqual(
      [...numericKeys, ...booleanKeys].sort(),
    );
    for (const key of numericKeys) {
      expect(typeof DEFAULT_FRICK_LIMITS[key]).toBe("number");
    }
    for (const key of booleanKeys) {
      expect(typeof DEFAULT_FRICK_LIMITS[key]).toBe("boolean");
    }
    expect(DEFAULT_FRICK_LIMITS.maxWebSocketFrameBytes).toBe(524_288);
    // Device binding ships OFF by default to preserve client compatibility.
    expect(DEFAULT_FRICK_LIMITS.bindSessionDevice).toBe(false);
  });

  it("merges partial overrides on top of defaults", async () => {
    const limits = mergeLimits({ maxHttpBodyBytes: 100, presenceTtlMaxSeconds: 30 });
    expect(limits.maxHttpBodyBytes).toBe(100);
    expect(limits.presenceTtlMaxSeconds).toBe(30);
    expect(limits.maxSubscriptionsPerConnection).toBe(DEFAULT_FRICK_LIMITS.maxSubscriptionsPerConnection);
  });

  it("clamps TTL into [min, max]", async () => {
    expect(clampTtlSeconds(5, 1, 10)).toBe(5);
    expect(clampTtlSeconds(0, 1, 10)).toBe(1);
    expect(clampTtlSeconds(999_999, 1, 10)).toBe(10);
  });

  it("calls the clamp logger only when clamping happens", async () => {
    let calls = 0;
    clampTtlSeconds(5, 1, 10, () => {
      calls += 1;
    });
    expect(calls).toBe(0);
    clampTtlSeconds(0, 1, 10, () => {
      calls += 1;
    });
    expect(calls).toBe(1);
  });

  it("applies the default per-principal connection cap when unset", async () => {
    expect(DEFAULT_FRICK_LIMITS.maxConnectionsPerPrincipal).toBe(64);
    expect(mergeLimits().maxConnectionsPerPrincipal).toBe(64);
    expect(mergeLimits({ maxHttpBodyBytes: 1 }).maxConnectionsPerPrincipal).toBe(64);
  });

  it("reads the per-principal connection cap from the environment", async () => {
    expect(limitsFromEnv({})).toEqual({});
    expect(limitsFromEnv({ FRICK_MAX_CONNECTIONS_PER_PRINCIPAL: "10" })).toEqual({
      maxConnectionsPerPrincipal: 10,
    });
  });

  it("defaults the per-principal blob quota to effectively unlimited", async () => {
    expect(DEFAULT_FRICK_LIMITS.maxBlobBytesPerPrincipal).toBe(Number.MAX_SAFE_INTEGER);
    expect(mergeLimits().maxBlobBytesPerPrincipal).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("reads the per-principal blob quota from the environment", async () => {
    expect(limitsFromEnv({ FRICK_MAX_BLOB_BYTES_PER_PRINCIPAL: "3000" })).toEqual({
      maxBlobBytesPerPrincipal: 3000,
    });
  });

  it("rejects a non-positive-integer per-principal blob quota env value", async () => {
    expect(() => limitsFromEnv({ FRICK_MAX_BLOB_BYTES_PER_PRINCIPAL: "0" })).toThrow(FrickConfigError);
    expect(() => limitsFromEnv({ FRICK_MAX_BLOB_BYTES_PER_PRINCIPAL: "-5" })).toThrow(FrickConfigError);
    expect(() => limitsFromEnv({ FRICK_MAX_BLOB_BYTES_PER_PRINCIPAL: "x" })).toThrow(FrickConfigError);
  });

  it("rejects a non-positive-integer per-principal connection cap env value", async () => {
    expect(() => limitsFromEnv({ FRICK_MAX_CONNECTIONS_PER_PRINCIPAL: "0" })).toThrow(FrickConfigError);
    expect(() => limitsFromEnv({ FRICK_MAX_CONNECTIONS_PER_PRINCIPAL: "-3" })).toThrow(FrickConfigError);
    expect(() => limitsFromEnv({ FRICK_MAX_CONNECTIONS_PER_PRINCIPAL: "abc" })).toThrow(FrickConfigError);
  });

  it("reads the opt-in device-binding toggle from the environment (FR-32)", async () => {
    // Unset → omitted, so the default (false) applies.
    expect(limitsFromEnv({})).toEqual({});
    expect(limitsFromEnv({ FRICK_BIND_SESSION_DEVICE: "" })).toEqual({});
    for (const truthy of ["true", "1", "yes", "TRUE"]) {
      expect(limitsFromEnv({ FRICK_BIND_SESSION_DEVICE: truthy })).toEqual({ bindSessionDevice: true });
    }
    for (const falsy of ["false", "0", "no", "FALSE"]) {
      expect(limitsFromEnv({ FRICK_BIND_SESSION_DEVICE: falsy })).toEqual({ bindSessionDevice: false });
    }
  });

  it("rejects a non-boolean device-binding env value (FR-32)", async () => {
    expect(() => limitsFromEnv({ FRICK_BIND_SESSION_DEVICE: "maybe" })).toThrow(FrickConfigError);
    expect(() => limitsFromEnv({ FRICK_BIND_SESSION_DEVICE: "2" })).toThrow(FrickConfigError);
  });

  it("carries limit metadata on FrickLimitError", async () => {
    const err = new FrickLimitError({ limit: "maxBlobBytes", actualValue: 99, configuredMax: 10 });
    expect(err.limit).toBe("maxBlobBytes");
    expect(err.actualValue).toBe(99);
    expect(err.configuredMax).toBe(10);
    expect(err.message).toContain("maxBlobBytes");
  });
});
