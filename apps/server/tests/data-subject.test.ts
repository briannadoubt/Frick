import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";
import { FrickStore } from "../src/store.js";
import { exportDataSubject } from "../src/compliance/data-subject-export.js";
import { eraseDataSubject } from "../src/compliance/data-subject-erase.js";
import { createMessagesSearchIndex, MESSAGES_SEARCH_INDEX_NAME } from "../src/search/messages-index.js";

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

  it("erase pseudonymizes account, blanks message bodies, deletes session & push", () => {
    const store = seedStore();
    const report = eraseDataSubject(store, TENANT, USER);

    expect(report.deleted.auth_sessions).toBe(1);
    expect(report.deleted.push_device_registrations).toBe(1);
    expect(report.deleted.idempotency_keys).toBe(1);
    expect(report.pseudonymized.auth_accounts).toBe(1);
    expect(report.pseudonymized.stream_events).toBe(1);

    const account = store.db
      .prepare(`SELECT handle, display_name, password_hash FROM auth_accounts WHERE user_id = ?`)
      .get(USER) as { handle: string; display_name: string; password_hash: string };
    expect(account.handle).toBe(`erased-${USER}`);
    expect(account.display_name).toBe("Erased user");
    expect(account.password_hash).toBe("");

    expect(
      store.db
        .prepare(`SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?`)
        .get(USER),
    ).toEqual({ n: 0 });
    expect(
      store.db
        .prepare(`SELECT COUNT(*) AS n FROM push_device_registrations WHERE user_id = ?`)
        .get(USER),
    ).toEqual({ n: 0 });

    const events = store.streams.read(TENANT, "MessageStream", "conv-1", 0);
    const senderMap = events.map((e) => ({
      senderId: (e.payload as { senderId: unknown }).senderId,
      body: (e.payload as { body: unknown }).body,
    }));
    expect(senderMap).toContainEqual({ senderId: null, body: null });
    expect(senderMap).toContainEqual({ senderId: OTHER, body: "hi from other" });
    store.close();
  });

  it("erase removes authored message text from search while keeping other messages searchable", () => {
    const store = seedStore();
    try {
      expect(
        store.searchAdapter.query(TENANT, {
          index: MESSAGES_SEARCH_INDEX_NAME,
          q: "me",
          limit: 10,
        }).total,
      ).toBe(1);
      expect(
        store.searchAdapter.query(TENANT, {
          index: MESSAGES_SEARCH_INDEX_NAME,
          q: "other",
          limit: 10,
        }).total,
      ).toBe(1);

      eraseDataSubject(store, TENANT, USER);

      expect(
        store.searchAdapter.query(TENANT, {
          index: MESSAGES_SEARCH_INDEX_NAME,
          q: "me",
          limit: 10,
        }).total,
      ).toBe(0);
      expect(
        store.searchAdapter.query(TENANT, {
          index: MESSAGES_SEARCH_INDEX_NAME,
          q: "other",
          limit: 10,
        }).total,
      ).toBe(1);
      expect(
        store.db
          .prepare(`SELECT COUNT(*) AS n FROM search_indexes WHERE tenant_id = ? AND text LIKE ?`)
          .get(TENANT, "%hi from me%"),
      ).toEqual({ n: 0 });
    } finally {
      store.close();
    }
  });

  it("erase deletes idempotency keys only for events authored by the erased user", () => {
    const store = seedStore();
    try {
      expect(
        store.db
          .prepare(`SELECT COUNT(*) AS n FROM idempotency_keys WHERE tenant_id = ?`)
          .get(TENANT),
      ).toEqual({ n: 2 });

      const report = eraseDataSubject(store, TENANT, USER);

      expect(report.deleted.idempotency_keys).toBe(1);
      expect(
        store.db
          .prepare(
            `SELECT replica_id, request_id FROM idempotency_keys WHERE tenant_id = ? ORDER BY replica_id ASC`,
          )
          .all(TENANT),
      ).toEqual([{ replica_id: "replica-2", request_id: "req-other" }]);
    } finally {
      store.close();
    }
  });

  it("HTTP erase refuses in production without ?confirm=yes", async () => {
    app = await startServer({ env: "production" });
    const response = await fetch(
      `${app.httpUrl}/_frick/admin/data-subject/erase?tenantId=${TENANT}&userId=${USER}`,
      { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
    );
    expect(response.status).toBe(412);
    const body = await response.json();
    expect(body.error).toBe("confirmation_required");
  });

  it("HTTP erase allowed in production with ?confirm=yes", async () => {
    app = await startServer({ env: "production" });
    seedRowsInto(app.store);
    const response = await fetch(
      `${app.httpUrl}/_frick/admin/data-subject/erase?tenantId=${TENANT}&userId=${USER}&confirm=yes`,
      { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { deleted: Record<string, number> };
    expect(body.deleted.auth_sessions).toBe(1);
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
  store.searchIndexes.register(createMessagesSearchIndex());
  store.searchAdapter.registerIndex(createMessagesSearchIndex());
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

  store.createSession({
    sessionToken: "sess-erase",
    tenantId: TENANT,
    userId: USER,
    deviceId: "device-1",
    replicaId: "replica-1",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });

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
