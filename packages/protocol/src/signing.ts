import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import type { FrickSchema } from "./schema.js";

/**
 * OPTIONAL schema-artifact signing (FR-45).
 *
 * The framework can emit a *detached* Ed25519 signature over a canonical
 * representation of a generated schema bundle's identity. Native clients that
 * ship a trusted public key can verify the bundle before trusting it, which
 * closes the "a compromised build pipeline ships a poisoned schema bundle"
 * gap described in `docs/threat-model.md`.
 *
 * Signing is entirely opt-in. Nothing here runs during `pnpm schema:generate`
 * unless a signing key is provided, so default generation is unchanged and
 * `pnpm verify:generated` stays clean without key infrastructure.
 *
 * The signature binds the schema identity (`schemaId`, `schemaHash`,
 * `schemaRevision`) together with a *manifest* — the list of emitted artifact
 * files and their content digests. Binding the manifest means tampering with
 * any generated file (not just the identity fields) invalidates the signature.
 */

export const SCHEMA_SIGNATURE_VERSION = 1 as const;
export const SCHEMA_SIGNATURE_ALGORITHM = "ed25519" as const;

/** One entry in a schema artifact manifest: a file and its content digest. */
export interface SchemaArtifactManifestEntry {
  /** Logical artifact path (e.g. the generated file's repo-relative path). */
  path: string;
  /** Lowercase hex SHA-256 digest of the artifact's bytes. */
  sha256: string;
}

/** The signed schema identity: the canonical subject of a signature. */
export interface SchemaArtifactIdentity {
  schemaId: string;
  schemaHash: string;
  schemaRevision: number;
  manifest: SchemaArtifactManifestEntry[];
}

/** A detached signature artifact emitted alongside generated outputs. */
export interface SchemaSignatureArtifact {
  /** Signature envelope version, for forward compatibility. */
  version: typeof SCHEMA_SIGNATURE_VERSION;
  /** Signature algorithm. Only "ed25519" is supported today. */
  algorithm: typeof SCHEMA_SIGNATURE_ALGORITHM;
  /** The canonically-serialized identity that was signed. */
  identity: SchemaArtifactIdentity;
  /** Base64-encoded Ed25519 signature over the canonical identity bytes. */
  signature: string;
}

export type SchemaSignaturePrivateKey = KeyObject | string | Buffer;
export type SchemaSignaturePublicKey = KeyObject | string | Buffer;

export interface VerifySchemaArtifactResult {
  valid: boolean;
  /** Present when verification fails: a stable machine-readable reason. */
  reason?:
    | "signatureMismatch"
    | "unsupportedVersion"
    | "unsupportedAlgorithm"
    | "malformedSignature"
    | "keyError";
  /** Human-readable detail, useful for logging. */
  message?: string;
}

/**
 * Compute the lowercase-hex SHA-256 digest of a buffer or string. Used to build
 * manifest entries from generated artifact contents.
 */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Build a manifest entry for a generated artifact from its raw contents.
 */
export function schemaArtifactManifestEntry(
  path: string,
  contents: string | Uint8Array,
): SchemaArtifactManifestEntry {
  return { path, sha256: sha256Hex(contents) };
}

/**
 * Build a {@link SchemaArtifactIdentity} from a schema and an artifact manifest.
 * Pulls the identity fields (`schemaId`, `schemaHash`, `schemaRevision`) from
 * the schema so callers cannot accidentally sign mismatched identity values.
 */
export function schemaArtifactIdentity(
  schema: FrickSchema,
  manifest: readonly SchemaArtifactManifestEntry[],
): SchemaArtifactIdentity {
  return {
    schemaId: schema.schemaId,
    schemaHash: schema.hash,
    schemaRevision: schema.schemaRevision,
    manifest: manifest.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
  };
}

/**
 * Produce the canonical byte representation of a schema identity. This is the
 * exact preimage that gets signed and verified, so it MUST be deterministic:
 * keys are emitted in a fixed order and the manifest is sorted by path.
 *
 * Returns a UTF-8 `Buffer` of stable JSON.
 */
export function canonicalizeSchemaIdentity(identity: SchemaArtifactIdentity): Buffer {
  const manifest = [...identity.manifest]
    .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // A hand-rolled stable serializer keeps the preimage independent of key
  // insertion order in the input object.
  const canonical = {
    version: SCHEMA_SIGNATURE_VERSION,
    algorithm: SCHEMA_SIGNATURE_ALGORITHM,
    schemaId: identity.schemaId,
    schemaHash: identity.schemaHash,
    schemaRevision: identity.schemaRevision,
    manifest,
  };

  return Buffer.from(JSON.stringify(canonical), "utf8");
}

/**
 * Sign a schema artifact identity with an Ed25519 private key and return a
 * detached signature artifact. The `key` may be a `KeyObject`, a PEM string, or
 * a base64-encoded DER (PKCS#8) private key.
 */
export function signSchemaArtifact(
  identity: SchemaArtifactIdentity,
  privateKey: SchemaSignaturePrivateKey,
): SchemaSignatureArtifact {
  const key = resolvePrivateKey(privateKey);
  const preimage = canonicalizeSchemaIdentity(identity);
  // Ed25519 uses no separate digest algorithm; pass null per Node's API.
  const signature = cryptoSign(null, preimage, key);

  return {
    version: SCHEMA_SIGNATURE_VERSION,
    algorithm: SCHEMA_SIGNATURE_ALGORITHM,
    identity: {
      schemaId: identity.schemaId,
      schemaHash: identity.schemaHash,
      schemaRevision: identity.schemaRevision,
      manifest: [...identity.manifest].map((entry) => ({
        path: entry.path,
        sha256: entry.sha256,
      })),
    },
    signature: signature.toString("base64"),
  };
}

/**
 * Verify a detached schema signature artifact against an Ed25519 public key.
 *
 * Returns a structured result rather than throwing for the expected failure
 * modes (bad signature, wrong key, malformed envelope) so callers can branch
 * without try/catch. Genuinely unexpected key-parsing problems are reported via
 * `reason: "keyError"`.
 */
export function verifySchemaArtifact(
  artifact: SchemaSignatureArtifact,
  publicKey: SchemaSignaturePublicKey,
): VerifySchemaArtifactResult {
  if (artifact.version !== SCHEMA_SIGNATURE_VERSION) {
    return {
      valid: false,
      reason: "unsupportedVersion",
      message: `Unsupported signature version: ${String(artifact.version)}`,
    };
  }
  if (artifact.algorithm !== SCHEMA_SIGNATURE_ALGORITHM) {
    return {
      valid: false,
      reason: "unsupportedAlgorithm",
      message: `Unsupported signature algorithm: ${String(artifact.algorithm)}`,
    };
  }

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(artifact.signature, "base64");
  } catch {
    return { valid: false, reason: "malformedSignature", message: "Signature is not valid base64" };
  }
  if (signatureBytes.length === 0) {
    return { valid: false, reason: "malformedSignature", message: "Signature is empty" };
  }

  let key: KeyObject;
  try {
    key = resolvePublicKey(publicKey);
  } catch (error) {
    return {
      valid: false,
      reason: "keyError",
      message: error instanceof Error ? error.message : "Failed to load public key",
    };
  }

  const preimage = canonicalizeSchemaIdentity(artifact.identity);

  let valid: boolean;
  try {
    valid = cryptoVerify(null, preimage, key, signatureBytes);
  } catch (error) {
    // A signature of the wrong length/shape can throw rather than return false.
    return {
      valid: false,
      reason: "signatureMismatch",
      message: error instanceof Error ? error.message : "Signature verification failed",
    };
  }

  if (!valid) {
    return { valid: false, reason: "signatureMismatch", message: "Signature does not match" };
  }
  return { valid: true };
}

/**
 * Convenience helper for native/example clients: verify a parsed signature
 * artifact against a trusted public key AND confirm it covers the expected
 * schema identity (id + hash + revision). Use when a client already knows which
 * schema it expects and wants to reject both forged signatures and a validly
 * signed but *different* schema bundle.
 */
export function verifySchemaArtifactForSchema(
  artifact: SchemaSignatureArtifact,
  publicKey: SchemaSignaturePublicKey,
  expected: { schemaId: string; schemaHash: string; schemaRevision: number },
): VerifySchemaArtifactResult {
  const result = verifySchemaArtifact(artifact, publicKey);
  if (!result.valid) {
    return result;
  }

  const { identity } = artifact;
  if (
    identity.schemaId !== expected.schemaId ||
    identity.schemaHash !== expected.schemaHash ||
    identity.schemaRevision !== expected.schemaRevision
  ) {
    return {
      valid: false,
      reason: "signatureMismatch",
      message:
        `Signed schema identity (${identity.schemaId}@${identity.schemaRevision}/${identity.schemaHash}) ` +
        `does not match expected (${expected.schemaId}@${expected.schemaRevision}/${expected.schemaHash})`,
    };
  }

  return { valid: true };
}

function resolvePrivateKey(privateKey: SchemaSignaturePrivateKey): KeyObject {
  if (isKeyObject(privateKey)) {
    return privateKey;
  }
  const pem = asPem(privateKey);
  if (pem !== undefined) {
    return createPrivateKey(pem);
  }
  // Base64-encoded DER (PKCS#8) private key.
  return createPrivateKey({ key: decodeBase64(privateKey), format: "der", type: "pkcs8" });
}

function resolvePublicKey(publicKey: SchemaSignaturePublicKey): KeyObject {
  if (isKeyObject(publicKey)) {
    // A private KeyObject can derive its public half; accept either.
    return publicKey.type === "private" ? createPublicKey(publicKey) : publicKey;
  }
  const pem = asPem(publicKey);
  if (pem !== undefined) {
    return createPublicKey(pem);
  }
  // Base64-encoded DER (SPKI) public key.
  return createPublicKey({ key: decodeBase64(publicKey), format: "der", type: "spki" });
}

function isKeyObject(value: SchemaSignaturePrivateKey): value is KeyObject {
  return typeof value === "object" && !Buffer.isBuffer(value);
}

/**
 * If `key` is a PEM string (or a Buffer holding PEM text), return it so the
 * caller can hand it to node:crypto verbatim. Returns `undefined` when the
 * input is not PEM (i.e. it should be treated as base64-encoded DER).
 */
function asPem(key: string | Buffer): string | Buffer | undefined {
  if (Buffer.isBuffer(key)) {
    return key.includes("-----BEGIN") ? key : undefined;
  }
  return key.includes("-----BEGIN") ? key : undefined;
}

function decodeBase64(key: string | Buffer): Buffer {
  if (Buffer.isBuffer(key)) {
    return key;
  }
  return Buffer.from(key.trim(), "base64");
}
