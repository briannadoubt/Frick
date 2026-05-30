import { readFileSync } from "node:fs";

/**
 * Raw styling-literal detection for handwritten component CSS.
 *
 * The design system bridges generated tokens (`packages/design-web/src/generated/*`) into
 * the handwritten component layer (`packages/design-web/src/components.css`). Component
 * rules are supposed to consume `var(--frick-*)` tokens rather than hardcoding values, so
 * that re-theming / mode / brand switches flow through the token pipeline.
 *
 * This linter flags the two highest-signal classes of raw literal that should always be a
 * token reference:
 *   - color literals (hex, rgb/rgba, hsl/hsla) in any property value, and
 *   - raw `opacity` values (which duplicate `primitive.opacity.*`).
 *
 * Custom-property *definitions* (`--frick-*: <literal>`) are exempt: that top-of-file block
 * is the intentional bridge layer where a handful of primitives (border width, line
 * heights, durations, the disabled opacity) are declared once and consumed via vars
 * everywhere else. Structural/layout numerics (grid templates, `100%`, `0`, breakpoints,
 * `aspect-ratio`, transforms) are out of scope because they are not token-backed values.
 */

export interface StyleIssue {
  readonly line: number;
  readonly message: string;
}

const COLOR_LITERAL =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/;
// Matches the numeric value of an `opacity` declaration so 0 / 1 (structural extremes
// for fully transparent / fully opaque) can be exempted while fractional theme-able
// values (e.g. 0.48, which duplicates `primitive.opacity.*`) are flagged.
const OPACITY_DECLARATION = /^\s*opacity\s*:\s*([0-9.]+)\s*(?:!important)?\s*;?\s*$/;

export function lintComponentStyles(source: string): StyleIssue[] {
  const issues: StyleIssue[] = [];
  let inBlockComment = false;

  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index] ?? "";

    // Strip block comments so commented-out literals are not flagged.
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) {
        continue;
      }
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    const commentStart = line.indexOf("/*");
    if (commentStart !== -1) {
      const commentEnd = line.indexOf("*/", commentStart + 2);
      if (commentEnd === -1) {
        line = line.slice(0, commentStart);
        inBlockComment = true;
      } else {
        line = line.slice(0, commentStart) + line.slice(commentEnd + 2);
      }
    }

    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    // Only property declarations are interesting (they contain `prop: value;`).
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const property = trimmed.slice(0, colon).trim();

    // The bridge layer: `--frick-*` custom-property definitions may carry primitives.
    if (property.startsWith("--")) {
      continue;
    }

    const value = trimmed.slice(colon + 1);

    if (COLOR_LITERAL.test(value)) {
      issues.push({
        line: index + 1,
        message: `raw color literal in "${trimmed.replace(/;$/, "")}" — reference a var(--frick-color-*) token instead`,
      });
      continue;
    }

    const opacityMatch = OPACITY_DECLARATION.exec(trimmed);
    if (opacityMatch) {
      const numeric = Number.parseFloat(opacityMatch[1] ?? "");
      // 0 and 1 are structural extremes (hidden / fully opaque), not design tokens.
      if (Number.isFinite(numeric) && numeric > 0 && numeric < 1) {
        issues.push({
          line: index + 1,
          message: `raw opacity literal in "${trimmed.replace(/;$/, "")}" — reference a var(--frick-opacity-*) token instead`,
        });
      }
    }
  }

  return issues;
}

export function lintComponentStyleFile(path: string): string[] {
  const source = readFileSync(path, "utf8");
  return lintComponentStyles(source).map((issue) => `${path}:${issue.line} ${issue.message}`);
}
