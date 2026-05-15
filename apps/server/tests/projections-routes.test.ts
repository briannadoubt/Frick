import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";

const ADMIN_TOKEN = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("/projections HTTP routes", () => {
  it("lists registered projections including conversation-inbox", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const response = await fetch(`${app.httpUrl}/projections`, {
      headers: authHeaders(login.sessionToken),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      projections: Array<{ name: string; sources: unknown[] }>;
    };
    const names = body.projections.map((p) => p.name);
    expect(names).toContain("conversation-inbox");
    const inbox = body.projections.find((p) => p.name === "conversation-inbox");
    expect(inbox?.sources).toEqual(
      expect.arrayContaining([
        { kind: "stream", type: "MessageStream" },
        { kind: "object", type: "RoomMember" },
      ]),
    );
  });

  it("serves conversation-inbox read with the same data as /inbox", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const inboxResp = await fetch(`${app.httpUrl}/inbox?userId=user-ada`, {
      headers: authHeaders(login.sessionToken),
    });
    const projectionResp = await fetch(
      `${app.httpUrl}/projections/conversation-inbox?userId=user-ada`,
      { headers: authHeaders(login.sessionToken) },
    );

    expect(inboxResp.status).toBe(200);
    expect(projectionResp.status).toBe(200);
    const inboxBody = (await inboxResp.json()) as { data: unknown };
    const projectionBody = (await projectionResp.json()) as {
      projection: string;
      data: unknown;
    };
    expect(projectionBody.projection).toBe("conversation-inbox");
    expect(projectionBody.data).toEqual(inboxBody.data);
  });

  it("rejects conversation-inbox reads for another userId", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const response = await fetch(
      `${app.httpUrl}/projections/conversation-inbox?userId=user-grace`,
      { headers: authHeaders(login.sessionToken) },
    );

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
    app = await startServer({ adminToken: ADMIN_TOKEN });
    const response = await fetch(
      `${app.httpUrl}/_frick/admin/projections/conversation-inbox/rebuild`,
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
    expect(body.projection).toBe("conversation-inbox");
    expect(body.tenantId).toBe("_default");
    expect(typeof body.rebuiltAt).toBe("string");
  });

  it("admin rebuild fails closed before running the handler when audit recording fails", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    const projection = app.store.projections.get("conversation-inbox");
    expect(projection).toBeDefined();
    let rebuildCalls = 0;
    (projection!.handler as unknown as { rebuild: () => void }).rebuild = () => {
      rebuildCalls += 1;
    };
    (app.store.adminAudit as unknown as { record: () => never }).record = () => {
      throw new Error("audit unavailable");
    };

    const response = await fetch(
      `${app.httpUrl}/_frick/admin/projections/conversation-inbox/rebuild`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      },
    );

    expect(response.status).toBe(500);
    expect(rebuildCalls).toBe(0);
  });

  it("admin rebuild rejects non-admin sessions with 403", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const response = await fetch(
      `${app.httpUrl}/_frick/admin/projections/conversation-inbox/rebuild`,
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
    app = await startServer({ inspectionEnabled: true });
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
    const inbox = body.projections.find((p) => p.name === "conversation-inbox");
    expect(inbox).toMatchObject({
      name: "conversation-inbox",
      supportsRebuild: true,
      supportsRead: true,
    });
  });
});

async function startServer(
  overrides: { adminToken?: string; inspectionEnabled?: boolean } = {},
) {
  const config: Record<string, unknown> = {};
  if (overrides.adminToken !== undefined) config.adminToken = overrides.adminToken;
  if (overrides.inspectionEnabled !== undefined)
    config.inspectionEnabled = overrides.inspectionEnabled;
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    config,
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
