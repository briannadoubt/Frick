import { DatabaseSync } from "node:sqlite";
import { foundationSchema } from "@fricken/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { definePlatformEventPipelineConformance } from "./platform-events.conformance.js";
import { SqlitePlatformEventPipeline } from "../src/platform-events/sqlite.js";
import { initializeStorage } from "../src/storage/schema.js";
import { SqliteSqlDriver } from "../src/storage/sql-driver.js";
import { FrickStore } from "../src/store.js";

let db: DatabaseSync | undefined;
let store: FrickStore | undefined;

function openPipeline(now = () => new Date("2026-05-17T00:00:00.000Z")) {
  db = new DatabaseSync(":memory:");
  initializeStorage(db, foundationSchema.schemaRevision);
  return new SqlitePlatformEventPipeline(new SqliteSqlDriver(db), {
    retentionMs: 60 * 60 * 1000,
    maxRows: 10_000,
    now,
  });
}

afterEach(async () => {
  store?.close();
  store = undefined;
  db?.close();
  db = undefined;
});

definePlatformEventPipelineConformance({
  name: "sqlite",
  async create() {
    return openPipeline();
  },
});

describe("SQLite platform events", () => {
  it("FrickStore exposes the default SQLite platform event pipeline", async () => {
    store = new FrickStore({ path: ":memory:", seed: false });

    const receipt = await store.platformEvents.publish({
      family: "jobs.lifecycle",
      name: "job.completed",
      source: "test",
      tenantId: "_default",
      payload: { jobType: "Example" },
    });

    const [delivery] = await await store.platformEvents.claim("dashboard");
    expect(delivery?.event.id).toBe(receipt.id);
    expect(delivery?.event.payload).toEqual({ jobType: "Example" });
  });

  it("prunes old rows by retention and caps newest rows", async () => {
    const now = new Date("2026-05-17T00:00:00.000Z");
    const pipeline = openPipeline(() => now);
    await pipeline.publish({
      family: "analytics.user_event",
      name: "old.event",
      source: "test",
      occurredAt: "2026-05-16T00:00:00.000Z",
    });
    await pipeline.publish({
      family: "analytics.user_event",
      name: "fresh.one",
      source: "test",
    });
    await pipeline.publish({
      family: "analytics.user_event",
      name: "fresh.two",
      source: "test",
    });

    const result = await pipeline.prune({ retentionMs: 60 * 60 * 1000, maxRows: 1 });

    expect(result.prunedByAge).toBe(1);
    expect(result.prunedByCap).toBe(1);
    expect((await pipeline.health()).retained).toBe(1);
  });

  it("redelivers stale claimed events after the claim timeout", async () => {
    let now = new Date("2026-05-17T00:00:00.000Z");
    const pipeline = openPipeline(() => now);
    const receipt = await pipeline.publish({
      family: "analytics.user_event",
      name: "button.clicked",
      source: "test",
    });

    const [first] = await pipeline.claim("analytics-worker");
    expect(first?.event.id).toBe(receipt.id);
    expect(first?.attempt).toBe(1);
    expect(await pipeline.claim("analytics-worker")).toEqual([]);

    now = new Date("2026-05-17T00:10:01.000Z");
    const [redelivery] = await pipeline.claim("analytics-worker");
    expect(redelivery?.event.id).toBe(receipt.id);
    expect(redelivery?.attempt).toBe(2);

    await pipeline.ack("analytics-worker", receipt.id, {
      attempt: first!.attempt,
      claimedAt: first!.claimedAt,
    });
    now = new Date("2026-05-17T00:20:02.000Z");
    const [afterStaleAck] = await pipeline.claim("analytics-worker");
    expect(afterStaleAck?.event.id).toBe(receipt.id);
    expect(afterStaleAck?.attempt).toBe(3);
  });
});
