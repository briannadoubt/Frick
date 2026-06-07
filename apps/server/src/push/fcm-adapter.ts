/**
 * FCM v1 adapter. Implements {@link FrickPushAdapter} for the
 * `fcm.googleapis.com/v1/projects/{projectId}/messages:send` endpoint.
 *
 * FCM uses an OAuth2 access token: we sign a service-account JWT (RS256)
 * with the credential's private key, POST it as a bearer assertion to
 * `oauth2.googleapis.com/token`, and cache the resulting access token for
 * its `expires_in` window (defaults to one hour). One token per tenant is
 * sufficient — Google's quota is per-project.
 *
 * Invalid-token translation:
 *   - HTTP 404 + `errorCode: UNREGISTERED` → `push.unregistered`
 *   - HTTP 400 + `errorCode: INVALID_ARGUMENT` mentioning "registration" →
 *     `push.badDeviceToken`
 *   - All other failures keep their original FCM error code so operators can
 *     read it back from the job result.
 *
 * Tenants without FCM credentials get a `status: "skipped"` delivery with
 * `push.credentials.missing`, matching the APNs adapter's policy.
 */

import { createSign } from "node:crypto";
import type {
  FrickNotificationContext,
  FrickNotificationIntent,
  FrickPushAdapter,
  FrickPushDelivery,
  PushDeviceRegistration,
} from "./types.js";
import { loadFcmCredentials, type FcmCredentials } from "./credentials.js";

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const DEFAULT_FCM_BASE = "https://fcm.googleapis.com";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

export interface FcmAdapterOptions {
  /** Override the FCM base URL. Tests inject a local HTTP server. */
  readonly fcmBaseUrl?: string;
  /** Override the OAuth2 token endpoint. Tests inject a local HTTP server. */
  readonly tokenUri?: string;
  /** Inject a custom fetch (defaults to global `fetch`). */
  readonly fetch?: typeof fetch;
  /** Override `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Stub clock (epoch ms) for deterministic token expiry tests. */
  readonly now?: () => number;
}

interface CachedAccessToken {
  token: string;
  expiresAtMs: number;
}

export interface FrickFcmAdapter extends FrickPushAdapter {
  platform: "fcm";
}

export function createFrickFcmAdapter(options: FcmAdapterOptions = {}): FrickFcmAdapter {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetch ?? fetch;
  const tokens = new Map<string, CachedAccessToken>();

  async function getAccessToken(creds: FcmCredentials, tenantId: string): Promise<string> {
    const cacheKey = `${tenantId}:${creds.clientEmail}`;
    const cached = tokens.get(cacheKey);
    const nowMs = now();
    // Refresh 60s before expiry to absorb clock skew + latency.
    if (cached && cached.expiresAtMs - nowMs > 60_000) {
      return cached.token;
    }
    const tokenUri = options.tokenUri ?? creds.tokenUri ?? DEFAULT_TOKEN_URI;
    const assertion = signServiceAccountJwt(creds, Math.floor(nowMs / 1000), tokenUri);
    const form = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
    const response = await fetchImpl(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new FcmTokenExchangeError(response.status, text);
    }
    const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) {
      throw new FcmTokenExchangeError(response.status, "missing access_token");
    }
    const expiresInSec = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
    tokens.set(cacheKey, { token: parsed.access_token, expiresAtMs: nowMs + expiresInSec * 1000 });
    return parsed.access_token;
  }

  async function send(
    intent: FrickNotificationIntent,
    registration: PushDeviceRegistration,
    ctx: FrickNotificationContext,
  ): Promise<FrickPushDelivery> {
    const credentialResult = await loadFcmCredentials(ctx.store.tenantSettings, ctx.tenantId, env);
    if (!credentialResult.ok) {
      return {
        registration,
        attemptedAt: new Date().toISOString(),
        status: "skipped",
        error: { code: credentialResult.error.code, message: credentialResult.error.message },
      };
    }
    const creds = credentialResult.value;
    let accessToken: string;
    try {
      accessToken = await getAccessToken(creds, ctx.tenantId);
    } catch (error) {
      return {
        registration,
        attemptedAt: new Date().toISOString(),
        status: "failed",
        error: {
          code: "push.tokenExchangeFailed",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const fcmBase = options.fcmBaseUrl ?? DEFAULT_FCM_BASE;
    const url = `${fcmBase}/v1/projects/${encodeURIComponent(creds.projectId)}/messages:send`;
    const body = JSON.stringify({ message: encodeFcmMessage(intent, registration) });
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body,
    });
    const text = await response.text();
    return translateFcmResult(response.status, text, registration);
  }

  return { platform: "fcm", send };
}

class FcmTokenExchangeError extends Error {
  constructor(public readonly status: number, body: string) {
    super(`FCM token exchange failed: ${status} ${body.slice(0, 200)}`);
    this.name = "FcmTokenExchangeError";
  }
}

function encodeFcmMessage(
  intent: FrickNotificationIntent,
  registration: PushDeviceRegistration,
): Record<string, unknown> {
  const message: Record<string, unknown> = { token: registration.token };
  if (intent.body.title || intent.body.body) {
    message.notification = {
      ...(intent.body.title ? { title: intent.body.title } : {}),
      ...(intent.body.body ? { body: intent.body.body } : {}),
    };
  }
  const data: Record<string, string> = { intent: intent.intent };
  if (intent.threadId) data.threadId = intent.threadId;
  if (intent.deepLink) data.deepLink = intent.deepLink;
  if (intent.body.data) {
    for (const [k, v] of Object.entries(intent.body.data)) {
      // FCM v1 requires string-valued data.
      data[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
  }
  message.data = data;
  return message;
}

function translateFcmResult(
  status: number,
  body: string,
  registration: PushDeviceRegistration,
): FrickPushDelivery {
  const attemptedAt = new Date().toISOString();
  if (status >= 200 && status < 300) {
    let receiptId: string | undefined;
    try {
      const parsed = JSON.parse(body) as { name?: string };
      receiptId = parsed.name;
    } catch {
      /* swallow */
    }
    return {
      registration,
      attemptedAt,
      status: "delivered",
      ...(receiptId ? { receiptId } : {}),
    };
  }
  let errorCode = "";
  let errorMessage = body.slice(0, 200);
  try {
    const parsed = JSON.parse(body) as {
      error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> };
    };
    errorCode = parsed.error?.details?.[0]?.errorCode ?? parsed.error?.status ?? "";
    errorMessage = parsed.error?.message ?? errorMessage;
  } catch {
    /* fall through */
  }
  return {
    registration,
    attemptedAt,
    status: "failed",
    error: { code: mapFcmErrorCode(status, errorCode), message: `FCM ${status}: ${errorMessage}` },
  };
}

function mapFcmErrorCode(status: number, errorCode: string): string {
  if (status === 404 || errorCode === "UNREGISTERED") return "push.unregistered";
  if (errorCode === "INVALID_ARGUMENT") return "push.badDeviceToken";
  if (errorCode === "SENDER_ID_MISMATCH") return "push.badDeviceToken";
  if (errorCode === "QUOTA_EXCEEDED") return "push.rateLimited";
  if (status === 429) return "push.rateLimited";
  if (status >= 500) return "push.serverError";
  return "push.deliveryFailed";
}

/**
 * Sign a service-account JWT (RS256) for OAuth2 token exchange. Google
 * accepts up to a one-hour validity window; we sign for 60 minutes from
 * `issuedAtSeconds`.
 */
export function signServiceAccountJwt(
  creds: FcmCredentials,
  issuedAtSeconds: number,
  audience: string,
): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: creds.clientEmail,
      scope: FCM_SCOPE,
      aud: audience,
      iat: issuedAtSeconds,
      exp: issuedAtSeconds + 3600,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key: creds.privateKey });
  return `${signingInput}.${base64url(signature)}`;
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
