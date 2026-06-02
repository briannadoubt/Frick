/**
 * Persistent web cache tests using `fake-indexeddb`. The fake provides a
 * complete in-process IDB implementation so we can exercise the real code
 * path (open / put / get / cursor) without a browser.
 *
 * Coverage:
 *   - Save objects, stream events, cursors, pending appends → re-open the
 *     DB → state is restored.
 *   - Pending-append delete propagates to IDB.
 *   - The mirror is always in sync with the persisted state.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { foundationSchema } from "@fricken/protocol";
import { openIndexedDBFrickCache } from "../src/indexeddb-cache.js";

let factory: IDBFactory;
let dbName: string;

beforeEach(() => {
  factory = new IDBFactory();
  dbName = `frick-test-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
  // Each test gets its own factory + db name, so no global teardown needed.
});

// Tiny helper to flush microtasks; IndexedDB writes from the in-memory
// mirror are scheduled but not awaited, so a `setTimeout(0)` lets them
// drain before re-opening the database.
async function flushIdb(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("IndexedDBFrickCache", () => {
  const tenantAdaScope = { tenantId: "tenant-a", userId: "user-ada" };

  it("round-trips objects, stream events, cursors, and pending appends", async () => {
    const cache = await openIndexedDBFrickCache({ indexedDB: factory, dbName });

    cache.saveObject(foundationSchema, "User", "user-ada", { displayName: "Ada" }, 1);
    cache.saveStreamEvent(foundationSchema, {
      stream: "MessageStream",
      streamId: "conversation-general",
      sequence: 5,
      eventId: "evt-5",
      event: "MessageSent",
      payload: { body: "hi" },
    });
    cache.saveCursor(foundationSchema, "MessageStream:conversation-general", 5);
    cache.savePendingAppend(foundationSchema, {
      requestId: "req-1",
      stream: "MessageStream",
      key: "conversation-general",
      event: "MessageSent",
      payload: { body: "queued" },
    });

    await flushIdb();
    (cache as { close(): void }).close();

    // Re-open the same db. The hydration step inside the factory reads
    // every persisted record back into the in-memory mirror, which is the
    // source of truth for synchronous reads.
    const reopened = await openIndexedDBFrickCache({ indexedDB: factory, dbName });
    const state = reopened.load(foundationSchema);

    expect(state.objects).toHaveLength(1);
    expect(state.objects[0]?.value.displayName).toBe("Ada");
    expect(state.streamEvents).toHaveLength(1);
    expect(state.streamEvents[0]?.payload).toEqual({ body: "hi" });
    expect(state.cursors["MessageStream:conversation-general"]).toBe(5);
    expect(state.pendingAppends).toHaveLength(1);
    expect(state.pendingAppends[0]?.requestId).toBe("req-1");

    (reopened as { close(): void }).close();
  });

  it("persists and enforces authenticated session cache scope", async () => {
    const cache = await openIndexedDBFrickCache({ indexedDB: factory, dbName });
    cache.saveObject(foundationSchema, "User", "user-ada", { displayName: "Ada" }, 1, tenantAdaScope);

    await flushIdb();
    (cache as { close(): void }).close();

    const reopened = await openIndexedDBFrickCache({ indexedDB: factory, dbName });
    expect(reopened.load(foundationSchema, tenantAdaScope).objects).toHaveLength(1);
    expect(() =>
      reopened.load(foundationSchema, { tenantId: "tenant-b", userId: "user-grace" }),
    ).toThrow("Cached session scope");
    (reopened as { close(): void }).close();
  });

  it("propagates removePendingAppend to IDB", async () => {
    const cache = await openIndexedDBFrickCache({ indexedDB: factory, dbName });
    cache.savePendingAppend(foundationSchema, {
      requestId: "req-1",
      stream: "MessageStream",
      key: "k",
      event: "MessageSent",
      payload: {},
    });
    cache.savePendingAppend(foundationSchema, {
      requestId: "req-2",
      stream: "MessageStream",
      key: "k",
      event: "MessageSent",
      payload: {},
    });
    cache.removePendingAppend(foundationSchema, "req-1");

    await flushIdb();
    (cache as { close(): void }).close();

    const reopened = await openIndexedDBFrickCache({ indexedDB: factory, dbName });
    const state = reopened.load(foundationSchema);
    expect(state.pendingAppends.map((a) => a.requestId)).toEqual(["req-2"]);
    (reopened as { close(): void }).close();
  });

  it("clear() drops every persisted record", async () => {
    const cache = await openIndexedDBFrickCache({ indexedDB: factory, dbName });
    cache.saveObject(foundationSchema, "User", "user-ada", { displayName: "Ada" }, 1);
    cache.savePendingAppend(foundationSchema, {
      requestId: "req-1",
      stream: "MessageStream",
      key: "k",
      event: "MessageSent",
      payload: {},
    });
    cache.clear();

    await flushIdb();
    (cache as { close(): void }).close();

    const reopened = await openIndexedDBFrickCache({ indexedDB: factory, dbName });
    const state = reopened.load(foundationSchema);
    expect(state.objects).toEqual([]);
    expect(state.pendingAppends).toEqual([]);
    (reopened as { close(): void }).close();
  });
});
