import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalizeSchemaIdentity,
  foundationSchema,
  schemaArtifactIdentity,
  schemaArtifactManifestEntry,
  signSchemaArtifact,
  verifySchemaArtifact,
  verifySchemaArtifactForSchema,
  type SchemaArtifactIdentity,
} from "../src/index.js";

function newKeyPair() {
  return generateKeyPairSync("ed25519");
}

function sampleIdentity(): SchemaArtifactIdentity {
  return schemaArtifactIdentity(foundationSchema, [
    schemaArtifactManifestEntry("packages/swift/Generated/FrickGenerated.swift", "swift-contents"),
    schemaArtifactManifestEntry("packages/core/src/generated/bindings.ts", "ts-contents"),
  ]);
}

describe("schema artifact signing", () => {
  it("round-trips: a signed artifact verifies with the matching public key", () => {
    const { publicKey, privateKey } = newKeyPair();
    const artifact = signSchemaArtifact(sampleIdentity(), privateKey);

    expect(artifact.algorithm).toBe("ed25519");
    expect(artifact.version).toBe(1);
    expect(verifySchemaArtifact(artifact, publicKey)).toEqual({ valid: true });
  });

  it("verifies via base64-encoded DER keys (not just KeyObjects)", () => {
    const { publicKey, privateKey } = newKeyPair();
    const privDer = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const pubDer = publicKey.export({ format: "der", type: "spki" }).toString("base64");

    const artifact = signSchemaArtifact(sampleIdentity(), privDer);
    expect(verifySchemaArtifact(artifact, pubDer)).toEqual({ valid: true });
  });

  it("verifies via PEM-encoded keys", () => {
    const { publicKey, privateKey } = newKeyPair();
    const privPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const pubPem = publicKey.export({ format: "pem", type: "spki" }).toString();

    const artifact = signSchemaArtifact(sampleIdentity(), privPem);
    expect(verifySchemaArtifact(artifact, pubPem)).toEqual({ valid: true });
  });

  it("fails verification when a manifest entry is tampered with", () => {
    const { publicKey, privateKey } = newKeyPair();
    const artifact = signSchemaArtifact(sampleIdentity(), privateKey);

    // Mutate the covered identity after signing — the signature must no longer match.
    const tampered = {
      ...artifact,
      identity: {
        ...artifact.identity,
        manifest: artifact.identity.manifest.map((entry, index) =>
          index === 0 ? { ...entry, sha256: "0".repeat(64) } : entry,
        ),
      },
    };

    const result = verifySchemaArtifact(tampered, publicKey);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signatureMismatch");
  });

  it("fails verification when the schema identity is tampered with", () => {
    const { publicKey, privateKey } = newKeyPair();
    const artifact = signSchemaArtifact(sampleIdentity(), privateKey);

    const tampered = {
      ...artifact,
      identity: { ...artifact.identity, schemaRevision: artifact.identity.schemaRevision + 1 },
    };

    expect(verifySchemaArtifact(tampered, publicKey).valid).toBe(false);
  });

  it("fails verification when the signature bytes are tampered with", () => {
    const { publicKey, privateKey } = newKeyPair();
    const artifact = signSchemaArtifact(sampleIdentity(), privateKey);

    const flipped = Buffer.from(artifact.signature, "base64");
    flipped[0] ^= 0xff;
    const tampered = { ...artifact, signature: flipped.toString("base64") };

    expect(verifySchemaArtifact(tampered, publicKey).valid).toBe(false);
  });

  it("fails verification with the wrong public key", () => {
    const signer = newKeyPair();
    const attacker = newKeyPair();
    const artifact = signSchemaArtifact(sampleIdentity(), signer.privateKey);

    const result = verifySchemaArtifact(artifact, attacker.publicKey);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signatureMismatch");
  });

  it("rejects unsupported signature versions and algorithms", () => {
    const { publicKey, privateKey } = newKeyPair();
    const artifact = signSchemaArtifact(sampleIdentity(), privateKey);

    expect(verifySchemaArtifact({ ...artifact, version: 2 as 1 }, publicKey)).toEqual({
      valid: false,
      reason: "unsupportedVersion",
      message: expect.stringContaining("2"),
    });
    expect(
      verifySchemaArtifact({ ...artifact, algorithm: "rsa" as "ed25519" }, publicKey).reason,
    ).toBe("unsupportedAlgorithm");
  });

  it("canonicalization is independent of manifest order", () => {
    const a = sampleIdentity();
    const b: SchemaArtifactIdentity = { ...a, manifest: [...a.manifest].reverse() };
    expect(canonicalizeSchemaIdentity(a).equals(canonicalizeSchemaIdentity(b))).toBe(true);
  });

  describe("verifySchemaArtifactForSchema", () => {
    it("accepts a valid signature over the expected schema identity", () => {
      const { publicKey, privateKey } = newKeyPair();
      const artifact = signSchemaArtifact(sampleIdentity(), privateKey);

      expect(
        verifySchemaArtifactForSchema(artifact, publicKey, {
          schemaId: foundationSchema.schemaId,
          schemaHash: foundationSchema.hash,
          schemaRevision: foundationSchema.schemaRevision,
        }),
      ).toEqual({ valid: true });
    });

    it("rejects a validly-signed but unexpected schema identity", () => {
      const { publicKey, privateKey } = newKeyPair();
      const artifact = signSchemaArtifact(sampleIdentity(), privateKey);

      const result = verifySchemaArtifactForSchema(artifact, publicKey, {
        schemaId: "some-other-app",
        schemaHash: foundationSchema.hash,
        schemaRevision: foundationSchema.schemaRevision,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("signatureMismatch");
    });
  });
});
