import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  foundationSchema,
  verifySchemaArtifact,
  type SchemaSignatureArtifact,
} from "../src/index.js";

// These tests exercise the OPTIONAL signing wired into `pnpm schema:generate`.
// They run the real generator script via tsx from the repo root.
const repoRoot = process.cwd();
const generateScript = join(repoRoot, "packages/protocol/scripts/generate-native-artifacts.ts");
const signaturePath = join(repoRoot, "packages/protocol/generated/schema-signature.json");

function runGenerate(env: NodeJS.ProcessEnv): void {
  execFileSync("npx", ["tsx", generateScript], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
}

describe("schema:generate optional signing", () => {
  beforeEach(() => {
    rmSync(signaturePath, { force: true });
  });

  afterEach(() => {
    rmSync(signaturePath, { force: true });
  });

  it("emits no signature artifact when FRICK_SCHEMA_SIGNING_KEY is unset", () => {
    runGenerate({ FRICK_SCHEMA_SIGNING_KEY: undefined });
    expect(existsSync(signaturePath)).toBe(false);
  });

  it("emits a verifiable detached signature when a key is provided", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

    runGenerate({ FRICK_SCHEMA_SIGNING_KEY: pem });

    expect(existsSync(signaturePath)).toBe(true);
    const artifact = JSON.parse(readFileSync(signaturePath, "utf8")) as SchemaSignatureArtifact;

    expect(artifact.identity.schemaId).toBe(foundationSchema.schemaId);
    expect(artifact.identity.schemaHash).toBe(foundationSchema.hash);
    expect(artifact.identity.schemaRevision).toBe(foundationSchema.schemaRevision);
    expect(artifact.identity.manifest.length).toBeGreaterThan(0);
    expect(verifySchemaArtifact(artifact, publicKey)).toEqual({ valid: true });
  }, 30_000);
});
