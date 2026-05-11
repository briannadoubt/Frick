import { afterEach, describe, expect, it } from "vitest";
import { isFrickErrorEnvelope } from "@frick/protocol";
import { createFrickServer } from "../src/server.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("auth-flow: tenant id validation", () => {
  it("rejects signup with a path-traversal-shaped tenantId", async () => {
    app = await startServer();

    const response = await fetch(`${app.httpUrl}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Sample User",
        handle: "sample-user",
        password: "correcthorsebattery",
        tenantId: "../etc/passwd",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(isFrickErrorEnvelope(body.error)).toBe(true);
    expect(body.error.code).toBe("sync.protocolError");
    expect(body.error.details?.reason).toBe("invalidTenantId");
  });

  it("rejects signup with empty tenantId string", async () => {
    app = await startServer();

    const response = await fetch(`${app.httpUrl}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Sample User",
        handle: "sample-user",
        password: "correcthorsebattery",
        tenantId: "",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("sync.protocolError");
    expect(body.error.details?.reason).toBe("invalidTenantId");
  });

  it("accepts signup with a well-formed tenantId", async () => {
    app = await startServer();

    const response = await fetch(`${app.httpUrl}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Sample User",
        handle: "sample-user",
        password: "correcthorsebattery",
        tenantId: "tenant-good",
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.tenantId).toBe("tenant-good");
  });

  it("accepts the _default tenant (regression)", async () => {
    app = await startServer();

    const response = await fetch(`${app.httpUrl}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Default User",
        handle: "default-user",
        password: "correcthorsebattery",
        tenantId: "_default",
      }),
    });

    expect(response.status).toBe(201);
  });

  it("rejects dev-login with malformed tenantId", async () => {
    app = await startServer();

    const response = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-ada", tenantId: "../bad" }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("sync.protocolError");
    expect(body.error.details?.reason).toBe("invalidTenantId");
  });
});

describe("auth-flow: signup then dev-login cycle", () => {
  it("allows dev-login for an account created via signup in the same tenant", async () => {
    app = await startServer();

    const signup = await fetch(`${app.httpUrl}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Cycle User",
        handle: "cycle-user",
        password: "correcthorsebattery",
        tenantId: "tenant-cycle",
      }),
    });
    expect(signup.status).toBe(201);
    const signupBody = await signup.json();

    const devLogin = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: signupBody.userId,
        tenantId: "tenant-cycle",
      }),
    });
    expect(devLogin.status).toBe(200);
    const devBody = await devLogin.json();
    expect(devBody.userId).toBe(signupBody.userId);
    expect(devBody.tenantId).toBe("tenant-cycle");
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
