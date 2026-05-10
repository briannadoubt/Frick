import { frickDesignDefinition } from "../frick.design.js";
import { validateDesign } from "../validate.js";

const issues = validateDesign(frickDesignDefinition);

if (issues.length > 0) {
  console.error(issues.join("\n"));
  process.exit(1);
}

console.log("Frick design definition is valid.");
