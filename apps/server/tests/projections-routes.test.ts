import { afterEach, describe, expect, it } from "vitest";
import { productTestSchema } from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";
import { deny, type FrickPolicyHook } from "../src/authz.js";
import type { FrickProjection } from "../src/projections/registry.js";

// The conversation-inbox projection that the previous version of this
// suite exercised was removed with the framework boundary cleanup
// (CHANGELOG: "Removed framework-owned chat routes, projections, search
// indexes, scheduled-message sweep logic, and conversation inbox storage
// from the server runtime"). The routes themselves (/projections,
// /projections/:name, /_frick/admin/projections/:name/rebuild,
// /_frick/inspect/projections) still exist, so this suite drives them
// against a test-registered "demo-inbox" projection.

const ADMIN_TOKEN = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface DemoInboxRow {
  userId: string;
  conversationId: string;
  unreadCount: number;
}

function createDemoInboxProjection(): FrickProjection {
  const rows = new Map<string, DemoInboxRow>();
  return {
    name: "demo-inbox",
    sources: [
      { kind: "stream", type: "MessageStream" },
      { kind: "object", type: "RoomMember" },
    ],
    handler: {
      apply() {
        // Trivial: never grows from events — we manually upsert below to
        // exercise the read path.
      },
      read(_ctx, query) {
        const userId = typeof query.userId === "string" ? query.userId : undefined;
        const out: DemoInboxRow[] = [];
        for (const row of rows.values()) {
          if (userId === undefined || row.userId === userId) out.push(row);
        }
        return out;
      },
      rebuild() {
        rows.clear();
      },
      // Test hook: lets the test seed rows without an event firing.
      __setRows(input: DemoInboxRow[]) {
        rows.clear();
        for (const row of input) {
          rows.set(`${row.userId}:${row.conversationId}`, row);
        }
      },
    } as FrickProjection["handler"] & { __setRows(rows: DemoInboxRow[]): void },
  };
}

describe("/projections HTTP routes", () => {
  it("lists registered projections", async () => {
    app = await startServer({ extraProjections: [createDemoInboxProjection()] });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const response = await fetch(`${app.httpUrl}/projections`, {
      headers: authHeaders(login.sessionToken),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      projections: Array<{ name: string; sources: unknown[] }>;
    };
    const names = body.projections.map((p) => p.name);
    expect(names).toContain("demo-inbox");
    const inbox = body.projections.find((p) => p.name === "demo-inbox");
    expect(inbox?.sources).toEqual(
      expect.arrayContaining([
        { kind: "stream", type: "MessageStream" },
        { kind: "object", type: "RoomMember" },
      ]),
    );
  });

  it("serves the projection read endpoint scoped to the principal's userId", async () => {
    const projection = createDemoInboxProjection();
    app = await startServer({ extraProjections: [projection] });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    (projection.handler as { __setRows: (rows: DemoInboxRow[]) => void }).__setRows([
      { userId: login.userId, conversationId: "c1", unreadCount: 2 },
      { userId: "user-grace", conversationId: "c1", unreadCount: 5 },
    ]);

    const response = await fetch(
      `${app.httpUrl}/projections/demo-inbox?userId=${login.userId}`,
      { headers: authHeaders(login.sessionToken) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { projection: string; data: DemoInboxRow[] };
    expect(body.projection).toBe("demo-inbox");
    expect(body.data.map((row) => row.userId)).toEqual([login.userId]);
  });

  // The previous "rejects another userId" test was removed: the framework
  // no longer inspects `userId` query params on projection reads (apps own
  // that filter inside `handler.read(...)` or via a policy hook keyed on
  // the resource `key`). The framework contract checked here — that
  // `assertCanSubscribe` runs and that policy hooks compose — is covered
  // by the next case.

  it("applies custom projection policy hooks before HTTP reads", async () => {
    const denyPrivateProjection: FrickPolicyHook = (input) =>
      input.action === "projection.read" && input.resource.name === "private-projection"
        ? deny("notAuthorizedForResource", "Projection is private")
        : null;
    app = await startServer({
      policyHooks: [denyPrivateProjection],
      extraProjections: [privateProjection],
    });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const response = await fetch(`${app.httpUrl}/projections/private-projection`, {
      headers: authHeaders(login.sessionToken),
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.details.reason).toBe("notAuthorizedForResource");
  });

  it("returns 404 envelope for an unknown projection name", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const response = await fetch(`${app.httpUrl}/projections/no-such-projection`, {
      headers: authHeaders(login.sessionToken),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: { code: string; details?: { reason?: string; projection?: string } };
    };
    expect(body.error.code).toBeDefined();
    expect(body.error.details?.reason).toBe("projectionNotFound");
    expect(body.error.details?.projection).toBe("no-such-projection");
  });

  it("returns 401 without a session token", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/projections`);
    expect(response.status).toBe(401);
  });

  it("rebuilds a projection via admin route and returns the timestamp", async () => {
    app = await startServer({
      adminToken: ADMIN_TOKEN,
      extraProjections: [createDemoInboxProjection()],
    });
    const response = await fetch(
      `${app.httpUrl}/_frick/admin/projections/demo-inbox/rebuild`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      projection: string;
      tenantId: string;
      rebuiltAt: string;
    };
    expect(body.projection).toBe("demo-inbox");
    expect(body.tenantId).toBe("_default");
    expect(typeof body.rebuiltAt).toBe("string");
  });

  it("admin rebuild fails closed before running the handler when audit recording fails", async () => {
    const projection = createDemoInboxProjection();
    app = await startServer({
      adminToken: ADMIN_TOKEN,
      extraProjections: [projection],
    });
    let rebuildCalls = 0;
    (projection.handler as unknown as { rebuild: () => void }).rebuild = () => {
      rebuildCalls += 1;
    };
    (app.store.adminAudit as unknown as { record: () => never }).record = () => {
      throw new Error("audit unavailable");
    };

    const response = await fetch(
      `${app.httpUrl}/_frick/admin/projections/demo-inbox/rebuild`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      },
    );

    expect(response.status).toBe(500);
    expect(rebuildCalls).toBe(0);
  });

  it("admin rebuild rejects non-admin sessions with 403", async () => {
    app = await startServer({
      adminToken: ADMIN_TOKEN,
      extraProjections: [createDemoInboxProjection()],
    });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const response = await fetch(
      `${app.httpUrl}/_frick/admin/projections/demo-inbox/rebuild`,
      {
        method: "POST",
        headers: authHeaders(login.sessionToken),
      },
    );
    expect(response.status).toBe(403);
  });

  it("admin rebuild returns 404 envelope for unknown projection", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    const response = await fetch(
      `${app.httpUrl}/_frick/admin/projections/no-such-projection/rebuild`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      },
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: { details?: { reason?: string } };
    };
    expect(body.error.details?.reason).toBe("projectionNotFound");
  });

  it("exposes /_frick/inspect/projections when inspection is enabled", async () => {
    app = await startServer({
      inspectionEnabled: true,
      extraProjections: [createDemoInboxProjection()],
    });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const response = await fetch(`${app.httpUrl}/_frick/inspect/projections`, {
      headers: authHeaders(login.sessionToken),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      projections: Array<{
        name: string;
        sources: unknown[];
        supportsRebuild: boolean;
        supportsRead: boolean;
      }>;
    };
    const inbox = body.projections.find((p) => p.name === "demo-inbox");
    expect(inbox).toMatchObject({
      name: "demo-inbox",
      supportsRebuild: true,
      supportsRead: true,
    });
  });
});

async function startServer(
  overrides: {
    adminToken?: string;
    inspectionEnabled?: boolean;
    policyHooks?: readonly FrickPolicyHook[];
    extraProjections?: readonly FrickProjection[];
  } = {},
) {
  const config: Record<string, unknown> = {};
  if (overrides.adminToken !== undefined) config.adminToken = overrides.adminToken;
  if (overrides.inspectionEnabled !== undefined)
    config.inspectionEnabled = overrides.inspectionEnabled;

  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    schema: productTestSchema,
    config,
    ...(overrides.policyHooks !== undefined ? { policyHooks: overrides.policyHooks } : {}),
  });
  // No `projections` option on createFrickServer; register on the store
  // before listening so the HTTP routes pick them up via the shared registry.
  for (const p of overrides.extraProjections ?? []) {
    server.store.projections.register(p);
  }
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
  body: { userId: string; tenantId?: string },
): Promise<{ sessionToken: string; userId: string }> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { sessionToken: string; userId: string };
}

function authHeaders(sessionToken: string): Record<string, string> {
  return { authorization: `Bearer ${sessionToken}` };
}

const privateProjection: FrickProjection = {
  name: "private-projection",
  sources: [{ kind: "stream", type: "MessageStream" }],
  handler: {
    apply() {},
    read() {
      return [{ id: "private-row" }];
    },
  },
};
