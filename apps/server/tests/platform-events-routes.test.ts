import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFrickServer } from "../src/server.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("platform event pipeline routes", () => {
  it("uses sqlite platform events by default and exposes authenticated inspection health", async () => {
    app = await startServer();
    await app.server.platformEvents.publish({
      family: "analytics.user_event",
      name: "message.sent",
      source: "test",
      tenantId: "_default",
    });

    const denied = await fetch(`${app.httpUrl}/_frick/inspect/platform-events`);
    expect(denied.status).toBe(401);

    const allowed = await fetch(`${app.httpUrl}/_frick/inspect/platform-events`, {
      headers: await inspectHeaders(app.httpUrl),
    });
    expect(allowed.status).toBe(200);
    const body = await allowed.json();
    expect(body).toMatchObject({
      adapter: "sqlite",
      ok: true,
      retained: expect.any(Number),
      unclaimed: expect.any(Number),
    });
    expect(body.retained).toBeGreaterThanOrEqual(1);
  });

  it("exposes mounted dashboard platform-event health with dashboard auth", async () => {
    app = await startServer();

    const denied = await fetch(`${app.httpUrl}/_frick/dashboard/api/platform-events/health`);
    expect(denied.status).toBe(401);

    const response = await fetch(`${app.httpUrl}/_frick/dashboard/api/platform-events/health`, {
      headers: await inspectHeaders(app.httpUrl),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.adapter).toBe("sqlite");
    expect(body.ok).toBe(true);
  });

  it("fails before opening storage when kafka is selected without brokers", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "frick-platform-events-kafka-"));
    const dbPath = path.join(dir, "frick.sqlite");
    try {
      expect(() =>
        createFrickServer({
          port: 0,
          dbPath,
          config: {
            dbPath,
            platformEventsDriver: "kafka",
          },
        }),
      ).toThrow(/FRICK_PLATFORM_EVENTS_KAFKA_BROKERS is required/);
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("constructs the kafka adapter lazily when brokers are configured", async () => {
    app = await startServer({
      config: {
        platformEventsDriver: "kafka",
        platformEventsKafkaBrokers: ["127.0.0.1:9092"],
      },
    });

    expect(app.server.platformEvents.adapter).toBe("kafka");
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

async function inspectHeaders(httpUrl: string): Promise<Record<string, string>> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "user-ada" }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { sessionToken: string };
  return { authorization: `Bearer ${body.sessionToken}` };
}
