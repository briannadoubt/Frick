import { describe, expect, it } from "vitest";
import { productTestSchema } from "@fricken/protocol";
import { FrickStore } from "../src/store.js";

describe("FrickStore.isObjectVisibleToUser — framework default", () => {
  // After the framework boundary cleanup, the built-in visibility check is
  // intentionally a no-op (always returns true). Apps own the policy via
  // registered policy hooks; the framework only exposes the primitive +
  // listObjectsForUser pipe so app-owned visibility can plug in.
  //
  // These tests pin that "deferred to app" contract so a future refactor
  // that re-adds opinionated behavior to the framework primitive shows up
  // as a deliberate failure.
  it("returns true for any (object, viewer) by default", async () => {
    const store = new FrickStore({ path: ":memory:", schema: productTestSchema });
    try {
      const draft = {
        id: "user-ada:conv-1",
        userId: "user-ada",
        conversationId: "conv-1",
        body: "in progress",
        updatedAt: 1_700_000_000_000,
      };
      expect(store.isObjectVisibleToUser("_default", "MessageDraft", draft, "user-ada")).toBe(true);
      // Default framework no longer filters by ownership; that policy is
      // app-owned now.
      expect(store.isObjectVisibleToUser("_default", "MessageDraft", draft, "user-grace")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("listObjectsForUser returns every row by default (app policy filters)", async () => {
    const store = new FrickStore({ path: ":memory:", schema: productTestSchema });
    try {
      await store.upsertObject("_default", "MessageDraft", "user-ada:conv-1", {
        userId: "user-ada",
        conversationId: "conv-1",
        body: "ada typing",
        updatedAt: 1_700_000_000_000,
      });
      await store.upsertObject("_default", "MessageDraft", "user-grace:conv-1", {
        userId: "user-grace",
        conversationId: "conv-1",
        body: "grace typing",
        updatedAt: 1_700_000_000_001,
      });

      const adaVisible = await store.listObjectsForUser("_default", "MessageDraft", "user-ada");
      // Both rows are visible by default; apps wire ownership filtering in
      // through a policy hook over the `object.read` action.
      expect(adaVisible.map((row) => row.userId).sort()).toEqual(["user-ada", "user-grace"]);
    } finally {
      store.close();
    }
  });
});
