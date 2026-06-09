import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { createRemoteJWKSet } from "jose";
import type { FrickStore } from "../store.js";
import type { FrickLogger } from "../logger.js";
import {
  verifyAppleIdentityToken,
  verifyAppleNotificationPayload,
} from "./apple.js";
import { verifyGoogleIdToken } from "./google.js";
import {
  createOidcProviderRuntime,
  type OidcProviderConfig,
  type OidcProviderRuntime,
  type VerifyOidcOptions,
} from "./oidc.js";
import {
  createSamlProviderRuntime,
  SamlValidationError,
  type SamlProviderConfig,
  type SamlProviderRuntime,
  type SamlSignatureVerifier,
} from "./saml.js";
import { createFrickEmailRouter, type FrickEmailRouter } from "../email/router.js";
import type { FrickEmailAdapter } from "../email/types.js";

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
   * Enable one or more generic OpenID Connect providers (Okta, Auth0,
   * Microsoft Entra, Keycloak, any standards-compliant issuer). Each entry
   * mounts `POST /auth/oidc/:id/verify`. The client obtains an `id_token`
   * from the issuer and POSTs it; Frick verifies it against the provider's
   * JWKS (resolved directly via `jwksUri` or fetched from the issuer's
   * discovery document) and mints a session via the same `onFirstSignIn`
   * path Apple/Google use (provider:"oidc", providerId:"<id>"). Provider
   * ids must be unique.
   */
  oidc?: OidcProviderConfig[];

  /**
   * Enable one or more SAML 2.0 Service Provider integrations (Okta, Entra,
   * ADFS, Shibboleth, any standards-compliant IdP). Each entry mounts:
   *   - `GET  /auth/saml/:id/metadata` — the SP metadata XML (entityID, ACS
   *      URL, signing/encryption certs as configured).
   *   - `POST /auth/saml/:id/acs` — the Assertion Consumer Service. The IdP
   *      (or the browser) posts a base64 `SAMLResponse`; Frick verifies the
   *      XML signature against the provider's configured certificate, checks
   *      issuer / audience / validity window / recipient / InResponseTo, guards
   *      against assertion replay, maps attributes onto the User object, and
   *      mints a session via the same `onFirstSignIn` path Apple/Google/OIDC
   *      use (provider:"saml", providerId:"<id>"). Provider ids must be unique.
   *
   * Backward compatible: with no `saml` entries the routes are absent and
   * behavior is unchanged.
   */
  saml?: SamlProviderConfig[];

  /**
   * Test seam — per-SAML-provider signature-verifier overrides keyed by
   * provider id. Each entry swaps the XML-signature primitive so tests can
   * exercise assertion validation without minting real XML-DSIG. Production
   * code leaves this undefined (the `xml-crypto` verifier is used).
   */
  samlVerifyOverrides?: Record<string, SamlSignatureVerifier>;

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
  /**
   * Test seam — per-OIDC-provider verification overrides keyed by provider
   * id. Each entry may supply a local `jwksOverride` and/or a
   * `discoveryOverride` so verification (and discovery resolution) runs
   * fully offline. Production code leaves this undefined.
   */
  oidcVerifyOverrides?: Record<string, Pick<VerifyOidcOptions, "jwksOverride" | "discoveryOverride">>;

  /**
   * Opt-in refresh-token / short-access-token split (FR-33). When set, every
   * provider sign-in (apple/google/oidc/email) additionally mints a long-lived
   * refresh token alongside the session, and the session itself is issued with
   * the short {@link RefreshProviderConfig.accessTokenTtlSeconds} lifetime
   * instead of the single configured session TTL. Clients exchange the refresh
   * token at `POST /auth/refresh` for a fresh access token (a new session),
   * optionally rotating the refresh token, and revoke it at
   * `POST /auth/refresh/revoke`.
   *
   * Backward compatible: when omitted, sign-ins behave exactly as before (a
   * single session token at the configured TTL, no refresh token, and the
   * `/auth/refresh*` routes return 404).
   */
  refresh?: RefreshProviderConfig;
}

export interface RefreshProviderConfig {
  /**
   * Lifetime, in seconds, of the short-lived access token (session) minted on
   * sign-in and at every refresh. Defaults to 900 (15 minutes).
   */
  accessTokenTtlSeconds?: number;
  /**
   * Lifetime, in seconds, of the long-lived refresh token. Defaults to
   * 2,592,000 (30 days).
   */
  refreshTokenTtlSeconds?: number;
  /**
   * When true (the default), `POST /auth/refresh` rotates the refresh token —
   * the presented token is revoked and a fresh one is returned alongside the
   * new access token. When false, the presented refresh token is reused and
   * only a new access token is returned.
   */
  rotateOnRefresh?: boolean;
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
   *
   * This hook coexists with {@link EmailProviderConfig.outbound}: when both
   * are set the framework dispatches the templated reset email through the
   * configured adapter *and* invokes this hook, so an app can layer extra
   * behavior (analytics, custom providers) on top of the built-in send.
   */
  onPasswordResetRequested?: (event: PasswordResetRequest) => Promise<void> | void;
  /**
   * Opt-in framework-managed outbound email. Supply a {@link FrickEmailAdapter}
   * (e.g. the exported Resend reference adapter, or the in-memory test
   * adapter) and the framework will dispatch the password-reset and
   * first-sign-in welcome emails through it — apps no longer have to wire
   * those sends by hand. Reset-link composition stays in app code via the
   * `resetUrl` builder, because only the app knows its host name and in-app
   * screen paths; welcome content is supplied via `welcome.body`.
   *
   * Sends are best-effort: a failed delivery is logged + audited in the
   * DevTools event feed but never fails the originating auth request.
   */
  outbound?: EmailOutboundConfig;
}

export interface EmailOutboundConfig {
  /**
   * Adapter the framework dispatches through. Use
   * `createFrickResendEmailAdapter()` (from `@fricken/server` or
   * `@fricken/server/email/resend-adapter`) in production, or
   * `createFrickTestEmailAdapter()` in tests.
   */
  adapter: FrickEmailAdapter;
  /** Default `from:` address for framework-composed mail. Required. */
  defaultFrom: string;
  /** App name woven into the default subject lines. Defaults to "Your app". */
  appName?: string;
  /**
   * Builds the password-reset link the user clicks. Receives the issued
   * single-use token and the recipient email. When omitted, the framework
   * does not send a reset email (the `onPasswordResetRequested` hook, if
   * any, still fires).
   */
  resetUrl?: (event: { token: string; email: string }) => string;
  /** First-sign-in / welcome email, dispatched after a successful signup. */
  welcome?: EmailWelcomeConfig;
}

export interface EmailWelcomeConfig {
  /** `from:` override for the welcome mail; defaults to `defaultFrom`. */
  from?: string;
  /** Subject line. Defaults to `Welcome to <appName>`. */
  subject?: string;
  /**
   * Builds the welcome body. Receives the new user's email + display name
   * and returns `{ text, html? }`. When omitted, a minimal default body is
   * sent.
   */
  body?: (event: { email: string; displayName: string }) => {
    text: string;
    html?: string;
  };
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
  /**
   * Field that stores the generic-OIDC subject. Because an app may wire
   * several OIDC providers, Frick stores a composite `"<providerId>:<sub>"`
   * here so two issuers that happen to share a `sub` value never collide.
   * Defaults to `oidcSubject`.
   */
  oidcSubjectField?: string;
  /**
   * Field that stores the SAML subject. Like OIDC, an app may wire several
   * SAML IdPs, so Frick stores a composite `"<providerId>:<nameId>"` here so
   * two IdPs that share a NameID never collide. Defaults to `samlSubject`.
   */
  samlSubjectField?: string;
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
  provider: "apple" | "google" | "email" | "oidc" | "saml";
  /**
   * Stable provider-side identifier:
   *   apple/google → the IdP's `sub` claim
   *   oidc         → the issuer's `sub` claim (scope it with `providerId`)
   *   saml         → the assertion's NameID (scope it with `providerId`)
   *   email        → the lowercased email
   */
  subject: string;
  /**
   * For `provider: "oidc"` or `"saml"`, the configured provider id (e.g.
   * "okta") this sign-in came through. Undefined for the built-in providers.
   */
  providerId?: string;
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

/**
 * Shared auth-attempt throttle, injected by the server so the identity-provider
 * verify endpoints and the email password-reset endpoints count against the
 * SAME per-identifier/IP ceiling as the built-in password-login routes (FR-29).
 *
 * The server's adapter delegates to its single
 * `FixedWindowAuthAttemptLimiter`. `check` returns `{ retryAfterSeconds }` when
 * the attempt is over the limit (the caller must reject with 429) and
 * `undefined` when it is allowed. When the whole throttle is omitted the
 * identity routes run unthrottled — only the case in narrow unit tests that
 * don't wire a server.
 */
export interface IdentityAuthThrottle {
  /** Resolve the client IP for a request, matching the password-login path. */
  clientIp(req: IncomingMessage): string;
  check(input: {
    route: string;
    identifier: string;
    ip: string;
  }): { retryAfterSeconds: number } | undefined;
}

export interface IdentityRouterOptions {
  store: FrickStore;
  config: IdentityProvidersConfig;
  logger: FrickLogger;
  /**
   * Session lifetime in seconds for provider-minted sessions. Threaded from the
   * server's `FRICK_SESSION_TTL_SECONDS` config so every provider session
   * (Apple/Google/OIDC/email) honors the single configured TTL instead of a
   * hardcoded 30-day lifetime (FR-29). Falls back to a 30-day default only when
   * a caller constructs the router directly without passing it.
   */
  sessionTtlSeconds?: number;
  /**
   * Shared auth-attempt throttle. When provided, provider-verify and
   * password-reset endpoints are rate-limited through the same limiter the
   * built-in password-login routes use (FR-29).
   */
  authThrottle?: IdentityAuthThrottle;
}

/** Fallback TTL when no `sessionTtlSeconds` is supplied (legacy 30 days). */
const FALLBACK_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Default short access-token (session) lifetime when refresh is enabled. */
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
/** Default long refresh-token lifetime when refresh is enabled. */
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Refresh config resolved to concrete TTLs. Present only when the app opted
 * into the FR-33 split via `identityProviders.refresh`; otherwise undefined and
 * every sign-in keeps its legacy single-session behavior.
 */
interface ResolvedRefresh {
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  rotateOnRefresh: boolean;
}

interface ResolvedUserObject {
  type: string;
  appleSubjectField: string;
  googleSubjectField: string;
  oidcSubjectField: string;
  samlSubjectField: string;
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
  oidcSubjectField: "oidcSubject",
  samlSubjectField: "samlSubject",
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

  // Password-reset lifecycle audit on the shared admin-audit hash chain. The
  // actor is the subject user (no admin token in scope), fingerprinted to the
  // same 12-hex-char shape the admin rows use so an operator can correlate
  // without the row ever carrying the raw identity. Best-effort: a dropped
  // audit row must never fail the reset flow (which always returns 200 to
  // avoid account enumeration).
  const recordResetAudit = (input: {
    action: string;
    subject: string;
    outcome: "allow" | "deny" | "error";
    detail?: Record<string, unknown>;
  }): void => {
    try {
      options.store.adminAudit.record({
        adminTokenFingerprint: `u:${createHash("sha256").update(input.subject).digest("hex").slice(0, 12)}`,
        action: input.action,
        target: input.subject,
        outcome: input.outcome,
        ...(input.detail !== undefined ? { detail: JSON.stringify(input.detail) } : {}),
      });
    } catch {
      // Best-effort — never break the reset flow on an audit hiccup.
    }
  };

  // Framework-managed outbound email. Built once when the app opts in via
  // `email.outbound`. Reset + welcome sends go through this router so they
  // share the same audit + redaction path as any other framework mail.
  const outbound = options.config.email?.outbound;
  const emailRouter: FrickEmailRouter | undefined = outbound
    ? createFrickEmailRouter({
        adapter: outbound.adapter,
        store: options.store,
        logger: options.logger,
        defaultFrom: outbound.defaultFrom,
      })
    : undefined;

  // Generic OIDC providers, built once and keyed by provider id. JWKS /
  // discovery resolution is lazy (deferred to the first verify) + memoized
  // inside each runtime, so unused providers never touch the network. A
  // duplicate provider id is a hard config error — routing is by id.
  const oidcRuntimes = new Map<string, OidcProviderRuntime>();
  for (const providerConfig of options.config.oidc ?? []) {
    if (oidcRuntimes.has(providerConfig.id)) {
      throw new Error(
        `identityProviders.oidc has duplicate provider id "${providerConfig.id}"`,
      );
    }
    oidcRuntimes.set(providerConfig.id, createOidcProviderRuntime(providerConfig));
  }

  // SAML SP providers, built once and keyed by provider id. A SAML runtime is
  // pure/synchronous (the IdP signing cert is configured directly, so there's
  // no discovery/network step). A duplicate provider id is a hard config error.
  const samlRuntimes = new Map<string, SamlProviderRuntime>();
  for (const providerConfig of options.config.saml ?? []) {
    if (samlRuntimes.has(providerConfig.id)) {
      throw new Error(
        `identityProviders.saml has duplicate provider id "${providerConfig.id}"`,
      );
    }
    samlRuntimes.set(providerConfig.id, createSamlProviderRuntime(providerConfig));
  }

  // FR-29: one TTL knob for every provider session. Threaded from the server's
  // configured `FRICK_SESSION_TTL_SECONDS`; only falls back to the legacy
  // 30-day value when a caller constructs the router without passing it.
  const sessionTtlSeconds = options.sessionTtlSeconds ?? FALLBACK_SESSION_TTL_SECONDS;

  // FR-33: opt-in refresh / short-access-token split. Resolved once; when
  // present, sign-ins mint a refresh token + short access session and the
  // `/auth/refresh*` routes come online. When absent, everything below behaves
  // exactly as it did before this ticket.
  const refresh: ResolvedRefresh | undefined = options.config.refresh
    ? {
        accessTokenTtlSeconds:
          options.config.refresh.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
        refreshTokenTtlSeconds:
          options.config.refresh.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
        rotateOnRefresh: options.config.refresh.rotateOnRefresh ?? true,
      }
    : undefined;

  // Effective session (access-token) lifetime. With the refresh split enabled
  // the session is the SHORT access token; otherwise it keeps the single
  // configured session TTL.
  const accessTtlSeconds = refresh ? refresh.accessTokenTtlSeconds : sessionTtlSeconds;

  /**
   * Build the JSON body for a successful sign-in. When the refresh split is
   * enabled, mints a refresh token bound to the same `(tenant, user, device,
   * replica)` as the session and attaches `refreshToken` /
   * `refreshTokenExpiresAt` to the response. Without it, the body is identical
   * to the pre-FR-33 shape.
   */
  async function buildSessionResponse(
    session: MintedSession,
    extra: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      session: toFrickSessionShape(session, options.store.schema.hash),
      ...extra,
    };
    if (refresh) {
      const issued = await options.store.refreshTokens.issue({
        tenantId: session.tenantId,
        userId: session.userId,
        deviceId: session.deviceId,
        replicaId: session.replicaId,
        ttlSeconds: refresh.refreshTokenTtlSeconds,
      });
      body.refreshToken = issued.token;
      body.refreshTokenExpiresAt = issued.expiresAt;
    }
    return body;
  }

  // FR-29: shared auth-attempt throttle. Provider-verify and password-reset
  // endpoints run through the same limiter `/auth/login` uses, so an attacker
  // can't sidestep the password-login ceiling by hammering a provider route.
  // Returns true when the request was rate-limited (a 429 has been sent and the
  // caller must stop processing).
  const authThrottle = options.authThrottle;
  function throttled(input: {
    req: IncomingMessage;
    res: ServerResponse;
    route: string;
    identifier: string;
    /**
     * auth-core-4: when true, the throttle bucket is keyed on the identifier
     * COMBINED with the client IP, so one attacker IP can only drain its own
     * (identifier, IP) bucket and cannot lock out the victim's own
     * (identifier, victim-IP) bucket. Used by forgot-password, where keying on
     * the victim email alone lets an attacker deny a victim's reset capability.
     */
    keyByIp?: boolean;
  }): boolean {
    if (!authThrottle) return false;
    const ip = authThrottle.clientIp(input.req);
    const identifier =
      input.keyByIp && input.identifier ? `${input.identifier} ip:${ip}` : input.identifier;
    const limited = authThrottle.check({
      route: input.route,
      identifier,
      ip,
    });
    if (!limited) return false;
    sendRateLimited(input.res, limited.retryAfterSeconds);
    return true;
  }

  async function handleAppleVerify(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!options.config.apple) {
      sendJson(res, 404, { error: "apple_provider_not_configured" });
      return;
    }
    // FR-29: throttle by IP — the identityToken isn't a stable identifier yet.
    if (throttled({ req, res, route: "apple-verify", identifier: "" })) return;
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

    const existing = await findUserBySubject(
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
        await findPrimaryTenantForUser(options.store, existing.id as string);
      const session = await mintSession({
        store: options.store,
        sessionTtlSeconds: accessTtlSeconds,
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
      sendJson(res, 200, await buildSessionResponse(session, {
        user: existing,
        isNewUser: false,
      }));
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

    const session = await mintSession({
      store: options.store,
      sessionTtlSeconds: accessTtlSeconds,
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
    sendJson(res, 200, await buildSessionResponse(session, {
      user: { id: userId, ...userRow },
      isNewUser: true,
    }));
  }

  async function handleGoogleVerify(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!options.config.google) {
      sendJson(res, 404, { error: "google_provider_not_configured" });
      return;
    }
    // FR-29: throttle by IP — the idToken isn't a stable identifier yet.
    if (throttled({ req, res, route: "google-verify", identifier: "" })) return;
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

    const existing = await findUserBySubject(
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
        await findPrimaryTenantForUser(options.store, existing.id as string);
      const session = await mintSession({
        store: options.store,
        sessionTtlSeconds: accessTtlSeconds,
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
      sendJson(res, 200, await buildSessionResponse(session, {
        user: existing,
        isNewUser: false,
      }));
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

    const session = await mintSession({
      store: options.store,
      sessionTtlSeconds: accessTtlSeconds,
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
    sendJson(res, 200, await buildSessionResponse(session, {
      user: { id: userId, ...userRow },
      isNewUser: true,
    }));
  }

  async function handleOidcVerify(
    providerId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const runtime = oidcRuntimes.get(providerId);
    if (!runtime) {
      sendJson(res, 404, { error: "oidc_provider_not_configured", providerId });
      return;
    }
    // FR-29: throttle per provider id, by IP (the idToken isn't stable yet).
    if (throttled({ req, res, route: `oidc-verify:${providerId}`, identifier: "" })) return;
    let body: { idToken?: unknown; nonce?: unknown; deviceId?: unknown; replicaId?: unknown };
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
    const expectedNonce = typeof body.nonce === "string" ? body.nonce : undefined;

    const override = options.config.oidcVerifyOverrides?.[providerId];
    const verifyOptions: VerifyOidcOptions = {
      ...(expectedNonce !== undefined ? { expectedNonce } : {}),
      ...(override?.jwksOverride ? { jwksOverride: override.jwksOverride } : {}),
      ...(override?.discoveryOverride
        ? { discoveryOverride: override.discoveryOverride }
        : {}),
    };

    let verified;
    try {
      verified = await runtime.verify(idToken, verifyOptions);
    } catch (err) {
      const code = (err as { code?: string }).code ?? "JWTVerifyError";
      log.info("auth.oidc.verify_failed", {
        event: "auth.oidc.verify_failed",
        providerId,
        code,
      });
      sendJson(res, 401, {
        error: "oidc_token_invalid",
        providerId,
        code,
        message: err instanceof Error ? err.message : "verification failed",
      });
      return;
    }

    const deviceId = typeof body.deviceId === "string" ? body.deviceId : undefined;
    const replicaId = typeof body.replicaId === "string" ? body.replicaId : undefined;

    // Subjects are scoped by provider id so two issuers that reuse the same
    // `sub` value never alias onto the same User row.
    const scopedSubject = `${providerId}:${verified.subject}`;
    const existing = await findUserBySubject(
      options.store,
      userObject,
      userObject.oidcSubjectField,
      scopedSubject,
    );

    if (existing) {
      if (existing[userObject.revokedAtField]) {
        log.info("auth.oidc.signin_blocked_revoked", {
          event: "auth.oidc.signin_blocked_revoked",
          providerId,
          userId: existing.id as string,
        });
        sendJson(res, 403, {
          error: "user_revoked",
          message: "This account has been revoked.",
        });
        return;
      }
      const primaryTenantId =
        (existing[userObject.primaryTenantField] as string | undefined) ??
        await findPrimaryTenantForUser(options.store, existing.id as string);
      const session = await mintSession({
        store: options.store,
        sessionTtlSeconds: accessTtlSeconds,
        userId: existing.id as string,
        tenantId: primaryTenantId,
        displayName: (existing[userObject.displayNameField] as string) ?? "Crate user",
        deviceId,
        replicaId,
      });
      log.info("auth.oidc.signin_existing", {
        event: "auth.oidc.signin_existing",
        providerId,
        userId: existing.id,
        tenantId: primaryTenantId,
      });
      sendJson(res, 200, await buildSessionResponse(session, {
        user: existing,
        isNewUser: false,
      }));
      return;
    }

    // First sign-in. Standard OIDC claims (name / preferred_username / email)
    // and any configured claimMappings populate the User row; the app picks
    // the tenant + userId via onFirstSignIn.
    const defaultDisplayName =
      verified.name ??
      verified.preferredUsername ??
      (verified.email ? verified.email.split("@")[0]! : "Crate user");
    let hook: OnFirstSignInResult;
    try {
      const cb = options.config.onFirstSignIn;
      const fullName = verified.name ? { givenName: verified.name } : undefined;
      hook = cb
        ? await cb({
            provider: "oidc",
            providerId,
            subject: verified.subject,
            email: verified.email,
            fullName,
          })
        : { tenantId: SYSTEM_TENANT };
    } catch (err) {
      log.error("auth.oidc.onFirstSignIn_failed", {
        event: "auth.oidc.onFirstSignIn_failed",
        providerId,
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
      [userObject.googleSubjectField]: undefined,
      [userObject.oidcSubjectField]: scopedSubject,
      [userObject.createdAtField]: now,
      [userObject.revokedAtField]: undefined,
      [userObject.primaryTenantField]: hook.tenantId,
      // claimMappings.extra first, so an explicit onFirstSignIn extraUserFields
      // (app-authoritative) can still override a mapped claim.
      ...verified.extraUserFields,
      ...(hook.extraUserFields ?? {}),
    };
    options.store.upsertObject(SYSTEM_TENANT, userObject.type, userId, userRow);

    const session = await mintSession({
      store: options.store,
      sessionTtlSeconds: accessTtlSeconds,
      userId,
      tenantId: hook.tenantId,
      displayName,
      deviceId,
      replicaId,
    });
    log.info("auth.oidc.signin_new", {
      event: "auth.oidc.signin_new",
      providerId,
      userId,
      tenantId: hook.tenantId,
    });
    sendJson(res, 200, await buildSessionResponse(session, {
      user: { id: userId, ...userRow },
      isNewUser: true,
    }));
  }

  function handleSamlMetadata(
    providerId: string,
    res: ServerResponse,
  ): void {
    const runtime = samlRuntimes.get(providerId);
    if (!runtime) {
      sendJson(res, 404, { error: "saml_provider_not_configured", providerId });
      return;
    }
    const xml = runtime.metadataXml();
    res.statusCode = 200;
    res.setHeader("content-type", "application/samlmetadata+xml; charset=utf-8");
    res.setHeader("content-length", Buffer.byteLength(xml).toString());
    res.setHeader("access-control-allow-origin", "*");
    res.end(xml);
  }

  async function handleSamlAcs(
    providerId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const runtime = samlRuntimes.get(providerId);
    if (!runtime) {
      sendJson(res, 404, { error: "saml_provider_not_configured", providerId });
      return;
    }
    // FR-29: throttle per provider id, by IP.
    if (throttled({ req, res, route: `saml-acs:${providerId}`, identifier: "" })) return;

    // The IdP/browser posts the assertion either as form-encoded `SAMLResponse`
    // (the HTTP-POST binding) or as a JSON body { samlResponse, ... }.
    let samlResponse = "";
    let relayState: string | undefined;
    let expectedInResponseTo: string | undefined;
    let deviceId: string | undefined;
    let replicaId: string | undefined;
    const contentType = (req.headers["content-type"] ?? "").toLowerCase();
    if (contentType.includes("application/json")) {
      let body: {
        samlResponse?: unknown;
        SAMLResponse?: unknown;
        relayState?: unknown;
        expectedInResponseTo?: unknown;
        deviceId?: unknown;
        replicaId?: unknown;
      };
      try {
        body = (await readJsonBody(req)) as typeof body;
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      samlResponse =
        typeof body.samlResponse === "string"
          ? body.samlResponse
          : typeof body.SAMLResponse === "string"
            ? body.SAMLResponse
            : "";
      relayState = typeof body.relayState === "string" ? body.relayState : undefined;
      // auth-saml-5: this value is supplied by the same party that submits the
      // assertion, so it is NOT a server-verified SP-initiated binding — it only
      // lets a trusted backend-to-backend caller (which issued its own
      // AuthnRequest and tracks the id out-of-band) assert an additional
      // equality check. The framework does not issue/persist AuthnRequest ids,
      // so the real IdP HTTP-POST binding (the `else` form path below) treats
      // the flow as unsolicited/IdP-initiated and never trusts a client-echoed
      // InResponseTo. Do not rely on this for CSRF/login-binding guarantees.
      expectedInResponseTo =
        typeof body.expectedInResponseTo === "string" ? body.expectedInResponseTo : undefined;
      deviceId = typeof body.deviceId === "string" ? body.deviceId : undefined;
      replicaId = typeof body.replicaId === "string" ? body.replicaId : undefined;
    } else {
      const form = await readFormBody(req);
      samlResponse = form.get("SAMLResponse") ?? form.get("samlResponse") ?? "";
      relayState = form.get("RelayState") ?? undefined;
    }
    if (!samlResponse) {
      sendJson(res, 400, { error: "SAMLResponse required" });
      return;
    }

    const override = options.config.samlVerifyOverrides?.[providerId];
    let verified;
    try {
      verified = runtime.verify(samlResponse, {
        ...(expectedInResponseTo !== undefined ? { expectedInResponseTo } : {}),
        ...(override ? { signatureVerifierOverride: override } : {}),
      });
    } catch (err) {
      const code =
        err instanceof SamlValidationError ? err.code : "SamlVerifyError";
      log.info("auth.saml.verify_failed", {
        event: "auth.saml.verify_failed",
        providerId,
        code,
      });
      sendJson(res, 401, {
        error: "saml_assertion_invalid",
        providerId,
        code,
        message: err instanceof Error ? err.message : "verification failed",
      });
      return;
    }

    // Replay protection: record the assertion ID; a second presentation loses.
    // auth-saml-4: pin the row to the skew-padded replay TTL (notOnOrAfter +
    // clockToleranceSec) so a GC'd row can never predate a still-acceptable
    // assertion and reopen a one-shot replay window.
    const fresh = await options.store.samlAssertions.markSeen({
      providerId,
      assertionId: verified.assertionId,
      expiresAt: verified.replayExpiresAt,
    });
    if (!fresh) {
      log.info("auth.saml.replay_blocked", {
        event: "auth.saml.replay_blocked",
        providerId,
        assertionId: verified.assertionId,
      });
      sendJson(res, 401, {
        error: "saml_assertion_invalid",
        providerId,
        code: "SamlAssertionReplay",
        message: "This SAML assertion has already been consumed.",
      });
      return;
    }

    // Subjects are scoped by provider id so two IdPs reusing the same NameID
    // never alias onto the same User row.
    const scopedSubject = `${providerId}:${verified.subject}`;
    const existing = await findUserBySubject(
      options.store,
      userObject,
      userObject.samlSubjectField,
      scopedSubject,
    );

    if (existing) {
      if (existing[userObject.revokedAtField]) {
        log.info("auth.saml.signin_blocked_revoked", {
          event: "auth.saml.signin_blocked_revoked",
          providerId,
          userId: existing.id as string,
        });
        sendJson(res, 403, {
          error: "user_revoked",
          message: "This account has been revoked.",
        });
        return;
      }
      const primaryTenantId =
        (existing[userObject.primaryTenantField] as string | undefined) ??
        await findPrimaryTenantForUser(options.store, existing.id as string);
      const session = await mintSession({
        store: options.store,
        sessionTtlSeconds: accessTtlSeconds,
        userId: existing.id as string,
        tenantId: primaryTenantId,
        displayName: (existing[userObject.displayNameField] as string) ?? "Crate user",
        deviceId,
        replicaId,
      });
      log.info("auth.saml.signin_existing", {
        event: "auth.saml.signin_existing",
        providerId,
        userId: existing.id,
        tenantId: primaryTenantId,
      });
      sendJson(res, 200, await buildSessionResponse(session, {
        user: existing,
        isNewUser: false,
        ...(relayState !== undefined ? { relayState } : {}),
      }));
      return;
    }

    // First sign-in. Mapped SAML attributes populate the User row; the app
    // picks the tenant + userId via onFirstSignIn.
    const defaultDisplayName =
      verified.name ??
      (verified.email ? verified.email.split("@")[0]! : verified.subject);
    let hook: OnFirstSignInResult;
    try {
      const cb = options.config.onFirstSignIn;
      const fullName = verified.name ? { givenName: verified.name } : undefined;
      hook = cb
        ? await cb({
            provider: "saml",
            providerId,
            subject: verified.subject,
            email: verified.email,
            fullName,
          })
        : { tenantId: SYSTEM_TENANT };
    } catch (err) {
      log.error("auth.saml.onFirstSignIn_failed", {
        event: "auth.saml.onFirstSignIn_failed",
        providerId,
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
      [userObject.googleSubjectField]: undefined,
      [userObject.samlSubjectField]: scopedSubject,
      [userObject.createdAtField]: now,
      [userObject.revokedAtField]: undefined,
      [userObject.primaryTenantField]: hook.tenantId,
      // Mapped attributes first, so an explicit onFirstSignIn extraUserFields
      // (app-authoritative) can still override a mapped attribute.
      ...verified.extraUserFields,
      ...(hook.extraUserFields ?? {}),
    };
    options.store.upsertObject(SYSTEM_TENANT, userObject.type, userId, userRow);

    const session = await mintSession({
      store: options.store,
      sessionTtlSeconds: accessTtlSeconds,
      userId,
      tenantId: hook.tenantId,
      displayName,
      deviceId,
      replicaId,
    });
    log.info("auth.saml.signin_new", {
      event: "auth.saml.signin_new",
      providerId,
      userId,
      tenantId: hook.tenantId,
    });
    sendJson(res, 200, await buildSessionResponse(session, {
      user: { id: userId, ...userRow },
      isNewUser: true,
      ...(relayState !== undefined ? { relayState } : {}),
    }));
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
    // auth-core-1 / auth-core-6: throttle signup by email (+ IP fallback) so the
    // 409 already-registered existence oracle can't be probed at scale and the
    // route can't be abused for account-spam. Runs before the duplicate lookup.
    if (throttled({ req, res, route: "email-signup", identifier: email })) return;

    // Duplicate-email check via the schema User index. Frick's
    // auth_accounts has its own UNIQUE on (tenant_id, handle) so the
    // SQL layer also enforces — but we want a clean 409 before then.
    const existing = await findUserBySubject(
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
      await options.store.createAccountUser({
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

    const session = await mintSession({
      store: options.store,
      sessionTtlSeconds: accessTtlSeconds,
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
    // First-sign-in welcome email. Framework-managed and best-effort: a
    // failed delivery is logged + audited but the signup still succeeds.
    if (emailRouter && outbound?.welcome) {
      await sendWelcomeEmail({
        emailRouter,
        outbound,
        tenantId: hook.tenantId,
        email,
        displayName,
        log,
      });
    }
    sendJson(res, 200, await buildSessionResponse(session, {
      user: { id: userId, ...userRow },
      isNewUser: true,
    }));
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
    // auth-core-1: throttle login by email (+ IP fallback) so an attacker can't
    // brute-force passwords against this route, which performs the same password
    // verification as the throttled built-in /auth/login.
    if (throttled({ req, res, route: "email-login", identifier: email })) return;

    const user = await findUserBySubject(
      options.store,
      userObject,
      userObject.emailField,
      email,
    );
    // auth-core-2: keep timing + response uniform whether or not the account
    // exists (and whether or not it is revoked) so login can't be used to
    // enumerate accounts. The unknown-email and revoked branches spend the same
    // Argon2id work a real verify miss would (constant-work dummy verify) and
    // return the identical 401 — never a fast 401 or a distinct revoked status.
    if (!user || user[userObject.revokedAtField]) {
      await options.store.verifyDummyPassword(password);
      sendJson(res, 401, { error: "invalid_credentials" });
      return;
    }

    const primaryTenantId =
      (user[userObject.primaryTenantField] as string | undefined) ??
      await findPrimaryTenantForUser(options.store, user.id);
    const account = await options.store.verifyAccountPassword(primaryTenantId, email, password);
    if (!account) {
      sendJson(res, 401, { error: "invalid_credentials" });
      return;
    }

    const session = await mintSession({
      store: options.store,
      sessionTtlSeconds: accessTtlSeconds,
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
    sendJson(res, 200, await buildSessionResponse(session, {
      user,
      isNewUser: false,
    }));
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

    const existing = await findUserBySubject(
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
        const killed = await options.store.deleteSessionsForUser(userId);
        // FR-33: also revoke any outstanding refresh tokens so a revoked user
        // can't mint fresh access tokens after their sessions are wiped.
        await options.store.refreshTokens.revokeForUser(userId);
        if (options.config.onRevoke) {
          try {
            await options.config.onRevoke({
              userId,
              tenantId: await findPrimaryTenantForUser(options.store, userId),
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
    // FR-29: throttle reset-token issuance so it can't be hammered for one
    // address; runs before lookup so it also caps unknown emails without leaking
    // whether an account exists. auth-core-4: key on email AND client IP so an
    // attacker IP drains only its own (email, IP) bucket and cannot lock out the
    // victim's legitimate reset requests from their own IP.
    if (throttled({ req, res, route: "forgot-password", identifier: email, keyByIp: true })) {
      return;
    }
    const user = await findUserBySubject(
      options.store,
      userObject,
      userObject.emailField,
      email,
    );
    if (user) {
      const userId = user.id as string;
      const tenantId =
        (user[userObject.primaryTenantField] as string | undefined) ??
        await findPrimaryTenantForUser(options.store, userId);
      const issued = await options.store.passwordResetTokens.issue({
        tenantId,
        userId,
      });
      log.info("auth.email.password_reset_issued", {
        event: "auth.email.password_reset_issued",
        userId,
        tenantId,
        expiresAt: issued.expiresAt,
      });
      recordResetAudit({
        action: "auth.password_reset.issued",
        subject: userId,
        outcome: "allow",
        detail: { tenantId, expiresAt: issued.expiresAt },
      });
      // Framework-managed send: when the app opted into `email.outbound`
      // and supplied a `resetUrl` builder, dispatch the templated reset
      // email through the configured adapter. Best-effort — a failure is
      // logged + audited but never changes the 200 response.
      if (emailRouter && outbound?.resetUrl) {
        try {
          await emailRouter.sendPasswordResetEmail({
            tenantId,
            to: email,
            resetUrl: outbound.resetUrl({ token: issued.token, email }),
            ...(outbound.appName ? { appName: outbound.appName } : {}),
          });
        } catch (err) {
          log.error("auth.email.password_reset_send_failed", {
            event: "auth.email.password_reset_send_failed",
            userId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // The `onPasswordResetRequested` hook still fires so apps that want
      // full control (custom provider, custom template, analytics) keep
      // their seam; absent both an outbound adapter and a hook, the token
      // is logged in DEBUG builds so a developer can copy it manually
      // during local testing.
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
      } else if (
        !(emailRouter && outbound?.resetUrl) &&
        process.env.NODE_ENV !== "production"
      ) {
        // No hook and no framework send delivered the token — log it in
        // dev so the developer can copy it manually; never logged in
        // production builds (guarded by NODE_ENV).
        log.info("auth.email.password_reset_token_dev_only", {
          event: "auth.email.password_reset_token_dev_only",
          email,
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
    // FR-29: throttle reset-token guessing by token value (+ IP fallback).
    if (throttled({ req, res, route: "reset-password", identifier: token })) return;
    if (password.length < minLen) {
      sendJson(res, 400, {
        error: "password_too_short",
        message: `Password must be at least ${minLen} characters.`,
      });
      return;
    }
    const consumed = await options.store.passwordResetTokens.consume(token);
    if (!consumed) {
      sendJson(res, 400, { error: "invalid_or_expired_token" });
      return;
    }
    const ok = await options.store.accounts.setPassword(
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
    await options.store.deleteSessionsForUser(consumed.userId);
    // FR-33: and any refresh tokens, so a reset fully cuts off prior credentials.
    await options.store.refreshTokens.revokeForUser(consumed.userId);
    log.info("auth.email.password_reset_completed", {
      event: "auth.email.password_reset_completed",
      userId: consumed.userId,
      tenantId: consumed.tenantId,
    });
    recordResetAudit({
      action: "auth.password_reset.completed",
      subject: consumed.userId,
      outcome: "allow",
      detail: { tenantId: consumed.tenantId },
    });
    sendJson(res, 200, { ok: true });
  }

  // FR-33: exchange a valid refresh token for a fresh short-lived access token
  // (a new session). Optionally rotates the refresh token (the default), in
  // which case the presented token is revoked and a fresh one is returned.
  async function handleRefresh(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!refresh) {
      sendJson(res, 404, { error: "refresh_not_configured" });
      return;
    }
    // Throttle by IP — the refresh token isn't a stable per-user identifier we
    // want to log, and a stolen token is the threat we're bounding here.
    if (throttled({ req, res, route: "refresh", identifier: "" })) return;
    let body: { refreshToken?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
    const refreshToken = typeof body.refreshToken === "string" ? body.refreshToken : "";
    if (!refreshToken) {
      sendJson(res, 400, { error: "refreshToken required" });
      return;
    }

    // Resolve (and optionally rotate) the refresh token. Rotation revokes the
    // presented token and issues a fresh one atomically, so a replayed token is
    // rejected on its second use.
    let record: { tenantId: string; userId: string; deviceId: string; replicaId: string };
    let nextRefreshToken: string | undefined;
    let nextRefreshExpiresAt: string | undefined;
    if (refresh.rotateOnRefresh) {
      const rotated = await options.store.refreshTokens.rotate(
        refreshToken,
        refresh.refreshTokenTtlSeconds,
      );
      if (!rotated) {
        sendJson(res, 401, { error: "invalid_refresh_token" });
        return;
      }
      record = rotated;
      nextRefreshToken = rotated.token;
      nextRefreshExpiresAt = rotated.expiresAt;
    } else {
      const active = await options.store.refreshTokens.readActive(refreshToken);
      if (!active) {
        sendJson(res, 401, { error: "invalid_refresh_token" });
        return;
      }
      record = active;
    }

    // Refuse to mint an access token for a user whose account no longer exists
    // (e.g. deleted between issuance and refresh).
    if (!(await options.store.hasUser(record.tenantId, record.userId))) {
      sendJson(res, 401, { error: "invalid_refresh_token" });
      return;
    }

    const session = await mintSession({
      store: options.store,
      sessionTtlSeconds: accessTtlSeconds,
      userId: record.userId,
      tenantId: record.tenantId,
      displayName: record.userId,
      deviceId: record.deviceId,
      replicaId: record.replicaId,
      skipAccountCreate: true,
    });
    log.info("auth.refresh.exchanged", {
      event: "auth.refresh.exchanged",
      userId: record.userId,
      tenantId: record.tenantId,
      rotated: refresh.rotateOnRefresh,
    });
    const responseBody: Record<string, unknown> = {
      session: toFrickSessionShape(session, options.store.schema.hash),
    };
    if (nextRefreshToken && nextRefreshExpiresAt) {
      responseBody.refreshToken = nextRefreshToken;
      responseBody.refreshTokenExpiresAt = nextRefreshExpiresAt;
    }
    sendJson(res, 200, responseBody);
  }

  // FR-33: revoke a refresh token so it can no longer be exchanged. Idempotent
  // — an unknown or already-revoked token still returns 200 so a client can't
  // probe which tokens are live.
  async function handleRefreshRevoke(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!refresh) {
      sendJson(res, 404, { error: "refresh_not_configured" });
      return;
    }
    let body: { refreshToken?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
    const refreshToken = typeof body.refreshToken === "string" ? body.refreshToken : "";
    if (!refreshToken) {
      sendJson(res, 400, { error: "refreshToken required" });
      return;
    }
    await options.store.refreshTokens.revoke(refreshToken);
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
      if (req.method === "POST" && url.pathname === "/auth/refresh") {
        await handleRefresh(req, res);
        return true;
      }
      if (req.method === "POST" && url.pathname === "/auth/refresh/revoke") {
        await handleRefreshRevoke(req, res);
        return true;
      }
      // Generic OIDC: /auth/oidc/:providerId/verify
      const oidcMatch =
        req.method === "POST"
          ? /^\/auth\/oidc\/([^/]+)\/verify$/.exec(url.pathname)
          : null;
      if (oidcMatch) {
        const providerId = decodeURIComponent(oidcMatch[1]!);
        await handleOidcVerify(providerId, req, res);
        return true;
      }
      // SAML SP metadata: GET /auth/saml/:providerId/metadata
      const samlMetaMatch =
        req.method === "GET"
          ? /^\/auth\/saml\/([^/]+)\/metadata$/.exec(url.pathname)
          : null;
      if (samlMetaMatch) {
        const providerId = decodeURIComponent(samlMetaMatch[1]!);
        handleSamlMetadata(providerId, res);
        return true;
      }
      // SAML SP ACS (assertion consumer): POST /auth/saml/:providerId/acs
      const samlAcsMatch =
        req.method === "POST"
          ? /^\/auth\/saml\/([^/]+)\/acs$/.exec(url.pathname)
          : null;
      if (samlAcsMatch) {
        const providerId = decodeURIComponent(samlAcsMatch[1]!);
        await handleSamlAcs(providerId, req, res);
        return true;
      }
      return false;
    },
  };
}

interface UserRow extends Record<string, unknown> {
  id: string;
}

async function sendWelcomeEmail(input: {
  emailRouter: FrickEmailRouter;
  outbound: EmailOutboundConfig;
  tenantId: string;
  email: string;
  displayName: string;
  log: FrickLogger;
}): Promise<void> {
  const { emailRouter, outbound, tenantId, email, displayName, log } = input;
  const welcome = outbound.welcome;
  if (!welcome) return;
  const appName = outbound.appName ?? "Your app";
  const subject = welcome.subject ?? `Welcome to ${appName}`;
  const body = welcome.body
    ? welcome.body({ email, displayName })
    : { text: `Welcome to ${appName}, ${displayName}! Your account is ready.` };
  try {
    await emailRouter.send(
      {
        to: email,
        from: welcome.from ?? outbound.defaultFrom,
        subject,
        text: body.text,
        ...(body.html ? { html: body.html } : {}),
        tags: { kind: "welcome", tenantId },
      },
      { tenantId },
    );
  } catch (err) {
    log.error("auth.email.welcome_send_failed", {
      event: "auth.email.welcome_send_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function findUserBySubject(
  store: FrickStore,
  userObject: ResolvedUserObject,
  subjectField: string,
  subject: string,
): Promise<UserRow | undefined> {
  // auth-core-5: this is an O(N) scan of all User rows. Objects are persisted as
  // opaque packed blobs (see ObjectStore.list), so there is no per-field SQL
  // column to index on without a storage-layer change — a true indexed lookup is
  // tracked as follow-up. The unauthenticated DoS amplification the scan enabled
  // is now bounded because every unauthenticated caller of this helper (email
  // login/signup/forgot-password and the apple/google/oidc/saml verifies) is
  // gated behind the shared auth-attempt throttle BEFORE reaching here, so the
  // scan can no longer be driven by an unthrottled request flood.
  const users = (await store.listObjects(SYSTEM_TENANT, userObject.type)) as unknown as UserRow[];
  return users.find((u) => u[subjectField] === subject);
}

async function findPrimaryTenantForUser(store: FrickStore, userId: string): Promise<string> {
  // Apps own the membership model — we look for a TenantMembership row
  // pointing at this user in the system tenant. Falls back to userId-
  // as-tenant when no membership exists (the app didn't define one).
  type MembershipRow = { tenantId: string; userId: string; joinedAt?: number };
  let memberships: MembershipRow[] = [];
  try {
    memberships = (await store.listObjects(SYSTEM_TENANT, "TenantMembership")) as unknown as MembershipRow[];
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

async function mintSession(input: {
  store: FrickStore;
  userId: string;
  tenantId: string;
  displayName: string;
  /**
   * Session lifetime in seconds. Threaded from the server's configured
   * `FRICK_SESSION_TTL_SECONDS` so every provider session honors the same TTL
   * as the built-in password-login sessions (FR-29).
   */
  sessionTtlSeconds: number;
  deviceId?: string | undefined;
  replicaId?: string | undefined;
  /**
   * Skip the auto-create-account-if-missing path. Useful for the
   * email provider where we've already called `createAccountUser`
   * with a real password and don't want the helper to clobber it
   * with a random throwaway.
   */
  skipAccountCreate?: boolean;
}): Promise<MintedSession> {
  if (!input.skipAccountCreate && !input.store.hasUser(input.tenantId, input.userId)) {
    // Password hashing is async now (FR-35: Argon2id), so await the create to
    // ensure the row is persisted before the caller mints/uses the session.
    await input.store.createAccountUser({
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
    Date.now() + input.sessionTtlSeconds * 1000,
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

// auth-core-9: device binding (FR-32) ties a session to the deviceId/replicaId
// stored server-side, and the gateway rejects a Hello from a different device.
// Note this is NOT a token-theft countermeasure: `deviceId`/`replicaId` are
// echoed back in the sign-in response below, so an attacker who captures the
// full sign-in response also obtains the values needed to satisfy the binding.
// Device binding defends the "legitimate client's device changed" re-auth case,
// not exfiltration of the whole session payload. To harden against theft, bind
// to a value the server derives independently (e.g. a channel-bound key) rather
// than a client-chosen, response-echoed id.
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

/**
 * 429 for a rate-limited provider/reset attempt (FR-29). Carries a
 * `retry-after` header plus `retryAfterSeconds` in the body, in this router's
 * own flat `{ error }` envelope so it stays consistent with the other
 * identity-route error responses.
 */
function sendRateLimited(res: ServerResponse, retryAfterSeconds: number): void {
  res.setHeader("retry-after", String(retryAfterSeconds));
  sendJson(res, 429, { error: "rate_limited", retryAfterSeconds });
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

/**
 * Read an `application/x-www-form-urlencoded` body into a map. Used by the
 * SAML ACS endpoint, which receives the HTTP-POST binding's `SAMLResponse` /
 * `RelayState` form fields when the IdP auto-posts the browser back to the SP.
 */
async function readFormBody(req: IncomingMessage): Promise<Map<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const params = new URLSearchParams(text);
  const out = new Map<string, string>();
  for (const [k, v] of params) out.set(k, v);
  return out;
}
