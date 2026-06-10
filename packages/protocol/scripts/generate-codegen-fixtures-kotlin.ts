/**
 * Golden Kotlin codegen fixtures for the FR-236 Rust rewrite (FR-240).
 *
 * Runs the production TypeScript Kotlin generators (`generateKotlinArtifact`
 * from `src/artifacts.ts` and `generateKotlinErrorEnum` from
 * `src/generators/error-enums.ts`) on the validated foundation and
 * product-test schemas and writes the generator outputs **verbatim** (no
 * trailing newline appended — the `schema:generate` driver adds one when it
 * writes the committed artifacts):
 *
 *   conformance/fixtures/codegen/kotlin/foundation.kt
 *   conformance/fixtures/codegen/kotlin/product-test.kt
 *   conformance/fixtures/codegen/kotlin/error-enum.kt
 *
 * The Rust `frick-codegen` crate byte-compares `generate_kotlin_artifact` /
 * `generate_kotlin_error_enum` output against these files.
 *
 * Run from the repo root:
 *   pnpm exec tsx packages/protocol/scripts/generate-codegen-fixtures-kotlin.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKotlinArtifact } from "../src/artifacts.js";
import { generateKotlinErrorEnum } from "../src/generators/error-enums.js";
import { foundationSchema } from "../src/foundation.js";
import { productTestSchema } from "../src/fixtures/product-test-schema.js";
import { validateSchema } from "../src/schema.js";

const outDir = join(process.cwd(), "conformance", "fixtures", "codegen", "kotlin");
mkdirSync(outDir, { recursive: true });

const outputs: Array<[name: string, content: string]> = [
  ["foundation.kt", generateKotlinArtifact(validateSchema(foundationSchema))],
  ["product-test.kt", generateKotlinArtifact(validateSchema(productTestSchema))],
  ["error-enum.kt", generateKotlinErrorEnum()],
];

for (const [name, content] of outputs) {
  const path = join(outDir, name);
  writeFileSync(path, content);
  console.log(`Wrote ${path}`);
}
