/**
 * Per-tenant credential storage for the push adapters.
 *
 * The framework lets ops store APNs (`.p8` private key + key id + team id +
 * bundle id) and FCM (Google service-account JSON) credentials per tenant.
 * Credentials are stored in `tenant_settings` under the keys
 * `push.apns.encrypted` and `push.fcm.encrypted`, wrapped with AES-256-GCM
 * using a server-side key sourced from `FRICK_PUSH_CRED_KEY` (base64-encoded
 * 32 bytes).
 *
 * The encryption key is intentionally NOT loaded from the database — that
 * would defeat the purpose.
 *
 * Multi-key rotation (FR-61): `FRICK_PUSH_CRED_KEY` always names the *primary*
 * key used for all new writes. To rotate without re-saving every tenant's
 * credentials in one shot, list one or more *previous* keys in
 * `FRICK_PUSH_CRED_KEY_PREVIOUS` (comma-separated, base64-encoded 32-byte
 * values). During the overlap window a credential encrypted under any listed
 * key still decrypts, while new writes use the primary. Retire a key by
 * dropping it from `FRICK_PUSH_CRED_KEY_PREVIOUS` once every tenant has been
 * re-saved under the new primary.
 *
 * If `FRICK_PUSH_CRED_KEY` is unset, the credentials module returns a
 * `PushCredentialsDisabled` error from every operation. That keeps a
 * misconfigured deploy from silently accepting plaintext secrets.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from "node:crypto";
import type { TenantSettingsStore } from "../storage/tenant-settings-store.js";

export const APNS_SETTINGS_KEY = "push.apns.encrypted";
export const FCM_SETTINGS_KEY = "push.fcm.encrypted";
export const WEB_PUSH_SETTINGS_KEY = "push.webPush.encrypted";

/**
 * APNs credentials. The framework signs JWTs (ES256) from `privateKeyPem` and
 * attaches `keyId` + `teamId` as JWT header / claim per Apple's docs.
 * `bundleId` becomes the `apns-topic` header on every push.
 */
export interface ApnsCredentials {
  readonly keyId: string;
  readonly teamId: string;
  readonly bundleId: string;
  readonly privateKeyPem: string;
  /**
   * When `true`, the adapter targets `api.sandbox.push.apple.com`. Default
   * is `false` (production endpoint). Useful for development builds running
   * on a tenant whose ops haven't cut over to prod certs yet.
   */
  readonly useSandbox?: boolean;
}

/**
 * FCM credentials. Sourced verbatim from a Google service-account JSON. We
 * keep the full record so we can exchange JWT-bearer assertions for OAuth2
 * access tokens via `tokenUri`, and so we can derive the message endpoint
 * from `projectId`. `clientEmail` is the JWT `iss` claim; `privateKey` is
 * the PEM-encoded RSA key matching `privateKeyId`.
 */
export interface FcmCredentials {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly tokenUri?: string;
}

/**
 * Web push credentials. VAPID keypair (subject + public + private) plus
 * an optional `audience` override the adapter uses to scope the
 * authorization JWT. Subject must be either `mailto:` or `https://`.
 */
export interface WebPushCredentials {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

export type PushCredentialError =
  | { code: "push.credentials.disabled"; message: string }
  | { code: "push.credentials.missing"; message: string }
  | { code: "push.credentials.corrupt"; message: string };

const ENCRYPTION_ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function decodeKey(raw: string | undefined): Buffer | undefined {
  if (!raw) return undefined;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, "base64");
  } catch {
    return undefined;
  }
  if (decoded.length !== 32) return undefined;
  return decoded;
}

/**
 * The ordered set of keys to try when decrypting, primary first. The primary
 * comes from `FRICK_PUSH_CRED_KEY`; any additional overlap-window keys come
 * from `FRICK_PUSH_CRED_KEY_PREVIOUS` (comma-separated). Invalid / wrong-size
 * entries in the previous list are silently skipped so a stray comma or blank
 * doesn't disable decryption. Returns an empty array when no valid primary key
 * is configured.
 */
function readEncryptionKeys(env: NodeJS.ProcessEnv = process.env): Buffer[] {
  const primary = decodeKey(env.FRICK_PUSH_CRED_KEY);
  if (!primary) return [];
  const keys = [primary];
  const previous = env.FRICK_PUSH_CRED_KEY_PREVIOUS;
  if (previous) {
    for (const part of previous.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const decoded = decodeKey(trimmed);
      if (decoded) keys.push(decoded);
    }
  }
  return keys;
}

/** The single key used for all new writes (the primary), if configured. */
function readPrimaryKey(env: NodeJS.ProcessEnv = process.env): Buffer | undefined {
  return decodeKey(env.FRICK_PUSH_CRED_KEY);
}

/**
 * Wrap a plaintext credential record. The returned envelope is the
 * base64-encoded concatenation `iv || ciphertext || authTag`, which is what
 * we persist in `tenant_settings`.
 */
export function encryptCredential(
  value: object,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; ciphertext: string } | { ok: false; error: PushCredentialError } {
  const key = readPrimaryKey(env);
  if (!key) {
    return {
      ok: false,
      error: {
        code: "push.credentials.disabled",
        message: "FRICK_PUSH_CRED_KEY is unset or not a base64-encoded 32-byte value",
      },
    };
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ENCRYPTION_ALGO, key, iv) as CipherGCM;
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ok: true, ciphertext: Buffer.concat([iv, enc, tag]).toString("base64") };
}

export function decryptCredential<T extends object>(
  ciphertext: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; value: T } | { ok: false; error: PushCredentialError } {
  const keys = readEncryptionKeys(env);
  if (keys.length === 0) {
    return {
      ok: false,
      error: {
        code: "push.credentials.disabled",
        message: "FRICK_PUSH_CRED_KEY is unset or not a base64-encoded 32-byte value",
      },
    };
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(ciphertext, "base64");
  } catch {
    return { ok: false, error: { code: "push.credentials.corrupt", message: "not base64" } };
  }
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    return { ok: false, error: { code: "push.credentials.corrupt", message: "envelope too short" } };
  }
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const enc = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
  // Try the primary key first, then each overlap-window key in order. A GCM
  // auth-tag mismatch under one key just means the blob was written under a
  // different key, so we fall through; only after every key fails do we report
  // corruption.
  for (const key of keys) {
    const decipher = createDecipheriv(ENCRYPTION_ALGO, key, iv) as DecipherGCM;
    decipher.setAuthTag(tag);
    let plain: Buffer;
    try {
      plain = Buffer.concat([decipher.update(enc), decipher.final()]);
    } catch {
      continue;
    }
    try {
      return { ok: true, value: JSON.parse(plain.toString("utf8")) as T };
    } catch {
      return { ok: false, error: { code: "push.credentials.corrupt", message: "decrypted blob is not JSON" } };
    }
  }
  return { ok: false, error: { code: "push.credentials.corrupt", message: "decryption failed" } };
}

/**
 * Convenience: load APNs creds for a tenant. Returns the decrypted record or
 * a structured error describing why the lookup failed.
 */
export async function loadApnsCredentials(
  store: TenantSettingsStore,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; value: ApnsCredentials } | { ok: false; error: PushCredentialError }> {
  return loadCredential<ApnsCredentials>(store, tenantId, APNS_SETTINGS_KEY, env);
}

export async function loadFcmCredentials(
  store: TenantSettingsStore,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; value: FcmCredentials } | { ok: false; error: PushCredentialError }> {
  return loadCredential<FcmCredentials>(store, tenantId, FCM_SETTINGS_KEY, env);
}

export async function loadWebPushCredentials(
  store: TenantSettingsStore,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; value: WebPushCredentials } | { ok: false; error: PushCredentialError }> {
  return loadCredential<WebPushCredentials>(store, tenantId, WEB_PUSH_SETTINGS_KEY, env);
}

async function loadCredential<T extends object>(
  store: TenantSettingsStore,
  tenantId: string,
  key: string,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true; value: T } | { ok: false; error: PushCredentialError }> {
  const stored = await store.get(tenantId, key);
  if (typeof stored !== "string") {
    return {
      ok: false,
      error: { code: "push.credentials.missing", message: `No ${key} stored for tenant ${tenantId}` },
    };
  }
  return decryptCredential<T>(stored, env);
}

/** Save APNs creds for a tenant. Returns an error if encryption is disabled. */
export async function saveApnsCredentials(
  store: TenantSettingsStore,
  tenantId: string,
  value: ApnsCredentials,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true } | { ok: false; error: PushCredentialError }> {
  return saveCredential(store, tenantId, APNS_SETTINGS_KEY, value, env);
}

export async function saveFcmCredentials(
  store: TenantSettingsStore,
  tenantId: string,
  value: FcmCredentials,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true } | { ok: false; error: PushCredentialError }> {
  return saveCredential(store, tenantId, FCM_SETTINGS_KEY, value, env);
}

export async function saveWebPushCredentials(
  store: TenantSettingsStore,
  tenantId: string,
  value: WebPushCredentials,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true } | { ok: false; error: PushCredentialError }> {
  return saveCredential(store, tenantId, WEB_PUSH_SETTINGS_KEY, value, env);
}

async function saveCredential(
  store: TenantSettingsStore,
  tenantId: string,
  key: string,
  value: object,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true } | { ok: false; error: PushCredentialError }> {
  const wrapped = encryptCredential(value, env);
  if (!wrapped.ok) return wrapped;
  await store.set(tenantId, key, wrapped.ciphertext);
  return { ok: true };
}
