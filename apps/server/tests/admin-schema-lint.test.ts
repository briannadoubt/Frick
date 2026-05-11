import { afterEach, describe, expect, it } from "vitest";
import { foundationSchema } from "@frick/protocol";
import { createFrickServer } from "../src/server.js";

const ADMIN_TOKEN = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("POST /_frick/admin/schema/lint", () => {
  it("returns an empty result when no `previous` is supplied and the schema is clean", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/admin/schema/lint`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      findings: unknown[];
      breakingCount: number;
    };
    expect(body.findings).toEqual([]);
    expect(body.breakingCount).toBe(0);
  });

  it("reports breaking findings when `previous` carries an extra object the current schema dropped", async () => {
    app = await startServer();
    const previous = structuredClone(foundationSchema) as typeof foundationSchema;
    previous.objects = [
      ...previous.objects,
      {
        id: 9999,
        name: "DroppedType",
        fields: [{ id: 1, name: "value", kind: "string", required: true }],
        indexes: [],
      },
    ];
    const response = await fetch(`${app.httpUrl}/_frick/admin/schema/lint`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ previous }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      findings: Array<{ ruleId: string; severity: string }>;
      breakingCount: number;
    };
    expect(body.breakingCount).toBeGreaterThanOrEqual(1);
    expect(body.findings.some((f) => f.ruleId === "object.removed")).toBe(true);
  });

  it("requires admin auth", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/admin/schema/lint`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(401);
  });
});

function adminHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${ADMIN_TOKEN}`,
    "content-type": "application/json",
  };
}

async function startServer() {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    config: { adminToken: ADMIN_TOKEN },
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    close: server.close,
  };
}
