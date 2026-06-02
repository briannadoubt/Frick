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

describe("FrickStore idempotency replay window (lookup-time bound)", () => {
  it("dedupes a replay that lands within the window", () => {
    store = new FrickStore({
      path: ":memory:",
      seed: true,
      schema: productTestSchema,
      idempotencyReplayWindowMs: 60 * 60 * 1000, // 1h — well above test runtime
      idempotencyKeyPruneIntervalMs: 0,
    });

    const input = makeAppend("request-within", "once");
    const first = store.appendEvent(input);
    const second = store.appendEvent(input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.event.eventId).toBe(first.event.eventId);
  });

  it("treats a replay beyond the window as a fresh event WITHOUT pruning the row", async () => {
    store = new FrickStore({
      path: ":memory:",
      seed: true,
      schema: productTestSchema,
      idempotencyReplayWindowMs: 10, // 10ms lookup window
      // Keep rows for an hour and disable the prune timer so this proves the
      // bound is enforced at LOOKUP time, not by retention/pruning.
      idempotencyKeyRetentionMs: 60 * 60 * 1000,
      idempotencyKeyPruneIntervalMs: 0,
    });

    const first = store.appendEvent(makeAppend("request-beyond", "first"));
    expect(first.created).toBe(true);
    expect(store.idempotencyKeyRowCount()).toBe(1);

    // Age the record past the 10ms window. No prune pass runs.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const replay = store.appendEvent(makeAppend("request-beyond", "second"));

    // Beyond the replay window → not deduped, even though the original
    // idempotency row was never pruned: a fresh event is minted.
    expect(replay.created).toBe(true);
    expect(replay.event.eventId).not.toBe(first.event.eventId);
    // The key is rewritten in place (upsert), not duplicated — still one row,
    // now pointing at the fresh event.
    expect(store.idempotencyKeyRowCount()).toBe(1);

    // An immediate re-replay is within the window of the NEW record, so it
    // dedupes to the fresh event rather than the original.
    const reReplay = store.appendEvent(makeAppend("request-beyond", "third"));
    expect(reReplay.created).toBe(false);
    expect(reReplay.event.eventId).toBe(replay.event.eventId);
  });

  it("defaults to honouring replays for the full default window when unset", () => {
    store = new FrickStore({
      path: ":memory:",
      seed: true,
      schema: productTestSchema,
      idempotencyKeyPruneIntervalMs: 0,
    });

    const input = makeAppend("request-default", "once");
    const first = store.appendEvent(input);
    const second = store.appendEvent(input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.event.eventId).toBe(first.event.eventId);
  });
});
