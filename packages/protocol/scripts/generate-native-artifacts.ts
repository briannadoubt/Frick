import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { generateKotlinArtifact, generateSwiftArtifact } from "../src/artifacts.js";
import { generateTypeScriptBindings } from "../src/generators/typescript.js";
import { generateTypeScriptErrorEnum } from "../src/generators/error-enums.js";
import { foundationSchema } from "../src/foundation.js";
import {
  schemaArtifactIdentity,
  schemaArtifactManifestEntry,
  signSchemaArtifact,
  type SchemaArtifactManifestEntry,
} from "../src/signing.js";

const rootDir = process.cwd();
const swiftPath = join(rootDir, "packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift");
const kotlinPath = join(rootDir, "apps/android/frick/src/main/java/dev/frick/client/FrickGenerated.kt");
const tsBindingsPath = join(rootDir, "packages/core/src/generated/bindings.ts");
const tsErrorsPath = join(rootDir, "packages/core/src/generated/errors.ts");
const signaturePath = join(rootDir, "packages/protocol/generated/schema-signature.json");

const manifest: SchemaArtifactManifestEntry[] = [];

writeArtifact(swiftPath, `${generateSwiftArtifact(foundationSchema)}\n`);
writeArtifact(kotlinPath, `${generateKotlinArtifact(foundationSchema)}\n`);
writeArtifact(tsBindingsPath, `${generateTypeScriptBindings(foundationSchema)}\n`);
writeArtifact(tsErrorsPath, `${generateTypeScriptErrorEnum()}\n`);

console.log(`Wrote ${swiftPath}`);
console.log(`Wrote ${kotlinPath}`);
console.log(`Wrote ${tsBindingsPath}`);
console.log(`Wrote ${tsErrorsPath}`);

// OPTIONAL signing (FR-45). Without a key this is a NO-OP, so default
// generation is byte-for-byte unchanged and `pnpm verify:generated` stays
// clean in CI. With a key, emit a detached Ed25519 signature over the schema
// identity + artifact manifest.
signIfKeyProvided();

function writeArtifact(path: string, content: string): void {
  writeFile(path, content);
  manifest.push(schemaArtifactManifestEntry(relative(rootDir, path), content));
}

function signIfKeyProvided(): void {
  const key = process.env.FRICK_SCHEMA_SIGNING_KEY;
  if (key === undefined || key.trim().length === 0) {
    // No key: signing is intentionally a no-op.
    return;
  }

  const identity = schemaArtifactIdentity(foundationSchema, manifest);
  const artifact = signSchemaArtifact(identity, key);
  writeFile(signaturePath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`Wrote ${signaturePath} (detached schema signature)`);
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
