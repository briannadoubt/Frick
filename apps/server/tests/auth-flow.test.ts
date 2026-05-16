import { createHash } from "node:crypto";
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

describe("auth-flow: dev-login auto-create gating", () => {
  it("auto-creates a new tenant user in development mode", async () => {
    app = await startServer();

    const response = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: "user-fresh",
        tenantId: "tenant-x",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tenantId).toBe("tenant-x");
    expect(body.userId).toBe("user-fresh");
  });

  it("emits frick.auth.dev_login_auto_create when auto-creating", async () => {
    const events: { message: string; fields?: Record<string, unknown> }[] = [];
    const buildLogger = (inherited: Record<string, unknown> = {}): {
      debug: () => void;
      info: (message: string, fields?: Record<string, unknown>) => void;
      warn: () => void;
      error: () => void;
      child: (extra: Record<string, unknown>) => ReturnType<typeof buildLogger>;
    } => ({
      debug: () => {},
      info: (message: string, fields?: Record<string, unknown>) => {
        const merged = { ...inherited, ...(fields ?? {}) };
        events.push({ message, ...(Object.keys(merged).length > 0 ? { fields: merged } : {}) });
      },
      warn: () => {},
      error: () => {},
      child: (extra) => buildLogger({ ...inherited, ...extra }),
    });
    const logger = buildLogger();

    app = await startServer({ logger });

    const response = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: "user-observed",
        tenantId: "tenant-observed",
      }),
    });
    expect(response.status).toBe(200);

    const autoCreate = events.find(
      (event) => event.fields?.event === "frick.auth.dev_login_auto_create",
    );
    expect(autoCreate).toBeDefined();
    expect(autoCreate?.fields).toMatchObject({
      tenantId: "tenant-observed",
      userId: "user-observed",
    });
    // The session token must never appear in log fields.
    const serialised = JSON.stringify(autoCreate);
    expect(serialised).not.toMatch(/sessionToken/);
  });

  it("returns auth.forbidden for dev-login when demoAuthEnabled is false (existing demo-auth gate)", async () => {
    // In production today the demo-auth gate fires first; this test pins
    // that behavior so we know the auto-create gate would only ever apply
    // if demo-auth is somehow re-enabled in production.
    app = await startServer({
      config: { env: "production", demoAuthEnabled: false, sessionTtlSeconds: 60 },
    });

    const response = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-nobody", tenantId: "tenant-x" }),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("auth.forbidden");
  });

  it("returns 401 auth.unauthenticated when demo-auth is enabled but user is missing in the default tenant", async () => {
    // Even with demoAuthEnabled=true we still keep the default-tenant rule:
    // unknown users in the default tenant must signup explicitly.
    app = await startServer();

    const response = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-nobody" }),
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(isFrickErrorEnvelope(body.error)).toBe(true);
    expect(body.error.code).toBe("auth.unauthenticated");
    expect(body.error.details?.reason).toBe("accountNotFound");
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

describe("auth-flow: session response hardening", () => {
  it("marks auth token responses no-store", async () => {
    app = await startServer();

    const signup = await fetch(`${app.httpUrl}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Cache User",
        handle: "cache-user",
        password: "correcthorsebattery",
        tenantId: "tenant-cache",
      }),
    });
    expect(signup.status).toBe(201);
    expect(signup.headers.get("cache-control")).toBe("no-store");
    expect(signup.headers.get("pragma")).toBe("no-cache");

    const login = await fetch(`${app.httpUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identity: "cache-user",
        password: "correcthorsebattery",
        tenantId: "tenant-cache",
      }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("cache-control")).toBe("no-store");

    const devLogin = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: "user-cache",
        tenantId: "tenant-cache-dev",
      }),
    });
    expect(devLogin.status).toBe(200);
    expect(devLogin.headers.get("cache-control")).toBe("no-store");
  });

  it("revokes the current bearer session on logout", async () => {
    app = await startServer();

    const login = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-ada" }),
    });
    expect(login.status).toBe(200);
    const session = await login.json();

    const beforeLogout = await fetch(`${app.httpUrl}/inbox?userId=user-ada`, {
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(beforeLogout.status).toBe(200);

    const logout = await fetch(`${app.httpUrl}/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("cache-control")).toBe("no-store");

    const afterLogout = await fetch(`${app.httpUrl}/inbox?userId=user-ada`, {
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    const body = await afterLogout.json();
    expect(afterLogout.status).toBe(401);
    expect(body.error.code).toBe("auth.unauthenticated");
  });

  it("stores only a digest of session bearer tokens in SQLite", async () => {
    app = await startServer();

    const login = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-ada" }),
    });
    expect(login.status).toBe(200);
    const session = (await login.json()) as { sessionToken: string };

    const db = app.store.rawDatabase();
    const columns = db
      .prepare(`PRAGMA table_info(auth_sessions)`)
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("session_token");
    expect(columns.map((column) => column.name)).toContain("session_token_digest");

    const row = db.prepare(`SELECT * FROM auth_sessions`).get() as Record<string, unknown>;
    expect(Object.values(row)).not.toContain(session.sessionToken);
    expect(row.session_token_digest).toBe(
      createHash("sha256").update(session.sessionToken, "utf8").digest("hex"),
    );

    const authenticated = await fetch(`${app.httpUrl}/inbox?userId=user-ada`, {
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(authenticated.status).toBe(200);
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
    store: server.store,
    close: server.close,
  };
}
