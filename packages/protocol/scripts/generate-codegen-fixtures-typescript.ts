/**
 * Golden codegen fixtures for the FR-236 Rust rewrite (FR-240) — TypeScript
 * targets.
 *
 * Runs the production TypeScript generators
 * (`generateTypeScriptBindings` from `src/generators/typescript.ts` and the
 * error-enum emitters from `src/generators/error-enums.ts`) and writes their
 * output verbatim (plus the single trailing newline the
 * `generate-native-artifacts.ts` driver appends) so the Rust
 * `frick-codegen` crate can byte-compare its port:
 *
 *   conformance/fixtures/codegen/typescript/foundation-bindings.ts
 *   conformance/fixtures/codegen/typescript/product-test-bindings.ts
 *   conformance/fixtures/codegen/typescript/errors.ts
 *
 * Only the TypeScript outputs are snapshotted here: the Swift/Kotlin
 * error enums from `src/generators/error-enums.ts` are spliced into the
 * native artifacts by `artifacts.ts`, so they are pinned by the Swift/Kotlin
 * fixture scripts (`conformance/fixtures/codegen/swift/`, `.../kotlin/`).
 *
 * Schemas are passed through `validateSchema` first, matching the pipeline
 * (the normalized clone is what servers hold; generators read named
 * properties, so output is identical either way).
 *
 * Run from the repo root:
 *   pnpm exec tsx packages/protocol/scripts/generate-codegen-fixtures-typescript.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { foundationSchema } from "../src/foundation.js";
import { productTestSchema } from "../src/fixtures/product-test-schema.js";
import { validateSchema } from "../src/schema.js";
import { generateTypeScriptBindings } from "../src/generators/typescript.js";
import { generateTypeScriptErrorEnum } from "../src/generators/error-enums.js";

const outDir = join(process.cwd(), "conformance", "fixtures", "codegen");

const validatedFoundation = validateSchema(foundationSchema);
const validatedProduct = validateSchema(productTestSchema);

writeFixture(
  join(outDir, "typescript", "foundation-bindings.ts"),
  generateTypeScriptBindings(validatedFoundation),
);
writeFixture(
  join(outDir, "typescript", "product-test-bindings.ts"),
  generateTypeScriptBindings(validatedProduct),
);
writeFixture(join(outDir, "typescript", "errors.ts"), generateTypeScriptErrorEnum());

function writeFixture(path: string, generated: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // Same convention as generate-native-artifacts.ts: generator output plus
  // exactly one trailing newline.
  writeFileSync(path, `${generated}\n`);
  console.log(`Wrote ${path}`);
}
