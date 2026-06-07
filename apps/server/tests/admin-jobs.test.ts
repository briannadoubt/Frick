import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";

const ADMIN_TOKEN = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("/_frick/admin/jobs/:jobType POST", () => {
  it("admin enqueues a job and gets back the row", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    const response = await fetch(`${app.httpUrl}/_frick/admin/jobs/TestJob`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(201);
    const row = (await response.json()) as {
      id: number;
      jobType: string;
      status: string;
      tenantId: string;
    };
    expect(row.jobType).toBe("TestJob");
    expect(row.status).toBe("ready");
    expect(row.tenantId).toBe("_default");
  });

  it("payload is echoed in the stored row", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    const response = await fetch(`${app.httpUrl}/_frick/admin/jobs/TestJob`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ payload: { recipientUserId: "user-grace", kind: "message" } }),
    });
    expect(response.status).toBe(201);
    const row = (await response.json()) as { payload: { recipientUserId: string; kind: string } };
    expect(row.payload.recipientUserId).toBe("user-grace");
    expect(row.payload.kind).toBe("message");
  });

  it("fails closed before enqueueing when audit recording fails", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    (app.store.adminAudit as unknown as { record: () => never }).record = () => {
      throw new Error("audit unavailable");
    };

    const response = await fetch(`${app.httpUrl}/_frick/admin/jobs/TestJob`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ payload: { recipientUserId: "user-grace", kind: "message" } }),
    });

    expect(response.status).toBe(500);
    expect(await app.store.jobs.list({ jobType: "TestJob" })).toEqual([]);
  });

  it("non-admin bearer returns 403", async () => {
    app = await startServer({ adminToken: ADMIN_TOKEN });
    const login = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-ada" }),
    });
    const { sessionToken } = (await login.json()) as { sessionToken: string };

    const response = await fetch(`${app.httpUrl}/_frick/admin/jobs/TestJob`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(403);
  });
});

async function startServer(overrides: { adminToken?: string } = {}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    config: { ...(overrides.adminToken !== undefined ? { adminToken: overrides.adminToken } : {}) },
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
