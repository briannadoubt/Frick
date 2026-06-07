import { afterEach, describe, expect, it } from "vitest";
import { productTestSchema } from "@fricken/protocol";
import { FrickStore, SourceSessionNotActiveError, deriveSiblingSession } from "../src/index.js";

// FR-131: derive a sibling session in another tenant from a live session,
// reusing the caller's user/device/replica identity. The membership/authz
// check is the app's; this helper owns the re-mint + tenant.ensure machinery.

let store: FrickStore | undefined;

afterEach(async () => {
  store?.close();
  store = undefined;
});

function makeStore(): FrickStore {
  return new FrickStore({ path: ":memory:", seed: true, schema: productTestSchema });
}

function seedSession(s: FrickStore, token: string, expiresAt: string): void {
  s.sessions.create({
    sessionToken: token,
    tenantId: "tenant-a",
    userId: "user-ada",
    deviceId: "device-ada",
    replicaId: "replica-ada",
    expiresAt,
  });
}

const FUTURE = new Date(Date.now() + 60_000).toISOString();

describe("deriveSiblingSession", () => {
  it("mints a new session in the target tenant reusing the caller identity", async () => {
    store = makeStore();
    seedSession(store, "src-token", FUTURE);

    const derived = await deriveSiblingSession(store, {
      fromSessionToken: "src-token",
      tenantId: "tenant-b",
      ttlSeconds: 3600,
    });

    expect(derived.tenantId).toBe("tenant-b");
    expect(derived.userId).toBe("user-ada");
    expect(derived.deviceId).toBe("device-ada");
    expect(derived.replicaId).toBe("replica-ada");
    expect(derived.sessionToken).not.toBe("src-token");
    expect(Date.parse(derived.expiresAt)).toBeGreaterThan(Date.now());

    // The derived token resolves to a live session in the new tenant; the
    // original is untouched.
    expect((await store.readActiveSession(derived.sessionToken))?.tenantId).toBe("tenant-b");
    expect((await store.readActiveSession("src-token"))?.tenantId).toBe("tenant-a");
  });

  it("ensures the target tenant exists in the ledger by default", async () => {
    store = makeStore();
    seedSession(store, "src-token", FUTURE);
    expect(await store.tenants.get("tenant-b")).toBeUndefined();

    await deriveSiblingSession(store, {
      fromSessionToken: "src-token",
      tenantId: "tenant-b",
      ttlSeconds: 3600,
    });

    expect(await store.tenants.get("tenant-b")).toBeDefined();
  });

  it("honors a custom token factory and now()", async () => {
    store = makeStore();
    seedSession(store, "src-token", FUTURE);

    const fixedNow = new Date("2026-06-06T00:00:00.000Z");
    const derived = await deriveSiblingSession(store, {
      fromSessionToken: "src-token",
      tenantId: "tenant-b",
      ttlSeconds: 100,
      tokenFactory: () => "deterministic-token",
      now: () => fixedNow,
    });

    expect(derived.sessionToken).toBe("deterministic-token");
    expect(derived.expiresAt).toBe(new Date(fixedNow.getTime() + 100_000).toISOString());
  });

  it("throws SourceSessionNotActiveError for a missing or expired source token", async () => {
    store = makeStore();
    seedSession(store, "dead-token", "2000-01-01T00:00:00.000Z");

    await expect(
      deriveSiblingSession(store!, { fromSessionToken: "nope", tenantId: "tenant-b", ttlSeconds: 60 }),
    ).rejects.toThrow(SourceSessionNotActiveError);
    await expect(
      deriveSiblingSession(store!, { fromSessionToken: "dead-token", tenantId: "tenant-b", ttlSeconds: 60 }),
    ).rejects.toThrow(SourceSessionNotActiveError);
  });

  it("rejects a non-positive ttl", async () => {
    store = makeStore();
    seedSession(store, "src-token", FUTURE);
    await expect(
      deriveSiblingSession(store!, { fromSessionToken: "src-token", tenantId: "tenant-b", ttlSeconds: 0 }),
    ).rejects.toThrow(RangeError);
  });
});
