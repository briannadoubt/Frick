import { afterEach, describe, expect, it } from "vitest";
import { productTestSchema } from "@fricken/protocol";
import { FrickStore, eachTenant } from "../src/index.js";

// FR-132: per-tenant recurring-job fan-out. `eachTenant(...)` builds a
// `resolveTargets` that enumerates the tenant ledger so a recurring job runs
// once per tenant; the app supplies only an optional predicate / payload.

let store: FrickStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

function makeStore(): FrickStore {
  return new FrickStore({ path: ":memory:", seed: true, schema: productTestSchema });
}

const ctx = (s: FrickStore) => ({ store: s, logger: undefined as never });

describe("eachTenant", () => {
  it("yields one target per live tenant by default", () => {
    store = makeStore();
    store.tenants.ensure("tenant-a");
    store.tenants.ensure("tenant-b");

    const targets = [...eachTenant()(ctx(store))];
    const ids = targets.map((t) => t.tenantId);
    expect(ids).toContain("tenant-a");
    expect(ids).toContain("tenant-b");
    // No payload by default.
    expect(targets.every((t) => t.payload === undefined)).toBe(true);
  });

  it("excludes archived tenants unless includeArchived is set", () => {
    store = makeStore();
    store.tenants.create("tenant-live");
    store.tenants.create("tenant-archived");
    store.tenants.archive("tenant-archived");

    const live = [...eachTenant()(ctx(store))].map((t) => t.tenantId);
    expect(live).toContain("tenant-live");
    expect(live).not.toContain("tenant-archived");

    const all = [...eachTenant({ includeArchived: true })(ctx(store))].map((t) => t.tenantId);
    expect(all).toContain("tenant-archived");
  });

  it("applies the predicate filter", () => {
    store = makeStore();
    store.tenants.ensure("keep-1");
    store.tenants.ensure("drop-1");
    store.tenants.ensure("keep-2");

    const ids = [...eachTenant({ filter: (t) => t.tenantId.startsWith("keep") })(ctx(store))].map(
      (t) => t.tenantId,
    );
    expect(ids.sort()).toEqual(["keep-1", "keep-2"]);
  });

  it("builds a per-tenant payload", () => {
    store = makeStore();
    store.tenants.ensure("tenant-a");

    const targets = [
      ...eachTenant({
        filter: (t) => t.tenantId === "tenant-a",
        payload: (t) => ({ scope: t.tenantId }),
      })(ctx(store)),
    ];
    expect(targets).toEqual([{ tenantId: "tenant-a", payload: { scope: "tenant-a" } }]);
  });
});
