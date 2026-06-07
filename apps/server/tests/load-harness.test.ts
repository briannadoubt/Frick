import { describe, expect, it } from "vitest";
import { runLoad, parseLoadConfig, summarizeLatency } from "../../../bench/src/index.js";

// FR-96 — load harness. These tests run a TINY load config end-to-end against
// an in-process server and assert the JSON RESULT SHAPE only. They are NOT a
// real load test: a few users, a couple of ops each, kept fast. Correctness of
// the underlying writes is covered by the regular suites.

describe("FR-96 load harness", () => {
  it("runs a tiny load end-to-end and emits a well-formed JSON result", async () => {
    const result = await runLoad({
      users: 2,
      appendsPerUser: 3,
      objectWritesPerUser: 2,
      seed: 7,
    });

    expect(result.schemaVersion).toBe(1);
    expect(result.tool).toBe("frick-load-harness");
    expect(typeof result.startedAt).toBe("string");
    expect(result.env.inProcessServer).toBe(true);
    expect(typeof result.totalDurationMs).toBe("number");

    // Config echoes the merged values.
    expect(result.config.users).toBe(2);
    expect(result.config.appendsPerUser).toBe(3);
    expect(result.config.objectWritesPerUser).toBe(2);
    expect(result.config.seed).toBe(7);
    expect(result.config.subscribe).toBe(true);

    // Counts line up with the requested workload, no errors.
    expect(result.totals).toEqual({
      users: 2,
      connections: 2,
      objectUpserts: 4, // 2 users * 2 writes
      streamAppends: 6, // 2 users * 3 appends
      errors: 0,
    });
    expect(result.operations.connect.count).toBe(2);
    expect(result.operations.objectUpsert.count).toBe(4);
    expect(result.operations.streamAppend.count).toBe(6);

    // Latency summary shape: every op exposes the percentile fields.
    for (const op of [
      result.operations.connect,
      result.operations.objectUpsert,
      result.operations.streamAppend,
    ]) {
      expect(op).toMatchObject({
        count: expect.any(Number),
        errors: 0,
        throughputPerSec: expect.any(Number),
        latencyMs: {
          count: expect.any(Number),
          min: expect.any(Number),
          max: expect.any(Number),
          mean: expect.any(Number),
          p50: expect.any(Number),
          p90: expect.any(Number),
          p99: expect.any(Number),
        },
      });
    }

    // Result must round-trip through JSON without loss (CI consumes stdout).
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("supports a no-subscribe config", async () => {
    const result = await runLoad({
      users: 1,
      appendsPerUser: 1,
      objectWritesPerUser: 1,
      subscribe: false,
    });
    expect(result.config.subscribe).toBe(false);
    expect(result.totals.errors).toBe(0);
    expect(result.totals.connections).toBe(1);
  });

  it("parseLoadConfig layers flags over env over defaults", () => {
    const config = parseLoadConfig(
      ["--users", "50", "--no-subscribe", "--seed=9"],
      { FRICK_LOAD_APPENDS_PER_USER: "12", FRICK_LOAD_SEED: "1" },
    );
    expect(config.users).toBe(50);
    expect(config.appendsPerUser).toBe(12); // from env
    expect(config.seed).toBe(9); // flag wins over env
    expect(config.subscribe).toBe(false);
    expect(config.target).toBeUndefined();
  });

  it("parseLoadConfig requires both http-url and ws-url to target a server", () => {
    expect(() => parseLoadConfig(["--http-url", "http://x"], {})).toThrow(/both --http-url and --ws-url/);
    const targeted = parseLoadConfig(
      ["--http-url", "http://h", "--ws-url", "ws://w"],
      {},
    );
    expect(targeted.target).toEqual({ httpUrl: "http://h", wsUrl: "ws://w" });
  });

  it("summarizeLatency handles an empty sample set", () => {
    expect(summarizeLatency([])).toEqual({
      count: 0,
      min: 0,
      max: 0,
      mean: 0,
      p50: 0,
      p90: 0,
      p99: 0,
    });
  });
});
