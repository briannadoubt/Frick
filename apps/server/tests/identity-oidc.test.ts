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
 * Integration test for Frick's identityProviders.oidc surface:
 *
 *   POST /auth/oidc/:providerId/verify
 *
 * Frick verifies a generic OIDC `id_token` against the provider's JWKS
 * (resolved directly via `jwksUri` or fetched from the issuer's discovery
 * document), maps standard + configured claims into the app-owned User
 * object, runs onFirstSignIn, and mints a session exactly like the
 * Apple/Google paths.
 *
 * Real issuers are unreachable in CI, so we stand up a local Ed25519
 * keypair, sign synthetic id_tokens, and inject the JWKS + discovery
 * document through the `oidcVerifyOverrides` test seam — verification runs
 * fully offline (no network).
 */

// "okta" exercises discovery resolution; "auth0" exercises a direct jwksUri.
const OKTA_ID = "okta";
const OKTA_ISSUER = "https://example.okta.com";
const OKTA_CLIENT_ID = "0oa-okta-client";

const AUTH0_ID = "auth0";
const AUTH0_ISSUER = "https://example.auth0.com/";
const AUTH0_CLIENT_ID = "auth0-client-abc";
const AUTH0_AUDIENCE = "https://api.example.test";

const testSchema: FrickSchema = {
  name: "identity-oidc-test",
  schemaId: "identity-oidc-test",
  schemaVersion: "0.1.0",
  schemaRevision: 1,
  minimumClientRevision: 1,
  minimumServerRevision: 1,
  protocol: "frick.realtime",
  protocolVersion: 1,
  compatibility: "greenfield-cutover",
  hash: "identity-oidc-test-0.1.0",
  objects: [
    {
      id: 1,
      name: "User",
      fields: [
        { id: 1, name: "displayName", kind: "string", required: true },
        { id: 2, name: "email", kind: "string", required: false },
        { id: 3, name: "appleSubject", kind: "string", required: false },
        { id: 4, name: "googleSubject", kind: "string", required: false },
        { id: 5, name: "oidcSubject", kind: "string", required: false },
        { id: 6, name: "createdAt", kind: "timestamp", required: true },
        { id: 7, name: "revokedAt", kind: "timestamp", required: false },
        { id: 8, name: "primaryTenantId", kind: "string", required: false },
        { id: 9, name: "department", kind: "string", required: false },
      ],
      indexes: [{ id: 1, name: "byOidcSubject", fields: ["oidcSubject"] }],
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
  kid = "oidc-test-key-1";
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
      oidc: [
        {
          id: OKTA_ID,
          issuer: OKTA_ISSUER,
          clientId: OKTA_CLIENT_ID,
          discovery: true,
          claimMappings: {
            // Map a custom claim "dept" onto User.department.
            extra: { department: "dept" },
          },
        },
        {
          id: AUTH0_ID,
          issuer: AUTH0_ISSUER,
          clientId: AUTH0_CLIENT_ID,
          audience: AUTH0_AUDIENCE,
          jwksUri: "https://example.auth0.com/.well-known/jwks.json",
        },
      ],
      onFirstSignIn: async ({ subject, providerId }) => ({
        tenantId: `tenant-${providerId}-${subject}`,
      }),
      oidcVerifyOverrides: {
        [OKTA_ID]: {
          jwksOverride: testJwks,
          // Discovery doc points back at the issuer + a jwks_uri. The
          // jwksOverride short-circuits the actual fetch, but the override
          // is what keeps resolution offline if discovery were exercised.
          discoveryOverride: {
            issuer: OKTA_ISSUER,
            jwks_uri: `${OKTA_ISSUER}/oauth2/v1/keys`,
          },
        },
        [AUTH0_ID]: { jwksOverride: testJwks },
      },
    },
  });
  await app.listen();
});

afterAll(async () => {
  await app.close();
});

async function signOkta(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(OKTA_ISSUER)
    .setAudience(OKTA_CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
}

async function signAuth0(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(AUTH0_ISSUER)
    .setAudience(AUTH0_AUDIENCE)
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

describe("Frick identityProviders.oidc (discovery-resolved provider)", () => {
  it("first sign-in verifies, maps standard claims, and mints a session", async () => {
    const idToken = await signOkta({
      sub: "okta-sub-1",
      email: "alice@okta.test",
      name: "Alice Okta",
      preferred_username: "alice",
    });
    const res = await post(`/auth/oidc/${OKTA_ID}/verify`, { idToken });
    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.session.tenantId).toBe("tenant-okta-okta-sub-1");
    expect(res.body.user.oidcSubject).toBe("okta:okta-sub-1");
    expect(res.body.user.email).toBe("alice@okta.test");
    expect(res.body.user.displayName).toBe("Alice Okta");
  });

  it("claimMappings.extra populates the mapped User field", async () => {
    const idToken = await signOkta({
      sub: "okta-sub-dept",
      email: "bob@okta.test",
      name: "Bob",
      dept: "Engineering",
    });
    const res = await post(`/auth/oidc/${OKTA_ID}/verify`, { idToken });
    expect(res.status).toBe(200);
    expect(res.body.user.department).toBe("Engineering");
  });

  it("falls back to preferred_username when name is absent", async () => {
    const idToken = await signOkta({
      sub: "okta-sub-noname",
      email: "carol@okta.test",
      preferred_username: "carol-pref",
    });
    const res = await post(`/auth/oidc/${OKTA_ID}/verify`, { idToken });
    expect(res.status).toBe(200);
    expect(res.body.user.displayName).toBe("carol-pref");
  });

  it("returning sign-in reuses the same User + tenant", async () => {
    const first = await post(`/auth/oidc/${OKTA_ID}/verify`, {
      idToken: await signOkta({ sub: "okta-returning", email: "x@okta.test" }),
    });
    const second = await post(`/auth/oidc/${OKTA_ID}/verify`, {
      idToken: await signOkta({ sub: "okta-returning", email: "x@okta.test" }),
    });
    expect(second.body.user.id).toBe(first.body.user.id);
    expect(second.body.session.tenantId).toBe(first.body.session.tenantId);
    expect(second.body.isNewUser).toBe(false);
  });
});

describe("Frick identityProviders.oidc (direct jwksUri provider, custom audience)", () => {
  it("verifies a token whose audience matches the configured audience override", async () => {
    const idToken = await signAuth0({
      sub: "auth0-sub-1",
      email: "dave@auth0.test",
      name: "Dave",
    });
    const res = await post(`/auth/oidc/${AUTH0_ID}/verify`, { idToken });
    expect(res.status).toBe(200);
    expect(res.body.user.oidcSubject).toBe("auth0:auth0-sub-1");
    expect(res.body.session.tenantId).toBe("tenant-auth0-auth0-sub-1");
  });

  it("scopes subjects per-provider — same sub across providers does not alias", async () => {
    const okta = await post(`/auth/oidc/${OKTA_ID}/verify`, {
      idToken: await signOkta({ sub: "shared-sub", email: "a@okta.test" }),
    });
    const auth0 = await post(`/auth/oidc/${AUTH0_ID}/verify`, {
      idToken: await signAuth0({ sub: "shared-sub", email: "a@auth0.test" }),
    });
    expect(okta.body.user.id).not.toBe(auth0.body.user.id);
    expect(okta.body.user.oidcSubject).toBe("okta:shared-sub");
    expect(auth0.body.user.oidcSubject).toBe("auth0:shared-sub");
  });
});

describe("Frick identityProviders.oidc — rejections", () => {
  it("rejects wrong issuer", async () => {
    const idToken = await new SignJWT({ sub: "bad-iss" })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer("https://evil.test")
      .setAudience(OKTA_CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signingKey);
    const res = await post(`/auth/oidc/${OKTA_ID}/verify`, { idToken });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("oidc_token_invalid");
  });

  it("rejects wrong audience", async () => {
    const idToken = await new SignJWT({ sub: "bad-aud" })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(OKTA_ISSUER)
      .setAudience("some-other-client")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signingKey);
    const res = await post(`/auth/oidc/${OKTA_ID}/verify`, { idToken });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("oidc_token_invalid");
  });

  it("rejects an expired token", async () => {
    const idToken = await new SignJWT({ sub: "expired" })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(OKTA_ISSUER)
      .setAudience(OKTA_CLIENT_ID)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(signingKey);
    const res = await post(`/auth/oidc/${OKTA_ID}/verify`, { idToken });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("JWTExpired");
  });

  it("rejects a token signed by the wrong key (bad signature)", async () => {
    const { privateKey: otherKey } = await generateKeyPair("RS256");
    const idToken = await new SignJWT({ sub: "bad-sig" })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(OKTA_ISSUER)
      .setAudience(OKTA_CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(otherKey);
    const res = await post(`/auth/oidc/${OKTA_ID}/verify`, { idToken });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("oidc_token_invalid");
  });

  it("rejects a nonce mismatch when a nonce is expected", async () => {
    const idToken = await signOkta({ sub: "nonce-user", nonce: "actual-nonce" });
    const res = await post(`/auth/oidc/${OKTA_ID}/verify`, {
      idToken,
      nonce: "expected-different-nonce",
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("JWTNonceMismatch");
  });

  it("accepts a matching nonce", async () => {
    const idToken = await signOkta({ sub: "nonce-ok", nonce: "the-nonce", email: "n@okta.test" });
    const res = await post(`/auth/oidc/${OKTA_ID}/verify`, {
      idToken,
      nonce: "the-nonce",
    });
    expect(res.status).toBe(200);
  });

  it("rejects a bogus (non-JWT) token with 401", async () => {
    const res = await post(`/auth/oidc/${OKTA_ID}/verify`, { idToken: "not.a.jwt" });
    expect(res.status).toBe(401);
  });

  it("rejects an empty idToken with 400", async () => {
    const res = await post(`/auth/oidc/${OKTA_ID}/verify`, {});
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unconfigured provider id", async () => {
    const idToken = await signOkta({ sub: "whoever" });
    const res = await post(`/auth/oidc/keycloak/verify`, { idToken });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("oidc_provider_not_configured");
  });
});

describe("Frick identityProviders.oidc disabled", () => {
  it("returns 404 when no oidc providers are configured", async () => {
    const fresh = createFrickServer({
      schema: testSchema,
      port: 0,
      dbPath: ":memory:",
      config: { env: "test" },
      jobs: { workerEnabled: false },
      identityProviders: { google: { clientId: "g" } },
    });
    await fresh.listen();
    try {
      const response = await fetch(`${fresh.httpUrl}/auth/oidc/okta/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken: "x" }),
      });
      expect(response.status).toBe(404);
    } finally {
      await fresh.close();
    }
  });
});
