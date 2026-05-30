import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { frickDesignDefinition } from "../frick.design.js";
import { validateDesign } from "../validate.js";
import { lintComponentStyleFile } from "../validate-styles.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const componentStylePath = resolve(repoRoot, "packages/design-web/src/components.css");

const issues = [
  ...validateDesign(frickDesignDefinition),
  ...lintComponentStyleFile(componentStylePath),
];

if (issues.length > 0) {
  console.error(issues.join("\n"));
  process.exit(1);
}

console.log("Frick design definition is valid.");
