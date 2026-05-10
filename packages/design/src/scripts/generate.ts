import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { frickDesignDefinition } from "../frick.design.js";
import { generateJsonArtifact } from "../generate/json.js";
import { generateKotlinTokens } from "../generate/kotlin.js";
import { generateSwiftTokens } from "../generate/swift.js";
import { generateCssVariables, generateWebTokensModule } from "../generate/web.js";
import { resolveDesign } from "../resolver.js";
import { validateDesign } from "../validate.js";

const issues = validateDesign(frickDesignDefinition);
if (issues.length > 0) {
  console.error(issues.join("\n"));
  process.exit(1);
}

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const artifact = generateJsonArtifact();
const webDesign = resolveDesign(frickDesignDefinition, {
  mode: "light",
  density: "regular",
  brand: "frick",
  iconPack: "native",
  platform: "web",
});
const swiftDesign = resolveDesign(frickDesignDefinition, {
  mode: "light",
  density: "regular",
  brand: "frick",
  iconPack: "native",
  platform: "ios",
});
const androidDesign = resolveDesign(frickDesignDefinition, {
  mode: "light",
  density: "regular",
  brand: "frick",
  iconPack: "native",
  platform: "android",
});

await writeGenerated(resolve(repoRoot, "packages/design/dist/frick.design.json"), `${JSON.stringify(artifact, null, 2)}\n`);
await writeGenerated(resolve(repoRoot, "packages/design-web/src/generated/tokens.css"), generateCssVariables());
await writeGenerated(resolve(repoRoot, "packages/design-web/src/generated/tokens.ts"), generateWebTokensModule(webDesign));
await writeGenerated(
  resolve(repoRoot, "packages/design-swift/Sources/FrickDesign/Generated/FrickTokens.swift"),
  generateSwiftTokens(swiftDesign),
);
await writeGenerated(
  resolve(repoRoot, "apps/android/design/src/main/java/dev/frick/design/generated/FrickTokens.kt"),
  generateKotlinTokens(androidDesign),
);

console.log("Generated Frick design artifacts.");

async function writeGenerated(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
