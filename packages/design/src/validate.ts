import { resolveDesign } from "./resolver.js";
import type { FrickDesignDefinition, TokenAlias, TokenTree } from "./model.js";

export function validateDesign(definition: FrickDesignDefinition): string[] {
  const issues: string[] = [];
  validateMetrics("semantic.spacing", readTree(definition.semantic, "spacing"), issues);
  validateMetrics("semantic.padding", readTree(definition.semantic, "padding"), issues);
  validateMetrics("semantic.corner", readTree(definition.semantic, "corner"), issues);
  validateComponentIcons(definition.component, issues);
  validateIconMappings(definition, issues);
  validateResolvable(definition, issues);
  return issues;
}

function validateMetrics(path: string, tree: TokenTree | undefined, issues: string[]): void {
  if (!tree) {
    issues.push(`${path} is required`);
    return;
  }
  for (const [key, value] of Object.entries(tree)) {
    const nextPath = `${path}.${key}`;
    if (isAlias(value)) {
      continue;
    }
    if (isTokenTree(value)) {
      validateMetrics(nextPath, value, issues);
      continue;
    }
    if (typeof value === "number" && (value === 999 || value % 4 === 0)) {
      continue;
    }
    issues.push(`${nextPath} must be a 4-point metric or an alias`);
  }
}

function validateComponentIcons(tree: TokenTree, issues: string[], path = "component"): void {
  for (const [key, value] of Object.entries(tree)) {
    const nextPath = `${path}.${key}`;
    if (key === "icon") {
      if (!isAlias(value) || !value.$alias.startsWith("icon.")) {
        issues.push(`${nextPath} must reference icon.* semantic aliases`);
      }
      continue;
    }
    if (isTokenTree(value)) {
      validateComponentIcons(value, issues, nextPath);
    }
  }
}

function validateIconMappings(definition: FrickDesignDefinition, issues: string[]): void {
  for (const [key, icon] of Object.entries(definition.icons)) {
    for (const platform of ["web", "ios", "android", "fallback"] as const) {
      const mapping = icon[platform];
      if (!mapping.family || !mapping.name) {
        issues.push(`icon.${key}.${platform} must include family and name`);
      }
    }
  }
}

function validateResolvable(definition: FrickDesignDefinition, issues: string[]): void {
  try {
    resolveDesign(definition, {
      mode: "light",
      density: "regular",
      brand: "frick",
      iconPack: "native",
      platform: "web",
    });
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "Design definition failed to resolve");
  }
}

function readTree(tree: TokenTree, key: string): TokenTree | undefined {
  const value = tree[key];
  return isTokenTree(value) ? value : undefined;
}

function isAlias(value: unknown): value is TokenAlias {
  return isTokenTree(value) && "$alias" in value && typeof value.$alias === "string";
}

function isTokenTree(value: unknown): value is TokenTree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
