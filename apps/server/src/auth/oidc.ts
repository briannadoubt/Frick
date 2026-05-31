import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * Generic OpenID Connect provider — server-side ID-token verification.
 *
 * Where {@link ./apple.ts} and {@link ./google.ts} hard-wire a single
 * issuer + JWKS URL, this module is config-driven: an app declares one or
 * more standards-compliant OIDC issuers (Okta, Auth0, Microsoft Entra,
 * Keycloak, etc.) and Frick verifies the supplied `id_token` against that
 * provider's published JWKS exactly the way the Google path does.
 *
 * Each provider resolves its JWKS in one of two ways:
 *   - `jwksUri` given      → use it directly.
 *   - `discovery: true`    → fetch `<issuer>/.well-known/openid-configuration`
 *                            once and read `jwks_uri` from the discovery doc.
 *
 * Verification checks signature, issuer, audience (the configured
 * `audience` if set, otherwise `clientId`), and expiry — all via `jose`,
 * the same primitive Apple/Google use. `nonce` is checked when the caller
 * supplies an expected value (OIDC implicit/hybrid flows bind a nonce into
 * the id_token; pure code flows that already validated it at the token
 * endpoint can omit it).
 *
 * Refs:
 *   https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation
 *   https://openid.net/specs/openid-connect-discovery-1_0.html
 */

export interface OidcClaimMappings {
  /** Source claim for the User's email. Default: `email`. */
  email?: string;
  /** Source claim for the User's display name. Default: `name`. */
  displayName?: string;
  /** Source claim for the preferred username. Default: `preferred_username`. */
  preferredUsername?: string;
  /**
   * Extra claim → User-field mappings copied verbatim into the upserted
   * User row (via `extraUserFields`). Keys are the destination User field
   * name, values are the source claim name on the verified id_token.
   * Only string/number/boolean claim values are copied.
   */
  extra?: Record<string, string>;
}

/**
 * One generic-OIDC provider an app plugs in via
 * `identityProviders.oidc: [...]`.
 */
export interface OidcProviderConfig {
  /**
   * App-chosen stable id for this provider, used in the route
   * (`/auth/oidc/:id/verify`) and recorded on the mapped User row. Must be
   * unique within the `oidc` array and URL-safe.
   */
  id: string;
  /** Expected `iss` claim, e.g. `https://example.okta.com`. */
  issuer: string;
  /**
   * OAuth 2.0 client id registered with the provider. Used as the expected
   * `aud` when `audience` is not set.
   */
  clientId: string;
  /**
   * Override the expected `aud`. Defaults to `clientId`. Some providers
   * (or multi-audience setups) issue tokens whose audience differs from
   * the client id; set this when that is the case.
   */
  audience?: string;
  /**
   * Direct JWKS endpoint. Mutually exclusive with `discovery` — if both
   * are set, `jwksUri` wins (no network discovery is performed).
   */
  jwksUri?: string;
  /**
   * Resolve the JWKS URL from the provider's discovery document at
   * `<issuer>/.well-known/openid-configuration`. Ignored when `jwksUri`
   * is given.
   */
  discovery?: boolean;
  /** Claim → User-field overrides. Standard OIDC names are used by default. */
  claimMappings?: OidcClaimMappings;
  /** Clock-skew tolerance in seconds. Defaults to 60. */
  clockToleranceSec?: number;
}

export interface VerifiedOidcIdentity {
  /** The provider's stable `sub` claim. Keyed onto `User.<oidc>Subject`. */
  subject: string;
  /** Verified email, if the provider scoped/returned one. */
  email: string | undefined;
  /** Display name resolved from the configured/standard name claim. */
  name: string | undefined;
  /** `preferred_username` (or the mapped claim), if present. */
  preferredUsername: string | undefined;
  /**
   * Extra User fields resolved from `claimMappings.extra` — keyed by the
   * destination User field name. Only present when the source claim was a
   * string/number/boolean.
   */
  extraUserFields: Record<string, unknown>;
  /** The full verified payload, for callers that need additional claims. */
  payload: JWTPayload;
}

export interface VerifyOidcOptions {
  /**
   * Expected nonce. When set, the id_token's `nonce` claim must match
   * exactly or verification fails. Omit for code flows that validated the
   * nonce out-of-band.
   */
  expectedNonce?: string;
  /**
   * Test override — swap the JWKS resolver, bypassing discovery + network.
   * Production code leaves this undefined.
   */
  jwksOverride?: ReturnType<typeof createRemoteJWKSet>;
  /**
   * Test override — supply the discovery document directly instead of
   * fetching `<issuer>/.well-known/openid-configuration`. Used to keep
   * tests fully offline.
   */
  discoveryOverride?: OidcDiscoveryDocument;
}

export interface OidcDiscoveryDocument {
  issuer?: string;
  jwks_uri?: string;
  [key: string]: unknown;
}

/**
 * Resolves and caches a per-provider JWKS resolver. Built lazily on first
 * verify so a misconfigured-but-unused provider never blocks startup, and
 * memoized so we don't re-fetch the discovery doc / rebuild the resolver on
 * every request.
 */
export interface OidcProviderRuntime {
  config: ResolvedOidcProvider;
  verify(idToken: string, options?: VerifyOidcOptions): Promise<VerifiedOidcIdentity>;
}

interface ResolvedOidcProvider {
  id: string;
  issuer: string;
  clientId: string;
  audience: string;
  jwksUri: string | undefined;
  discovery: boolean;
  claimMappings: Required<Omit<OidcClaimMappings, "extra">> & {
    extra: Record<string, string>;
  };
  clockToleranceSec: number;
}

const DEFAULT_CLAIM_MAPPINGS = {
  email: "email",
  displayName: "name",
  preferredUsername: "preferred_username",
} as const;

function resolveProvider(config: OidcProviderConfig): ResolvedOidcProvider {
  return {
    id: config.id,
    issuer: config.issuer,
    clientId: config.clientId,
    audience: config.audience ?? config.clientId,
    jwksUri: config.jwksUri,
    discovery: config.discovery ?? false,
    claimMappings: {
      email: config.claimMappings?.email ?? DEFAULT_CLAIM_MAPPINGS.email,
      displayName:
        config.claimMappings?.displayName ?? DEFAULT_CLAIM_MAPPINGS.displayName,
      preferredUsername:
        config.claimMappings?.preferredUsername ??
        DEFAULT_CLAIM_MAPPINGS.preferredUsername,
      extra: config.claimMappings?.extra ?? {},
    },
    clockToleranceSec: config.clockToleranceSec ?? 60,
  };
}

function discoveryUrl(issuer: string): string {
  // Per OIDC Discovery: the well-known path is appended to the issuer with
  // exactly one separating slash, regardless of any trailing slash.
  const base = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
  return `${base}/.well-known/openid-configuration`;
}

async function fetchDiscoveryDocument(
  issuer: string,
): Promise<OidcDiscoveryDocument> {
  const url = discoveryUrl(issuer);
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (err) {
    const error = new Error(
      `OIDC discovery fetch failed for ${url}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    ) as Error & { code?: string };
    error.code = "OIDCDiscoveryFetchFailed";
    throw error;
  }
  if (!res.ok) {
    const error = new Error(
      `OIDC discovery returned ${res.status} for ${url}`,
    ) as Error & { code?: string };
    error.code = "OIDCDiscoveryHttpError";
    throw error;
  }
  try {
    return (await res.json()) as OidcDiscoveryDocument;
  } catch {
    const error = new Error(
      `OIDC discovery document at ${url} was not valid JSON`,
    ) as Error & { code?: string };
    error.code = "OIDCDiscoveryInvalid";
    throw error;
  }
}

function configError(message: string, code: string): Error & { code?: string } {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

/**
 * Build a runtime for one OIDC provider. JWKS resolution (direct or via
 * discovery) is deferred to the first `verify` and memoized thereafter.
 */
export function createOidcProviderRuntime(
  config: OidcProviderConfig,
): OidcProviderRuntime {
  const resolved = resolveProvider(config);
  // Memoized network JWKS resolver. A test `jwksOverride` always wins and is
  // never cached, so swapping it between calls is honored. The real resolver
  // is built once (after discovery, if any) and reused across requests.
  let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

  async function resolveJwks(
    options: VerifyOidcOptions | undefined,
  ): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (options?.jwksOverride) return options.jwksOverride;
    if (cachedJwks) return cachedJwks;

    let jwksUri = resolved.jwksUri;
    if (!jwksUri) {
      if (!resolved.discovery) {
        throw configError(
          `OIDC provider "${resolved.id}" needs either jwksUri or discovery:true`,
          "OIDCMissingJwksConfig",
        );
      }
      const doc =
        options?.discoveryOverride ??
        (await fetchDiscoveryDocument(resolved.issuer));
      // Defense-in-depth: the discovery doc's own issuer must match the
      // configured issuer, so a hijacked/misconfigured well-known endpoint
      // can't silently repoint us at a different IdP.
      if (typeof doc.issuer === "string" && doc.issuer !== resolved.issuer) {
        throw configError(
          `OIDC discovery issuer "${doc.issuer}" does not match configured issuer "${resolved.issuer}"`,
          "OIDCDiscoveryIssuerMismatch",
        );
      }
      if (typeof doc.jwks_uri !== "string" || !doc.jwks_uri) {
        throw configError(
          `OIDC discovery document for "${resolved.id}" has no jwks_uri`,
          "OIDCDiscoveryNoJwksUri",
        );
      }
      jwksUri = doc.jwks_uri;
    }

    const jwks = createRemoteJWKSet(new URL(jwksUri));
    cachedJwks = jwks;
    return jwks;
  }

  async function verify(
    idToken: string,
    options?: VerifyOidcOptions,
  ): Promise<VerifiedOidcIdentity> {
    const jwks = await resolveJwks(options);
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(idToken, jwks, {
        issuer: resolved.issuer,
        audience: resolved.audience,
        clockTolerance: resolved.clockToleranceSec,
      });
      payload = result.payload;
    } catch (err) {
      // Surface jose's subclass name (JWTExpired,
      // JWSSignatureVerificationFailed, JWTClaimValidationFailed, …) so the
      // route can map to specific 401 sub-codes without importing jose.
      const code = err instanceof Error ? err.constructor.name : "JWTVerifyError";
      const error = new Error(
        err instanceof Error ? err.message : "OIDC token verification failed",
      ) as Error & { code?: string };
      error.code = code;
      throw error;
    }

    const subject = typeof payload.sub === "string" ? payload.sub : "";
    if (!subject) {
      throw configError("OIDC id_token missing sub claim", "JWTClaimMissing");
    }

    if (options?.expectedNonce !== undefined) {
      const nonce = (payload as { nonce?: unknown }).nonce;
      if (nonce !== options.expectedNonce) {
        throw configError("OIDC id_token nonce mismatch", "JWTNonceMismatch");
      }
    }

    const mappings = resolved.claimMappings;
    const email = readStringClaim(payload, mappings.email);
    const name = readStringClaim(payload, mappings.displayName);
    const preferredUsername = readStringClaim(payload, mappings.preferredUsername);

    const extraUserFields: Record<string, unknown> = {};
    for (const [destField, sourceClaim] of Object.entries(mappings.extra)) {
      const value = (payload as Record<string, unknown>)[sourceClaim];
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        extraUserFields[destField] = value;
      }
    }

    return {
      subject,
      email,
      name,
      preferredUsername,
      extraUserFields,
      payload,
    };
  }

  return { config: resolved, verify };
}

function readStringClaim(payload: JWTPayload, claim: string): string | undefined {
  const value = (payload as Record<string, unknown>)[claim];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
