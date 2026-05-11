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
 * would defeat the purpose. Rotation: change the env var, re-`set` every
 * tenant's credentials. We do not (yet) support multi-key decryption.
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

export type PushCredentialError =
  | { code: "push.credentials.disabled"; message: string }
  | { code: "push.credentials.missing"; message: string }
  | { code: "push.credentials.corrupt"; message: string };

const ENCRYPTION_ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function readEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer | undefined {
  const raw = env.FRICK_PUSH_CRED_KEY;
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
 * Wrap a plaintext credential record. The returned envelope is the
 * base64-encoded concatenation `iv || ciphertext || authTag`, which is what
 * we persist in `tenant_settings`.
 */
export function encryptCredential(
  value: object,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; ciphertext: string } | { ok: false; error: PushCredentialError } {
  const key = readEncryptionKey(env);
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
  const key = readEncryptionKey(env);
  if (!key) {
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
  const decipher = createDecipheriv(ENCRYPTION_ALGO, key, iv) as DecipherGCM;
  decipher.setAuthTag(tag);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(enc), decipher.final()]);
  } catch {
    return { ok: false, error: { code: "push.credentials.corrupt", message: "decryption failed" } };
  }
  try {
    return { ok: true, value: JSON.parse(plain.toString("utf8")) as T };
  } catch {
    return { ok: false, error: { code: "push.credentials.corrupt", message: "decrypted blob is not JSON" } };
  }
}

/**
 * Convenience: load APNs creds for a tenant. Returns the decrypted record or
 * a structured error describing why the lookup failed.
 */
export function loadApnsCredentials(
  store: TenantSettingsStore,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; value: ApnsCredentials } | { ok: false; error: PushCredentialError } {
  return loadCredential<ApnsCredentials>(store, tenantId, APNS_SETTINGS_KEY, env);
}

export function loadFcmCredentials(
  store: TenantSettingsStore,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; value: FcmCredentials } | { ok: false; error: PushCredentialError } {
  return loadCredential<FcmCredentials>(store, tenantId, FCM_SETTINGS_KEY, env);
}

function loadCredential<T extends object>(
  store: TenantSettingsStore,
  tenantId: string,
  key: string,
  env: NodeJS.ProcessEnv,
): { ok: true; value: T } | { ok: false; error: PushCredentialError } {
  const stored = store.get(tenantId, key);
  if (typeof stored !== "string") {
    return {
      ok: false,
      error: { code: "push.credentials.missing", message: `No ${key} stored for tenant ${tenantId}` },
    };
  }
  return decryptCredential<T>(stored, env);
}

/** Save APNs creds for a tenant. Returns an error if encryption is disabled. */
export function saveApnsCredentials(
  store: TenantSettingsStore,
  tenantId: string,
  value: ApnsCredentials,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true } | { ok: false; error: PushCredentialError } {
  return saveCredential(store, tenantId, APNS_SETTINGS_KEY, value, env);
}

export function saveFcmCredentials(
  store: TenantSettingsStore,
  tenantId: string,
  value: FcmCredentials,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true } | { ok: false; error: PushCredentialError } {
  return saveCredential(store, tenantId, FCM_SETTINGS_KEY, value, env);
}

function saveCredential(
  store: TenantSettingsStore,
  tenantId: string,
  key: string,
  value: object,
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; error: PushCredentialError } {
  const wrapped = encryptCredential(value, env);
  if (!wrapped.ok) return wrapped;
  store.set(tenantId, key, wrapped.ciphertext);
  return { ok: true };
}
