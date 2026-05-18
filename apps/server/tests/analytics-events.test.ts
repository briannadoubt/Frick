import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("POST /analytics/events", () => {
  it("requires an authenticated session", async () => {
    app = await startServer();

    const response = await fetch(`${app.httpUrl}/analytics/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "screen.viewed" }),
    });

    expect(response.status).toBe(401);
  });

  it("publishes authenticated product analytics events into the platform event pipeline", async () => {
    app = await startServer();
    const headers = await authHeaders(app.httpUrl);

    const response = await fetch(`${app.httpUrl}/analytics/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "screen.viewed",
        properties: { screen: "Home" },
        context: { path: "/", title: "Home" },
        traceId: "trace-analytics-1",
        idempotencyKey: "event-analytics-1",
        occurredAt: "2026-05-17T12:00:00.000Z",
      }),
    });

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      duplicate: false,
      eventId: expect.any(String),
      sequence: expect.any(Number),
      acceptedAt: expect.any(String),
    });

    const [delivery] = await app.server.platformEvents.claim("analytics-worker", { batchSize: 10 });
    expect(delivery?.event).toMatchObject({
      id: body.eventId,
      family: "analytics.user_event",
      name: "screen.viewed",
      source: "frick.analytics.ingest",
      tenantId: "_default",
      subjectId: "user-ada",
      traceId: "trace-analytics-1",
      idempotencyKey: "event-analytics-1",
      occurredAt: "2026-05-17T12:00:00.000Z",
      payload: {
        properties: { screen: "Home" },
        context: { path: "/", title: "Home" },
      },
      attributes: {
        deviceId: "device-analytics",
        replicaId: "replica-analytics",
      },
    });
  });

  it("deduplicates by tenant-scoped idempotency key", async () => {
    app = await startServer();
    const headers = await authHeaders(app.httpUrl);

    const first = await postAnalytics(app.httpUrl, headers, {
      name: "button.clicked",
      idempotencyKey: "duplicate-click",
    });
    const second = await postAnalytics(app.httpUrl, headers, {
      name: "button.clicked",
      idempotencyKey: "duplicate-click",
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(firstBody.duplicate).toBe(false);
    expect(secondBody).toMatchObject({
      duplicate: true,
      eventId: firstBody.eventId,
      sequence: firstBody.sequence,
    });
    expect(await app.server.platformEvents.claim("analytics-worker", { batchSize: 10 })).toHaveLength(1);
  });

  it("rejects malformed analytics payloads before publishing", async () => {
    app = await startServer();
    const headers = await authHeaders(app.httpUrl);

    const response = await postAnalytics(app.httpUrl, headers, {
      name: "screen.viewed",
      properties: ["not", "an", "object"],
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("sync.protocolError");
    expect(body.message).toContain("properties");
    expect(await app.server.platformEvents.claim("analytics-worker", { batchSize: 10 })).toEqual([]);
  });

  it.each([
    "05/17/2026",
    "2026-02-30T00:00:00.000Z",
    "2026-05-17T12:00:00Z",
  ])("rejects non-canonical occurredAt timestamps: %s", async (occurredAt) => {
    app = await startServer();
    const headers = await authHeaders(app.httpUrl);

    const response = await postAnalytics(app.httpUrl, headers, {
      name: "screen.viewed",
      occurredAt,
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("sync.protocolError");
    expect(body.message).toContain("occurredAt");
    expect(await app.server.platformEvents.claim("analytics-worker", { batchSize: 10 })).toEqual([]);
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

async function authHeaders(httpUrl: string): Promise<Record<string, string>> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId: "user-ada",
      deviceId: "device-analytics",
      replicaId: "replica-analytics",
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { sessionToken: string };
  return {
    authorization: `Bearer ${body.sessionToken}`,
    "content-type": "application/json",
  };
}

function postAnalytics(httpUrl: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${httpUrl}/analytics/events`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
