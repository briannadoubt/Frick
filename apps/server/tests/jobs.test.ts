import { describe, expect, it } from "vitest";
import { FrickStore } from "../src/store.js";
import { jobBackoffMs } from "../src/storage/job-store.js";

function newStore(): FrickStore {
  return new FrickStore({ path: ":memory:", seed: false });
}

describe("JobStore enqueue/claim/complete", () => {
  it("round-trips a single job through enqueue → claim → complete", async () => {
    const store = newStore();
    const row = await store.jobs.enqueue({
      tenantId: "_default",
      jobType: "TestJob",
      payload: { hello: "world" },
    });
    expect(row.status).toBe("ready");
    expect(row.attemptCount).toBe(0);

    const claimed = await store.jobs.claim("worker-a");
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.id).toBe(row.id);
    expect(claimed[0]!.status).toBe("running");
    expect(claimed[0]!.claimedBy).toBe("worker-a");
    expect(claimed[0]!.attemptCount).toBe(1);

    await store.jobs.complete(row.id, { ok: true });
    const final = await store.jobs.getById(row.id);
    expect(final?.status).toBe("completed");
    expect(final?.completedAt).toBeTruthy();
    store.close();
  });

  it("returns the same row when re-enqueueing with the same idempotency key", async () => {
    const store = newStore();
    const first = await store.jobs.enqueue({
      tenantId: "_default",
      jobType: "PushNotification",
      payload: { x: 1 },
      idempotencyKey: "abc",
    });
    const second = await store.jobs.enqueue({
      tenantId: "_default",
      jobType: "PushNotification",
      payload: { x: 2 },
      idempotencyKey: "abc",
    });
    expect(second.id).toBe(first.id);
    // The payload from the first enqueue wins — second call returns existing row.
    expect((second.payload as { x: number }).x).toBe(1);
    store.close();
  });

  it("claim is atomic — two concurrent claim calls never see overlap", async () => {
    const store = newStore();
    for (let i = 0; i < 10; i++) {
      await store.jobs.enqueue({
        tenantId: "_default",
        jobType: "TestJob",
        payload: { i },
      });
    }
    // node:sqlite is synchronous so "concurrent" here means back-to-back calls
    // within the same tick. The real safety property is that the UPDATE...
    // RETURNING is one statement under SQLite's writer lock — two callers
    // each see a disjoint slice. We assert that property by checking the union
    // of two claims equals the full set with no duplicates.
    const a = await store.jobs.claim("worker-a", undefined, 6);
    const b = await store.jobs.claim("worker-b", undefined, 6);
    const ids = new Set([...a, ...b].map((row) => row.id));
    expect(ids.size).toBe(a.length + b.length);
    expect(a.length + b.length).toBe(10);
    store.close();
  });

  it("retryable failure re-arms with exponential backoff", async () => {
    const store = newStore();
    const row = await store.jobs.enqueue({
      tenantId: "_default",
      jobType: "TestJob",
      payload: {},
      maxAttempts: 3,
    });
    const claimed = (await store.jobs.claim("worker-a"))[0]!;
    expect(claimed.attemptCount).toBe(1);
    await store.jobs.fail(claimed.id, "test.transient", "boom", true);
    const after = await store.jobs.getById(row.id);
    expect(after?.status).toBe("ready");
    expect(after?.lastErrorCode).toBe("test.transient");
    expect(after?.attemptCount).toBe(1);
    expect(after?.claimedAt).toBeUndefined();
    // available_at should be >= now + jobBackoffMs(1)
    const expected = Date.now() + jobBackoffMs(1);
    const actual = Date.parse(after!.availableAt);
    // Allow ±5s slack — clocks tick between the call and the assertion.
    expect(actual).toBeGreaterThanOrEqual(expected - 5000);
    store.close();
  });

  it("non-retryable failure dead-letters immediately", async () => {
    const store = newStore();
    const row = await store.jobs.enqueue({
      tenantId: "_default",
      jobType: "TestJob",
      payload: {},
      maxAttempts: 10,
    });
    const claimed = (await store.jobs.claim("worker-a"))[0]!;
    await store.jobs.fail(claimed.id, "test.fatal", "no retry", false);
    const after = await store.jobs.getById(row.id);
    expect(after?.status).toBe("dead_lettered");
    expect(after?.deadLetteredAt).toBeTruthy();
    expect(after?.lastErrorCode).toBe("test.fatal");
    store.close();
  });

  it("dead-letters when max_attempts is reached", async () => {
    const store = newStore();
    const row = await store.jobs.enqueue({
      tenantId: "_default",
      jobType: "TestJob",
      payload: {},
      maxAttempts: 2,
    });
    // Attempt 1
    let claimed = (await store.jobs.claim("worker-a"))[0]!;
    expect(claimed.attemptCount).toBe(1);
    await store.jobs.fail(claimed.id, "test.retry", "first", true);
    expect((await store.jobs.getById(row.id))?.status).toBe("ready");

    // Reset available_at so we can claim again without waiting for backoff.
    await store.jobs.list({ status: "ready" }); // sanity
    // Force-claim by manually adjusting available_at via re-enqueue isn't
    // worth it; instead, exercise the budget directly: a second fail at
    // attempt_count = max_attempts should dead-letter.
    // Simulate attempt 2 by manually setting attempt_count to 2 via fail's
    // check: claim won't see the row (backed off), so we test by direct
    // path. Use a small max_attempts trick — set up a fresh row.
    const row2 = await store.jobs.enqueue({
      tenantId: "_default",
      jobType: "TestJob",
      payload: {},
      maxAttempts: 1,
    });
    const claimed2 = (await store.jobs.claim("worker-a", "TestJob", 1))[0]!;
    expect(claimed2.attemptCount).toBe(1);
    await store.jobs.fail(claimed2.id, "test.retry", "exhausted", true);
    const after = await store.jobs.getById(row2.id);
    expect(after?.status).toBe("dead_lettered");
    store.close();
  });

  it("tenant isolation — claim with a tenant filter via list won't cross tenants", async () => {
    const store = newStore();
    await store.jobs.enqueue({ tenantId: "tenant-a", jobType: "T", payload: {} });
    await store.jobs.enqueue({ tenantId: "tenant-b", jobType: "T", payload: {} });
    expect(await store.jobs.list({ tenantId: "tenant-a" })).toHaveLength(1);
    expect(await store.jobs.list({ tenantId: "tenant-b" })).toHaveLength(1);
    expect((await store.jobs.list({ tenantId: "tenant-a" }))[0]!.tenantId).toBe("tenant-a");
    // getById with a tenant filter only finds within that tenant.
    const aRow = (await store.jobs.list({ tenantId: "tenant-a" }))[0]!;
    expect(await store.jobs.getById(aRow.id, "tenant-b")).toBeUndefined();
    expect((await store.jobs.getById(aRow.id, "tenant-a"))?.id).toBe(aRow.id);
    store.close();
  });

  it("countsByStatus exposes a per-state snapshot", async () => {
    const store = newStore();
    const a = await store.jobs.enqueue({ tenantId: "_default", jobType: "T", payload: {} });
    const b = await store.jobs.enqueue({ tenantId: "_default", jobType: "T", payload: {} });
    await store.jobs.enqueue({ tenantId: "_default", jobType: "T", payload: {} });
    const [first, second] = await store.jobs.claim("worker-a", "T", 2);
    await store.jobs.complete(first!.id);
    await store.jobs.fail(second!.id, "test.fatal", "x", false);
    const counts = await store.jobs.countsByStatus();
    expect(counts.completed).toBe(1);
    expect(counts.dead_lettered).toBe(1);
    expect(counts.ready).toBe(1);
    expect(counts.failed).toBeGreaterThanOrEqual(1);
    void a;
    void b;
    store.close();
  });
});

describe("jobBackoffMs", () => {
  it("doubles per attempt and caps at 5 minutes", async () => {
    expect(jobBackoffMs(1)).toBe(60_000);
    expect(jobBackoffMs(2)).toBe(120_000);
    expect(jobBackoffMs(3)).toBe(240_000);
    // Cap kicks in around attempt 4 (480_000 > 300_000).
    expect(jobBackoffMs(4)).toBe(300_000);
    expect(jobBackoffMs(10)).toBe(300_000);
  });
});
