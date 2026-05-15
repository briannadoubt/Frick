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
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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
  readonly resolveHostname?: (hostname: string) => Promise<readonly { address: string }[]>;
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
  const resolveHostname = options.resolveHostname ?? defaultResolveHostname;
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
    if (!(await isSafeWebPushEndpointForSend(subscription.endpoint, resolveHostname))) {
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
    if (typeof parsed.endpoint !== "string" || !isSafeWebPushEndpoint(parsed.endpoint)) {
      return undefined;
    }
    return { endpoint: parsed.endpoint, keys: parsed.keys ?? { p256dh: "", auth: "" } };
  } catch {
    return undefined;
  }
}

export function validateWebPushRegistrationToken(token: string): void {
  if (!parseSubscriptionToken(token)) {
    throw new Error(
      "webPush token must be a PushSubscription JSON with a public https endpoint",
    );
  }
}

function isSafeWebPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") {
    return false;
  }
  return !isUnsafeHost(url.hostname);
}

async function isSafeWebPushEndpointForSend(
  endpoint: string,
  resolveHostname: (hostname: string) => Promise<readonly { address: string }[]>,
): Promise<boolean> {
  if (!isSafeWebPushEndpoint(endpoint)) {
    return false;
  }
  const url = new URL(endpoint);
  const host = normalizeHostname(url.hostname);
  if (isIP(host)) {
    return true;
  }
  try {
    const addresses = await resolveHostname(host);
    return addresses.length > 0 && addresses.every((row) => !isUnsafeHost(row.address));
  } catch {
    return false;
  }
}

async function defaultResolveHostname(hostname: string): Promise<readonly { address: string }[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

function isUnsafeHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "metadata.google.internal"
  ) {
    return true;
  }
  const version = isIP(host);
  if (version === 4) {
    return isUnsafeIpv4(host);
  }
  if (version === 6) {
    return isUnsafeIpv6(host);
  }
  return false;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
}

function isUnsafeIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a >= 224 && a <= 239) ||
    a >= 240
  );
}

function isUnsafeIpv6(host: string): boolean {
  const embeddedIpv4 = host.includes(".")
    ? host.slice(host.lastIndexOf(":") + 1)
    : undefined;
  if (embeddedIpv4 && isIP(embeddedIpv4) === 4 && isUnsafeIpv4(embeddedIpv4)) {
    return true;
  }
  const segments = parseIpv6Segments(host);
  if (!segments) {
    return true;
  }
  const first = segments[0]!;
  const allButLastZero = segments.slice(0, 7).every((segment) => segment === 0);
  return (
    (allButLastZero && (segments[7] === 0 || segments[7] === 1)) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00
  );
}

function parseIpv6Segments(host: string): number[] | undefined {
  const withoutZone = host.split("%", 1)[0] ?? host;
  const sides = withoutZone.split("::");
  if (sides.length > 2) {
    return undefined;
  }
  const left = splitIpv6Side(sides[0] ?? "");
  const right = splitIpv6Side(sides[1] ?? "");
  if (!left || !right) {
    return undefined;
  }
  const missing = 8 - left.length - right.length;
  if (sides.length === 1 && missing !== 0) {
    return undefined;
  }
  if (sides.length === 2 && missing < 0) {
    return undefined;
  }
  return [...left, ...Array(Math.max(0, missing)).fill(0), ...right];
}

function splitIpv6Side(side: string): number[] | undefined {
  if (side.length === 0) {
    return [];
  }
  const out: number[] = [];
  for (const part of side.split(":")) {
    if (part.length === 0 || part.length > 4 || !/^[0-9a-f]+$/i.test(part)) {
      return undefined;
    }
    const parsed = Number.parseInt(part, 16);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0xffff) {
      return undefined;
    }
    out.push(parsed);
  }
  return out;
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
