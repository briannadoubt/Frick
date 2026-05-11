import { afterEach, describe, expect, it } from "vitest";
import { isFrickErrorEnvelope } from "@frick/protocol";
import { createFrickServer } from "../src/server.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("dev-login demo auth gating", () => {
  it("accepts dev-login by default (development env)", async () => {
    app = await startServer();

    const response = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-ada" }),
    });

    expect(response.status).toBe(200);
  });

  it("returns 403 auth.forbidden when demoAuthEnabled is false (production)", async () => {
    app = await startServer({
      config: { env: "production", demoAuthEnabled: false, sessionTtlSeconds: 60 },
    });

    const response = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-ada" }),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(isFrickErrorEnvelope(body.error)).toBe(true);
    expect(body.error.code).toBe("auth.forbidden");
    expect(body.error.requestId).toBe("dev_login_disabled");
    expect(body.error.message).toContain("Demo authentication");
  });

  it("allows demoAuthEnabled override even in production (for staging-like envs)", async () => {
    const warnings: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warnings.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      app = await startServer({
        config: { env: "production", demoAuthEnabled: true },
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    const response = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-ada" }),
    });

    expect(response.status).toBe(200);
    expect(warnings.join("")).toContain("demoAuthEnabled=true in production");
  });
});

async function startServer(options: Parameters<typeof createFrickServer>[0] = {}) {
  const server = createFrickServer({ port: 0, dbPath: ":memory:", ...options });
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
