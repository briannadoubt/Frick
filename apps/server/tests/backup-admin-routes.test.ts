import { afterEach, describe, expect, it } from "vitest";
import { isFrickErrorEnvelope } from "@frick/protocol";
import { createFrickServer } from "../src/server.js";

const ADMIN_TOKEN = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function startServer(overrides: { env?: "development" | "test" | "production" } = {}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    config: { adminToken: ADMIN_TOKEN, ...(overrides.env ? { env: overrides.env } : {}) },
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    store: server.store,
    close: server.close,
  };
}

describe("POST /_frick/admin/backup", () => {
  it("streams NDJSON with a valid header line for an admin caller", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/admin/backup`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tenantId: "_default" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toMatch(/x-ndjson/);
    const text = await response.text();
    const lines = text.split("\n").filter((l) => l.length > 0);
    const header = JSON.parse(lines[0]!) as { type: string; row: { frickFormat: number } };
    expect(header.type).toBe("header");
    expect(header.row.frickFormat).toBe(1);
  });

  it("is denied for an unauthenticated caller", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/admin/backup`, { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("returns 400 for malformed JSON while keeping empty body defaults", async () => {
    app = await startServer();
    const malformed = await fetch(`${app.httpUrl}/_frick/admin/backup`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: "{",
    });
    expect(malformed.status).toBe(400);

    const empty = await fetch(`${app.httpUrl}/_frick/admin/backup`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      body: "",
    });
    expect(empty.status).toBe(200);
  });

  it("fails closed when backup audit recording fails", async () => {
    app = await startServer();
    (app.store.adminAudit as unknown as { record: () => never }).record = () => {
      throw new Error("audit unavailable");
    };

    const response = await fetch(`${app.httpUrl}/_frick/admin/backup`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tenantId: "_default" }),
    });

    expect(response.status).toBe(500);
  });
});

describe("POST /_frick/admin/restore", () => {
  it("refuses without ?confirm=yes", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/admin/restore`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      body: "",
    });
    expect(response.status).toBe(400);
  });

  it("refuses in production mode with auth.forbidden envelope", async () => {
    app = await startServer({ env: "production" });
    const response = await fetch(
      `${app.httpUrl}/_frick/admin/restore?confirm=yes`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        body: "",
      },
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(isFrickErrorEnvelope(body.error)).toBe(true);
    expect(body.error.code).toBe("auth.forbidden");
    expect(body.error.details?.reason).toBe("restoreNotAllowedInProduction");
  });

  it("round-trips dump output back through restore", async () => {
    app = await startServer();
    app.store.upsertObject("_default", "User", "user-backup", { displayName: "Backup" });
    const backup = await fetch(`${app.httpUrl}/_frick/admin/backup`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tenantId: "_default" }),
    });
    const ndjson = await backup.text();
    const restore = await fetch(
      `${app.httpUrl}/_frick/admin/restore?confirm=yes&overwrite=true`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/x-ndjson",
        },
        body: ndjson,
      },
    );
    expect(restore.status).toBe(200);
    const report = (await restore.json()) as {
      rowCountsByType: Record<string, number>;
      schemaCompatibility: { matched: boolean };
    };
    expect(report.schemaCompatibility.matched).toBe(true);
    expect(report.rowCountsByType.objects).toBeGreaterThanOrEqual(1);
  });
});
