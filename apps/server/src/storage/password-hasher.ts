import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import argon2 from "@node-rs/argon2";

/**
 * Pluggable password hashing for Frick account credentials (FR-35).
 *
 * Historically the server hashed passwords with a bare {@link scryptSync} call
 * and stored the raw derived key (base64url) alongside a separate per-user
 * salt column. That format is *not* self-describing: nothing in the stored
 * string says which algorithm or parameters produced it, so there is no way to
 * upgrade the hash function without a flag-day migration.
 *
 * This module replaces that with a self-describing string format and a small
 * {@link FrickPasswordHasher} interface so deployments can choose a stronger
 * KDF (Argon2id by default now) while existing scrypt credentials keep
 * verifying and get transparently re-hashed on the next successful login.
 *
 * ## Stored format
 *
 * Every hash produced here is a single self-describing string of the form:
 *
 * ```
 *   <algo>$<param1>$<param2>$...$<salt-b64url>$<digest-b64url>
 * ```
 *
 * - `scrypt$<N>$<r>$<p>$<keylen>$<salt>$<digest>`
 * - `argon2$<encoded-PHC-string>` — the argon2 library already emits a
 *   self-describing PHC string (`$argon2id$v=19$m=...,t=...,p=...$salt$hash`),
 *   so we only prefix it with `argon2$` to keep dispatch uniform.
 *
 * The leading algorithm tag is what {@link FrickPasswordHasher.verify} and
 * {@link FrickPasswordHasher.needsRehash} dispatch on, and what lets lazy
 * migration recognise a legacy/weaker hash.
 *
 * ## Legacy compatibility
 *
 * Rows written before FR-35 stored the salt in a separate `password_salt`
 * column and the digest (with no algorithm tag) in `password_hash`. The
 * account store reconstructs a legacy stored string of the form
 * `legacy-scrypt$<salt>$<digest>` from those two columns (see
 * {@link toStoredHash}) so the hasher can verify and flag it for rehash. New
 * rows leave `password_salt` empty because the salt is embedded in the
 * self-describing hash.
 */
export interface FrickPasswordHasher {
  /** Stable identifier for the active algorithm, e.g. `"argon2"`. */
  readonly id: string;
  /** Hash a plaintext password into a self-describing stored string. */
  hash(password: string): Promise<string>;
  /**
   * Verify a plaintext password against a stored string. Dispatches on the
   * algorithm tag, so a single hasher can verify hashes produced by any
   * supported algorithm (needed for migration).
   */
  verify(password: string, stored: string): Promise<boolean>;
  /**
   * True when `stored` was produced by an algorithm/parameter set weaker than
   * this hasher's current configuration and should be re-hashed on the next
   * successful login.
   */
  needsRehash(stored: string): boolean;
}

const LEGACY_SCRYPT_PREFIX = "legacy-scrypt";
const SCRYPT_PREFIX = "scrypt";
const ARGON2_PREFIX = "argon2";

// Default scrypt parameters. `N` must be a power of two. N=16384 is the Node
// default and matches the original bare `scryptSync` call's effective
// security; keylen 32 matches the original 32-byte digest.
const SCRYPT_DEFAULTS = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

// Argon2id parameters. These mirror the @node-rs/argon2 defaults (OWASP-ish:
// 19 MiB, 2 iterations) and are encoded into the PHC string, so verify reads
// them back from the stored hash rather than these constants.
const ARGON2_DEFAULTS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

function splitTag(stored: string): { tag: string; rest: string } {
  const idx = stored.indexOf("$");
  if (idx === -1) return { tag: stored, rest: "" };
  return { tag: stored.slice(0, idx), rest: stored.slice(idx + 1) };
}

function scryptDigest(password: string, salt: Buffer, params: ScryptParams): Buffer {
  return scryptSync(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    // scrypt with large N needs maxmem raised above the 32 MiB default.
    maxmem: 256 * 1024 * 1024,
  });
}

function encodeScrypt(salt: Buffer, digest: Buffer, params: ScryptParams): string {
  return [
    SCRYPT_PREFIX,
    params.N,
    params.r,
    params.p,
    params.keylen,
    salt.toString("base64url"),
    digest.toString("base64url"),
  ].join("$");
}

/** Verify a `scrypt$N$r$p$keylen$salt$digest` self-describing hash. */
function verifyScrypt(password: string, rest: string): boolean {
  const parts = rest.split("$");
  if (parts.length !== 6) return false;
  const [nStr, rStr, pStr, keylenStr, saltB64, digestB64] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const params: ScryptParams = {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
    keylen: Number(keylenStr),
  };
  if (
    !Number.isInteger(params.N) ||
    !Number.isInteger(params.r) ||
    !Number.isInteger(params.p) ||
    !Number.isInteger(params.keylen)
  ) {
    return false;
  }
  const salt = Buffer.from(saltB64, "base64url");
  const expected = Buffer.from(digestB64, "base64url");
  const actual = scryptDigest(password, salt, params);
  return constantTimeEqual(expected, actual);
}

/**
 * Verify a legacy `legacy-scrypt$<salt>$<digest>` pseudo-hash reconstructed
 * from the pre-FR-35 `password_salt`/`password_hash` columns. The original
 * code called `scryptSync(password, saltString, 32)` — note the salt was the
 * *string*, not decoded bytes — so we reproduce that exactly here.
 */
function verifyLegacyScrypt(password: string, rest: string): boolean {
  const sep = rest.indexOf("$");
  if (sep === -1) return false;
  const salt = rest.slice(0, sep);
  const digestB64 = rest.slice(sep + 1);
  const expected = Buffer.from(digestB64, "base64url");
  const actual = scryptSync(password, salt, 32);
  return constantTimeEqual(expected, actual);
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

abstract class BaseHasher implements FrickPasswordHasher {
  abstract readonly id: string;
  abstract hash(password: string): Promise<string>;
  abstract needsRehash(stored: string): boolean;

  async verify(password: string, stored: string): Promise<boolean> {
    const { tag, rest } = splitTag(stored);
    switch (tag) {
      case LEGACY_SCRYPT_PREFIX:
        return verifyLegacyScrypt(password, rest);
      case SCRYPT_PREFIX:
        return verifyScrypt(password, rest);
      case ARGON2_PREFIX:
        try {
          return await argon2.verify(rest, password);
        } catch {
          return false;
        }
      default:
        return false;
    }
  }
}

/** scrypt-based hasher matching (an upgraded form of) the original behavior. */
export class ScryptPasswordHasher extends BaseHasher {
  readonly id = SCRYPT_PREFIX;
  readonly #params: ScryptParams;

  constructor(params: Partial<ScryptParams> = {}) {
    super();
    this.#params = { ...SCRYPT_DEFAULTS, ...params };
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const digest = scryptDigest(password, salt, this.#params);
    return encodeScrypt(salt, digest, this.#params);
  }

  needsRehash(stored: string): boolean {
    const { tag, rest } = splitTag(stored);
    if (tag === LEGACY_SCRYPT_PREFIX) return true;
    // A hash produced by a stronger algorithm should not be downgraded.
    if (tag === ARGON2_PREFIX) return false;
    if (tag !== SCRYPT_PREFIX) return true;
    const parts = rest.split("$");
    if (parts.length !== 6) return true;
    const [nStr, rStr, pStr, keylenStr] = parts as [string, string, string, string, ...string[]];
    return (
      Number(nStr) !== this.#params.N ||
      Number(rStr) !== this.#params.r ||
      Number(pStr) !== this.#params.p ||
      Number(keylenStr) !== this.#params.keylen
    );
  }
}

/** Argon2id-based hasher — the recommended default for new deployments. */
export class Argon2PasswordHasher extends BaseHasher {
  readonly id = ARGON2_PREFIX;
  readonly #params: typeof ARGON2_DEFAULTS;

  constructor(params: Partial<typeof ARGON2_DEFAULTS> = {}) {
    super();
    this.#params = { ...ARGON2_DEFAULTS, ...params };
  }

  async hash(password: string): Promise<string> {
    const encoded = await argon2.hash(password, {
      memoryCost: this.#params.memoryCost,
      timeCost: this.#params.timeCost,
      parallelism: this.#params.parallelism,
    });
    return `${ARGON2_PREFIX}$${encoded}`;
  }

  needsRehash(stored: string): boolean {
    const { tag, rest } = splitTag(stored);
    // Anything not argon2 (legacy scrypt, self-describing scrypt) is weaker.
    if (tag !== ARGON2_PREFIX) return true;
    const encoded = parseArgon2Params(rest);
    if (encoded === undefined) return true; // Unparseable — re-hash to be safe.
    return (
      encoded.memoryCost !== this.#params.memoryCost ||
      encoded.timeCost !== this.#params.timeCost ||
      encoded.parallelism !== this.#params.parallelism ||
      encoded.variant !== "argon2id"
    );
  }
}

interface Argon2Params {
  variant: string;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

/**
 * Parse the cost parameters out of an argon2 PHC string of the form
 * `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`. Returns `undefined` when the
 * string is not a recognisable argon2 PHC encoding. Used by
 * {@link Argon2PasswordHasher.needsRehash} since the installed argon2 binding
 * does not expose a `needsRehash` helper.
 */
function parseArgon2Params(encoded: string): Argon2Params | undefined {
  const segments = encoded.split("$");
  // ["", "argon2id", "v=19", "m=...,t=...,p=...", salt, hash]
  if (segments.length < 4) return undefined;
  const variant = segments[1];
  const paramSegment = segments[3];
  if (variant === undefined || paramSegment === undefined) return undefined;
  if (!variant.startsWith("argon2")) return undefined;
  const params: Record<string, number> = {};
  for (const kv of paramSegment.split(",")) {
    const [key, value] = kv.split("=");
    if (key === undefined || value === undefined) return undefined;
    params[key] = Number(value);
  }
  const memoryCost = params.m;
  const timeCost = params.t;
  const parallelism = params.p;
  if (
    memoryCost === undefined ||
    timeCost === undefined ||
    parallelism === undefined ||
    !Number.isInteger(memoryCost) ||
    !Number.isInteger(timeCost) ||
    !Number.isInteger(parallelism)
  ) {
    return undefined;
  }
  return { variant, memoryCost, timeCost, parallelism };
}

export type FrickPasswordHasherId = "argon2" | "scrypt";

/**
 * Build a {@link FrickPasswordHasher} from a selection id. `argon2` is the
 * default for new credentials; `scrypt` is retained for back-compat and for
 * deployments that cannot run the native Argon2 binding.
 */
export function createPasswordHasher(
  id: FrickPasswordHasherId = "argon2",
): FrickPasswordHasher {
  switch (id) {
    case "scrypt":
      return new ScryptPasswordHasher();
    case "argon2":
      return new Argon2PasswordHasher();
    default: {
      const exhaustive: never = id;
      throw new Error(`Unknown password hasher: ${String(exhaustive)}`);
    }
  }
}

/**
 * Reconstruct the self-describing stored string for the legacy two-column
 * (`password_salt` + bare `password_hash`) format, so the hasher can verify
 * and flag it for migration. New rows store an empty salt and a tagged hash;
 * those are passed through unchanged.
 */
export function toStoredHash(passwordHash: string, passwordSalt: string): string {
  if (passwordHash.includes("$")) {
    // Already a self-describing hash (argon2$… or scrypt$…).
    return passwordHash;
  }
  // Legacy: salt lived in its own column, digest had no tag.
  return `${LEGACY_SCRYPT_PREFIX}$${passwordSalt}$${passwordHash}`;
}
