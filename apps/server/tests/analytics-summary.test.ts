import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("dashboard analytics summary", () => {
  it("requires dashboard authentication", async () => {
    app = await startServer();

    const response = await fetch(`${app.httpUrl}/_frick/dashboard/api/analytics/summary`);

    expect(response.status).toBe(401);
  });

  it("summarizes accepted product analytics events for the authenticated tenant", async () => {
    app = await startServer();
    const headers = await authHeaders(app.httpUrl, {
      userId: "user-ada",
      tenantId: "_default",
    });

    await postAnalytics(app.httpUrl, headers, {
      name: "screen.viewed",
      properties: { path: "/", title: "Home" },
    });
    await postAnalytics(app.httpUrl, headers, {
      name: "screen.viewed",
      properties: { path: "/", title: "Home" },
    });
    await postAnalytics(app.httpUrl, headers, {
      name: "button.clicked",
      properties: { buttonId: "compose" },
    });

    const response = await fetch(
      `${app.httpUrl}/_frick/dashboard/api/analytics/summary?windowMs=604800000`,
      { headers },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      family: "analytics.user_event",
      windowMs: 604800000,
      scope: {
        kind: "tenant",
        tenantId: "_default",
      },
      totals: {
        events: 3,
        uniqueUsers: 1,
        uniqueTenants: 1,
      },
      topEvents: [
        { name: "screen.viewed", count: 2 },
        { name: "button.clicked", count: 1 },
      ],
      topRoutes: [{ path: "/", count: 2 }],
    });
    expect(body.generatedAt).toEqual(expect.any(String));
    expect(body.recentEvents).toHaveLength(3);
    expect(body.recentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "screen.viewed",
          tenantId: "_default",
          subjectId: "user-ada",
          properties: expect.objectContaining({ path: "/" }),
        }),
        expect.objectContaining({
          name: "button.clicked",
          tenantId: "_default",
          subjectId: "user-ada",
          properties: expect.objectContaining({ buttonId: "compose" }),
        }),
      ]),
    );
  });

  it("does not expose another tenant's analytics to a tenant principal", async () => {
    app = await startServer();
    const tenantAHeaders = await authHeaders(app.httpUrl, {
      userId: "user-ada",
      tenantId: "tenant-a",
    });
    const tenantBHeaders = await authHeaders(app.httpUrl, {
      userId: "user-grace",
      tenantId: "tenant-b",
    });

    await postAnalytics(app.httpUrl, tenantAHeaders, {
      name: "screen.viewed",
      properties: { path: "/tenant-a" },
    });
    await postAnalytics(app.httpUrl, tenantBHeaders, {
      name: "screen.viewed",
      properties: { path: "/tenant-b" },
    });

    const response = await fetch(
      `${app.httpUrl}/_frick/dashboard/api/analytics/summary?windowMs=604800000`,
      { headers: tenantAHeaders },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.scope).toEqual({ kind: "tenant", tenantId: "tenant-a" });
    expect(body.totals).toMatchObject({
      events: 1,
      uniqueUsers: 1,
      uniqueTenants: 1,
    });
    expect(body.topRoutes).toEqual([{ path: "/tenant-a", count: 1 }]);
    expect(body.recentEvents).toEqual([
      expect.objectContaining({
        tenantId: "tenant-a",
        subjectId: "user-ada",
        properties: expect.objectContaining({ path: "/tenant-a" }),
      }),
    ]);
  });
});

async function startServer(options: Parameters<typeof createFrickServer>[0] = {}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    ...options,
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    server,
    close: server.close,
  };
}

async function authHeaders(
  httpUrl: string,
  input: {
    userId: string;
    tenantId: string;
  },
): Promise<Record<string, string>> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId: input.userId,
      tenantId: input.tenantId,
      deviceId: `device-${input.tenantId}`,
      replicaId: `replica-${input.tenantId}`,
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { sessionToken: string };
  return {
    authorization: `Bearer ${body.sessionToken}`,
    "content-type": "application/json",
  };
}

async function postAnalytics(
  httpUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${httpUrl}/analytics/events`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(202);
}
