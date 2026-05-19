import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * Sign in with Apple — server-side identity token verification.
 *
 * Apple's iOS flow returns a signed JWT (`identityToken`) to the device.
 * The device sends it to us; we verify the signature against Apple's
 * published JWKS and check the standard claims (issuer, audience, expiry).
 * Apple's `sub` claim is the user's stable, app-scoped identifier — that's
 * what we key our `User.appleSubject` on.
 *
 * Implementation uses `jose` for the actual JWT crypto. Don't roll our
 * own — the threat model for "spoofing a signed-in user" is too high.
 *
 * Refs:
 *   https://developer.apple.com/documentation/sign_in_with_apple/verifying_a_user
 *   https://developer.apple.com/documentation/sign_in_with_apple/sign_in_with_apple_rest_api
 */

const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER = "https://appleid.apple.com";

/** Cached JWKS — `jose` handles refresh + cache eviction internally. */
const appleJwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL));

export interface VerifiedAppleIdentity {
  /** Apple's stable, app-scoped user id. Goes into `User.appleSubject`. */
  subject: string;
  /** Email if Apple shared it. May be a relay address (privaterelay.appleid.com). */
  email: string | undefined;
  /** Apple only sets `email_verified` when the email is real and verified. */
  emailVerified: boolean;
  /**
   * Apple's full-name claim isn't in the JWT — the iOS SDK gives it to
   * the client on the very first sign-in. The client is expected to pass
   * it through to us alongside the identityToken.
   */
}

export interface VerifyAppleOptions {
  /** Your iOS app's bundle id, e.g. com.briannadoubt.crate. Must match `aud`. */
  audience: string;
  /** Test override — swap the JWKS resolver. Defaults to Apple's real one. */
  jwksOverride?: ReturnType<typeof createRemoteJWKSet>;
  /** Clock-skew tolerance in seconds. Defaults to 60. */
  clockToleranceSec?: number;
}

/**
 * Verify an Apple identityToken. Returns the verified identity or throws.
 * The thrown error has a `code` property when the failure is structurally
 * meaningful (signature, expired, audience, etc.) — useful for surfacing
 * specific 401 sub-types to the client.
 */
export async function verifyAppleIdentityToken(
  identityToken: string,
  options: VerifyAppleOptions,
): Promise<VerifiedAppleIdentity> {
  const jwks = options.jwksOverride ?? appleJwks;
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(identityToken, jwks, {
      issuer: APPLE_ISSUER,
      audience: options.audience,
      clockTolerance: options.clockToleranceSec ?? 60,
    });
    payload = result.payload;
  } catch (err) {
    // `jose` throws subclasses like JWTExpired, JWSSignatureVerificationFailed,
    // JWTClaimValidationFailed. Surface the constructor name so callers can
    // map to error codes without depending on `jose` directly.
    const code = err instanceof Error ? err.constructor.name : "JWTVerifyError";
    const error = new Error(
      err instanceof Error ? err.message : "Apple token verification failed",
    ) as Error & { code?: string };
    error.code = code;
    throw error;
  }

  const subject = typeof payload.sub === "string" ? payload.sub : "";
  if (!subject) {
    const error = new Error("Apple identityToken missing sub claim") as Error & {
      code?: string;
    };
    error.code = "JWTClaimMissing";
    throw error;
  }

  const email = typeof payload.email === "string" ? payload.email : undefined;
  // Apple sets email_verified as a string ("true") or a boolean depending on
  // when the user signed up. Treat both consistently.
  const ev = (payload as { email_verified?: unknown }).email_verified;
  const emailVerified =
    ev === true || ev === "true" || (typeof ev === "number" && ev === 1);

  return { subject, email, emailVerified };
}

// MARK: - Server-to-server notifications

/**
 * Event types Apple sends in server-to-server notifications. We treat
 * unknown future types as no-ops rather than failing — Apple may add
 * new types without bumping the contract.
 *
 * Apple docs: https://developer.apple.com/documentation/sign_in_with_apple/processing_changes_for_sign_in_with_apple_accounts
 */
export type AppleNotificationEventType =
  | "email-disabled"
  | "email-enabled"
  | "email-updated"
  | "consent-revoked"
  | "account-delete"
  | (string & Record<never, never>); // accepts unknown future types

export interface AppleNotificationEvent {
  type: AppleNotificationEventType;
  /** Apple subject — the same `sub` we store as `User.appleSubject`. */
  subject: string;
  /** Present on email-* events. May be the user's private relay address. */
  email: string | undefined;
  isPrivateEmail: boolean | undefined;
  /** ms since epoch. */
  eventTime: number;
}

/**
 * Verify an Apple server-to-server notification payload.
 *
 * Apple POSTs `{ "payload": "<JWT>" }` to your registered notification
 * endpoint. The JWT has the same `iss` (https://appleid.apple.com) and
 * `aud` (your bundle id / Services id) as identity tokens, but its
 * payload carries an `events` claim that's a *JSON-stringified* object
 * with the actual change. Yes, stringified inside a JWT — that's Apple.
 */
export async function verifyAppleNotificationPayload(
  payloadJwt: string,
  options: VerifyAppleOptions,
): Promise<AppleNotificationEvent> {
  const jwks = options.jwksOverride ?? appleJwks;
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(payloadJwt, jwks, {
      issuer: APPLE_ISSUER,
      audience: options.audience,
      clockTolerance: options.clockToleranceSec ?? 60,
    });
    payload = result.payload;
  } catch (err) {
    const code = err instanceof Error ? err.constructor.name : "JWTVerifyError";
    const error = new Error(
      err instanceof Error ? err.message : "Apple notification verification failed",
    ) as Error & { code?: string };
    error.code = code;
    throw error;
  }

  // The `events` claim is a JSON string. Apple's docs say "events" can
  // also be a top-level object in some versions — handle both shapes.
  const rawEvents = (payload as { events?: unknown }).events;
  let events: Record<string, unknown>;
  if (typeof rawEvents === "string") {
    try {
      events = JSON.parse(rawEvents) as Record<string, unknown>;
    } catch {
      const error = new Error(
        "Apple notification 'events' claim was not valid JSON",
      ) as Error & { code?: string };
      error.code = "MalformedEvents";
      throw error;
    }
  } else if (rawEvents && typeof rawEvents === "object") {
    events = rawEvents as Record<string, unknown>;
  } else {
    const error = new Error("Apple notification missing 'events' claim") as Error & {
      code?: string;
    };
    error.code = "MissingEvents";
    throw error;
  }

  const type = typeof events.type === "string" ? (events.type as AppleNotificationEventType) : "";
  const subject = typeof events.sub === "string" ? events.sub : "";
  if (!type || !subject) {
    const error = new Error(
      "Apple notification events missing required type/sub",
    ) as Error & { code?: string };
    error.code = "MalformedEvents";
    throw error;
  }
  const email = typeof events.email === "string" ? events.email : undefined;
  // is_private_email is stringified bool in Apple's payload.
  const ipe = events.is_private_email;
  const isPrivateEmail =
    ipe === true || ipe === "true"
      ? true
      : ipe === false || ipe === "false"
        ? false
        : undefined;
  // event_time arrives as a numeric ms-since-epoch in Apple's payload.
  const eventTime =
    typeof events.event_time === "number"
      ? events.event_time
      : typeof events.event_time === "string"
        ? Number(events.event_time)
        : Date.now();

  return { type, subject, email, isPrivateEmail, eventTime };
}
