import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type KeyLike,
} from "jose";
import { createOidcProviderRuntime } from "../src/auth/oidc.js";

/**
 * Unit tests for the generic-OIDC verifier's discovery + claim-mapping
 * resolution, isolated from the HTTP router.
 *
 * The discovery fetch is exercised here by stubbing `global.fetch` so the
 * `<issuer>/.well-known/openid-configuration` round-trip is fully offline.
 * Signature verification still uses the test `jwksOverride` (the discovery
 * doc only resolves the jwks_uri; we don't want a real network JWKS fetch).
 */

const ISSUER = "https://idp.example.test";
const CLIENT_ID = "client-xyz";

let signingKey: KeyLike;
let kid: string;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  signingKey = privateKey;
  kid = "disco-key-1";
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  jwks = createLocalJWKSet({ keys: [jwk] });
});

afterEach(async () => {
  vi.unstubAllGlobals();
});

async function sign(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
}

describe("createOidcProviderRuntime — discovery resolution", () => {
  it("fetches the well-known document to resolve jwks_uri (offline-stubbed)", async () => {
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      expect(url).toBe(`${ISSUER}/.well-known/openid-configuration`);
      return new Response(
        JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/keys` }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = createOidcProviderRuntime({
      id: "disco",
      issuer: ISSUER,
      clientId: CLIENT_ID,
      discovery: true,
    });
    // jwksOverride supplies the actual verification key; discovery still
    // runs to resolve jwks_uri, proving the fetch path works offline.
    const verified = await runtime.verify(await sign({ sub: "u1", email: "u@e.test" }), {
      jwksOverride: jwks,
    });
    expect(verified.subject).toBe("u1");
    expect(verified.email).toBe("u@e.test");
  });

  it("rejects a discovery document whose issuer mismatches the configured issuer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ issuer: "https://evil.test", jwks_uri: `${ISSUER}/keys` }),
          { status: 200 },
        ),
      ),
    );
    const runtime = createOidcProviderRuntime({
      id: "disco-bad-iss",
      issuer: ISSUER,
      clientId: CLIENT_ID,
      discovery: true,
    });
    // No jwksOverride → discovery doc is validated before key resolution.
    await expect(runtime.verify(await sign({ sub: "u" }))).rejects.toMatchObject({
      code: "OIDCDiscoveryIssuerMismatch",
    });
  });

  it("errors when neither jwksUri nor discovery is configured", async () => {
    const runtime = createOidcProviderRuntime({
      id: "no-jwks",
      issuer: ISSUER,
      clientId: CLIENT_ID,
    });
    await expect(runtime.verify(await sign({ sub: "u" }))).rejects.toMatchObject({
      code: "OIDCMissingJwksConfig",
    });
  });

  it("surfaces an HTTP error from the discovery endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const runtime = createOidcProviderRuntime({
      id: "disco-500",
      issuer: ISSUER,
      clientId: CLIENT_ID,
      discovery: true,
    });
    await expect(runtime.verify(await sign({ sub: "u" }))).rejects.toMatchObject({
      code: "OIDCDiscoveryHttpError",
    });
  });

  it("uses the configured audience override instead of clientId", async () => {
    const runtime = createOidcProviderRuntime({
      id: "aud",
      issuer: ISSUER,
      clientId: CLIENT_ID,
      audience: "https://api.example.test",
      jwksUri: `${ISSUER}/keys`,
    });
    const token = await new SignJWT({ sub: "aud-user" })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(ISSUER)
      .setAudience("https://api.example.test")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signingKey);
    const verified = await runtime.verify(token, { jwksOverride: jwks });
    expect(verified.subject).toBe("aud-user");
  });
});
