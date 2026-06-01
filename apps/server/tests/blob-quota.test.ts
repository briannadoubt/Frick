/**
 * Per-principal blob quota (FR-56). Exercises the upload-time enforcement and
 * the quota-aware listing endpoint: under-quota success, over-quota rejection
 * (with no persisted side effects), the inclusive boundary, two-principal
 * independence, cross-tenant isolation, same-id re-upload not double-counting,
 * and the unchanged default when no quota is configured.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";
import type { FrickLimits } from "../src/limits.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function startServer(limits?: Partial<FrickLimits>) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    ...(limits ? { limits } : {}),
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    store: server.store,
    close: server.close,
  };
}

async function devLogin(httpUrl: string, userId: string, tenantId?: string) {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, ...(tenantId !== undefined ? { tenantId } : {}) }),
  });
  return (await response.json()) as { sessionToken: string; userId: string; tenantId: string };
}

async function uploadBlob(
  httpUrl: string,
  sessionToken: string,
  blobId: string,
  body: Buffer,
  ownerId: string,
): Promise<Response> {
  return fetch(
    `${httpUrl}/blobs/${encodeURIComponent(blobId)}/content?ownerId=${encodeURIComponent(ownerId)}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/octet-stream",
      },
      body,
    },
  );
}

describe("per-principal blob quota", () => {
  it("accepts an upload under the per-principal cap", async () => {
    app = await startServer({ maxBlobBytesPerPrincipal: 100 });
    const session = await devLogin(app.httpUrl, "alice");

    const res = await uploadBlob(app.httpUrl, session.sessionToken, "a-1", Buffer.alloc(60), session.userId);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; byteLength: number };
    expect(body.ok).toBe(true);
    expect(body.byteLength).toBe(60);
  });

  it("rejects an upload that would exceed the cap and persists nothing", async () => {
    app = await startServer({ maxBlobBytesPerPrincipal: 100 });
    const session = await devLogin(app.httpUrl, "alice");

    expect((await uploadBlob(app.httpUrl, session.sessionToken, "a-1", Buffer.alloc(60), session.userId)).status).toBe(201);

    // 60 already used; another 50 would total 110 > 100 → rejected.
    const second = await uploadBlob(app.httpUrl, session.sessionToken, "a-2", Buffer.alloc(50), session.userId);
    expect(second.status).toBe(413);
    const body = (await second.json()) as {
      code: string;
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(body.code).toBe("blob.quotaExceeded");
    expect(body.error.code).toBe("blob.quotaExceeded");
    expect(body.error.details?.limit).toBe("maxBlobBytesPerPrincipal");
    expect(body.error.details?.configuredMax).toBe(100);

    // The rejected blob must not have been persisted (metadata or bytes).
    expect(app.store.blobs.read(session.tenantId, "a-2")).toBeUndefined();
    const get = await fetch(`${app.httpUrl}/blobs/a-2/content`, {
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(get.status).toBe(404);
    // Usage is unchanged by the rejected upload.
    expect(app.store.blobs.totalBytesForOwner(session.tenantId, session.userId)).toBe(60);
  });

  it("accepts a blob that exactly fills the remaining budget but not one byte more", async () => {
    app = await startServer({ maxBlobBytesPerPrincipal: 100 });
    const session = await devLogin(app.httpUrl, "alice");

    expect((await uploadBlob(app.httpUrl, session.sessionToken, "a-1", Buffer.alloc(60), session.userId)).status).toBe(201);
    // Exactly 40 more → total 100, at the cap (inclusive), so allowed.
    expect((await uploadBlob(app.httpUrl, session.sessionToken, "a-2", Buffer.alloc(40), session.userId)).status).toBe(201);
    // One more byte → over the cap, rejected.
    expect((await uploadBlob(app.httpUrl, session.sessionToken, "a-3", Buffer.alloc(1), session.userId)).status).toBe(413);
  });

  it("gives two principals independent budgets", async () => {
    app = await startServer({ maxBlobBytesPerPrincipal: 100 });
    const alice = await devLogin(app.httpUrl, "alice");
    const bob = await devLogin(app.httpUrl, "bob");

    // Alice fills her budget.
    expect((await uploadBlob(app.httpUrl, alice.sessionToken, "a-1", Buffer.alloc(100), alice.userId)).status).toBe(201);
    expect((await uploadBlob(app.httpUrl, alice.sessionToken, "a-2", Buffer.alloc(1), alice.userId)).status).toBe(413);

    // Bob is unaffected by Alice's usage and can fill his own budget.
    expect((await uploadBlob(app.httpUrl, bob.sessionToken, "b-1", Buffer.alloc(100), bob.userId)).status).toBe(201);
    expect((await uploadBlob(app.httpUrl, bob.sessionToken, "b-2", Buffer.alloc(1), bob.userId)).status).toBe(413);
  });

  it("scopes usage by tenant as well as owner", async () => {
    // Cross-tenant isolation: the same owner id in two tenants must not share a
    // usage total. Asserted at the store level since the SUM query is the unit
    // the upload route trusts.
    app = await startServer({ maxBlobBytesPerPrincipal: 100 });
    const store = app.store;
    store.blobs.create("tenant-a", {
      blobId: "blob-1",
      ownerId: "user-1",
      contentHash: "hash-1",
      byteLength: 70,
      mimeType: "application/octet-stream",
    });
    store.blobs.create("tenant-b", {
      blobId: "blob-2",
      ownerId: "user-1",
      contentHash: "hash-2",
      byteLength: 30,
      mimeType: "application/octet-stream",
    });

    expect(store.blobs.totalBytesForOwner("tenant-a", "user-1")).toBe(70);
    expect(store.blobs.totalBytesForOwner("tenant-b", "user-1")).toBe(30);
    // A different owner in tenant-a has no usage.
    expect(store.blobs.totalBytesForOwner("tenant-a", "user-2")).toBe(0);
  });

  it("does not double-count a same-id re-upload", async () => {
    app = await startServer({ maxBlobBytesPerPrincipal: 100 });
    const session = await devLogin(app.httpUrl, "alice");

    const bytes = Buffer.alloc(80, 7);
    expect((await uploadBlob(app.httpUrl, session.sessionToken, "a-1", bytes, session.userId)).status).toBe(201);
    // Re-uploading the same blob id with identical bytes is an overwrite, not
    // new usage; the projected total stays 80, under the cap.
    const reupload = await uploadBlob(app.httpUrl, session.sessionToken, "a-1", bytes, session.userId);
    expect(reupload.status).toBe(200);
    expect(app.store.blobs.totalBytesForOwner(session.tenantId, session.userId)).toBe(80);
  });

  it("leaves uploads unbounded by default and reports quota null in listing", async () => {
    app = await startServer();
    const session = await devLogin(app.httpUrl, "alice");

    // Comfortably larger than any quota a test would use, but within the
    // single-blob maxBlobBytes default (25 MB).
    const big = Buffer.alloc(2_000_000);
    expect((await uploadBlob(app.httpUrl, session.sessionToken, "a-1", big, session.userId)).status).toBe(201);
    expect((await uploadBlob(app.httpUrl, session.sessionToken, "a-2", big, session.userId)).status).toBe(201);

    const list = await fetch(`${app.httpUrl}/blobs?ownerId=${encodeURIComponent(session.userId)}`, {
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      usage?: { ownerId: string; usedBytes: number; quotaBytes: number | null };
    };
    expect(body.usage?.ownerId).toBe(session.userId);
    expect(body.usage?.usedBytes).toBe(4_000_000);
    // No quota configured → quotaBytes is null, not the sentinel max.
    expect(body.usage?.quotaBytes).toBeNull();
  });

  it("reports usage and the configured quota in the listing", async () => {
    app = await startServer({ maxBlobBytesPerPrincipal: 500 });
    const session = await devLogin(app.httpUrl, "alice");

    expect((await uploadBlob(app.httpUrl, session.sessionToken, "a-1", Buffer.alloc(120), session.userId)).status).toBe(201);

    const list = await fetch(`${app.httpUrl}/blobs?ownerId=${encodeURIComponent(session.userId)}`, {
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      usage?: { usedBytes: number; quotaBytes: number | null };
    };
    expect(body.usage?.usedBytes).toBe(120);
    expect(body.usage?.quotaBytes).toBe(500);
  });
});
