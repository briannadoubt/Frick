/**
 * Web Push adapter (VAPID-authenticated, RFC 8291 encrypted payloads).
 *
 * Closes the third leg of the push trio next to APNs and FCM. The
 * adapter signs a per-endpoint VAPID JWT (ES256 over the credential's
 * private key) and POSTs to the push subscription's `endpoint`.
 *
 * When the subscription carries the browser's `p256dh` + `auth` keys and
 * the intent has a payload, the adapter encrypts the notification body
 * per RFC 8291 (Message Encryption for Web Push) using the `aes128gcm`
 * content encoding (RFC 8188) and sends the ciphertext as the request
 * body with `Content-Encoding: aes128gcm`. The browser Service Worker
 * then has the decrypted `title`/`body`/`data` in its `push` event.
 *
 * When no subscription keys are present (older registrations) the adapter
 * falls back to an EMPTY body and lets the Service Worker show a generic
 * wake-up notification — backward compatible with the pre-FR-60 behavior.
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

import {
  createECDH,
  createHmac,
  createSign,
  createCipheriv,
  randomBytes,
  type CipherGCM,
} from "node:crypto";
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

/** Web Push (RFC 8291) caps the application payload at 4096 octets. */
const MAX_WEB_PUSH_PAYLOAD = 4096;
/** TTL (seconds) the push service holds an undelivered message for. */
const WEB_PUSH_TTL = "2419200";

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
      ttl: WEB_PUSH_TTL,
    };

    // RFC 8291: encrypt the notification payload when the subscription
    // carries the browser keys. Older registrations (no keys) keep the
    // backward-compatible empty-body wake-up path.
    const plaintext = encodeNotificationPayload(intent);
    // `BodyInit` doesn't list Node's `Buffer`, but `Buffer` is a `Uint8Array`
    // subclass, which `BodyInit` does accept — the runtime value is unchanged.
    let body: BodyInit = "";
    if (plaintext !== undefined && subscription.keys.p256dh && subscription.keys.auth) {
      let encrypted: Buffer;
      try {
        encrypted = encryptWebPushPayload(
          plaintext,
          subscription.keys.p256dh,
          subscription.keys.auth,
        );
      } catch {
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
      if (encrypted.length > MAX_WEB_PUSH_PAYLOAD) {
        return {
          registration,
          attemptedAt: new Date().toISOString(),
          status: "failed",
          error: {
            code: "push.payloadTooLarge",
            message: `Encrypted Web Push payload is ${encrypted.length} bytes (max ${MAX_WEB_PUSH_PAYLOAD})`,
          },
        };
      }
      body = encrypted as unknown as BodyInit;
      headers["content-encoding"] = "aes128gcm";
      headers["content-length"] = String(encrypted.length);
    } else {
      headers["content-length"] = "0";
    }

    const response = await fetchImpl(subscription.endpoint, {
      method: "POST",
      headers,
      body,
    });
    return translateWebPushResult(response, registration, intent);
  }

  return { platform: "webPush", send };
}

/**
 * Serialize the notification intent into the JSON blob the browser
 * Service Worker reads off the decrypted `push` event. Returns
 * `undefined` when there is nothing meaningful to encrypt so the adapter
 * can fall back to the empty-body wake-up path.
 */
function encodeNotificationPayload(intent: FrickNotificationIntent): string | undefined {
  const { title, body, data } = intent.body;
  if (title === undefined && body === undefined && data === undefined) {
    return undefined;
  }
  const payload: Record<string, unknown> = { intent: intent.intent };
  if (title !== undefined) payload.title = title;
  if (body !== undefined) payload.body = body;
  if (data !== undefined) payload.data = data;
  if (intent.threadId !== undefined) payload.threadId = intent.threadId;
  if (intent.deepLink !== undefined) payload.deepLink = intent.deepLink;
  return JSON.stringify(payload);
}

/**
 * Encrypt a Web Push payload per RFC 8291 using the `aes128gcm` content
 * encoding (RFC 8188).
 *
 * Steps (RFC 8291 §3.4):
 *   1. Generate an ephemeral P-256 keypair (`as_*`) and ECDH against the
 *      subscription's public key (`ua_public`, the `p256dh` value) to get
 *      the shared `ecdh_secret`.
 *   2. Derive the input keying material with HKDF-SHA-256 keyed by the
 *      subscription `auth` secret as salt, with
 *      `info = "WebPush: info\0" || ua_public || as_public`.
 *   3. Generate a random 16-byte content-encoding salt and run the
 *      RFC 8188 HKDF to derive the 16-byte AES-128-GCM content-encryption
 *      key (`info = "Content-Encoding: aes128gcm\0"`) and the 12-byte
 *      nonce (`info = "Content-Encoding: nonce\0"`).
 *   4. AES-128-GCM encrypt the single record: `plaintext || 0x02`
 *      delimiter padding (last record), no extra padding.
 *   5. Frame the body as the RFC 8188 header
 *      (`salt(16) || rs(4) || idlen(1) || keyid`) where `keyid` is the
 *      uncompressed ephemeral public key, followed by the ciphertext.
 *
 * @param payload    UTF-8 plaintext to deliver.
 * @param p256dhB64  Subscription `p256dh` (base64url, uncompressed P-256 point).
 * @param authB64    Subscription `auth` secret (base64url, 16 bytes).
 */
export function encryptWebPushPayload(
  payload: string | Buffer,
  p256dhB64: string,
  authB64: string,
): Buffer {
  const uaPublic = decodeBase64Url(p256dhB64);
  const authSecret = decodeBase64Url(authB64);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error("p256dh must be a 65-byte uncompressed P-256 point");
  }
  if (authSecret.length === 0) {
    throw new Error("auth secret must not be empty");
  }

  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(); // 65-byte uncompressed point.
  const ecdhSecret = ecdh.computeSecret(uaPublic); // 32-byte shared secret.

  // RFC 8291 §3.3: derive the pseudo-random key from the shared secret,
  // keyed by the auth secret, binding both public keys.
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    uaPublic,
    asPublic,
  ]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // RFC 8188 §2.2: content-encoding salt seeds the per-record key/nonce.
  const salt = randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12);

  // Single-record framing: append the 0x02 "last record" delimiter.
  const plaintext = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const record = Buffer.concat([plaintext, Buffer.from([0x02])]);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce) as CipherGCM;
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  // RFC 8188 §2.1 header: salt(16) || rs(4, big-endian) || idlen(1) || keyid.
  const rs = Buffer.alloc(4);
  // The record size MUST be large enough to hold the whole ciphertext.
  rs.writeUInt32BE(Math.max(ciphertext.length, MAX_WEB_PUSH_PAYLOAD), 0);
  const idlen = Buffer.from([asPublic.length]);
  return Buffer.concat([salt, rs, idlen, asPublic, ciphertext]);
}

/**
 * HKDF (RFC 5869) with SHA-256 for the short output lengths Web Push
 * needs (≤ 32 bytes), so a single expand block suffices.
 */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  const t = createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([0x01])]))
    .digest();
  return t.subarray(0, length);
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
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
