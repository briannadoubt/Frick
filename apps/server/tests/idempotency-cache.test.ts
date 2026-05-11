import { describe, expect, it } from "vitest";
import { BoundedIdempotencyCache } from "../src/storage/idempotency-cache.js";

describe("BoundedIdempotencyCache", () => {
  it("rejects non-positive capacity", () => {
    expect(() => new BoundedIdempotencyCache<string>(0)).toThrow();
    expect(() => new BoundedIdempotencyCache<string>(-1)).toThrow();
    expect(() => new BoundedIdempotencyCache<string>(Number.NaN)).toThrow();
  });

  it("stores entries under capacity without evicting", () => {
    const cache = new BoundedIdempotencyCache<number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.size).toBe(3);
    expect(cache.evictions).toBe(0);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("evicts least-recently-used keys in order when over capacity", () => {
    const cache = new BoundedIdempotencyCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // evicts "a"
    expect(cache.size).toBe(2);
    expect(cache.evictions).toBe(1);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("updates recency on get so oldest becomes newest after access", () => {
    const cache = new BoundedIdempotencyCache<number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    // Access "a" — it should now be most-recent.
    expect(cache.get("a")).toBe(1);
    cache.set("d", 4); // should evict "b" (now LRU), not "a"
    expect(cache.evictions).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  it("re-setting an existing key updates value and moves it to most-recent", () => {
    const cache = new BoundedIdempotencyCache<number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("a", 11); // update value, move to most-recent
    expect(cache.get("a")).toBe(11);
    cache.set("d", 4); // evicts "b" (now LRU)
    expect(cache.evictions).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(11);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  it("increments evictions counter on each eviction", () => {
    const cache = new BoundedIdempotencyCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.evictions).toBe(0);
    cache.set("c", 3);
    expect(cache.evictions).toBe(1);
    cache.set("d", 4);
    expect(cache.evictions).toBe(2);
    cache.set("e", 5);
    expect(cache.evictions).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("get on missing key returns undefined without affecting state", () => {
    const cache = new BoundedIdempotencyCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("missing")).toBeUndefined();
    expect(cache.size).toBe(2);
    expect(cache.evictions).toBe(0);
  });
});
