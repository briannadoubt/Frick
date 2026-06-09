import { afterEach, describe, expect, it } from "vitest";
import { productTestSchema } from "@fricken/protocol";
import {
  FrickStore,
  listProjectionObjects,
  projectionSourceObjectTypes,
  singleChange,
  type FrickProjection,
  type FrickProjectionContext,
} from "../src/index.js";

// FR-134: projection-author ergonomics sugar over the FrickProjection API.

let store: FrickStore | undefined;

afterEach(async () => {
  store?.close();
  store = undefined;
});

describe("singleChange", () => {
  it("wraps a single keyed row into an apply result", async () => {
    expect(singleChange("counts", { open: 3 })).toEqual({
      changes: [{ key: "counts", value: { open: 3 } }],
    });
  });
});

describe("listProjectionObjects", () => {
  it("reads every object of a type in the context tenant, typed", async () => {
    store = new FrickStore({ path: ":memory:", seed: true, schema: productTestSchema });
    await store.upsertObject("_default", "Conversation", "c1", { kind: "group", title: "One", createdBy: "u" });
    await store.upsertObject("_default", "Conversation", "c2", { kind: "group", title: "Two", createdBy: "u" });
    // A different tenant's row must not leak in.
    await store.upsertObject("tenant-b", "Conversation", "c3", { kind: "group", title: "Other", createdBy: "u" });

    const ctx: FrickProjectionContext = {
      tenantId: "_default",
      store,
      logger: undefined as never,
    };
    const rows = await listProjectionObjects<{ id: string; title: string }>(ctx, "Conversation");
    expect(rows.map((r) => r.id).sort()).toEqual(["c1", "c2"]);
    expect(rows.map((r) => r.title).sort()).toEqual(["One", "Two"]);
  });

  it("honors ctx.appId so a per-app projection reads its OWN app, not _default (tenant-app-isolation-7)", async () => {
    store = new FrickStore({ path: ":memory:", seed: true, schema: productTestSchema });
    // Same tenant, same object type, but two distinct app partitions. Write
    // through the object store so we can target the app partition directly.
    await store.objects.upsert("_default", "Conversation", "default-1", { kind: "group", title: "Default", createdBy: "u" }, 0, "_default");
    await store.objects.upsert("_default", "Conversation", "appb-1", { kind: "group", title: "AppB", createdBy: "u" }, 0, "app-b");

    // A projection context originating from a write under app-b.
    const ctx: FrickProjectionContext = {
      tenantId: "_default",
      appId: "app-b",
      store,
      logger: undefined as never,
    };
    const rows = await listProjectionObjects<{ id: string }>(ctx, "Conversation");
    // Before the fix this read `_default` and returned `default-1`; the helper
    // must now read app-b's partition only.
    expect(rows.map((r) => r.id)).toEqual(["appb-1"]);
  });
});

describe("projectionSourceObjectTypes", () => {
  it("returns distinct object source types and ignores stream sources", async () => {
    const projections: FrickProjection[] = [
      {
        name: "p1",
        sources: [{ kind: "object", type: "WorkOrder" }],
        handler: { apply: () => ({ changes: [] }) },
      },
      {
        name: "p2",
        sources: [
          { kind: "object", type: "WorkOrder" },
          { kind: "object", type: "Invoice" },
          { kind: "stream", type: "AuditLog" },
        ],
        handler: { apply: () => ({ changes: [] }) },
      },
    ];
    expect(projectionSourceObjectTypes(projections).sort()).toEqual(["Invoice", "WorkOrder"]);
    expect(projectionSourceObjectTypes([])).toEqual([]);
  });
});
