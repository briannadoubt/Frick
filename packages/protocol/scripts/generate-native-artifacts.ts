import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateKotlinArtifact, generateSwiftArtifact } from "../src/artifacts.js";
import { foundationSchema } from "../src/foundation.js";

const rootDir = process.cwd();
const swiftPath = join(rootDir, "packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift");
const kotlinPath = join(rootDir, "apps/android/frick/src/main/java/dev/frick/client/FrickGenerated.kt");

writeFile(swiftPath, `${generateSwiftArtifact(foundationSchema)}\n`);
writeFile(kotlinPath, `${generateKotlinArtifact(foundationSchema)}\n`);

console.log(`Wrote ${swiftPath}`);
console.log(`Wrote ${kotlinPath}`);

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
