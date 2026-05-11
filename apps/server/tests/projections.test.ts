import { afterEach, describe, expect, it } from "vitest";
import { FrickStore } from "../src/store.js";
import {
  createFrickProjectionRegistry,
  type FrickProjection,
  type FrickProjectionWriteEvent,
} from "../src/projections/registry.js";
import { createConversationInboxProjection } from "../src/projections/conversation-inbox.js";

let store: FrickStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

describe("projection registry", () => {
  it("dispatches object upserts to matching registered projections", () => {
    const events: FrickProjectionWriteEvent[] = [];
    const projection: FrickProjection = {
      name: "test-room-members",
      sources: [{ kind: "object", type: "RoomMember" }],
      handler: {
        apply(event) {
          events.push(event);
        },
      },
    };
    const projections = createFrickProjectionRegistry();
    projections.register(projection);
    store = new FrickStore({ path: ":memory:", seed: true, projections });

    // Drain seed-time notifications so we only assert on what we trigger.
    events.length = 0;

    store.upsertObject("RoomMember", "member-test", {
      conversationId: "conversation-general",
      userId: "user-ada",
      role: "member",
    });
    // Upserts to unrelated object types must not invoke this projection.
    store.upsertObject("User", "user-spy", { displayName: "Spy" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "objectUpsert",
      objectType: "RoomMember",
      objectId: "member-test",
    });
    expect((events[0]?.object as { userId?: string } | undefined)?.userId).toBe("user-ada");
  });

  it("fires multiple projections that share a source", () => {
    const firstApplied: string[] = [];
    const secondApplied: string[] = [];
    const projections = createFrickProjectionRegistry();
    projections.register({
      name: "first",
      sources: [{ kind: "stream", type: "MessageStream" }],
      handler: { apply: (event) => firstApplied.push(String(event.streamId)) },
    });
    projections.register({
      name: "second",
      sources: [{ kind: "stream", type: "MessageStream" }],
      handler: { apply: (event) => secondApplied.push(String(event.streamId)) },
    });
    store = new FrickStore({ path: ":memory:", seed: true, projections });

    store.appendEvent({
      requestId: "request-shared-1",
      replicaId: "replica-1",
      stream: "MessageStream",
      streamId: "conversation-general",
      event: "MessageSent",
      payload: {
        senderId: "user-ada",
        body: "shared",
        createdAt: "2026-05-09T00:00:00.000Z",
      },
    });

    expect(firstApplied).toEqual(["conversation-general"]);
    expect(secondApplied).toEqual(["conversation-general"]);
  });

  it("rebuild() resets and re-derives projection state from source events", () => {
    let counter = 0;
    const projections = createFrickProjectionRegistry();
    projections.register({
      name: "counter",
      sources: [{ kind: "stream", type: "MessageStream" }],
      handler: {
        apply: () => {
          counter += 1;
        },
        rebuild: (ctx) => {
          counter = ctx.store.readEvents("MessageStream", "conversation-general", 0).length;
        },
      },
    });
    store = new FrickStore({ path: ":memory:", seed: true, projections });

    for (let i = 1; i <= 3; i += 1) {
      store.appendEvent({
        requestId: `request-counter-${i}`,
        replicaId: "replica-1",
        stream: "MessageStream",
        streamId: "conversation-general",
        event: "MessageSent",
        payload: {
          senderId: "user-ada",
          body: `msg-${i}`,
          createdAt: "2026-05-09T00:00:00.000Z",
        },
      });
    }
    expect(counter).toBe(3);
    // Simulate drift — the rebuild should restore the truth from raw events.
    counter = 999;
    const result = projections.rebuildAll({
      tenantId: "_default",
      store,
      logger: noopLogger(),
    });
    expect(result.rebuilt).toEqual(["counter"]);
    expect(counter).toBe(3);
  });

  it("conversation-inbox projection produces correct per-user counts", () => {
    const projections = createFrickProjectionRegistry();
    projections.register(createConversationInboxProjection());
    store = new FrickStore({ path: ":memory:", seed: true, projections });

    // Two messages from ada — grace's row should show two unread.
    for (let i = 1; i <= 2; i += 1) {
      store.appendEvent({
        requestId: `request-inbox-${i}`,
        replicaId: "replica-1",
        stream: "MessageStream",
        streamId: "conversation-general",
        event: "MessageSent",
        payload: {
          senderId: "user-ada",
          body: `hello-${i}`,
          createdAt: "2026-05-09T00:00:00.000Z",
        },
      });
    }
    const inbox = store.listInbox("user-grace");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      conversationId: "conversation-general",
      unreadCount: 2,
      lastMessageSenderId: "user-ada",
    });

    // Rebuild from raw events — same answer.
    projections.rebuildAll({
      tenantId: "_default",
      store,
      logger: noopLogger(),
    });
    const rebuilt = store.listInbox("user-grace");
    expect(rebuilt[0]?.unreadCount).toBe(2);
  });

  it("registry rejects duplicate registrations", () => {
    const projections = createFrickProjectionRegistry();
    projections.register({
      name: "dup",
      sources: [],
      handler: { apply: () => {} },
    });
    expect(() =>
      projections.register({
        name: "dup",
        sources: [],
        handler: { apply: () => {} },
      }),
    ).toThrow(/already registered/);
  });
});

function noopLogger() {
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return logger;
    },
  };
  return logger;
}
