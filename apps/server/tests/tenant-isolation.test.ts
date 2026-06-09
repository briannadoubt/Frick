import { afterEach, describe, expect, it } from "vitest";
import { productTestSchema } from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";

// Tenant isolation tests. The previous version exercised the framework's
// `/conversations` and `/inbox` routes, both of which were removed in the
// framework boundary cleanup (CHANGELOG: "Removed framework-owned chat
// routes..."). The cases here keep the underlying tenant isolation
// invariants but exercise them through the generic `/objects`, `/append`,
// `/streams`, `/blobs`, and `/signals` routes that production still ships.

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("tenant isolation", () => {
  it("scopes object lookups to the principal's tenant", async () => {
    app = await startServer();
    // user_id is globally unique in auth_accounts (only `handle` is
    // tenant-scoped post-cleanup); use distinct user ids per tenant.
    const a = await devLogin(app.httpUrl, { userId: "user-a-shared", tenantId: "tenant-a" });
    const b = await devLogin(app.httpUrl, { userId: "user-b-shared", tenantId: "tenant-b" });

    // Tenant-a writes a Conversation directly via the store (the
    // `/conversations` convenience route is gone). Tenant-b reading the
    // same object type must see nothing.
    await app.store.upsertObject("tenant-a", "Conversation", "conv-a-1", {
      kind: "group",
      title: "Tenant A Group",
      createdBy: "user-a-shared",
    });

    const listedA = await getJson(`${app.httpUrl}/objects?type=Conversation`, a.sessionToken);
    expect(listedA.body.data.length).toBeGreaterThan(0);

    const listedB = await getJson(`${app.httpUrl}/objects?type=Conversation`, b.sessionToken);
    expect(listedB.body.data).toEqual([]);
  });

  it("isolates message streams across tenants", async () => {
    app = await startServer();
    // user_id is globally unique in auth_accounts (only `handle` is
    // tenant-scoped post-cleanup); use distinct user ids per tenant.
    const a = await devLogin(app.httpUrl, { userId: "user-a-shared", tenantId: "tenant-a" });
    const b = await devLogin(app.httpUrl, { userId: "user-b-shared", tenantId: "tenant-b" });

    const conversationId = "conversation-shared";

    const appendA = await postJson(
      `${app.httpUrl}/append`,
      {
        requestId: "request-a",
        stream: "MessageStream",
        key: conversationId,
        event: "MessageSent",
        payload: {
          messageId: "message-a",
          senderId: "user-a-shared",
          body: "tenant-a only",
          createdAt: "2026-05-09T00:00:00.000Z",
        },
      },
      a.sessionToken,
    );
    expect(appendA.status).toBe(200);

    // Tenant-b reading the SAME stream key sees no events: the storage row
    // is partitioned by tenant_id even though the stream key matches.
    const readB = await getJson(
      `${app.httpUrl}/streams/MessageStream/${conversationId}`,
      b.sessionToken,
    );
    expect(readB.status).toBe(200);
    expect(readB.body.data).toEqual([]);

    const readA = await getJson(
      `${app.httpUrl}/streams/MessageStream/${conversationId}`,
      a.sessionToken,
    );
    expect(readA.status).toBe(200);
    expect(readA.body.data.length).toBeGreaterThan(0);
  });

  it("isolates blob ownership across tenants", async () => {
    app = await startServer();
    // user_id is globally unique in auth_accounts (only `handle` is
    // tenant-scoped post-cleanup); use distinct user ids per tenant.
    const a = await devLogin(app.httpUrl, { userId: "user-a-shared", tenantId: "tenant-a" });
    const b = await devLogin(app.httpUrl, { userId: "user-b-shared", tenantId: "tenant-b" });

    const blobId = "blob-tenant-test";
    const put = await fetch(`${app.httpUrl}/blobs/${blobId}/content?ownerId=user-a-shared`, {
      method: "PUT",
      headers: {
        "content-type": "text/plain",
        authorization: `Bearer ${a.sessionToken}`,
      },
      body: Buffer.from("tenant-a payload"),
    });
    expect(put.status).toBe(201);

    // Tenant-b cannot fetch the metadata or content — looked up scoped to
    // tenant-b, the blob is "not found".
    const meta = await fetch(`${app.httpUrl}/blobs/${blobId}`, {
      headers: { authorization: `Bearer ${b.sessionToken}` },
    });
    expect(meta.status).toBe(404);

    const content = await fetch(`${app.httpUrl}/blobs/${blobId}/content`, {
      headers: { authorization: `Bearer ${b.sessionToken}` },
    });
    expect(content.status).toBe(404);

    // Tenant-a can still read its own blob.
    const ownMeta = await fetch(`${app.httpUrl}/blobs/${blobId}`, {
      headers: { authorization: `Bearer ${a.sessionToken}` },
    });
    expect(ownMeta.status).toBe(200);
  });

  it("isolates signals across tenants on the same key", async () => {
    app = await startServer();
    // user_id is globally unique in auth_accounts (only `handle` is
    // tenant-scoped post-cleanup); use distinct user ids per tenant.
    const a = await devLogin(app.httpUrl, { userId: "user-a-shared", tenantId: "tenant-a" });
    const b = await devLogin(app.httpUrl, { userId: "user-b-shared", tenantId: "tenant-b" });

    // WebRTCSignal keys are callIds and the relay is gated on call membership
    // (calls-signal-1). Seed a real call in tenant-a created by user-a (the
    // creator is an implicit member), so the signal is allowed for user-a while
    // tenant-b — which has no such call — is denied. (productTestSchema's
    // CallRoom only declares conversationId/state/createdBy.)
    await app.store.upsertObject("tenant-a", "CallRoom", "room-1", {
      conversationId: "conv-shared",
      state: "active",
      createdBy: "user-a-shared",
    });

    const post = await postJson(
      `${app.httpUrl}/signals/WebRTCSignal/room-1`,
      { senderDeviceId: "device-shared", kind: "offer", payload: "a-only" },
      a.sessionToken,
    );
    expect(post.status).toBe(200);

    // tenant-b's user is not a member of tenant-a's call (and the call doesn't
    // exist in tenant-b), so the WebRTC signal relay denies the read outright —
    // an even stronger isolation guarantee than an empty drain.
    const drainB = await getJson(`${app.httpUrl}/signals/WebRTCSignal/room-1`, b.sessionToken);
    expect(drainB.status).toBe(403);

    const drainA = await getJson(`${app.httpUrl}/signals/WebRTCSignal/room-1`, a.sessionToken);
    expect(drainA.body.data.length).toBeGreaterThan(0);
  });

  it("allows the same handle to sign up in different tenants as distinct accounts", async () => {
    app = await startServer();

    const signupA = await postJson(`${app.httpUrl}/auth/signup`, {
      handle: "dorothy",
      displayName: "Dorothy A",
      password: "password-correct",
      tenantId: "tenant-a",
    });
    expect(signupA.status).toBe(201);

    const signupB = await postJson(`${app.httpUrl}/auth/signup`, {
      handle: "dorothy",
      displayName: "Dorothy B",
      password: "password-correct",
      tenantId: "tenant-b",
    });
    expect(signupB.status).toBe(201);

    expect(signupA.body.userId).not.toBe(signupB.body.userId);
    expect(signupA.body.tenantId).toBe("tenant-a");
    expect(signupB.body.tenantId).toBe("tenant-b");

    // Re-signup with the same handle in the same tenant collides.
    const dup = await postJson(`${app.httpUrl}/auth/signup`, {
      handle: "dorothy",
      displayName: "Dorothy A duplicate",
      password: "password-correct",
      tenantId: "tenant-a",
    });
    expect(dup.status).toBe(400);
  });

  it("dev-login with explicit tenantId pins subsequent requests to that tenant", async () => {
    app = await startServer();
    const login = await postJson(`${app.httpUrl}/auth/dev-login`, {
      userId: "user-pinned",
      tenantId: "tenant-pinned",
    });
    expect(login.status).toBe(200);
    expect(login.body.tenantId).toBe("tenant-pinned");

    // The session reads back the tenant from storage.
    const session = await app.store.readActiveSession(login.body.sessionToken);
    expect(session?.tenantId).toBe("tenant-pinned");

    // Requests with this token are scoped to tenant-pinned — tenant-a's
    // objects are invisible from this session.
    await app.store.upsertObject("tenant-a", "Conversation", "conv-a-only", {
      kind: "group",
      title: "A Only",
      createdBy: "user-other",
    });

    const listed = await getJson(
      `${app.httpUrl}/objects?type=Conversation`,
      login.body.sessionToken,
    );
    expect(listed.body.data).toEqual([]);
  });
});

async function startServer() {
  const server = createFrickServer({ port: 0, dbPath: ":memory:", schema: productTestSchema });
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

async function devLogin(
  httpUrl: string,
  body: { userId: string; tenantId?: string; deviceId?: string; replicaId?: string; platform?: string },
): Promise<{ sessionToken: string; tenantId: string }> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { sessionToken: string; tenantId: string };
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  sessionToken?: string,
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? JSON.parse(text) : undefined,
  };
}

async function getJson(url: string, sessionToken: string): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? JSON.parse(text) : undefined,
  };
}
