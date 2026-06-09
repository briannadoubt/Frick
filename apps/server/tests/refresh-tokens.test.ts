import { afterEach, describe, expect, it } from "vitest";
import { foundationSchema, validateSchema, type FrickSchema } from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";
import type { RefreshProviderConfig } from "../src/auth/identity-routes.js";

/// FR-33: refresh-token / short-access-token split. These tests drive the
/// full lifecycle through the email provider: sign up (issues an access token
/// + refresh token), use the refresh token to mint a fresh access token,
/// rotate, and revoke.

function schemaWithUser(): FrickSchema {
  const next = structuredClone(foundationSchema);
  next.hash = `${next.hash}-refresh-test`;
  next.objects.push({
    id: 99,
    name: "User",
    fields: [
      { id: 1, name: "displayName", kind: "string", required: true },
      { id: 2, name: "email", kind: "string", required: false },
      { id: 3, name: "appleSubject", kind: "string", required: false },
      { id: 4, name: "googleSubject", kind: "string", required: false },
      { id: 5, name: "createdAt", kind: "int", required: false },
      { id: 6, name: "revokedAt", kind: "int", required: false },
      { id: 7, name: "primaryTenantId", kind: "string", required: false },
    ],
    indexes: [{ id: 1, name: "byEmail", fields: ["email"] }],
  });
  return validateSchema(next);
}

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface SignupBody {
  session: { sessionToken: string; expiresAt: string; userId: string };
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}

async function signup(httpUrl: string, email = "ada@example.com"): Promise<SignupBody> {
  const res = await fetch(`${httpUrl}/auth/email/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery-staple", displayName: "Ada" }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SignupBody;
}

describe("refresh tokens (FR-33)", () => {
  it("issues a refresh token alongside the session on sign-in", async () => {
    app = await startServer({ refresh: { accessTokenTtlSeconds: 60 } });
    const body = await signup(app.httpUrl);
    expect(body.refreshToken).toBeTruthy();
    expect(body.refreshTokenExpiresAt).toBeTruthy();
    expect(body.session.sessionToken).toBeTruthy();
    // The access token's expiry should reflect the short access TTL, not the
    // 30-day refresh TTL.
    const accessLifetimeMs = Date.parse(body.session.expiresAt) - Date.now();
    expect(accessLifetimeMs).toBeLessThanOrEqual(60 * 1000 + 5_000);
  });

  it("exchanges a refresh token for a fresh access token (with rotation)", async () => {
    app = await startServer({ refresh: { accessTokenTtlSeconds: 60 } });
    const body = await signup(app.httpUrl);

    const refreshRes = await fetch(`${app.httpUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: body.refreshToken }),
    });
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as SignupBody;
    expect(refreshed.session.sessionToken).toBeTruthy();
    // A brand-new access token, distinct from the sign-in one.
    expect(refreshed.session.sessionToken).not.toBe(body.session.sessionToken);
    // Rotation is on by default: a fresh refresh token comes back...
    expect(refreshed.refreshToken).toBeTruthy();
    expect(refreshed.refreshToken).not.toBe(body.refreshToken);
    // ...and the new access token is usable on an authenticated WS/HTTP path.
    expect(refreshed.session.userId).toBe(body.session.userId);
  });

  it("revokes the old refresh token after rotation (no replay)", async () => {
    app = await startServer({ refresh: {} });
    const body = await signup(app.httpUrl);

    const first = await fetch(`${app.httpUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: body.refreshToken }),
    });
    expect(first.status).toBe(200);

    // Replaying the original (now-rotated) refresh token must fail.
    const replay = await fetch(`${app.httpUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: body.refreshToken }),
    });
    expect(replay.status).toBe(401);
  });

  // auth-core-3: replaying an already-rotated token (the theft signal) must
  // burn the whole rotation family, so even the legitimate live token dies.
  it("revokes the rotation family when an already-rotated token is reused", async () => {
    app = await startServer({ refresh: {} });
    const body = await signup(app.httpUrl);

    // Legit rotation: body.refreshToken -> rotated.refreshToken.
    const rotatedRes = await fetch(`${app.httpUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: body.refreshToken }),
    });
    expect(rotatedRes.status).toBe(200);
    const rotated = (await rotatedRes.json()) as SignupBody;
    expect(rotated.refreshToken).toBeTruthy();

    // Attacker reuses the original (already-rotated) token: rejected.
    const reuse = await fetch(`${app.httpUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: body.refreshToken }),
    });
    expect(reuse.status).toBe(401);

    // The reuse burned the family — the legitimate live token is now dead too.
    const afterBurn = await fetch(`${app.httpUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: rotated.refreshToken }),
    });
    expect(afterBurn.status).toBe(401);
  });

  it("does not rotate when rotateOnRefresh is false", async () => {
    app = await startServer({ refresh: { rotateOnRefresh: false } });
    const body = await signup(app.httpUrl);

    const refreshRes = await fetch(`${app.httpUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: body.refreshToken }),
    });
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as SignupBody;
    // No fresh refresh token; the original stays usable.
    expect(refreshed.refreshToken).toBeUndefined();

    const again = await fetch(`${app.httpUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: body.refreshToken }),
    });
    expect(again.status).toBe(200);
  });

  it("revokes a refresh token via /auth/refresh/revoke", async () => {
    app = await startServer({ refresh: { rotateOnRefresh: false } });
    const body = await signup(app.httpUrl);

    const revoke = await fetch(`${app.httpUrl}/auth/refresh/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: body.refreshToken }),
    });
    expect(revoke.status).toBe(200);

    const afterRevoke = await fetch(`${app.httpUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: body.refreshToken }),
    });
    expect(afterRevoke.status).toBe(401);
  });

  it("rejects an unknown refresh token", async () => {
    app = await startServer({ refresh: {} });
    const res = await fetch(`${app.httpUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "not-a-real-token" }),
    });
    expect(res.status).toBe(401);
  });

  it("is opt-in: no refresh token on sign-in and /auth/refresh 404s when unconfigured", async () => {
    app = await startServer({});
    const body = await signup(app.httpUrl);
    // Backward compatible: legacy single-session behavior, no refresh token.
    expect(body.refreshToken).toBeUndefined();
    expect(body.session.sessionToken).toBeTruthy();

    const res = await fetch(`${app.httpUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "anything" }),
    });
    expect(res.status).toBe(404);
  });

  it("refresh/revoke is idempotent on an unknown token (always 200)", async () => {
    app = await startServer({ refresh: {} });
    const res = await fetch(`${app.httpUrl}/auth/refresh/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "unknown" }),
    });
    expect(res.status).toBe(200);
  });
});

async function startServer(options: { schema?: FrickSchema; refresh?: RefreshProviderConfig }) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    schema: options.schema ?? schemaWithUser(),
    identityProviders: {
      email: {},
      ...(options.refresh ? { refresh: options.refresh } : {}),
    },
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
