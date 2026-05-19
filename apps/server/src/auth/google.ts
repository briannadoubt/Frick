import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * Sign in with Google — server-side ID-token verification.
 *
 * Google's OAuth 2.0 + OpenID Connect flow returns a signed JWT (the
 * `id_token`) to the client. Whether the client uses the GoogleSignIn
 * iOS SDK, a web ASWebAuthenticationSession, or a server-redirect flow,
 * the payload is the same: a JWT we verify against Google's published
 * JWKS at https://www.googleapis.com/oauth2/v3/certs.
 *
 * `aud` is the OAuth client_id you registered with Google. `iss` is
 * either "https://accounts.google.com" or "accounts.google.com" — Google
 * uses both interchangeably across token versions; we accept either.
 *
 * Implementation uses `jose` for the crypto. Same module Apple uses;
 * the security model is identical.
 *
 * Refs:
 *   https://developers.google.com/identity/openid-connect/openid-connect#validatinganidtoken
 */

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

const googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

export interface VerifiedGoogleIdentity {
  /** Google's stable user id. Goes into `User.googleSubject`. */
  subject: string;
  /** User's verified email. Google only sets it after their email verification. */
  email: string | undefined;
  emailVerified: boolean;
  /** Display name from the user's Google profile (if scoped). */
  name: string | undefined;
  picture: string | undefined;
}

export interface VerifyGoogleOptions {
  /** OAuth client id registered with Google. Must match the `aud` claim. */
  audience: string;
  /** Test override — swap the JWKS resolver. */
  jwksOverride?: ReturnType<typeof createRemoteJWKSet>;
  /** Clock-skew tolerance in seconds. Defaults to 60. */
  clockToleranceSec?: number;
}

export async function verifyGoogleIdToken(
  idToken: string,
  options: VerifyGoogleOptions,
): Promise<VerifiedGoogleIdentity> {
  const jwks = options.jwksOverride ?? googleJwks;
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(idToken, jwks, {
      // jose's `issuer` option accepts an array; either spelling matches.
      issuer: GOOGLE_ISSUERS,
      audience: options.audience,
      clockTolerance: options.clockToleranceSec ?? 60,
    });
    payload = result.payload;
  } catch (err) {
    const code = err instanceof Error ? err.constructor.name : "JWTVerifyError";
    const error = new Error(
      err instanceof Error ? err.message : "Google token verification failed",
    ) as Error & { code?: string };
    error.code = code;
    throw error;
  }

  const subject = typeof payload.sub === "string" ? payload.sub : "";
  if (!subject) {
    const error = new Error("Google id_token missing sub claim") as Error & {
      code?: string;
    };
    error.code = "JWTClaimMissing";
    throw error;
  }

  const email = typeof payload.email === "string" ? payload.email : undefined;
  const ev = (payload as { email_verified?: unknown }).email_verified;
  const emailVerified =
    ev === true || ev === "true" || (typeof ev === "number" && ev === 1);
  const name =
    typeof (payload as { name?: unknown }).name === "string"
      ? ((payload as { name?: string }).name as string)
      : undefined;
  const picture =
    typeof (payload as { picture?: unknown }).picture === "string"
      ? ((payload as { picture?: string }).picture as string)
      : undefined;

  return { subject, email, emailVerified, name, picture };
}
