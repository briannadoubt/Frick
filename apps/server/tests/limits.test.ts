import { describe, expect, it } from "vitest";
import {
  DEFAULT_FRICK_LIMITS,
  FrickLimitError,
  clampTtlSeconds,
  mergeLimits,
} from "../src/limits.js";

describe("FrickLimits", () => {
  it("returns a copy of defaults when no overrides are supplied", () => {
    const limits = mergeLimits();
    expect(limits).toEqual(DEFAULT_FRICK_LIMITS);
    expect(limits).not.toBe(DEFAULT_FRICK_LIMITS);
  });

  it("exposes the expected set of limit keys with numeric values", () => {
    const expectedKeys: ReadonlyArray<keyof typeof DEFAULT_FRICK_LIMITS> = [
      "maxHttpBodyBytes",
      "maxStreamAppendPayloadBytes",
      "maxBlobBytes",
      "maxSubscriptionsPerConnection",
      "maxStreamPageSize",
      "maxPendingAppendsPerClient",
      "maxWebSocketFrameBytes",
      "presenceTtlMinSeconds",
      "presenceTtlMaxSeconds",
      "signalTtlMinSeconds",
      "signalTtlMaxSeconds",
      "heartbeatIntervalSeconds",
      "heartbeatTimeoutSeconds",
    ];
    expect(Object.keys(DEFAULT_FRICK_LIMITS).sort()).toEqual([...expectedKeys].sort());
    for (const key of expectedKeys) {
      expect(typeof DEFAULT_FRICK_LIMITS[key]).toBe("number");
    }
    expect(DEFAULT_FRICK_LIMITS.maxWebSocketFrameBytes).toBe(524_288);
  });

  it("merges partial overrides on top of defaults", () => {
    const limits = mergeLimits({ maxHttpBodyBytes: 100, presenceTtlMaxSeconds: 30 });
    expect(limits.maxHttpBodyBytes).toBe(100);
    expect(limits.presenceTtlMaxSeconds).toBe(30);
    expect(limits.maxSubscriptionsPerConnection).toBe(DEFAULT_FRICK_LIMITS.maxSubscriptionsPerConnection);
  });

  it("clamps TTL into [min, max]", () => {
    expect(clampTtlSeconds(5, 1, 10)).toBe(5);
    expect(clampTtlSeconds(0, 1, 10)).toBe(1);
    expect(clampTtlSeconds(999_999, 1, 10)).toBe(10);
  });

  it("calls the clamp logger only when clamping happens", () => {
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

  it("carries limit metadata on FrickLimitError", () => {
    const err = new FrickLimitError({ limit: "maxBlobBytes", actualValue: 99, configuredMax: 10 });
    expect(err.limit).toBe("maxBlobBytes");
    expect(err.actualValue).toBe(99);
    expect(err.configuredMax).toBe(10);
    expect(err.message).toContain("maxBlobBytes");
  });
});
