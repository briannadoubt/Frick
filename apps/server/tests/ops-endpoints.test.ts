import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFrickServer } from "../src/server.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("operational HTTP endpoints", () => {
  it("/health returns 200 with status ok", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.ok).toBe(true);
  });

  it("/ready returns 200 with schema metadata when the database is responsive", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/ready`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ready");
    expect(typeof body.schemaId).toBe("string");
    expect(typeof body.schemaRevision).toBe("number");
    expect(typeof body.schemaHash).toBe("string");
    expect(typeof body.appliedMigrations).toBe("number");
    expect(body.appliedMigrations).toBeGreaterThanOrEqual(1);
  });

  it("exposes /_frick/inspect/server in non-production with schema and runtime metadata", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/inspect/server`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      env: "development",
      demoAuthEnabled: true,
      inspectionEnabled: true,
    });
    expect(typeof body.schemaId).toBe("string");
    expect(typeof body.schemaVersion).toBe("string");
    expect(typeof body.schemaRevision).toBe("number");
    expect(typeof body.startedAt).toBe("string");
    // No secrets leak into the inspection payload.
    expect(JSON.stringify(body)).not.toContain("password");
    expect(JSON.stringify(body)).not.toContain("sessionToken");
  });

  it("exposes /_frick/inspect/migrations listing the applied ledger", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/inspect/migrations`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.applied)).toBe(true);
    expect(body.applied.length).toBeGreaterThanOrEqual(1);
    expect(body.applied[0]).toMatchObject({
      id: expect.any(String),
      schemaRevision: expect.any(Number),
      appliedAt: expect.any(String),
      checksum: expect.any(String),
      durationMs: expect.any(Number),
    });
  });

  it("exposes /_frick/inspect/db with a readiness flag and last-applied summary", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/inspect/db`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ready).toBe(true);
    expect(body.applied).toBeGreaterThanOrEqual(1);
    expect(body.lastApplied).toMatchObject({
      id: expect.any(String),
      schemaRevision: expect.any(Number),
      appliedAt: expect.any(String),
    });
  });

  it("/_frick/inspect/db reports an empty idempotency cache initially", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/inspect/db`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.idempotencyCache).toEqual({
      size: 0,
      capacity: 10000,
      evictions: 0,
    });
  });

  it("/_frick/inspect/db reflects cache growth after appends", async () => {
    app = await startServer();
    for (let i = 0; i < 3; i += 1) {
      app.store.appendEvent({
        requestId: `request-${i}`,
        replicaId: "replica-ops-test",
        stream: "MessageStream",
        streamId: "conversation-ops-test",
        event: "MessageSent",
        payload: {
          messageId: `message-ops-${i}`,
          senderId: "user-ops",
          body: "ops",
          createdAt: "2026-05-09T00:00:00.000Z",
        },
      });
    }
    const response = await fetch(`${app.httpUrl}/_frick/inspect/db`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.idempotencyCache.size).toBeGreaterThan(0);
    expect(body.idempotencyCache.capacity).toBe(10000);
    expect(body.idempotencyCache.evictions).toBe(0);
  });

  it("hides inspection routes (404) when inspectionEnabled is false", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "frick-ops-"));
    const dbPath = path.join(dir, "frick.sqlite");
    try {
      app = await startServer({
        dbPath,
        config: { env: "production", dbPath, inspectionEnabled: false },
      });
      const response = await fetch(`${app.httpUrl}/_frick/inspect/server`);
      expect(response.status).toBe(404);
    } finally {
      await app?.close();
      app = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function startServer(options: Parameters<typeof createFrickServer>[0] = {}) {
  const merged = { port: 0, dbPath: ":memory:", ...options } as Parameters<typeof createFrickServer>[0];
  const server = createFrickServer(merged);
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
