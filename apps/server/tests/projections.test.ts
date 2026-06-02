import { afterEach, describe, expect, it } from "vitest";
import { productTestSchema } from "@fricken/protocol";
import { FrickStore } from "../src/store.js";
import {
  createFrickProjectionRegistry,
  type FrickProjection,
  type FrickProjectionWriteEvent,
} from "../src/projections/registry.js";

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
    store = new FrickStore({ path: ":memory:", seed: true, projections , schema: productTestSchema });

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
    store = new FrickStore({ path: ":memory:", seed: true, projections , schema: productTestSchema });

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
    store = new FrickStore({ path: ":memory:", seed: true, projections , schema: productTestSchema });

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

  // The previous "conversation-inbox projection produces correct per-user
  // counts" test was deleted: the framework no longer ships
  // `createConversationInboxProjection` or `store.listInbox` — those moved
  // out of the framework with the boundary cleanup (see CHANGELOG). The
  // projection registry primitives exercised by the other cases here cover
  // the framework contract that remains.

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
