import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type KeyLike,
} from "jose";
import type { FrickSchema } from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";

/**
 * Integration test for Frick's identityProviders.apple surface:
 *
 *   POST /auth/apple/verify
 *   POST /auth/apple/notifications
 *
 * The verify path mints sessions; the notifications path applies
 * email-updated / consent-revoked / account-delete events. Real Apple
 * JWKS is unreachable in CI, so we stand up a local keypair and inject
 * it through the `appleJwksOverride` test seam.
 *
 * A small test-only schema declares the User/TenantMembership shapes
 * Frick reads through its config — apps can put these fields anywhere,
 * but the field names here match the framework defaults.
 */

const APPLE_AUDIENCE = "com.test.crate";
const APPLE_ISSUER = "https://appleid.apple.com";
const GOOGLE_AUDIENCE = "111-test.apps.googleusercontent.com";
const GOOGLE_ISSUER = "https://accounts.google.com";

const testSchema: FrickSchema = {
  name: "identity-test",
  schemaId: "identity-test",
  schemaVersion: "0.1.0",
  schemaRevision: 1,
  minimumClientRevision: 1,
  minimumServerRevision: 1,
  protocol: "frick.realtime",
  protocolVersion: 1,
  compatibility: "greenfield-cutover",
  hash: "identity-test-0.1.0",
  objects: [
    {
      id: 1,
      name: "User",
      fields: [
        { id: 1, name: "displayName", kind: "string", required: true },
        { id: 2, name: "email", kind: "string", required: false },
        { id: 3, name: "appleSubject", kind: "string", required: false },
        { id: 4, name: "googleSubject", kind: "string", required: false },
        { id: 5, name: "createdAt", kind: "timestamp", required: true },
        { id: 6, name: "revokedAt", kind: "timestamp", required: false },
        { id: 7, name: "primaryTenantId", kind: "string", required: false },
      ],
      indexes: [{ id: 1, name: "byAppleSubject", fields: ["appleSubject"] }],
    },
    {
      id: 2,
      name: "TenantMembership",
      fields: [
        { id: 1, name: "tenantId", kind: "string", required: true },
        { id: 2, name: "userId", kind: "ref", ref: "User", required: true },
        { id: 3, name: "role", kind: "string", required: true },
        { id: 4, name: "joinedAt", kind: "timestamp", required: true },
      ],
      indexes: [{ id: 1, name: "byUser", fields: ["userId"] }],
    },
  ],
  streams: [],
  events: [],
  presences: [],
  signals: [],
  blobs: [],
  jobs: [],
  projections: [],
};

let app: ReturnType<typeof createFrickServer>;
let signingKey: KeyLike;
let kid: string;
let testJwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  signingKey = privateKey;
  kid = "test-key-1";
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  testJwks = createLocalJWKSet({ keys: [jwk] });

  app = createFrickServer({
    schema: testSchema,
    port: 0,
    dbPath: ":memory:",
    config: { env: "test" },
    jobs: { workerEnabled: false },
    identityProviders: {
      apple: { audience: APPLE_AUDIENCE },
      email: { minPasswordLength: 8 },
      google: { clientId: GOOGLE_AUDIENCE },
      appleJwksOverride: testJwks,
      googleJwksOverride: testJwks,
      onFirstSignIn: async ({ subject }) => ({
        tenantId: `tenant-${subject}`,
      }),
    },
  });
  await app.listen();
});

afterAll(async () => {
  await app.close();
});

async function signIdentity(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(APPLE_ISSUER)
    .setAudience(APPLE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
}

async function signNotification(events: Record<string, unknown>): Promise<string> {
  return new SignJWT({ events: JSON.stringify(events) })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(APPLE_ISSUER)
    .setAudience(APPLE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${app.httpUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function signInUser(subject: string, name: string): Promise<{ userId: string; tenantId: string }> {
  const idToken = await signIdentity({ sub: subject, email: `${subject}@example.test` });
  const res = await post("/auth/apple/verify", { identityToken: idToken, fullName: { givenName: name } });
  expect(res.status).toBe(200);
  return { userId: res.body.user.id as string, tenantId: res.body.session.tenantId as string };
}

describe("Frick identityProviders.apple", () => {
  it("first sign-in creates a User row + mints a session", async () => {
    const { userId, tenantId } = await signInUser("apple-sub-1", "Alice");
    expect(userId).toMatch(/^user-/);
    expect(tenantId).toBe("tenant-apple-sub-1");
  });

  it("returning sign-in reuses the same User + tenant", async () => {
    const first = await signInUser("apple-sub-returning", "Bob");
    const second = await signInUser("apple-sub-returning", "Bob");
    expect(second.userId).toBe(first.userId);
    expect(second.tenantId).toBe(first.tenantId);
  });

  it("email-updated notification overwrites User.email", async () => {
    const { userId } = await signInUser("apple-sub-email", "Carol");
    const jwt = await signNotification({
      type: "email-updated",
      sub: "apple-sub-email",
      email: "carol-new@example.test",
      event_time: Date.now(),
    });
    const res = await post("/auth/apple/notifications", { payload: jwt });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: true, type: "email-updated" });
    const user = app.store.readObject("_default", "User", userId) as { email?: string };
    expect(user.email).toBe("carol-new@example.test");
  });

  it("consent-revoked sets revokedAt, kills sessions, blocks re-signin", async () => {
    const { userId } = await signInUser("apple-sub-revoke", "Dave");
    const jwt = await signNotification({
      type: "consent-revoked",
      sub: "apple-sub-revoke",
      event_time: Date.now(),
    });
    const res = await post("/auth/apple/notifications", { payload: jwt });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: true, sessionsKilled: 1 });

    const idToken = await signIdentity({ sub: "apple-sub-revoke", email: "x@y.z" });
    const blocked = await post("/auth/apple/verify", { identityToken: idToken });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("user_revoked");
  });

  it("account-delete behaves the same as consent-revoked", async () => {
    await signInUser("apple-sub-deleted", "Eve");
    const jwt = await signNotification({
      type: "account-delete",
      sub: "apple-sub-deleted",
      event_time: Date.now(),
    });
    const res = await post("/auth/apple/notifications", { payload: jwt });
    expect(res.body).toMatchObject({ applied: true, type: "account-delete" });
  });

  it("unknown subject returns 200 + applied:false", async () => {
    const jwt = await signNotification({
      type: "email-updated",
      sub: "never-existed",
      email: "x@y.z",
      event_time: Date.now(),
    });
    const res = await post("/auth/apple/notifications", { payload: jwt });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: false, reason: "unknown_user" });
  });

  it("rejects malformed identity token", async () => {
    const res = await post("/auth/apple/verify", { identityToken: "not.a.jwt" });
    expect(res.status).toBe(401);
  });

  it("rejects empty identity token with 400", async () => {
    const res = await post("/auth/apple/verify", {});
    expect(res.status).toBe(400);
  });
});

describe("Frick identityProviders.email", () => {
  it("signup creates a User row + account + mints a session", async () => {
    const res = await post("/auth/email/signup", {
      email: "alice@example.test",
      password: "correcthorsebattery",
      displayName: "Alice",
    });
    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.session.tenantId).toBe("tenant-alice@example.test");
    expect(res.body.user.email).toBe("alice@example.test");
  });

  it("signup rejects too-short passwords with 400", async () => {
    const res = await post("/auth/email/signup", {
      email: "x@y.z",
      password: "short",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("password_too_short");
  });

  it("signup rejects malformed emails with 400", async () => {
    const res = await post("/auth/email/signup", {
      email: "not-an-email",
      password: "longenoughpassword",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_email");
  });

  it("signup is idempotent on email — 409 on duplicate", async () => {
    await post("/auth/email/signup", {
      email: "dup@example.test",
      password: "correcthorsebattery",
    });
    const second = await post("/auth/email/signup", {
      email: "dup@example.test",
      password: "correcthorsebattery",
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("email_already_registered");
  });

  it("login with correct password returns the same tenant", async () => {
    await post("/auth/email/signup", {
      email: "login@example.test",
      password: "correcthorsebattery",
    });
    const login = await post("/auth/email/login", {
      email: "login@example.test",
      password: "correcthorsebattery",
    });
    expect(login.status).toBe(200);
    expect(login.body.isNewUser).toBe(false);
    expect(login.body.session.tenantId).toBe("tenant-login@example.test");
  });

  it("login with wrong password returns 401 invalid_credentials", async () => {
    await post("/auth/email/signup", {
      email: "wrongpw@example.test",
      password: "correcthorsebattery",
    });
    const login = await post("/auth/email/login", {
      email: "wrongpw@example.test",
      password: "wrong",
    });
    expect(login.status).toBe(401);
    expect(login.body.error).toBe("invalid_credentials");
  });

  it("login with unknown email returns 401 invalid_credentials (no email enumeration)", async () => {
    const login = await post("/auth/email/login", {
      email: "ghost@example.test",
      password: "whatever",
    });
    expect(login.status).toBe(401);
    expect(login.body.error).toBe("invalid_credentials");
  });
});

describe("Frick identityProviders.google", () => {
  async function signGoogleIdToken(payload: Record<string, unknown>): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(GOOGLE_ISSUER)
      .setAudience(GOOGLE_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signingKey);
  }

  it("first sign-in creates a User keyed on googleSubject", async () => {
    const idToken = await signGoogleIdToken({
      sub: "google-sub-1",
      email: "alice@gmail.test",
      email_verified: true,
      name: "Alice Adams",
    });
    const res = await post("/auth/google/verify", { idToken });
    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.session.tenantId).toBe("tenant-google-sub-1");
    expect(res.body.user.googleSubject).toBe("google-sub-1");
    expect(res.body.user.email).toBe("alice@gmail.test");
  });

  it("returning sign-in reuses the same User + tenant", async () => {
    const idToken1 = await signGoogleIdToken({ sub: "google-sub-returning", email: "x@y.z" });
    const first = await post("/auth/google/verify", { idToken: idToken1 });
    const idToken2 = await signGoogleIdToken({ sub: "google-sub-returning", email: "x@y.z" });
    const second = await post("/auth/google/verify", { idToken: idToken2 });
    expect(second.body.user.id).toBe(first.body.user.id);
    expect(second.body.session.tenantId).toBe(first.body.session.tenantId);
    expect(second.body.isNewUser).toBe(false);
  });

  it("rejects bogus tokens with 401", async () => {
    const res = await post("/auth/google/verify", { idToken: "not.a.jwt" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("google_token_invalid");
  });

  it("rejects empty idToken with 400", async () => {
    const res = await post("/auth/google/verify", {});
    expect(res.status).toBe(400);
  });
});

describe("Frick identityProviders disabled", () => {
  it("returns 404 when apple isn't configured", async () => {
    const fresh = createFrickServer({
      schema: testSchema,
      port: 0,
      dbPath: ":memory:",
      config: { env: "test" },
      jobs: { workerEnabled: false },
      // no identityProviders
    });
    await fresh.listen();
    try {
      const response = await fetch(`${fresh.httpUrl}/auth/apple/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityToken: "x" }),
      });
      expect(response.status).toBe(404);
    } finally {
      await fresh.close();
    }
  });
});
