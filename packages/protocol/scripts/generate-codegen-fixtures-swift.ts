/**
 * Golden Swift-codegen fixtures for the FR-236 Rust rewrite (FR-240).
 *
 * Runs the production TypeScript Swift generator
 * (`generateSwiftArtifact`, packages/protocol/src/artifacts.ts) on both
 * `foundationSchema` and `productTestSchema` — each passed through
 * `validateSchema` exactly as the generation pipeline does — and writes:
 *
 *   conformance/fixtures/codegen/swift/<name>.swift       — the generator
 *     output plus the single trailing newline the
 *     `generate-native-artifacts.ts` driver appends.
 *   conformance/fixtures/codegen/swift/<name>-schema.json — the validated
 *     (key-sorted) schema as pretty JSON, the input the Rust test
 *     deserializes to reproduce the artifact.
 *
 * The Rust `frick-codegen` crate (`src/swift.rs`) must reproduce every
 * `.swift` fixture byte-for-byte.
 *
 * Run from the repo root:
 *   pnpm exec tsx packages/protocol/scripts/generate-codegen-fixtures-swift.ts
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSwiftArtifact } from "../src/artifacts.js";
import { generateSwiftErrorEnum } from "../src/generators/error-enums.js";
import { foundationSchema } from "../src/foundation.js";
import { productTestSchema } from "../src/fixtures/product-test-schema.js";
import { validateSchema, type FrickSchema } from "../src/schema.js";

const outDir = join(process.cwd(), "conformance", "fixtures", "codegen", "swift");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// The artifact embeds the Swift error enum (no standalone Swift error file
// exists in the pipeline); pin the bare enum too so the Rust port of
// `generateSwiftErrorEnum` is testable in isolation.
const errorEnumPath = join(outDir, "error-enum.swift");
writeFileSync(errorEnumPath, `${generateSwiftErrorEnum()}\n`);
console.log(`Wrote ${errorEnumPath}`);

const cases: ReadonlyArray<readonly [string, FrickSchema]> = [
  ["foundation", validateSchema(foundationSchema)],
  ["product-test", validateSchema(productTestSchema)],
];

for (const [name, schema] of cases) {
  const swiftPath = join(outDir, `${name}.swift`);
  const schemaPath = join(outDir, `${name}-schema.json`);
  writeFileSync(swiftPath, `${generateSwiftArtifact(schema)}\n`);
  writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`Wrote ${swiftPath}`);
  console.log(`Wrote ${schemaPath}`);
}
