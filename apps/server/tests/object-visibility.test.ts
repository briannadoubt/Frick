import { describe, expect, it } from "vitest";
import { FrickStore } from "../src/store.js";

describe("FrickStore.isObjectVisibleToUser — MessageDraft", () => {
  // The MessageDraft schema uses the `${userId}:${conversationId}` id
  // convention shared across all SDKs. Visibility must be the source
  // of truth, not the id: a client that subscribes to all of
  // MessageDraft must never see another user's row, even if it
  // somehow learns the id.
  it("hides a MessageDraft from any user other than its owner", () => {
    const store = new FrickStore({ path: ":memory:" });
    try {
      const draft = {
        id: "user-ada:conv-1",
        userId: "user-ada",
        conversationId: "conv-1",
        body: "in progress",
        updatedAt: 1_700_000_000_000,
      };
      expect(store.isObjectVisibleToUser("_default", "MessageDraft", draft, "user-ada")).toBe(true);
      expect(store.isObjectVisibleToUser("_default", "MessageDraft", draft, "user-grace")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("excludes other users' drafts from listObjectsForUser", () => {
    const store = new FrickStore({ path: ":memory:" });
    try {
      store.upsertObject("_default", "MessageDraft", "user-ada:conv-1", {
        userId: "user-ada",
        conversationId: "conv-1",
        body: "ada typing",
        updatedAt: 1_700_000_000_000,
      });
      store.upsertObject("_default", "MessageDraft", "user-grace:conv-1", {
        userId: "user-grace",
        conversationId: "conv-1",
        body: "grace typing",
        updatedAt: 1_700_000_000_001,
      });

      const adaVisible = store.listObjectsForUser("_default", "MessageDraft", "user-ada");
      expect(adaVisible.map((row) => row.userId)).toEqual(["user-ada"]);
      const graceVisible = store.listObjectsForUser("_default", "MessageDraft", "user-grace");
      expect(graceVisible.map((row) => row.userId)).toEqual(["user-grace"]);
    } finally {
      store.close();
    }
  });
});
