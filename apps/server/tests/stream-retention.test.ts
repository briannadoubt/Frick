import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { productTestSchema } from "@fricken/protocol";
import { initializeStorage } from "../src/storage/schema.js";
import { SqliteSqlDriver } from "../src/storage/sql-driver.js";
import { StreamStore } from "../src/storage/stream-store.js";

// FR-145: opt-in per-stream retention. Streams absent from the policy map keep
// their full history; policy'd streams prune by maxEvents / maxAgeMs. Cursors
// are the operator's responsibility (bounds must exceed the catch-up window).

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function makeStore(now?: () => number): StreamStore {
  db = new DatabaseSync(":memory:");
  initializeStorage(db, productTestSchema.schemaRevision);
  return new StreamStore(
    new SqliteSqlDriver(db),
    productTestSchema,
    undefined,
    now ? { now } : {},
  );
}

const STREAM = "MessageStream";

async function appendN(store: StreamStore, streamId: string, n: number, createdAt?: string) {
  for (let i = 0; i < n; i++) {
    await store.append({
      tenantId: "_default",
      stream: STREAM,
      streamId,
      replicaId: "r1",
      requestId: `${streamId}-${i}-${Math.random()}`,
      event: "MessageSent",
      payload: {
        messageId: `m-${streamId}-${i}`,
        senderId: "user-ada",
        body: `body ${i}`,
        createdAt: createdAt ?? "2026-05-31T00:00:00.000Z",
      },
    });
  }
}

async function count(store: StreamStore, streamId: string): Promise<number> {
  const events = await store.read("_default", STREAM, streamId, 0);
  return events.length;
}

describe("StreamStore.pruneRetention (FR-145)", () => {
  it("keeps full history for streams with no policy", async () => {
    const store = makeStore();
    await appendN(store, "conv-a", 5);

    const result = await store.pruneRetention({}); // no policies
    expect(result).toEqual({ prunedByAge: 0, prunedByCount: 0 });
    expect(await count(store, "conv-a")).toBe(5);
  });

  it("keeps only the newest maxEvents per stream id", async () => {
    const store = makeStore();
    await appendN(store, "conv-a", 10);
    await appendN(store, "conv-b", 3);

    const result = await store.pruneRetention({ [STREAM]: { maxEvents: 4 } });
    expect(result.prunedByCount).toBe(6); // conv-a: 10 → 4 (6 removed); conv-b: 3 ≤ 4 (none)

    expect(await count(store, "conv-a")).toBe(4);
    expect(await count(store, "conv-b")).toBe(3);

    // The survivors are the NEWEST events (highest sequences).
    const remaining = await store.read("_default", STREAM, "conv-a", 0);
    const bodies = remaining.map((e) => (e.payload as { body: string }).body);
    expect(bodies).toEqual(["body 6", "body 7", "body 8", "body 9"]);
  });

  it("drops events older than maxAgeMs and is idempotent", async () => {
    // append() stamps the row created_at with the real wall clock; pruneRetention
    // takes an explicit `now` per call, so we move the cutoff rather than the rows.
    const store = makeStore();
    await appendN(store, "conv-a", 5);
    const DAY = 24 * 60 * 60 * 1000;

    // A far-past cutoff (huge maxAgeMs at the real now) prunes nothing.
    const keep = await store.pruneRetention({ [STREAM]: { maxAgeMs: 365 * DAY } });
    expect(keep.prunedByAge).toBe(0);
    expect(await count(store, "conv-a")).toBe(5);

    // Evaluate retention "10 days from now" with a 1-day window: every existing
    // row is now older than the cutoff, so all are pruned.
    const tenDaysLater = () => Date.now() + 10 * DAY;
    const pruned = await store.pruneRetention({ [STREAM]: { maxAgeMs: DAY } }, tenDaysLater);
    expect(pruned.prunedByAge).toBe(5);
    expect(await count(store, "conv-a")).toBe(0);

    // Idempotent: nothing left to prune.
    const again = await store.pruneRetention({ [STREAM]: { maxAgeMs: DAY } }, tenDaysLater);
    expect(again.prunedByAge).toBe(0);
  });

  it("only prunes the named stream type", async () => {
    const store = makeStore();
    await appendN(store, "conv-a", 6);

    // Policy names a DIFFERENT stream type → conv-a (MessageStream) untouched.
    const result = await store.pruneRetention({ SomeOtherStream: { maxEvents: 1 } });
    expect(result.prunedByCount).toBe(0);
    expect(await count(store, "conv-a")).toBe(6);
  });
});
