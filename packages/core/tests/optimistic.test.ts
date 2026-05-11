/**
 * Display-only optimistic overlay tests.
 *
 * The overlay is the runtime primitive that lets a `client.append(...)` or
 * `client.upsertObject(...)` surface its synthesized event/value in the
 * matching signal immediately, before the server Ack. These tests cover
 * the in-isolation behavior of `OptimisticOverlay`; end-to-end ack/nack
 * rollback through `FrickClient` is exercised via the runtime tests.
 */
import { describe, expect, it, vi } from "vitest";
import { OptimisticOverlay } from "../src/optimistic.js";

describe("OptimisticOverlay", () => {
  it("publishes a pending stream event and notifies subscribers", () => {
    const overlay = new OptimisticOverlay();
    const listener = vi.fn();
    overlay.subscribeStream("MessageStream", "room-1", listener);

    overlay.addStreamEvent("req-1", {
      stream: "MessageStream",
      key: "room-1",
      event: {
        stream: "MessageStream",
        streamId: "room-1",
        sequence: Number.MAX_SAFE_INTEGER,
        eventId: "optimistic-req-1",
        event: "MessageSent",
        payload: { body: "hi" },
      },
    });

    expect(listener).toHaveBeenCalledTimes(1);
    const pending = overlay.forStream("MessageStream", "room-1");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.payload).toEqual({ body: "hi" });
  });

  it("does not notify a listener for a different stream/key", () => {
    const overlay = new OptimisticOverlay();
    const other = vi.fn();
    overlay.subscribeStream("MessageStream", "room-2", other);

    overlay.addStreamEvent("req-2", {
      stream: "MessageStream",
      key: "room-1",
      event: {
        stream: "MessageStream",
        streamId: "room-1",
        sequence: 0,
        eventId: "x",
        event: "MessageSent",
        payload: {},
      },
    });

    expect(other).not.toHaveBeenCalled();
  });

  it("removes a pending entry on Ack and notifies", () => {
    const overlay = new OptimisticOverlay();
    overlay.addStreamEvent("req-1", {
      stream: "MessageStream",
      key: "room-1",
      event: {
        stream: "MessageStream",
        streamId: "room-1",
        sequence: 0,
        eventId: "x",
        event: "MessageSent",
        payload: {},
      },
    });

    const listener = vi.fn();
    overlay.subscribeStream("MessageStream", "room-1", listener);

    overlay.remove("req-1");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(overlay.forStream("MessageStream", "room-1")).toHaveLength(0);
  });

  it("last-write-wins for repeated object overlays on the same id", () => {
    const overlay = new OptimisticOverlay();
    overlay.addObjectUpsert("req-1", { type: "User", id: "u1", value: { displayName: "Ada" } });
    overlay.addObjectUpsert("req-2", { type: "User", id: "u1", value: { displayName: "Ada v2" } });

    const map = overlay.forObjectType("User");
    expect(map.get("u1")).toEqual({ displayName: "Ada v2" });
  });

  it("clear() drops every entry and notifies all subscribers", () => {
    const overlay = new OptimisticOverlay();
    overlay.addStreamEvent("r1", {
      stream: "A", key: "k",
      event: { stream: "A", streamId: "k", sequence: 0, eventId: "x", event: "E", payload: {} },
    });
    overlay.addObjectUpsert("r2", { type: "Thing", id: "1", value: {} });

    const onStream = vi.fn();
    const onObject = vi.fn();
    overlay.subscribeStream("A", "k", onStream);
    overlay.subscribeObjectType("Thing", onObject);

    overlay.clear();
    expect(onStream).toHaveBeenCalledTimes(1);
    expect(onObject).toHaveBeenCalledTimes(1);
    expect(overlay.forStream("A", "k")).toHaveLength(0);
    expect(overlay.forObjectType("Thing").size).toBe(0);
  });
});
