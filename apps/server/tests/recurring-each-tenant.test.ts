import { afterEach, describe, expect, it } from "vitest";
import { productTestSchema } from "@fricken/protocol";
import { FrickStore, eachTenant } from "../src/index.js";

// FR-132: per-tenant recurring-job fan-out. `eachTenant(...)` builds a
// `resolveTargets` that enumerates the tenant ledger so a recurring job runs
// once per tenant; the app supplies only an optional predicate / payload.

let store: FrickStore | undefined;

afterEach(async () => {
  store?.close();
  store = undefined;
});

function makeStore(): FrickStore {
  return new FrickStore({ path: ":memory:", seed: true, schema: productTestSchema });
}

const ctx = (s: FrickStore) => ({ store: s, logger: undefined as never });

describe("eachTenant", () => {
  it("yields one target per live tenant by default", async () => {
    store = makeStore();
    await store.tenants.ensure("tenant-a");
    await store.tenants.ensure("tenant-b");

    const targets = [...(await eachTenant()(ctx(store)))];
    const ids = targets.map((t) => t.tenantId);
    expect(ids).toContain("tenant-a");
    expect(ids).toContain("tenant-b");
    // No payload by default.
    expect(targets.every((t) => t.payload === undefined)).toBe(true);
  });

  it("excludes archived tenants unless includeArchived is set", async () => {
    store = makeStore();
    await store.tenants.create("tenant-live");
    await store.tenants.create("tenant-archived");
    await store.tenants.archive("tenant-archived");

    const live = [...(await eachTenant()(ctx(store)))].map((t) => t.tenantId);
    expect(live).toContain("tenant-live");
    expect(live).not.toContain("tenant-archived");

    const all = [...(await eachTenant({ includeArchived: true })(ctx(store)))].map((t) => t.tenantId);
    expect(all).toContain("tenant-archived");
  });

  it("applies the predicate filter", async () => {
    store = makeStore();
    await store.tenants.ensure("keep-1");
    await store.tenants.ensure("drop-1");
    await store.tenants.ensure("keep-2");

    const ids = [...(await eachTenant({ filter: (t) => t.tenantId.startsWith("keep") })(ctx(store)))].map(
      (t) => t.tenantId,
    );
    expect(ids.sort()).toEqual(["keep-1", "keep-2"]);
  });

  it("builds a per-tenant payload", async () => {
    store = makeStore();
    await store.tenants.ensure("tenant-a");

    const targets = [
      ...(await eachTenant({
        filter: (t) => t.tenantId === "tenant-a",
        payload: (t) => ({ scope: t.tenantId }),
      })(ctx(store))),
    ];
    expect(targets).toEqual([{ tenantId: "tenant-a", payload: { scope: "tenant-a" } }]);
  });
});
