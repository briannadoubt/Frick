import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";
import { FrickStore } from "../src/store.js";
import { exportDataSubject } from "../src/compliance/data-subject-export.js";

const ADMIN_TOKEN = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";
const TENANT = "tenant-ds";
const USER = "user-erase-me";
const OTHER = "user-other";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("data-subject export", () => {
  it("exports account, sessions, inbox, push, and authored messages", () => {
    const store = seedStore();
    const result = exportDataSubject(store, TENANT, USER);

    expect(result.account).toMatchObject({ user_id: USER, handle: "erase-me" });
    expect(result.sessions).toHaveLength(1);
    expect(result.pushRegistrations).toHaveLength(1);
    expect(result.inbox).toHaveLength(1);
    expect(result.conversations).toEqual([
      { conversationId: "conv-1", role: "member" },
    ]);
    // Only the user's own messages should appear (1 of 2 total).
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.payload).toMatchObject({
      senderId: USER,
      body: "hi from me",
    });
    store.close();
  });

  it("HTTP export returns the assembled document", async () => {
    app = await startServer();
    seedRowsInto(app.store);
    const response = await fetch(
      `${app.httpUrl}/_frick/admin/data-subject?tenantId=${TENANT}&userId=${USER}`,
      { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      account: { handle: string } | null;
      messages: Array<unknown>;
    };
    expect(body.account?.handle).toBe("erase-me");
    expect(body.messages).toHaveLength(1);
  });

  it("HTTP export requires tenantId + userId", async () => {
    app = await startServer();
    const response = await fetch(
      `${app.httpUrl}/_frick/admin/data-subject?tenantId=${TENANT}`,
      { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
    );
    expect(response.status).toBe(400);
  });
});

function seedStore(): FrickStore {
  const store = new FrickStore({ path: ":memory:", seed: false });
  seedRowsInto(store);
  return store;
}

function seedRowsInto(store: FrickStore): void {
  store.tenants.ensure(TENANT);
  store.accounts.create({
    tenantId: TENANT,
    userId: USER,
    handle: "erase-me",
    displayName: "Erase Me",
    password: "correcthorse",
  });
  store.accounts.create({
    tenantId: TENANT,
    userId: OTHER,
    handle: "other",
    displayName: "Other",
    password: "correcthorse",
  });

  store.db
    .prepare(
      `INSERT INTO auth_sessions
         (session_token, tenant_id, user_id, device_id, replica_id, expires_at, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "sess-erase",
      TENANT,
      USER,
      "device-1",
      "replica-1",
      "2099-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );

  store.db
    .prepare(
      `INSERT INTO push_device_registrations
         (registration_id, tenant_id, user_id, device_id, platform, token, environment, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "push-erase",
      TENANT,
      USER,
      "device-1",
      "apns",
      "token-x",
      "production",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );

  store.inbox.upsert(TENANT, {
    conversationId: "conv-1",
    userId: USER,
    kind: "direct",
    lastSequence: 2,
    readSequence: 0,
    unreadCount: 2,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  store.appendEvent({
    tenantId: TENANT,
    requestId: "req-mine",
    replicaId: "replica-1",
    stream: "MessageStream",
    streamId: "conv-1",
    event: "MessageSent",
    payload: {
      senderId: USER,
      body: "hi from me",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  });
  store.appendEvent({
    tenantId: TENANT,
    requestId: "req-other",
    replicaId: "replica-2",
    stream: "MessageStream",
    streamId: "conv-1",
    event: "MessageSent",
    payload: {
      senderId: OTHER,
      body: "hi from other",
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  });
}

async function startServer(overrides: { env?: "development" | "test" | "production" } = {}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    config: {
      adminToken: ADMIN_TOKEN,
      ...(overrides.env ? { env: overrides.env } : {}),
    },
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
