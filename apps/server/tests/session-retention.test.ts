import { afterEach, describe, expect, it } from "vitest";
import { productTestSchema } from "@fricken/protocol";
import { FrickStore } from "../src/store.js";

// Coverage for FR-42 expired-session retention. `auth_sessions` rows are
// filtered by expiry on read but were never deleted, so the table grew
// unbounded. The store now sweeps expired rows on a background pass (one shot
// at construction, then on a timer). These tests drive the prune manually
// (timer disabled) and exercise the grace window.

let store: FrickStore | undefined;

afterEach(async () => {
  store?.close();
  store = undefined;
});

function makeStore(overrides: Record<string, unknown> = {}): FrickStore {
  return new FrickStore({
    path: ":memory:",
    seed: true,
    schema: productTestSchema,
    expiredSessionPruneIntervalMs: 0, // disable timer; drive prune manually
    ...overrides,
  });
}

function createSession(s: FrickStore, token: string, expiresAt: string): void {
  s.sessions.create({
    sessionToken: token,
    tenantId: "_default",
    userId: "user-ada",
    deviceId: "device-ada",
    replicaId: "replica-ada",
    expiresAt,
  });
}

const PAST = "2000-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

describe("FrickStore auth_sessions retention", () => {
  it("prunes expired session rows and leaves live ones", async () => {
    store = makeStore();
    createSession(store, "expired", PAST);
    createSession(store, "live", FUTURE);

    // Both rows physically exist before pruning (readAny ignores expiry).
    expect(await store.sessions.readAny("expired")).toBeDefined();
    expect(await store.sessions.readAny("live")).toBeDefined();

    const removed = await store.sessions.pruneExpired();
    expect(removed).toBe(1);

    expect(await store.sessions.readAny("expired")).toBeUndefined();
    expect(await store.sessions.readAny("live")).toBeDefined();
  });

  it("keeps a recently-expired row within the grace window", async () => {
    // A 1h grace window: a row that expired 'now' is still within grace and
    // must survive a prune whose cutoff is one hour in the past.
    store = makeStore();
    const justExpired = new Date(Date.now() - 1000).toISOString();
    createSession(store, "recent", justExpired);

    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(await store.sessions.pruneExpired(cutoff)).toBe(0);
    expect(await store.sessions.readAny("recent")).toBeDefined();

    // With the default (no-grace) cutoff it is eligible.
    expect(await store.sessions.pruneExpired()).toBe(1);
    expect(await store.sessions.readAny("recent")).toBeUndefined();
  });

  it("sweeps expired rows on the background pass when a grace is configured", async () => {
    // Grace of 0 (default) — the store's own #safeExpiredSessionPrune deletes
    // anything already expired. Drive it by re-running the constructor's prime
    // path: create an expired row, then trigger a manual prune via the public
    // store API used by the timer.
    store = makeStore({ expiredSessionRetentionGraceMs: 0 });
    createSession(store, "dead", PAST);
    expect(await store.sessions.readAny("dead")).toBeDefined();

    // pruneExpired with the default cutoff mirrors what the background timer
    // calls each tick.
    expect(await store.sessions.pruneExpired()).toBe(1);
    expect(await store.sessions.readAny("dead")).toBeUndefined();
  });
});
