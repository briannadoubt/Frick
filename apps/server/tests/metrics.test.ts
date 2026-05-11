import { describe, expect, it } from "vitest";
import { NegativeCounterIncrementError, createInMemoryMetrics } from "../src/metrics.js";

describe("in-memory metrics registry", () => {
  it("counter inc defaults to +1 and accepts arbitrary positive numbers", () => {
    const metrics = createInMemoryMetrics();
    const c = metrics.counter("frick.test.counter");
    c.inc();
    c.inc(3);
    c.inc(0);
    expect(c.value).toBe(4);
  });

  it("counter rejects negative increments with a typed error", () => {
    const metrics = createInMemoryMetrics();
    const c = metrics.counter("frick.test.counter");
    expect(() => c.inc(-1)).toThrow(NegativeCounterIncrementError);
  });

  it("gauge set replaces the current value", () => {
    const metrics = createInMemoryMetrics();
    const g = metrics.gauge("frick.test.gauge");
    g.set(5);
    expect(g.value).toBe(5);
    g.set(2);
    expect(g.value).toBe(2);
    g.set(0);
    expect(g.value).toBe(0);
  });

  it("same name+fields returns the same counter handle regardless of field order", () => {
    const metrics = createInMemoryMetrics();
    const a = metrics.counter("frick.http.requests.total", { method: "GET", status: "200" });
    const b = metrics.counter("frick.http.requests.total", { status: "200", method: "GET" });
    a.inc();
    b.inc();
    expect(a).toBe(b);
    expect(a.value).toBe(2);
  });

  it("different field values yield different handles", () => {
    const metrics = createInMemoryMetrics();
    const a = metrics.counter("frick.http.requests.total", { method: "GET" });
    const b = metrics.counter("frick.http.requests.total", { method: "POST" });
    a.inc(5);
    b.inc(2);
    expect(a).not.toBe(b);
    expect(a.value).toBe(5);
    expect(b.value).toBe(2);
  });

  it("snapshot returns entries sorted by name then by stringified fields, stably across calls", () => {
    const metrics = createInMemoryMetrics();
    metrics.counter("frick.b.total", { x: "2" }).inc();
    metrics.counter("frick.a.total", { x: "1" }).inc(2);
    metrics.counter("frick.a.total", { x: "0" }).inc(7);
    metrics.gauge("frick.b.current").set(11);
    metrics.gauge("frick.a.current").set(3);

    const first = metrics.snapshot();
    const second = metrics.snapshot();
    expect(first).toEqual(second);

    expect(first.counters.map((c) => c.name)).toEqual([
      "frick.a.total",
      "frick.a.total",
      "frick.b.total",
    ]);
    expect(first.counters[0]!.fields).toEqual({ x: "0" });
    expect(first.counters[1]!.fields).toEqual({ x: "1" });
    expect(first.gauges.map((g) => g.name)).toEqual(["frick.a.current", "frick.b.current"]);
  });

  it("snapshot omits fields key when the counter has no fields", () => {
    const metrics = createInMemoryMetrics();
    metrics.counter("frick.plain").inc();
    const snap = metrics.snapshot();
    expect(snap.counters[0]).toEqual({ name: "frick.plain", value: 1 });
  });
});
