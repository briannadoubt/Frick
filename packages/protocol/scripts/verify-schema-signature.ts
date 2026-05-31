/**
 * Example client-side verifier for a detached schema signature (FR-45).
 *
 * Native/example clients that ship a trusted Ed25519 *public* key can run this
 * to confirm a generated schema bundle was signed by the expected build
 * pipeline before trusting it. This mirrors what an SDK would do at startup.
 *
 * Usage:
 *   tsx packages/protocol/scripts/verify-schema-signature.ts \
 *     --signature path/to/schema-signature.json \
 *     --public-key path/to/public-key.pem
 *
 * The public key may be PEM or base64-encoded SPKI DER. Exits non-zero on any
 * verification failure so it can gate a CI/release step.
 */
import { readFileSync } from "node:fs";
import {
  verifySchemaArtifact,
  type SchemaSignatureArtifact,
} from "../src/index.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const signaturePath = arg("signature");
const publicKeyPath = arg("public-key");

if (!signaturePath || !publicKeyPath) {
  console.error(
    "Usage: tsx verify-schema-signature.ts --signature <file.json> --public-key <key.pem|key.der.b64>",
  );
  process.exit(2);
}

const artifact = JSON.parse(readFileSync(signaturePath, "utf8")) as SchemaSignatureArtifact;
const publicKey = readFileSync(publicKeyPath, "utf8");

const result = verifySchemaArtifact(artifact, publicKey);

if (result.valid) {
  const { schemaId, schemaRevision, schemaHash } = artifact.identity;
  console.log(`OK: verified ${schemaId}@${schemaRevision} (${schemaHash})`);
  console.log(`  ${artifact.identity.manifest.length} artifact(s) covered by signature`);
  process.exit(0);
}

console.error(`FAILED (${result.reason ?? "unknown"}): ${result.message ?? "signature verification failed"}`);
process.exit(1);
