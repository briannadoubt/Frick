import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateKotlinArtifact, generateSwiftArtifact } from "../src/artifacts.js";
import { generateTypeScriptBindings } from "../src/generators/typescript.js";
import { generateTypeScriptErrorEnum } from "../src/generators/error-enums.js";
import { foundationSchema } from "../src/foundation.js";

const rootDir = process.cwd();
const swiftPath = join(rootDir, "packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift");
const kotlinPath = join(rootDir, "apps/android/frick/src/main/java/dev/frick/client/FrickGenerated.kt");
const tsBindingsPath = join(rootDir, "packages/core/src/generated/bindings.ts");
const tsErrorsPath = join(rootDir, "packages/core/src/generated/errors.ts");

writeFile(swiftPath, `${generateSwiftArtifact(foundationSchema)}\n`);
writeFile(kotlinPath, `${generateKotlinArtifact(foundationSchema)}\n`);
writeFile(tsBindingsPath, `${generateTypeScriptBindings(foundationSchema)}\n`);
writeFile(tsErrorsPath, `${generateTypeScriptErrorEnum()}\n`);

console.log(`Wrote ${swiftPath}`);
console.log(`Wrote ${kotlinPath}`);
console.log(`Wrote ${tsBindingsPath}`);
console.log(`Wrote ${tsErrorsPath}`);

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
