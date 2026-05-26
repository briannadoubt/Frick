import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { createRemoteJWKSet } from "jose";
import type { FrickStore } from "../store.js";
import type { FrickLogger } from "../logger.js";
import {
  verifyAppleIdentityToken,
  verifyAppleNotificationPayload,
} from "./apple.js";
import { verifyGoogleIdToken } from "./google.js";

/**
 * Third-party identity provider routes.
 *
 * Frick handles JWT verification, account/session creation, and Apple's
 * server-to-server notifications. Apps configure providers via
 * `createFrickServer({ identityProviders })`; Frick mounts the matching
 * /auth/<provider>/* routes automatically.
 *
 * Apps wire their own User schema object into the framework via
 * `userObject` — Frick reads/writes User rows through that mapping so
 * the schema stays app-owned. The expected shape:
 *
 *   {
 *     id: string,
 *     displayName: string,
 *     email?: string,
 *     appleSubject?: string,
 *     googleSubject?: string,
 *     revokedAt?: number,
 *     createdAt: number,
 *     ...whatever-else
 *   }
 *
 * On first sign-in Frick calls `onFirstSignIn` (if provided) so the app
 * can stand up its own per-user state (Tenants, memberships, default
 * settings, etc.) and decide which tenantId to mint the session against.
 */

const SYSTEM_TENANT = "_default";
const SESSION_TTL_DAYS = 30;

export interface IdentityProvidersConfig {
  apple?: AppleProviderConfig;
  /**
   * Enable the email/password provider. Mounts /auth/email/signup and
   * /auth/email/login. Wraps Frick's internal account store + threads
   * tenant decisions through the same `onFirstSignIn` hook Apple uses.
   */
  email?: EmailProviderConfig;
  /**
   * Enable Google Sign-In. Mounts /auth/google/verify. The iOS app
   * obtains an `id_token` via Sign in with Google (any flavor:
   * GoogleSignIn SDK, ASWebAuthenticationSession, or a web client) and
   * POSTs it; Frick verifies against Google's JWKS and mints a session
   * via the same `onFirstSignIn` path Apple uses (provider:"google").
   */
  google?: GoogleProviderConfig;

  /**
   * Schema object name + field mapping that points Frick at the app's
   * User-shaped object. Defaults to `{ type: "User" }` with conventional
   * field names. Fields default to standard names — override if the app
   * picked something different.
   */
  userObject?: UserObjectMapping;

  /**
   * Called on a brand-new sign-in (no existing User row with the
   * verified subject). The hook decides the tenantId + userId for the
   * fresh account; Frick uses them when writing the User row + minting
   * the session. The hook may do additional side-effects (create Tenant
   * rows, send welcome email, etc.).
   */
  onFirstSignIn?: OnFirstSignIn;

  /**
   * Called when the provider tells us a user has revoked consent or
   * deleted their account. Frick has already set `revokedAt` and wiped
   * sessions; this is a chance for the app to do extra cleanup.
   */
  onRevoke?: OnRevoke;

  /**
   * Test seam — pass a local JWKS to bypass fetches against Apple's
   * real keys endpoint. Production code leaves this undefined.
   */
  appleJwksOverride?: ReturnType<typeof createRemoteJWKSet>;
  /** Same idea, for Google. */
  googleJwksOverride?: ReturnType<typeof createRemoteJWKSet>;
}

export interface AppleProviderConfig {
  /** iOS bundle id (or Services id) — must match `aud` on Apple JWTs. */
  audience: string;
}

export interface EmailProviderConfig {
  /** Minimum password length. Defaults to 8. */
  minPasswordLength?: number;
  /**
   * Called after `/auth/email/forgot-password` mints a token. The app is
   * responsible for composing the reset URL (it knows the host name and
   * the path of the in-app reset screen) and dispatching the email via
   * `FrickEmailRouter.sendPasswordResetEmail`. Always called when a real
   * user matched the request; never called when the email is unknown
   * (so the email-existence probe stays plugged).
   */
  onPasswordResetRequested?: (event: PasswordResetRequest) => Promise<void> | void;
}

export interface PasswordResetRequest {
  /** Email the user typed. Already lower-cased + trimmed. */
  email: string;
  /** Resolved user id and tenant. */
  userId: string;
  tenantId: string;
  /** Raw token to put in the email link (single-use, hashed at rest). */
  token: string;
  /** ISO 8601 expiry timestamp. Default TTL is 60 minutes. */
  expiresAt: string;
}

export interface GoogleProviderConfig {
  /** OAuth 2.0 client id registered with Google — must match `aud` on
   * the id_token. For iOS-driven sign-in this is your iOS OAuth client
   * id (it ends in `.apps.googleusercontent.com`). */
  clientId: string;
}

export interface UserObjectMapping {
  type?: string;
  appleSubjectField?: string;
  googleSubjectField?: string;
  emailField?: string;
  displayNameField?: string;
  createdAtField?: string;
  revokedAtField?: string;
  /**
   * Field holding the user's primary tenantId. Frick writes it on first
   * sign-in (from `onFirstSignIn`'s return) and reads it on returning
   * sign-in to mint the session against the right tenant. Apps can write
   * to it to switch a user's active tenant.
   */
  primaryTenantField?: string;
}

export interface OnFirstSignInInput {
  provider: "apple" | "google" | "email";
  /**
   * Stable provider-side identifier:
   *   apple/google → the IdP's `sub` claim
   *   email        → the lowercased email
   */
  subject: string;
  email: string | undefined;
  fullName: { givenName?: string; familyName?: string } | undefined;
}

export interface OnFirstSignInResult {
  tenantId: string;
  /** Override the userId Frick uses for this account. Default: random. */
  userId?: string;
  /** Default display name for the User row. Default: derived from email/sub. */
  displayName?: string;
  /** Extra fields to merge into the upserted User row. */
  extraUserFields?: Record<string, unknown>;
}

export type OnFirstSignIn = (
  input: OnFirstSignInInput,
) => Promise<OnFirstSignInResult> | OnFirstSignInResult;

export interface OnRevokeInput {
  userId: string;
  tenantId: string;
  provider: "apple";
  reason: "consent-revoked" | "account-delete";
}

export type OnRevoke = (input: OnRevokeInput) => Promise<void> | void;

export interface IdentityRouter {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

export interface IdentityRouterOptions {
  store: FrickStore;
  config: IdentityProvidersConfig;
  logger: FrickLogger;
}

interface ResolvedUserObject {
  type: string;
  appleSubjectField: string;
  googleSubjectField: string;
  emailField: string;
  displayNameField: string;
  createdAtField: string;
  revokedAtField: string;
  primaryTenantField: string;
}

const DEFAULT_USER_FIELDS: ResolvedUserObject = {
  type: "User",
  appleSubjectField: "appleSubject",
  googleSubjectField: "googleSubject",
  emailField: "email",
  displayNameField: "displayName",
  createdAtField: "createdAt",
  revokedAtField: "revokedAt",
  primaryTenantField: "primaryTenantId",
};

export function createIdentityRouter(
  options: IdentityRouterOptions,
): IdentityRouter {
  const userObject = { ...DEFAULT_USER_FIELDS, ...(options.config.userObject ?? {}) };
  const log = options.logger;

  async function handleAppleVerify(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!options.config.apple) {
      sendJson(res, 404, { error: "apple_provider_not_configured" });
      return;
    }
    let body: { identityToken?: unknown; fullName?: unknown; deviceId?: unknown; replicaId?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
    const identityToken = typeof body.identityToken === "string" ? body.identityToken : "";
    if (!identityToken) {
      sendJson(res, 400, { error: "identityToken required" });
      return;
    }

    let verified;
    try {
      verified = await verifyAppleIdentityToken(identityToken, {
        audience: options.config.apple.audience,
        ...(options.config.appleJwksOverride
          ? { jwksOverride: options.config.appleJwksOverride }
          : {}),
      });
    } catch (err) {
      const code = (err as { code?: string }).code ?? "JWTVerifyError";
      log.info("auth.apple.verify_failed", { event: "auth.apple.verify_failed", code });
      sendJson(res, 401, {
        error: "apple_token_invalid",
        code,
        message: err instanceof Error ? err.message : "verification failed",
      });
      return;
    }

    const fullName =
      typeof body.fullName === "object" && body.fullName !== null
        ? (body.fullName as { givenName?: string; familyName?: string })
        : undefined;
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : undefined;
    const replicaId = typeof body.replicaId === "string" ? body.replicaId : undefined;

    const existing = findUserBySubject(
      options.store,
      userObject,
      userObject.appleSubjectField,
      verified.subject,
    );

    if (existing) {
      if (existing[userObject.revokedAtField]) {
        log.info("auth.apple.signin_blocked_revoked", {
          event: "auth.apple.signin_blocked_revoked",
          userId: existing.id as string,
        });
        sendJson(res, 403, {
          error: "user_revoked",
          message: "This account was disconnected from Sign in with Apple.",
        });
        return;
      }
      const primaryTenantId =
        (existing[userObject.primaryTenantField] as string | undefined) ??
        findPrimaryTenantForUser(options.store, existing.id as string);
      const session = mintSession({
        store: options.store,
        userId: existing.id as string,
        tenantId: primaryTenantId,
        displayName: (existing[userObject.displayNameField] as string) ?? "Crate user",
        deviceId,
        replicaId,
      });
      log.info("auth.apple.signin_existing", {
        event: "auth.apple.signin_existing",
        userId: existing.id,
        tenantId: primaryTenantId,
      });
      sendJson(res, 200, {
        session: toFrickSessionShape(session, options.store.schema.hash),
        user: existing,
        isNewUser: false,
      });
      return;
    }

    // First sign-in. Defer to the app callback for tenant + userId.
    const defaultDisplayName = derivedDisplayName(fullName, verified.email);
    let hook: OnFirstSignInResult;
    try {
      const cb = options.config.onFirstSignIn;
      hook = cb
        ? await cb({
            provider: "apple",
            subject: verified.subject,
            email: verified.email,
            fullName,
          })
        : { tenantId: SYSTEM_TENANT };
    } catch (err) {
      log.error("auth.apple.onFirstSignIn_failed", {
        event: "auth.apple.onFirstSignIn_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      sendJson(res, 500, { error: "first_sign_in_failed" });
      return;
    }

    const userId = hook.userId ?? `user-${randomUUID()}`;
    const displayName = hook.displayName ?? defaultDisplayName;
    const now = Date.now();

    const userRow: Record<string, unknown> = {
      [userObject.displayNameField]: displayName,
      [userObject.emailField]: verified.email,
      [userObject.appleSubjectField]: verified.subject,
      [userObject.googleSubjectField]: undefined,
      [userObject.createdAtField]: now,
      [userObject.revokedAtField]: undefined,
      [userObject.primaryTenantField]: hook.tenantId,
      ...(hook.extraUserFields ?? {}),
    };
    options.store.upsertObject(SYSTEM_TENANT, userObject.type, userId, userRow);

    const session = mintSession({
      store: options.store,
      userId,
      tenantId: hook.tenantId,
      displayName,
      deviceId,
      replicaId,
    });
    log.info("auth.apple.signin_new", {
      event: "auth.apple.signin_new",
      userId,
      tenantId: hook.tenantId,
    });
    sendJson(res, 200, {
      session: toFrickSessionShape(session, options.store.schema.hash),
      user: { id: userId, ...userRow },
      isNewUser: true,
    });
  }

  async function handleGoogleVerify(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!options.config.google) {
      sendJson(res, 404, { error: "google_provider_not_configured" });
      return;
    }
    let body: { idToken?: unknown; deviceId?: unknown; replicaId?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
    const idToken = typeof body.idToken === "string" ? body.idToken : "";
    if (!idToken) {
      sendJson(res, 400, { error: "idToken required" });
      return;
    }

    let verified;
    try {
      verified = await verifyGoogleIdToken(idToken, {
        audience: options.config.google.clientId,
        ...(options.config.googleJwksOverride
          ? { jwksOverride: options.config.googleJwksOverride }
          : {}),
      });
    } catch (err) {
      const code = (err as { code?: string }).code ?? "JWTVerifyError";
      log.info("auth.google.verify_failed", { event: "auth.google.verify_failed", code });
      sendJson(res, 401, {
        error: "google_token_invalid",
        code,
        message: err instanceof Error ? err.message : "verification failed",
      });
      return;
    }

    const deviceId = typeof body.deviceId === "string" ? body.deviceId : undefined;
    const replicaId = typeof body.replicaId === "string" ? body.replicaId : undefined;

    const existing = findUserBySubject(
      options.store,
      userObject,
      userObject.googleSubjectField,
      verified.subject,
    );

    if (existing) {
      if (existing[userObject.revokedAtField]) {
        log.info("auth.google.signin_blocked_revoked", {
          event: "auth.google.signin_blocked_revoked",
          userId: existing.id as string,
        });
        sendJson(res, 403, {
          error: "user_revoked",
          message: "This account was disconnected.",
        });
        return;
      }
      const primaryTenantId =
        (existing[userObject.primaryTenantField] as string | undefined) ??
        findPrimaryTenantForUser(options.store, existing.id as string);
      const session = mintSession({
        store: options.store,
        userId: existing.id as string,
        tenantId: primaryTenantId,
        displayName: (existing[userObject.displayNameField] as string) ?? "Crate user",
        deviceId,
        replicaId,
      });
      log.info("auth.google.signin_existing", {
        event: "auth.google.signin_existing",
        userId: existing.id,
        tenantId: primaryTenantId,
      });
      sendJson(res, 200, {
        session: toFrickSessionShape(session, options.store.schema.hash),
        user: existing,
        isNewUser: false,
      });
      return;
    }

    // First sign-in. Google's id_token carries `name` directly, so we
    // don't need a fullName-on-first-signin dance like Apple.
    const defaultDisplayName =
      verified.name ?? (verified.email ? verified.email.split("@")[0]! : "Crate user");
    let hook: OnFirstSignInResult;
    try {
      const cb = options.config.onFirstSignIn;
      const fullName = verified.name
        ? { givenName: verified.name }
        : undefined;
      hook = cb
        ? await cb({
            provider: "google",
            subject: verified.subject,
            email: verified.email,
            fullName,
          })
        : { tenantId: SYSTEM_TENANT };
    } catch (err) {
      log.error("auth.google.onFirstSignIn_failed", {
        event: "auth.google.onFirstSignIn_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      sendJson(res, 500, { error: "first_sign_in_failed" });
      return;
    }

    const userId = hook.userId ?? `user-${randomUUID()}`;
    const displayName = hook.displayName ?? defaultDisplayName;
    const now = Date.now();
    const userRow: Record<string, unknown> = {
      [userObject.displayNameField]: displayName,
      [userObject.emailField]: verified.email,
      [userObject.appleSubjectField]: undefined,
      [userObject.googleSubjectField]: verified.subject,
      [userObject.createdAtField]: now,
      [userObject.revokedAtField]: undefined,
      [userObject.primaryTenantField]: hook.tenantId,
      ...(hook.extraUserFields ?? {}),
    };
    options.store.upsertObject(SYSTEM_TENANT, userObject.type, userId, userRow);

    const session = mintSession({
      store: options.store,
      userId,
      tenantId: hook.tenantId,
      displayName,
      deviceId,
      replicaId,
    });
    log.info("auth.google.signin_new", {
      event: "auth.google.signin_new",
      userId,
      tenantId: hook.tenantId,
    });
    sendJson(res, 200, {
      session: toFrickSessionShape(session, options.store.schema.hash),
      user: { id: userId, ...userRow },
      isNewUser: true,
    });
  }

  async function handleEmailSignup(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!options.config.email) {
      sendJson(res, 404, { error: "email_provider_not_configured" });
      return;
    }
    let body: { email?: unknown; password?: unknown; displayName?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const submittedName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const minLen = options.config.email.minPasswordLength ?? 8;
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      sendJson(res, 400, { error: "invalid_email" });
      return;
    }
    if (password.length < minLen) {
      sendJson(res, 400, {
        error: "password_too_short",
        message: `Password must be at least ${minLen} characters.`,
      });
      return;
    }

    // Duplicate-email check via the schema User index. Frick's
    // auth_accounts has its own UNIQUE on (tenant_id, handle) so the
    // SQL layer also enforces — but we want a clean 409 before then.
    const existing = findUserBySubject(
      options.store,
      userObject,
      userObject.emailField,
      email,
    );
    if (existing) {
      sendJson(res, 409, { error: "email_already_registered" });
      return;
    }

    const fullName = submittedName ? { givenName: submittedName } : undefined;
    let hook: OnFirstSignInResult;
    try {
      const cb = options.config.onFirstSignIn;
      hook = cb
        ? await cb({ provider: "email", subject: email, email, fullName })
        : { tenantId: SYSTEM_TENANT };
    } catch (err) {
      log.error("auth.email.onFirstSignIn_failed", {
        event: "auth.email.onFirstSignIn_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      sendJson(res, 500, { error: "first_sign_in_failed" });
      return;
    }

    const userId = hook.userId ?? `user-${randomUUID()}`;
    const displayName = hook.displayName ?? submittedName ?? email.split("@")[0]!;
    const now = Date.now();
    const userRow: Record<string, unknown> = {
      [userObject.displayNameField]: displayName,
      [userObject.emailField]: email,
      [userObject.appleSubjectField]: undefined,
      [userObject.googleSubjectField]: undefined,
      [userObject.createdAtField]: now,
      [userObject.revokedAtField]: undefined,
      [userObject.primaryTenantField]: hook.tenantId,
      ...(hook.extraUserFields ?? {}),
    };
    options.store.upsertObject(SYSTEM_TENANT, userObject.type, userId, userRow);

    try {
      // Account creation also handles password hashing inside Frick's
      // accounts store. The handle is the email — Frick's UNIQUE
      // (tenant_id, handle) gives us a per-tenant uniqueness check.
      options.store.createAccountUser({
        tenantId: hook.tenantId,
        userId,
        handle: email,
        displayName,
        password,
      });
    } catch (err) {
      log.error("auth.email.account_create_failed", {
        event: "auth.email.account_create_failed",
        userId,
        message: err instanceof Error ? err.message : String(err),
      });
      sendJson(res, 500, { error: "account_create_failed" });
      return;
    }

    const session = mintSession({
      store: options.store,
      userId,
      tenantId: hook.tenantId,
      displayName,
      skipAccountCreate: true, // already created above
    });
    log.info("auth.email.signup", {
      event: "auth.email.signup",
      userId,
      tenantId: hook.tenantId,
    });
    sendJson(res, 200, {
      session: toFrickSessionShape(session, options.store.schema.hash),
      user: { id: userId, ...userRow },
      isNewUser: true,
    });
  }

  async function handleEmailLogin(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!options.config.email) {
      sendJson(res, 404, { error: "email_provider_not_configured" });
      return;
    }
    let body: { email?: unknown; password?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) {
      sendJson(res, 400, { error: "email_and_password_required" });
      return;
    }

    const user = findUserBySubject(
      options.store,
      userObject,
      userObject.emailField,
      email,
    );
    if (!user) {
      // Same response shape as bad-password so we don't leak whether
      // the email is registered.
      sendJson(res, 401, { error: "invalid_credentials" });
      return;
    }
    if (user[userObject.revokedAtField]) {
      sendJson(res, 403, {
        error: "user_revoked",
        message: "This account has been revoked.",
      });
      return;
    }

    const primaryTenantId =
      (user[userObject.primaryTenantField] as string | undefined) ??
      findPrimaryTenantForUser(options.store, user.id);
    const account = options.store.verifyAccountPassword(primaryTenantId, email, password);
    if (!account) {
      sendJson(res, 401, { error: "invalid_credentials" });
      return;
    }

    const session = mintSession({
      store: options.store,
      userId: user.id,
      tenantId: primaryTenantId,
      displayName: (user[userObject.displayNameField] as string) ?? email,
      skipAccountCreate: true,
    });
    log.info("auth.email.signin", {
      event: "auth.email.signin",
      userId: user.id,
      tenantId: primaryTenantId,
    });
    sendJson(res, 200, {
      session: toFrickSessionShape(session, options.store.schema.hash),
      user,
      isNewUser: false,
    });
  }

  async function handleAppleNotifications(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!options.config.apple) {
      sendJson(res, 404, { error: "apple_provider_not_configured" });
      return;
    }
    let body: { payload?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
    const payloadJwt = typeof body.payload === "string" ? body.payload : "";
    if (!payloadJwt) {
      sendJson(res, 400, { error: "payload required" });
      return;
    }
    let event;
    try {
      event = await verifyAppleNotificationPayload(payloadJwt, {
        audience: options.config.apple.audience,
        ...(options.config.appleJwksOverride
          ? { jwksOverride: options.config.appleJwksOverride }
          : {}),
      });
    } catch (err) {
      const code = (err as { code?: string }).code ?? "JWTVerifyError";
      log.info("auth.apple.notification_invalid", {
        event: "auth.apple.notification_invalid",
        code,
      });
      sendJson(res, 401, { error: "notification_invalid", code });
      return;
    }

    const existing = findUserBySubject(
      options.store,
      userObject,
      userObject.appleSubjectField,
      event.subject,
    );
    if (!existing) {
      log.info("auth.apple.notification_unknown_user", {
        event: "auth.apple.notification_unknown_user",
        type: event.type,
        subject: event.subject,
      });
      sendJson(res, 200, { ok: true, applied: false, reason: "unknown_user" });
      return;
    }

    const userId = existing.id as string;
    const now = event.eventTime;

    switch (event.type) {
      case "email-updated": {
        if (event.email) {
          options.store.upsertObject(SYSTEM_TENANT, userObject.type, userId, {
            ...existing,
            [userObject.emailField]: event.email,
          });
        }
        log.info("auth.apple.notification_applied", {
          event: "auth.apple.notification_applied",
          type: event.type,
          userId,
        });
        sendJson(res, 200, { ok: true, applied: true, type: event.type });
        return;
      }
      case "email-enabled":
      case "email-disabled": {
        log.info("auth.apple.notification_applied", {
          event: "auth.apple.notification_applied",
          type: event.type,
          userId,
          isPrivateEmail: event.isPrivateEmail,
        });
        sendJson(res, 200, { ok: true, applied: true, type: event.type });
        return;
      }
      case "consent-revoked":
      case "account-delete": {
        // Narrow back from the open union — `event.type` includes a
        // wildcard `(string & Record<never, never>)` to accept unknown
        // future event types, which prevents the case match from
        // narrowing to the literal.
        const revokeReason =
          event.type === "account-delete" ? "account-delete" : ("consent-revoked" as const);
        options.store.upsertObject(SYSTEM_TENANT, userObject.type, userId, {
          ...existing,
          [userObject.revokedAtField]: now,
        });
        const killed = options.store.deleteSessionsForUser(userId);
        if (options.config.onRevoke) {
          try {
            await options.config.onRevoke({
              userId,
              tenantId: findPrimaryTenantForUser(options.store, userId),
              provider: "apple",
              reason: revokeReason,
            });
          } catch (err) {
            log.error("auth.apple.onRevoke_failed", {
              event: "auth.apple.onRevoke_failed",
              userId,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
        log.info("auth.apple.notification_applied", {
          event: "auth.apple.notification_applied",
          type: event.type,
          userId,
          sessionsKilled: killed,
        });
        sendJson(res, 200, {
          ok: true,
          applied: true,
          type: event.type,
          sessionsKilled: killed,
        });
        return;
      }
      default: {
        log.info("auth.apple.notification_unknown_type", {
          event: "auth.apple.notification_unknown_type",
          type: event.type,
          userId,
        });
        sendJson(res, 200, { ok: true, applied: false, reason: "unknown_type" });
        return;
      }
    }
  }

  async function handleEmailForgotPassword(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Privacy: we always return 200 here, even when the email isn't on
    // file, so a probe can't enumerate known accounts. Whether the email
    // was actually sent is logged but never returned to the caller.
    if (!options.config.email) {
      sendJson(res, 404, { error: "email_provider_not_configured" });
      return;
    }
    let body: { email?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email) {
      sendJson(res, 400, { error: "invalid_email" });
      return;
    }
    const user = findUserBySubject(
      options.store,
      userObject,
      userObject.emailField,
      email,
    );
    if (user) {
      const userId = user.id as string;
      const tenantId =
        (user[userObject.primaryTenantField] as string | undefined) ??
        findPrimaryTenantForUser(options.store, userId);
      const issued = options.store.passwordResetTokens.issue({
        tenantId,
        userId,
      });
      log.info("auth.email.password_reset_issued", {
        event: "auth.email.password_reset_issued",
        userId,
        tenantId,
        expiresAt: issued.expiresAt,
      });
      // The actual email send is an out-of-band concern wired by the
      // app (it composes the reset URL + adapter). The framework just
      // emits a hook here; absent a hook, the token is logged in DEBUG
      // builds so a developer can copy it manually during local testing.
      const hook = options.config.email.onPasswordResetRequested;
      if (hook) {
        try {
          await hook({
            email,
            userId,
            tenantId,
            token: issued.token,
            expiresAt: issued.expiresAt,
          });
        } catch (err) {
          log.error("auth.email.password_reset_hook_failed", {
            event: "auth.email.password_reset_hook_failed",
            userId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } else if (process.env.NODE_ENV !== "production") {
        log.info("auth.email.password_reset_token_dev_only", {
          event: "auth.email.password_reset_token_dev_only",
          email,
          // Logged in dev so the developer can copy it; never logged in
          // production builds (guarded by NODE_ENV).
          token: issued.token,
        });
      }
    }
    sendJson(res, 200, { ok: true });
  }

  async function handleEmailResetPassword(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!options.config.email) {
      sendJson(res, 404, { error: "email_provider_not_configured" });
      return;
    }
    let body: { token?: unknown; password?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
    const token = typeof body.token === "string" ? body.token : "";
    const password = typeof body.password === "string" ? body.password : "";
    const minLen = options.config.email.minPasswordLength ?? 8;
    if (!token) {
      sendJson(res, 400, { error: "missing_token" });
      return;
    }
    if (password.length < minLen) {
      sendJson(res, 400, {
        error: "password_too_short",
        message: `Password must be at least ${minLen} characters.`,
      });
      return;
    }
    const consumed = options.store.passwordResetTokens.consume(token);
    if (!consumed) {
      sendJson(res, 400, { error: "invalid_or_expired_token" });
      return;
    }
    const ok = options.store.accounts.setPassword(
      consumed.tenantId,
      consumed.userId,
      password,
    );
    if (!ok) {
      // Token validated but the account vanished — race with deletion.
      sendJson(res, 410, { error: "account_no_longer_exists" });
      return;
    }
    // Kill outstanding sessions on a successful reset — common pattern
    // to invalidate cookies/JWTs an attacker might have squirreled away.
    options.store.deleteSessionsForUser(consumed.userId);
    log.info("auth.email.password_reset_completed", {
      event: "auth.email.password_reset_completed",
      userId: consumed.userId,
      tenantId: consumed.tenantId,
    });
    sendJson(res, 200, { ok: true });
  }

  return {
    async handle(req, res) {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      if (req.method === "POST" && url.pathname === "/auth/apple/verify") {
        await handleAppleVerify(req, res);
        return true;
      }
      if (req.method === "POST" && url.pathname === "/auth/apple/notifications") {
        await handleAppleNotifications(req, res);
        return true;
      }
      if (req.method === "POST" && url.pathname === "/auth/email/signup") {
        await handleEmailSignup(req, res);
        return true;
      }
      if (req.method === "POST" && url.pathname === "/auth/email/login") {
        await handleEmailLogin(req, res);
        return true;
      }
      if (req.method === "POST" && url.pathname === "/auth/email/forgot-password") {
        await handleEmailForgotPassword(req, res);
        return true;
      }
      if (req.method === "POST" && url.pathname === "/auth/email/reset-password") {
        await handleEmailResetPassword(req, res);
        return true;
      }
      if (req.method === "POST" && url.pathname === "/auth/google/verify") {
        await handleGoogleVerify(req, res);
        return true;
      }
      return false;
    },
  };
}

interface UserRow extends Record<string, unknown> {
  id: string;
}

function findUserBySubject(
  store: FrickStore,
  userObject: ResolvedUserObject,
  subjectField: string,
  subject: string,
): UserRow | undefined {
  const users = store.listObjects(SYSTEM_TENANT, userObject.type) as UserRow[];
  return users.find((u) => u[subjectField] === subject);
}

function findPrimaryTenantForUser(store: FrickStore, userId: string): string {
  // Apps own the membership model — we look for a TenantMembership row
  // pointing at this user in the system tenant. Falls back to userId-
  // as-tenant when no membership exists (the app didn't define one).
  type MembershipRow = { tenantId: string; userId: string; joinedAt?: number };
  let memberships: MembershipRow[] = [];
  try {
    memberships = store.listObjects(SYSTEM_TENANT, "TenantMembership") as MembershipRow[];
  } catch {
    // App doesn't have TenantMembership — fall through.
  }
  const matched = memberships.filter((m) => m.userId === userId);
  if (matched.length === 0) return userId;
  matched.sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0));
  return matched[0]!.tenantId;
}

function derivedDisplayName(
  fullName: { givenName?: string; familyName?: string } | undefined,
  email: string | undefined,
): string {
  if (fullName) {
    const parts = [fullName.givenName, fullName.familyName].filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    if (parts.length > 0) return parts.join(" ");
  }
  if (email) return email.split("@")[0]!;
  return "Crate user";
}

interface MintedSession {
  sessionToken: string;
  userId: string;
  tenantId: string;
  deviceId: string;
  replicaId: string;
  expiresAt: string;
}

function mintSession(input: {
  store: FrickStore;
  userId: string;
  tenantId: string;
  displayName: string;
  deviceId?: string | undefined;
  replicaId?: string | undefined;
  /**
   * Skip the auto-create-account-if-missing path. Useful for the
   * email provider where we've already called `createAccountUser`
   * with a real password and don't want the helper to clobber it
   * with a random throwaway.
   */
  skipAccountCreate?: boolean;
}): MintedSession {
  if (!input.skipAccountCreate && !input.store.hasUser(input.tenantId, input.userId)) {
    input.store.createAccountUser({
      tenantId: input.tenantId,
      userId: input.userId,
      handle: input.userId,
      displayName: input.displayName,
      password: randomBytes(32).toString("hex"),
    });
  }
  const sessionToken = randomBytes(32).toString("base64url");
  const deviceId = input.deviceId ?? `device-${randomBytes(8).toString("hex")}`;
  const replicaId = input.replicaId ?? `replica-${randomBytes(8).toString("hex")}`;
  const expiresAt = new Date(
    Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  input.store.createSession({
    sessionToken,
    userId: input.userId,
    deviceId,
    replicaId,
    expiresAt,
    tenantId: input.tenantId,
  });
  return { sessionToken, userId: input.userId, tenantId: input.tenantId, deviceId, replicaId, expiresAt };
}

function toFrickSessionShape(session: MintedSession, schemaHash: string) {
  return {
    schemaHash,
    sessionToken: session.sessionToken,
    tenantId: session.tenantId,
    userId: session.userId,
    deviceId: session.deviceId,
    replicaId: session.replicaId,
    expiresAt: session.expiresAt,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(json).toString());
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, authorization");
  res.end(json);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}
