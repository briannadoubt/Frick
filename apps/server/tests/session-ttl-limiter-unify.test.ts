import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type KeyLike,
} from "jose";
import type { FrickSchema } from "@frick/protocol";
import { createFrickServer } from "../src/server.js";

/**
 * FR-29 — unify session TTL + auth-attempt limiter across all identity
 * providers.
 *
 * Two guarantees are exercised here:
 *
 *  1. Provider-minted sessions (Apple/Google/OIDC/email) honor the single
 *     configured `FRICK_SESSION_TTL_SECONDS` instead of a hardcoded 30-day
 *     lifetime. OIDC is the representative third-party provider (it mints
 *     through the same shared `mintSession` helper the others use) and the
 *     email path covers the password provider. When the TTL is left at its
 *     config default (env unset) the 7-day default applies — emphatically not
 *     30 days.
 *
 *  2. The identity-provider verify endpoints and the email
 *     forgot-password/reset-password endpoints run through the SAME
 *     auth-attempt limiter that protects `/auth/login`, so they trip a 429
 *     once the per-window ceiling is exceeded.
 *
 * Real issuers are unreachable in CI, so each test signs synthetic id_tokens
 * with a fresh local RSA keypair and injects the JWKS through the
 * `oidcVerifyOverrides` test seam — verification runs fully offline. Keys are
 * generated per test (not shared module state) to keep tests order-independent.
 */

const OIDC_ID = "primary";
const ISSUER = "https://issuer.fr29.example.com";
const CLIENT_ID = "fr29-client-id";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const testSchema: FrickSchema = {
  name: "fr29-test",
  schemaId: "fr29-test",
  schemaVersion: "0.1.0",
  schemaRevision: 1,
  minimumClientRevision: 1,
  minimumServerRevision: 1,
  protocol: "frick.realtime",
  protocolVersion: 1,
  compatibility: "greenfield-cutover",
  hash: "fr29-test-0.1.0",
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
      ],
      indexes: [{ id: 1, name: "byOidcSubject", fields: ["oidcSubject"] }],
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

// One keypair + JWKS for the whole file (the proven pattern from
// identity-oidc.test.ts). Tests use unique subjects so accounts never collide.
let signingKey: KeyLike;
let kid: string;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  signingKey = privateKey;
  kid = "fr29-test-key";
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  jwks = createLocalJWKSet({ keys: [jwk] });
});

async function signIdToken(sub: string, email = "user@example.com"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt(now)
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setExpirationTime(now + 3600)
    .sign(signingKey);
}

let app: ReturnType<typeof createFrickServer> | undefined;
let baseUrl = "";

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

async function startOidcServer(
  overrides: Parameters<typeof createFrickServer>[0] = {},
): Promise<void> {
  app = createFrickServer({
    schema: testSchema,
    port: 0,
    dbPath: ":memory:",
    config: { env: "test" },
    jobs: { workerEnabled: false },
    identityProviders: {
      oidc: [{ id: OIDC_ID, issuer: ISSUER, clientId: CLIENT_ID, jwksUri: `${ISSUER}/jwks` }],
      oidcVerifyOverrides: { [OIDC_ID]: { jwksOverride: jwks } },
    },
    ...overrides,
  });
  await app.listen();
  baseUrl = app.httpUrl;
}

async function startEmailServer(
  overrides: Parameters<typeof createFrickServer>[0] = {},
): Promise<void> {
  app = createFrickServer({
    schema: testSchema,
    port: 0,
    dbPath: ":memory:",
    config: { env: "test" },
    jobs: { workerEnabled: false },
    identityProviders: { email: {} },
    ...overrides,
  });
  await app.listen();
  baseUrl = app.httpUrl;
}

async function verifyOidc(idToken: string): Promise<Response> {
  return fetch(`${baseUrl}/auth/oidc/${OIDC_ID}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
}

describe("FR-29 — provider session TTL honors the configured value", () => {
  it("an OIDC-minted session expiry matches the configured TTL, not 30 days", async () => {
    const ttlSeconds = 120;
    await startOidcServer({ config: { env: "test", sessionTtlSeconds: ttlSeconds } });
    const before = Date.now();
    const res = await verifyOidc(await signIdToken("fr29-ttl-1"));
    const after = Date.now();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { session?: { expiresAt?: string } };
    const expiresAt = json.session?.expiresAt;
    expect(expiresAt).toBeTruthy();

    const expiresMs = Date.parse(expiresAt!);
    // ~2 minutes out: within [before+ttl, after+ttl] with a little slack.
    expect(expiresMs).toBeGreaterThanOrEqual(before + ttlSeconds * 1000 - 50);
    expect(expiresMs).toBeLessThanOrEqual(after + ttlSeconds * 1000 + 50);
    // And nowhere near the old hardcoded 30-day lifetime.
    expect(expiresMs).toBeLessThan(before + THIRTY_DAYS_MS / 2);
  });

  it("falls back to the default config TTL when sessionTtlSeconds is unset", async () => {
    // No sessionTtlSeconds override → loadFrickConfig default (7 days), not 30.
    await startOidcServer();
    const before = Date.now();
    const res = await verifyOidc(await signIdToken("fr29-ttl-default"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { session?: { expiresAt?: string } };
    const expiresMs = Date.parse(json.session!.expiresAt!);

    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(before + sevenDaysMs - 60_000);
    expect(expiresMs).toBeLessThanOrEqual(before + sevenDaysMs + 60_000);
    expect(expiresMs).toBeLessThan(before + THIRTY_DAYS_MS / 2);
  });

  it("an email signup session also honors the configured TTL", async () => {
    const ttlSeconds = 90;
    await startEmailServer({ config: { env: "test", sessionTtlSeconds: ttlSeconds } });
    const before = Date.now();
    const res = await fetch(`${baseUrl}/auth/email/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ttl-signup@example.com", password: "password123" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { session?: { expiresAt?: string } };
    const expiresMs = Date.parse(json.session!.expiresAt!);
    expect(expiresMs).toBeGreaterThanOrEqual(before + ttlSeconds * 1000 - 60_000);
    expect(expiresMs).toBeLessThanOrEqual(before + ttlSeconds * 1000 + 60_000);
    expect(expiresMs).toBeLessThan(before + THIRTY_DAYS_MS / 2);
  });
});

describe("FR-29 — shared auth-attempt limiter on provider routes", () => {
  it("rate-limits repeated OIDC verify attempts (same limiter as /auth/login)", async () => {
    await startOidcServer({ config: { env: "test" }, limits: { maxAuthAttemptsPerWindow: 3 } });
    // Invalid token: each attempt is a fresh auth attempt that counts toward the
    // ceiling without minting a session. The limiter runs before verification,
    // so even invalid tokens are throttled.
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await verifyOidc("not-a-real-token");
      statuses.push(res.status);
    }
    // First 3 pass the limiter (and fail verification → 401); 4 and 5 are 429.
    expect(statuses.slice(0, 3).every((s) => s === 401)).toBe(true);
    expect(statuses[3]).toBe(429);
    expect(statuses[4]).toBe(429);

    // The 429 carries a retry-after header + retryAfterSeconds body.
    const limited = await verifyOidc("not-a-real-token");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    const body = (await limited.json()) as { error?: string; retryAfterSeconds?: number };
    expect(body.error).toBe("rate_limited");
    expect(typeof body.retryAfterSeconds).toBe("number");
  });

  it("rate-limits repeated reset-password attempts", async () => {
    await startEmailServer({ config: { env: "test" }, limits: { maxAuthAttemptsPerWindow: 3 } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${baseUrl}/auth/email/reset-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "bogus-token", password: "password123" }),
      });
      statuses.push(res.status);
    }
    // First 3 reach the handler (invalid token → 400); 4 and 5 throttled → 429.
    expect(statuses.slice(0, 3).every((s) => s === 400)).toBe(true);
    expect(statuses[3]).toBe(429);
    expect(statuses[4]).toBe(429);
  });

  it("rate-limits repeated forgot-password attempts for one email", async () => {
    await startEmailServer({ config: { env: "test" }, limits: { maxAuthAttemptsPerWindow: 3 } });
    const email = "throttle-forgot@example.com";
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${baseUrl}/auth/email/forgot-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      statuses.push(res.status);
    }
    // forgot-password returns 200 (anti-enumeration) until the limiter trips.
    expect(statuses.slice(0, 3).every((s) => s === 200)).toBe(true);
    expect(statuses[3]).toBe(429);
    expect(statuses[4]).toBe(429);
  });
});
