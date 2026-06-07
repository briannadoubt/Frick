/**
 * APNs adapter. Implements the {@link FrickPushAdapter} contract by signing
 * an ES256 JWT from the tenant's stored APNs `.p8` private key, opening an
 * HTTP/2 connection to `api.push.apple.com` (or the sandbox variant), and
 * POSTing the encoded intent to `/3/device/<token>`.
 *
 * Per-tenant state is cached on the adapter instance:
 *
 *   - `connections`: one persistent HTTP/2 session per (tenant, environment).
 *     APNs requires HTTP/2 for batching; opening a session per request would
 *     burn ~150ms of TLS handshake on each notification.
 *   - `jwts`: cached signed bearer tokens. APNs accepts a JWT for up to
 *     60 minutes; we rotate at the 50-minute mark to absorb clock skew.
 *
 * The adapter is registered as a single global with `platform: "apns"`. It
 * resolves the per-tenant credentials at delivery time via
 * `ctx.store.tenantSettings`. Tenants without APNs credentials surface a
 * `status: "skipped"` delivery so the operator can see what's misconfigured.
 *
 * Invalid-token handling: APNs returns 410 + `{"reason":"Unregistered"}` or
 * 400 + `BadDeviceToken` for dead tokens. We translate those into the
 * `push.unregistered` / `push.badDeviceToken` error codes that the router's
 * `isPushRevocationError` recognizes, so the registration gets tombstoned.
 */

import { connect, type ClientHttp2Session } from "node:http2";
import { createSign } from "node:crypto";
import type {
  FrickNotificationContext,
  FrickNotificationIntent,
  FrickPushAdapter,
  FrickPushDelivery,
  PushDeviceRegistration,
} from "./types.js";
import { loadApnsCredentials, type ApnsCredentials } from "./credentials.js";

/** APNs JWT bearer is valid for ~1 hour; we refresh slightly earlier. */
const JWT_REFRESH_MS = 50 * 60 * 1000;
/** Header recommended by Apple for messaging traffic. */
const DEFAULT_PUSH_TYPE = "alert";

export interface ApnsAdapterOptions {
  /**
   * Override the URL the adapter dials. Defaults to
   * `https://api.push.apple.com` (or the sandbox URL when the tenant
   * credentials set `useSandbox: true`). Tests inject a local HTTP/2 server.
   */
  readonly endpoint?: string;
  /** Override `process.env` for tests. */
  readonly env?: NodeJS.ProcessEnv;
  /** Stub clock for deterministic JWT expiry tests. */
  readonly now?: () => number;
  /**
   * Override the HTTP/2 connector. Tests pass a function that returns a
   * pre-built session against their mock server.
   */
  readonly connect?: (endpoint: string) => ClientHttp2Session;
}

interface CachedSession {
  session: ClientHttp2Session;
  endpoint: string;
  closed: boolean;
}

interface CachedJwt {
  token: string;
  signedAtMs: number;
}

export interface FrickApnsAdapter extends FrickPushAdapter {
  platform: "apns";
  /** Close any cached HTTP/2 sessions. Call at server shutdown. */
  close(): Promise<void>;
}

export function createFrickApnsAdapter(options: ApnsAdapterOptions = {}): FrickApnsAdapter {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, CachedSession>();
  const jwts = new Map<string, CachedJwt>();

  function resolveEndpoint(creds: ApnsCredentials): string {
    if (options.endpoint) return options.endpoint;
    return creds.useSandbox ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  }

  function getSession(creds: ApnsCredentials, tenantId: string): ClientHttp2Session {
    const endpoint = resolveEndpoint(creds);
    const cacheKey = `${tenantId}:${endpoint}`;
    const existing = sessions.get(cacheKey);
    if (existing && !existing.closed && !existing.session.destroyed && !existing.session.closed) {
      return existing.session;
    }
    const session = options.connect ? options.connect(endpoint) : connect(endpoint);
    const entry: CachedSession = { session, endpoint, closed: false };
    session.on("close", () => {
      entry.closed = true;
      sessions.delete(cacheKey);
    });
    session.on("error", () => {
      entry.closed = true;
      sessions.delete(cacheKey);
    });
    sessions.set(cacheKey, entry);
    return session;
  }

  function getJwt(creds: ApnsCredentials, tenantId: string): string {
    const cacheKey = `${tenantId}:${creds.keyId}`;
    const cached = jwts.get(cacheKey);
    const nowMs = now();
    if (cached && nowMs - cached.signedAtMs < JWT_REFRESH_MS) {
      return cached.token;
    }
    const token = signApnsJwt(creds, Math.floor(nowMs / 1000));
    jwts.set(cacheKey, { token, signedAtMs: nowMs });
    return token;
  }

  async function send(
    intent: FrickNotificationIntent,
    registration: PushDeviceRegistration,
    ctx: FrickNotificationContext,
  ): Promise<FrickPushDelivery> {
    const credentialResult = await loadApnsCredentials(ctx.store.tenantSettings, ctx.tenantId, env);
    if (!credentialResult.ok) {
      return {
        registration,
        attemptedAt: new Date().toISOString(),
        status: "skipped",
        error: { code: credentialResult.error.code, message: credentialResult.error.message },
      };
    }
    const creds = credentialResult.value;
    const session = getSession(creds, ctx.tenantId);
    const jwt = getJwt(creds, ctx.tenantId);
    const body = encodeApnsBody(intent);

    const headers: Record<string, string> = {
      ":method": "POST",
      ":path": `/3/device/${registration.token}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": creds.bundleId,
      "apns-push-type": DEFAULT_PUSH_TYPE,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    };

    const result = await sendOnce(session, headers, body);
    return translateApnsResult(result, registration);
  }

  async function close(): Promise<void> {
    await Promise.all(
      Array.from(sessions.values()).map((entry) =>
        new Promise<void>((resolve) => {
          if (entry.closed || entry.session.destroyed) return resolve();
          entry.session.close(() => resolve());
        }),
      ),
    );
    sessions.clear();
    jwts.clear();
  }

  return { platform: "apns", send, close };
}

interface ApnsResult {
  status: number;
  apnsId?: string | undefined;
  body: string;
}

function sendOnce(
  session: ClientHttp2Session,
  headers: Record<string, string>,
  body: string,
): Promise<ApnsResult> {
  return new Promise((resolve, reject) => {
    const req = session.request(headers);
    let status = 0;
    let apnsId: string | undefined;
    const chunks: Buffer[] = [];
    req.on("response", (h) => {
      status = Number(h[":status"] ?? 0);
      const id = h["apns-id"];
      apnsId = typeof id === "string" ? id : Array.isArray(id) ? id[0] : undefined;
    });
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => {
      resolve({ status, apnsId, body: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", reject);
    req.end(body);
  });
}

function translateApnsResult(
  result: ApnsResult,
  registration: PushDeviceRegistration,
): FrickPushDelivery {
  const attemptedAt = new Date().toISOString();
  if (result.status === 200) {
    return {
      registration,
      attemptedAt,
      status: "delivered",
      ...(result.apnsId ? { receiptId: result.apnsId } : {}),
    };
  }
  let reason = "";
  try {
    const parsed = JSON.parse(result.body) as { reason?: string };
    reason = parsed.reason ?? "";
  } catch {
    /* fall through */
  }
  const code = mapApnsReason(result.status, reason);
  return {
    registration,
    attemptedAt,
    status: "failed",
    error: { code, message: `APNs ${result.status} ${reason || "unknown"}` },
    ...(result.apnsId ? { receiptId: result.apnsId } : {}),
  };
}

function mapApnsReason(status: number, reason: string): string {
  if (status === 410 || reason === "Unregistered") return "push.unregistered";
  if (reason === "BadDeviceToken") return "push.badDeviceToken";
  if (reason === "ExpiredProviderToken") return "push.tokenExpired";
  if (status === 413) return "push.payloadTooLarge";
  if (status === 429) return "push.rateLimited";
  if (status >= 500) return "push.serverError";
  return "push.deliveryFailed";
}

/**
 * Build the APNs JSON payload from a {@link FrickNotificationIntent}. We
 * default to an "alert" notification: title and body are surfaced under
 * `aps.alert`, and any custom `body.data` is hoisted to the top level
 * (APNs convention — non-`aps` top-level keys reach the app).
 */
function encodeApnsBody(intent: FrickNotificationIntent): string {
  const aps: Record<string, unknown> = {};
  if (intent.body.title || intent.body.body) {
    aps.alert = {
      ...(intent.body.title ? { title: intent.body.title } : {}),
      ...(intent.body.body ? { body: intent.body.body } : {}),
    };
  }
  if (intent.threadId) aps["thread-id"] = intent.threadId;
  aps.sound = "default";
  const payload: Record<string, unknown> = { aps };
  if (intent.body.data) {
    for (const [key, value] of Object.entries(intent.body.data)) {
      if (key === "aps") continue;
      payload[key] = value;
    }
  }
  if (intent.deepLink) payload.deepLink = intent.deepLink;
  payload.intent = intent.intent;
  return JSON.stringify(payload);
}

/**
 * Sign an APNs JWT (ES256 over the private key). Apple requires:
 *   - header: `{"alg":"ES256","kid":"<keyId>","typ":"JWT"}`
 *   - claims: `{"iss":"<teamId>","iat":<seconds since epoch>}`
 *   - signature: ECDSA P-256 / SHA-256 over `base64url(header).base64url(claims)`,
 *     emitted in IEEE P1363 (raw r||s) form — NOT the default DER that Node
 *     produces.
 */
export function signApnsJwt(creds: ApnsCredentials, issuedAtSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: creds.keyId, typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iss: creds.teamId, iat: issuedAtSeconds }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const der = signer.sign({ key: creds.privateKeyPem, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64url(der)}`;
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
