import { describe, expect, test } from "vitest";
import { aggregateReactions } from "./realtime.js";
import type { ChatStreamEvent } from "@frick/core/chat";

function reactionEvent(payload: { messageId: string; userId: string; emoji: string }, seq: number): ChatStreamEvent {
  return {
    stream: "MessageStream",
    streamId: "convo-1",
    sequence: seq,
    eventId: `evt-${seq}`,
    event: "ReactionAdded",
    payload,
  };
}

describe("aggregateReactions", () => {
  test("folds events into per-emoji user sets", () => {
    const events: ChatStreamEvent[] = [
      reactionEvent({ messageId: "m1", userId: "ada", emoji: "👍" }, 1),
      reactionEvent({ messageId: "m1", userId: "grace", emoji: "👍" }, 2),
      reactionEvent({ messageId: "m1", userId: "ada", emoji: "🎉" }, 3),
      reactionEvent({ messageId: "other", userId: "linus", emoji: "👍" }, 4),
    ];
    const result = aggregateReactions(events, "m1", "ada");
    const thumbs = result.find((r) => r.emoji === "👍");
    const tada = result.find((r) => r.emoji === "🎉");
    expect(thumbs?.userIds).toEqual(["ada", "grace"]);
    expect(thumbs?.meReacted).toBe(true);
    expect(tada?.userIds).toEqual(["ada"]);
    expect(result.every((r) => r.emoji !== "👍" || r.userIds.includes("ada"))).toBe(true);
  });

  test("retracts via the leading-dash convention", () => {
    const events: ChatStreamEvent[] = [
      reactionEvent({ messageId: "m1", userId: "ada", emoji: "👍" }, 1),
      reactionEvent({ messageId: "m1", userId: "ada", emoji: "-👍" }, 2),
    ];
    const result = aggregateReactions(events, "m1", "ada");
    expect(result.find((r) => r.emoji === "👍")).toBeUndefined();
  });

  test("ignores events on other messages", () => {
    const events: ChatStreamEvent[] = [
      reactionEvent({ messageId: "other", userId: "ada", emoji: "👍" }, 1),
    ];
    expect(aggregateReactions(events, "m1", "ada")).toEqual([]);
  });
});
