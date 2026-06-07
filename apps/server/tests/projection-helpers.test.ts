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

afterEach(() => {
  store?.close();
  store = undefined;
});

describe("singleChange", () => {
  it("wraps a single keyed row into an apply result", () => {
    expect(singleChange("counts", { open: 3 })).toEqual({
      changes: [{ key: "counts", value: { open: 3 } }],
    });
  });
});

describe("listProjectionObjects", () => {
  it("reads every object of a type in the context tenant, typed", () => {
    store = new FrickStore({ path: ":memory:", seed: true, schema: productTestSchema });
    store.upsertObject("_default", "Conversation", "c1", { kind: "group", title: "One", createdBy: "u" });
    store.upsertObject("_default", "Conversation", "c2", { kind: "group", title: "Two", createdBy: "u" });
    // A different tenant's row must not leak in.
    store.upsertObject("tenant-b", "Conversation", "c3", { kind: "group", title: "Other", createdBy: "u" });

    const ctx: FrickProjectionContext = {
      tenantId: "_default",
      store,
      logger: undefined as never,
    };
    const rows = listProjectionObjects<{ id: string; title: string }>(ctx, "Conversation");
    expect(rows.map((r) => r.id).sort()).toEqual(["c1", "c2"]);
    expect(rows.map((r) => r.title).sort()).toEqual(["One", "Two"]);
  });
});

describe("projectionSourceObjectTypes", () => {
  it("returns distinct object source types and ignores stream sources", () => {
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
