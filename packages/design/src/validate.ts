import { resolveDesign } from "./resolver.js";
import type {
  FrickBrand,
  FrickDensity,
  FrickDesignDefinition,
  FrickMode,
  TokenAlias,
  TokenTree,
} from "./model.js";

/**
 * WCAG 2.1 contrast thresholds.
 * - Normal body text must reach AA (4.5:1).
 * - UI component / large-text pairs (e.g. button labels) must reach the AA large
 *   threshold (3:1). Button-style controls render bold/large glyphs, so the action
 *   pairs are validated against this looser-but-still-accessible bar.
 */
const CONTRAST_AA_NORMAL = 4.5;
const CONTRAST_AA_LARGE = 3;

export function validateDesign(definition: FrickDesignDefinition): string[] {
  const issues: string[] = [];
  validateMetrics("semantic.spacing", readTree(definition.semantic, "spacing"), issues);
  validateMetrics("semantic.padding", readTree(definition.semantic, "padding"), issues);
  validateMetrics("semantic.corner", readTree(definition.semantic, "corner"), issues);
  validateScaleMembership(definition, issues);
  validateComponentIcons(definition.component, issues);
  validateIconMappings(definition, issues);
  validateComponentIconReferences(definition, issues);
  validateNoCircularAliases(definition, issues);
  validateContrast(definition, issues);
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

/**
 * Off-scale spacing/radius detection.
 *
 * `validateMetrics` only enforces the 4-point rhythm, which still admits raw numbers
 * (e.g. 36) that are not actually defined on the primitive scale. The token model
 * declares the authoritative scales under `primitive.space` and `primitive.radius`;
 * any literal spacing/padding/corner metric must be a member of those scales so that
 * generated artifacts never ship one-off values that drift from the system.
 */
function validateScaleMembership(definition: FrickDesignDefinition, issues: string[]): void {
  const spaceScale = numericScale(readTree(definition.primitive, "space"));
  const radiusScale = numericScale(readTree(definition.primitive, "radius"));

  const checkTree = (path: string, tree: TokenTree | undefined, scale: Set<number>, scaleName: string): void => {
    if (!tree) {
      return;
    }
    for (const [key, value] of Object.entries(tree)) {
      const nextPath = `${path}.${key}`;
      if (isAlias(value)) {
        continue;
      }
      if (isTokenTree(value)) {
        checkTree(nextPath, value, scale, scaleName);
        continue;
      }
      if (typeof value === "number" && !scale.has(value)) {
        issues.push(`${nextPath} value ${value} is off-scale (not a member of ${scaleName})`);
      }
    }
  };

  checkTree("semantic.spacing", readTree(definition.semantic, "spacing"), spaceScale, "primitive.space");
  checkTree("semantic.padding", readTree(definition.semantic, "padding"), spaceScale, "primitive.space");
  checkTree("semantic.corner", readTree(definition.semantic, "corner"), radiusScale, "primitive.radius");

  // Density overrides can also introduce literal metrics; validate the spacing
  // overrides each density layer contributes.
  for (const [density, layer] of Object.entries(definition.density)) {
    const overrides = readTree(layer, "semantic");
    checkTree(
      `density.${density}.semantic.spacing`,
      readTree(overrides ?? {}, "spacing"),
      spaceScale,
      "primitive.space",
    );
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

/**
 * Missing icon mapping detection.
 *
 * Components reference icons via `icon.<name>` aliases. Every such reference must point
 * at a key that actually exists in `definition.icons`; otherwise the alias resolves to a
 * raw string at generate time and the platform renders a non-existent glyph. This is the
 * static counterpart to the resolver's runtime lookup — it surfaces the offending
 * component path instead of silently emitting a dangling icon name.
 */
function validateComponentIconReferences(definition: FrickDesignDefinition, issues: string[]): void {
  const defined = new Set(Object.keys(definition.icons));
  const walk = (tree: TokenTree, path: string): void => {
    for (const [key, value] of Object.entries(tree)) {
      const nextPath = `${path}.${key}`;
      if (isAlias(value) && value.$alias.startsWith("icon.")) {
        const name = value.$alias.slice("icon.".length);
        if (!defined.has(name)) {
          issues.push(`${nextPath} references missing icon mapping "${name}"`);
        }
        continue;
      }
      if (isTokenTree(value)) {
        walk(value, nextPath);
      }
    }
  };
  walk(definition.component, "component");
}

/**
 * Circular alias detection.
 *
 * The resolver throws on cycles, but only for the single ResolveOptions combination
 * `validateResolvable` exercises. A circular chain can live entirely inside a density,
 * mode, or brand override layer that the default resolve never merges in. This walks the
 * fully-merged token tree for every layer combination and reports the cycle path up
 * front, before any artifact is generated.
 */
function validateNoCircularAliases(definition: FrickDesignDefinition, issues: string[]): void {
  const modes = Object.keys(definition.modes) as FrickMode[];
  const densities = Object.keys(definition.density) as FrickDensity[];
  const brands = Object.keys(definition.brands) as FrickBrand[];
  const seenCycles = new Set<string>();

  for (const mode of modes) {
    for (const density of densities) {
      for (const brand of brands) {
        const merged = mergeForLayers(definition, mode, density, brand);
        detectCycles(merged, issues, seenCycles);
      }
    }
  }
}

function mergeForLayers(
  definition: FrickDesignDefinition,
  mode: FrickMode,
  density: FrickDensity,
  brand: FrickBrand,
): TokenTree {
  const base: TokenTree = {
    primitive: definition.primitive,
    semantic: definition.semantic,
    component: definition.component,
  };
  return mergeTrees(
    base,
    definition.density[density] ?? {},
    definition.modes[mode] ?? {},
    definition.brands[brand] ?? {},
  );
}

function detectCycles(root: TokenTree, issues: string[], seenCycles: Set<string>): void {
  const resolvePath = (path: string, seen: string[]): void => {
    // icon.* aliases are resolved to a literal name, so they cannot form a cycle.
    if (path.startsWith("icon.")) {
      return;
    }
    if (seen.includes(path)) {
      const chain = [...seen.slice(seen.indexOf(path)), path].join(" -> ");
      if (!seenCycles.has(chain)) {
        seenCycles.add(chain);
        issues.push(`Circular alias ${chain}`);
      }
      return;
    }
    const value = getPath(root, path);
    if (value === undefined) {
      // Unresolved aliases are reported by validateResolvable; ignore here.
      return;
    }
    visit(value, [...seen, path]);
  };

  const visit = (value: unknown, seen: string[]): void => {
    if (isAlias(value)) {
      resolvePath(value.$alias, seen);
      return;
    }
    if (isTokenTree(value)) {
      for (const child of Object.values(value)) {
        visit(child, seen);
      }
    }
  };

  visit(root, []);
}

/**
 * Color-contrast validation.
 *
 * Resolves the canonical semantic color palette for every mode/brand combination and
 * checks that the foreground/background pairs which carry text or UI labels meet WCAG
 * 2.1 contrast minimums. Body-text pairs are held to AA normal (4.5:1); the action
 * button pair (which renders bold/large control labels) is held to AA large (3:1).
 */
function validateContrast(definition: FrickDesignDefinition, issues: string[]): void {
  const modes = Object.keys(definition.modes) as FrickMode[];
  const brands = Object.keys(definition.brands) as FrickBrand[];

  for (const mode of modes) {
    for (const brand of brands) {
      let palette: Record<string, unknown>;
      try {
        const resolved = resolveDesign(definition, {
          mode,
          density: "regular",
          brand,
          iconPack: "native",
          platform: "web",
        });
        palette = resolved.semantic.color as Record<string, unknown>;
      } catch {
        // Resolution failures are surfaced by validateResolvable.
        continue;
      }

      const pairs: Array<{ name: string; fg: string; bg: string; min: number }> = [
        { name: "text on page", fg: "text", bg: "page", min: CONTRAST_AA_NORMAL },
        { name: "text on surface", fg: "text", bg: "surface", min: CONTRAST_AA_NORMAL },
        { name: "textMuted on page", fg: "textMuted", bg: "page", min: CONTRAST_AA_NORMAL },
        { name: "textMuted on surface", fg: "textMuted", bg: "surface", min: CONTRAST_AA_NORMAL },
        {
          name: "onActionPrimary on actionPrimary",
          fg: "onActionPrimary",
          bg: "actionPrimary",
          min: CONTRAST_AA_LARGE,
        },
      ];

      for (const pair of pairs) {
        const fg = palette[pair.fg];
        const bg = palette[pair.bg];
        if (!isHexColor(fg) || !isHexColor(bg)) {
          // Non-hex semantic colors (e.g. gradients) are out of scope for contrast.
          continue;
        }
        const ratio = contrastRatio(fg, bg);
        if (ratio < pair.min) {
          issues.push(
            `${mode}/${brand}: ${pair.name} contrast ${ratio.toFixed(2)} is below ${pair.min} (${fg} on ${bg})`,
          );
        }
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

function numericScale(tree: TokenTree | undefined): Set<number> {
  const scale = new Set<number>();
  if (!tree) {
    return scale;
  }
  for (const value of Object.values(tree)) {
    if (typeof value === "number") {
      scale.add(value);
    }
  }
  return scale;
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

function relativeLuminance(hex: string): number {
  const normalized = hex.slice(1);
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((part) => `${part}${part}`)
          .join("")
      : normalized;
  const numeric = Number.parseInt(expanded, 16);
  const linearize = (raw: number): number => {
    const channel = raw / 255;
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  };
  const red = linearize((numeric >> 16) & 255);
  const green = linearize((numeric >> 8) & 255);
  const blue = linearize(numeric & 255);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function readTree(tree: TokenTree, key: string): TokenTree | undefined {
  const value = tree[key];
  return isTokenTree(value) ? value : undefined;
}

function getPath(root: TokenTree, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (isTokenTree(current) && segment in current) {
      return current[segment];
    }
    return undefined;
  }, root);
}

function mergeTrees(...trees: TokenTree[]): TokenTree {
  const output: Record<string, unknown> = {};
  for (const tree of trees) {
    for (const [key, value] of Object.entries(tree)) {
      const existing = output[key];
      output[key] = isTokenTree(existing) && isTokenTree(value) ? mergeTrees(existing, value) : value;
    }
  }
  return output as TokenTree;
}

function isAlias(value: unknown): value is TokenAlias {
  return isTokenTree(value) && "$alias" in value && typeof value.$alias === "string";
}

function isTokenTree(value: unknown): value is TokenTree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
