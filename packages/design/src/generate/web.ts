import type { FrickBrand, FrickDensity, FrickMode, ResolvedDesign } from "../model.js";
import { resolveDesign } from "../resolver.js";
import { frickDesignDefinition } from "../frick.design.js";

export function generateCssVariables(): string {
  const modes: FrickMode[] = ["light", "dark"];
  const densities: FrickDensity[] = ["compact", "regular", "comfortable"];
  const brands: FrickBrand[] = ["frick", "frickenChat"];
  const blocks: string[] = [];

  blocks.push(cssBlock(":root", webDesign("light", "regular", "frick")));
  blocks.push(cssBlock('[data-frick-mode="system"]', webDesign("light", "regular", "frick")));

  for (const mode of modes) {
    for (const density of densities) {
      for (const brand of brands) {
        blocks.push(
          cssBlock(
            `[data-frick-mode="${mode}"][data-frick-density="${density}"][data-frick-brand="${brand}"]`,
            webDesign(mode, density, brand),
          ),
        );
      }
    }
  }

  blocks.push(
    "@media (prefers-color-scheme: dark) {\n" +
      indent(cssBlock('[data-frick-mode="system"]', webDesign("dark", "regular", "frick"))) +
      "\n}\n",
  );

  return `${blocks.join("\n")}\n`;
}

export function generateWebTokensModule(design: ResolvedDesign): string {
  return `export const frickTokens = ${JSON.stringify(design, null, 2)} as const;\n\nexport const tokenMetadata = frickTokens;\n`;
}

function webDesign(mode: FrickMode, density: FrickDensity, brand: FrickBrand): ResolvedDesign {
  return resolveDesign(frickDesignDefinition, {
    mode,
    density,
    brand,
    iconPack: "native",
    platform: "web",
  });
}

function cssBlock(selector: string, design: ResolvedDesign): string {
  const lines = [`${selector} {`];
  flatten("--frick", design.semantic).forEach(([name, value]) => {
    lines.push(`  ${name}: ${formatCssValue(name, value)};`);
  });
  flatten("--frick-component", design.component).forEach(([name, value]) => {
    if (typeof value === "string" || typeof value === "number") {
      lines.push(`  ${name}: ${formatCssValue(name, value)};`);
    }
  });
  lines.push("}");
  return lines.join("\n");
}

function flatten(prefix: string, value: unknown): Array<[string, unknown]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [[prefix, value]];
  }
  return Object.entries(value).flatMap(([key, child]) => flatten(`${prefix}-${kebab(key)}`, child));
}

function formatCssValue(name: string, value: unknown): string {
  if (typeof value !== "number" || value === 0) {
    return String(value);
  }
  if (
    name.endsWith("-weight") ||
    name.includes("-opacity") ||
    name.endsWith("-line-height") ||
    name.endsWith("-ratio")
  ) {
    return String(value);
  }
  return `${value}px`;
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
