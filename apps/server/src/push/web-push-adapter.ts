/**
 * Web Push adapter (VAPID-authenticated).
 *
 * Closes the third leg of the push trio next to APNs and FCM. The
 * adapter signs a per-endpoint VAPID JWT (ES256 over the credential's
 * private key), POSTs an empty body to the push subscription's
 * `endpoint`, and asks the browser-side Service Worker to fetch the
 * full payload from the server via the existing devtools / inspect
 * surface. (Full payload encryption per RFC 8291 is a non-trivial
 * follow-up and is intentionally not implemented here — for the first
 * iteration we route the consumer to the in-app feed for the actual
 * notification body, which is simpler and avoids shipping ECDH
 * primitives.)
 *
 * The push registration's `token` field is a JSON-encoded string of the
 * browser's `PushSubscription` (`{ endpoint, keys: { p256dh, auth } }`)
 * — clients register that blob via the existing `/push/registrations`
 * route. The adapter parses the token at delivery time and dispatches
 * to the registration's endpoint origin.
 *
 * Invalid-token translation:
 *   - HTTP 410 / 404 → `push.unregistered` (push subscription expired);
 *     the router tombstones the registration.
 *   - HTTP 413 → `push.payloadTooLarge`.
 *   - HTTP 429 → `push.rateLimited`.
 *   - 5xx → `push.serverError`.
 */

import { createSign } from "node:crypto";
import type {
  FrickNotificationContext,
  FrickNotificationIntent,
  FrickPushAdapter,
  FrickPushDelivery,
  PushDeviceRegistration,
} from "./types.js";
import { loadWebPushCredentials, type WebPushCredentials } from "./credentials.js";

/** VAPID JWT is valid up to 24h; refresh well before that to absorb skew. */
const JWT_REFRESH_MS = 12 * 60 * 60 * 1000;

export interface WebPushAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

interface CachedVapid {
  token: string;
  signedAtMs: number;
  audience: string;
}

export interface FrickWebPushAdapter extends FrickPushAdapter {
  platform: "webPush";
}

export function createFrickWebPushAdapter(options: WebPushAdapterOptions = {}): FrickWebPushAdapter {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetch ?? fetch;
  const vapidCache = new Map<string, CachedVapid>();

  function vapidHeader(creds: WebPushCredentials, audience: string): { authorization: string } {
    const cacheKey = `${creds.publicKey}\x00${audience}`;
    const cached = vapidCache.get(cacheKey);
    const nowMs = now();
    if (cached && cached.audience === audience && nowMs - cached.signedAtMs < JWT_REFRESH_MS) {
      return { authorization: `vapid t=${cached.token}, k=${creds.publicKey}` };
    }
    const exp = Math.floor(nowMs / 1000) + 12 * 60 * 60;
    const token = signVapidJwt(creds, audience, exp);
    vapidCache.set(cacheKey, { token, signedAtMs: nowMs, audience });
    return { authorization: `vapid t=${token}, k=${creds.publicKey}` };
  }

  async function send(
    intent: FrickNotificationIntent,
    registration: PushDeviceRegistration,
    ctx: FrickNotificationContext,
  ): Promise<FrickPushDelivery> {
    const credentialResult = loadWebPushCredentials(ctx.store.tenantSettings, ctx.tenantId, env);
    if (!credentialResult.ok) {
      return {
        registration,
        attemptedAt: new Date().toISOString(),
        status: "skipped",
        error: { code: credentialResult.error.code, message: credentialResult.error.message },
      };
    }
    const subscription = parseSubscriptionToken(registration.token);
    if (!subscription) {
      return {
        registration,
        attemptedAt: new Date().toISOString(),
        status: "failed",
        error: {
          code: "push.badDeviceToken",
          message: "Registration token is not a valid PushSubscription JSON",
        },
      };
    }
    const audience = new URL(subscription.endpoint).origin;
    const headers: Record<string, string> = {
      ...vapidHeader(credentialResult.value, audience),
      "content-length": "0",
      ttl: "60",
    };
    const response = await fetchImpl(subscription.endpoint, {
      method: "POST",
      headers,
      body: "",
    });
    return translateWebPushResult(response, registration, intent);
  }

  return { platform: "webPush", send };
}

function translateWebPushResult(
  response: Response,
  registration: PushDeviceRegistration,
  _intent: FrickNotificationIntent,
): FrickPushDelivery {
  const attemptedAt = new Date().toISOString();
  if (response.status >= 200 && response.status < 300) {
    return { registration, attemptedAt, status: "delivered" };
  }
  return {
    registration,
    attemptedAt,
    status: "failed",
    error: { code: mapStatus(response.status), message: `Web push ${response.status}` },
  };
}

function mapStatus(status: number): string {
  if (status === 404 || status === 410) return "push.unregistered";
  if (status === 413) return "push.payloadTooLarge";
  if (status === 429) return "push.rateLimited";
  if (status >= 500) return "push.serverError";
  return "push.deliveryFailed";
}

interface ParsedSubscription {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

function parseSubscriptionToken(token: string): ParsedSubscription | undefined {
  try {
    const parsed = JSON.parse(token) as Partial<ParsedSubscription>;
    if (typeof parsed.endpoint !== "string" || !parsed.endpoint.startsWith("http")) return undefined;
    return { endpoint: parsed.endpoint, keys: parsed.keys ?? { p256dh: "", auth: "" } };
  } catch {
    return undefined;
  }
}

/**
 * Sign a VAPID JWT. Header `ES256`, body `{ aud, exp, sub }`. Signature
 * is IEEE-P1363 (raw r||s) over `SHA256(header.payload)` — same shape
 * APNs requires, so we reuse the same crypto path.
 */
export function signVapidJwt(creds: WebPushCredentials, audience: string, exp: number): string {
  const header = base64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = base64url(JSON.stringify({ aud: audience, exp, sub: creds.subject }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const sig = signer.sign({ key: creds.privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64url(sig)}`;
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
