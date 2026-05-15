/**
 * Unit tests for the synced-draft helpers. The hook itself isn't tested
 * through a React renderer (the package's other test suites also avoid
 * pulling in `@testing-library/react` to keep deps slim); we exercise
 * the public id convention and the conflict-aware write helper that the
 * hook delegates to.
 */
import { describe, expect, test, vi } from "vitest";
import { FrickObjectConflictError } from "@frick/core";
import type { FrickErrorEnvelope } from "@frick/protocol";
import { clearLocalDraftsForUser, draftId, upsertDraftWithLwwRetry, useDraft } from "./draft.js";

class MemoryStorage {
  readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("draftId", () => {
  test("composes a stable `${userId}:${conversationId}` key per the cross-SDK convention", () => {
    expect(draftId("user-ada", "convo-1")).toBe("user-ada:convo-1");
  });

  test("does not collapse separators in odd ids — drafts stay per-user-per-convo", () => {
    expect(draftId("a:b", "c")).toBe("a:b:c");
  });
});

describe("useDraft", () => {
  test("exports the hook as a function", () => {
    expect(typeof useDraft).toBe("function");
  });
});

describe("clearLocalDraftsForUser", () => {
  test("removes only local draft keys for the selected user", () => {
    const storage = new MemoryStorage();
    storage.setItem("frick.draft.user-ada.convo-1", "draft one");
    storage.setItem("frick.draft.user-ada.convo-2", "draft two");
    storage.setItem("frick.draft.user-grace.convo-1", "keep");
    storage.setItem("other", "keep");

    clearLocalDraftsForUser("user-ada", storage);

    expect(storage.getItem("frick.draft.user-ada.convo-1")).toBeNull();
    expect(storage.getItem("frick.draft.user-ada.convo-2")).toBeNull();
    expect(storage.getItem("frick.draft.user-grace.convo-1")).toBe("keep");
    expect(storage.getItem("other")).toBe("keep");
  });
});

describe("upsertDraftWithLwwRetry", () => {
  function makeRow(body: string) {
    return {
      userId: "user-ada",
      conversationId: "convo-1",
      body,
      updatedAt: 1_700_000_000_000,
    };
  }

  function conflictEnvelope(): FrickErrorEnvelope {
    return {
      code: "storage.conflict",
      message: "version mismatch",
      requestId: "req-1",
      retryable: false,
    };
  }

  test("passes through to client.upsertObject when there's no conflict", async () => {
    const upsertObject = vi.fn().mockResolvedValue({ version: 3 });
    const client = { upsertObject };
    const result = await upsertDraftWithLwwRetry(client, "user-ada:convo-1", makeRow("hi"), 2);

    expect(result).toEqual({ version: 3 });
    expect(upsertObject).toHaveBeenCalledTimes(1);
    expect(upsertObject).toHaveBeenCalledWith(
      "MessageDraft",
      "user-ada:convo-1",
      expect.objectContaining({ body: "hi" }),
      2,
      { optimistic: true },
    );
  });

  test("on a versionPrecondition conflict, retries once with the server-reported version (last-write-wins)", async () => {
    const upsertObject = vi
      .fn()
      .mockRejectedValueOnce(
        new FrickObjectConflictError({
          envelope: conflictEnvelope(),
          expectedVersion: 2,
          actualVersion: 5,
          mergePolicy: "versionPrecondition",
        }),
      )
      .mockResolvedValueOnce({ version: 6 });
    const client = { upsertObject };
    const result = await upsertDraftWithLwwRetry(client, "user-ada:convo-1", makeRow("hi"), 2);

    expect(result).toEqual({ version: 6 });
    expect(upsertObject).toHaveBeenCalledTimes(2);
    expect(upsertObject.mock.calls[1]?.[3]).toBe(5);
  });

  test("non-conflict errors propagate unchanged", async () => {
    const upsertObject = vi.fn().mockRejectedValue(new Error("network down"));
    const client = { upsertObject };
    await expect(
      upsertDraftWithLwwRetry(client, "user-ada:convo-1", makeRow("hi"), undefined),
    ).rejects.toThrow("network down");
    expect(upsertObject).toHaveBeenCalledTimes(1);
  });
});
