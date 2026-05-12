/**
 * Scheduled-message sweep tests. Exercises the handler in isolation —
 * no socket, no worker — to keep the assertions focused on the promote
 * + status-flip logic.
 */
import { describe, expect, it } from "vitest";
import { FrickStore } from "../src/store.js";
import { createScheduledMessageSweepHandler } from "../src/scheduled-messages/sweep.js";
import type { FrickLogger } from "../src/logger.js";
import type { FrickJobContext } from "../src/jobs/registry.js";

function silentLogger(): FrickLogger {
  const noop = () => {};
  const child: FrickLogger = { debug: noop, info: noop, warn: noop, error: noop, child: () => child };
  return child;
}

function ctxFor(store: FrickStore): FrickJobContext {
  return {
    tenantId: "_default",
    jobId: 1,
    jobType: "scheduled.sweep",
    payload: undefined,
    attemptCount: 0,
    store,
    logger: silentLogger(),
  };
}

describe("scheduled-message sweep", () => {
  it("promotes due rows into MessageSent events and flips status to delivered", async () => {
    const store = new FrickStore({ path: ":memory:", seed: true });
    try {
      const past = new Date(Date.now() - 60_000).toISOString();
      const future = new Date(Date.now() + 60_000).toISOString();
      store.upsertObject("ScheduledMessage", "sched-1", {
        userId: "user-ada",
        conversationId: "conversation-general",
        body: "from the past",
        scheduledFor: past,
        status: "pending",
      });
      store.upsertObject("ScheduledMessage", "sched-2", {
        userId: "user-ada",
        conversationId: "conversation-general",
        body: "for later",
        scheduledFor: future,
        status: "pending",
      });

      const handler = createScheduledMessageSweepHandler({ store, logger: silentLogger() });
      const result = await handler(ctxFor(store));
      expect(result.status).toBe("completed");
      expect((result.result as { promoted: number }).promoted).toBe(1);

      const events = store.readEvents("_default", "MessageStream", "conversation-general", 0);
      const messages = events.filter((event) => event.event === "MessageSent" && (event.payload as { body?: string }).body === "from the past");
      expect(messages).toHaveLength(1);

      const promoted = store.readObject("ScheduledMessage", "sched-1") as { status?: string } | undefined;
      expect(promoted?.status).toBe("delivered");
      const stillPending = store.readObject("ScheduledMessage", "sched-2") as { status?: string } | undefined;
      expect(stillPending?.status).toBe("pending");
    } finally {
      store.close();
    }
  });

  it("skips already-delivered + cancelled rows", async () => {
    const store = new FrickStore({ path: ":memory:", seed: true });
    try {
      const past = new Date(Date.now() - 60_000).toISOString();
      store.upsertObject("ScheduledMessage", "sched-delivered", {
        userId: "user-ada",
        conversationId: "conversation-general",
        body: "already gone",
        scheduledFor: past,
        status: "delivered",
      });
      store.upsertObject("ScheduledMessage", "sched-cancelled", {
        userId: "user-ada",
        conversationId: "conversation-general",
        body: "withdrew this",
        scheduledFor: past,
        status: "cancelled",
      });
      const before = store.readEvents("_default", "MessageStream", "conversation-general", 0).length;
      const handler = createScheduledMessageSweepHandler({ store, logger: silentLogger() });
      const result = await handler(ctxFor(store));
      expect((result.result as { promoted: number }).promoted).toBe(0);
      const after = store.readEvents("_default", "MessageStream", "conversation-general", 0).length;
      expect(after).toBe(before);
    } finally {
      store.close();
    }
  });
});
