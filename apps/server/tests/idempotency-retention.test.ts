import { afterEach, describe, expect, it } from "vitest";
import { productTestSchema } from "@fricken/protocol";
import { FrickStore } from "../src/store.js";

let store: FrickStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

function makeAppend(requestId: string, body: string) {
  return {
    requestId,
    replicaId: "replica-1",
    stream: "MessageStream" as const,
    streamId: "conversation-general",
    event: "MessageSent" as const,
    payload: {
      messageId: `message-${requestId}`,
      senderId: "user-ada",
      body,
      createdAt: "2026-05-10T00:00:00.000Z",
    },
  };
}

describe("FrickStore idempotency_keys retention", () => {
  it("prunes rows older than the configured retention window", async () => {
    // Zero retention means every row is immediately eligible for pruning.
    // The intended semantic: once retention has elapsed, the idempotency
    // guarantee no longer applies and a retry produces a fresh event id.
    store = new FrickStore({
      path: ":memory:",
      seed: true,
      schema: productTestSchema,
      idempotencyKeyRetentionMs: 0,
      idempotencyKeyPruneIntervalMs: 0, // disable timer; we drive prune manually
    });

    const first = store.appendEvent(makeAppend("request-A", "hello"));
    expect(first.created).toBe(true);
    expect(store.idempotencyKeyRowCount()).toBe(1);

    // Wait a tick so created_at is strictly less than `now`. The ISO
    // timestamp resolution is milliseconds, so a single setImmediate suffices.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const result = store.prune();
    expect(result.prunedByAge).toBeGreaterThanOrEqual(1);
    expect(store.idempotencyKeyRowCount()).toBe(0);

    // After retention has lapsed and pruning has run, a replay must NOT be
    // deduplicated by the cache — it should produce a brand new event.
    const replay = store.appendEvent(makeAppend("request-A", "hello"));
    expect(replay.created).toBe(true);
    expect(replay.event.eventId).not.toBe(first.event.eventId);
  });

  it("enforces the maxRows cap after the age sweep", () => {
    store = new FrickStore({
      path: ":memory:",
      seed: true,
      schema: productTestSchema,
      idempotencyKeyRetentionMs: 60 * 60 * 1000, // 1h — well above test runtime
      idempotencyKeyMaxRows: 5,
      idempotencyKeyPruneIntervalMs: 0,
    });

    for (let i = 0; i < 10; i++) {
      store.appendEvent(makeAppend(`request-${i}`, `body-${i}`));
    }
    expect(store.idempotencyKeyRowCount()).toBe(10);

    const result = store.prune();
    expect(result.prunedByAge).toBe(0);
    expect(result.prunedByCap).toBe(5);
    expect(store.idempotencyKeyRowCount()).toBe(5);
  });

  it("preserves idempotency for replays within the default retention window", () => {
    store = new FrickStore({ path: ":memory:", seed: true, idempotencyKeyPruneIntervalMs: 0 , schema: productTestSchema });

    const input = makeAppend("request-stable", "once");
    const first = store.appendEvent(input);
    const second = store.appendEvent(input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.event.eventId).toBe(first.event.eventId);
  });

  it(
    "background timer prunes stale keys so retries produce fresh results",
    async () => {
      store = new FrickStore({
        path: ":memory:",
        seed: true,
        schema: productTestSchema,
        idempotencyKeyRetentionMs: 10,
        idempotencyKeyPruneIntervalMs: 50,
      });

      const first = store.appendEvent(makeAppend("request-timer", "first"));
      expect(first.created).toBe(true);

      // Wait long enough for at least one timer tick after the row's
      // `created_at` ages past the 10ms retention window.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const replay = store.appendEvent(makeAppend("request-timer", "second"));
      expect(replay.created).toBe(true);
      expect(replay.event.eventId).not.toBe(first.event.eventId);
    },
    5_000,
  );
});
