/**
 * Accessibility contract primitives for the Frick design system (FR-101).
 *
 * This module is the platform-agnostic, testable core of the a11y contract: a
 * WCAG-compliant color-contrast calculator plus a declarative description of
 * which resolved semantic color pairs are *meant* to sit on top of one another
 * (foreground text on a background surface). The web package and the token
 * suite enforce the contract by checking every resolved theme against these
 * pairs; see `docs/accessibility.md` for the full contract.
 *
 * The math here is pure (no DOM, no React) so it runs in any environment and
 * can be unit-tested directly. Colors are accepted as `#rgb`/`#rrggbb` hex.
 */

/** WCAG 2.1 contrast thresholds. */
export const WCAG_CONTRAST = {
  /** Normal-size text / UI must meet 4.5:1 for AA. */
  AA_NORMAL: 4.5,
  /** Large text (>=18.66px bold or >=24px) may use 3:1 for AA. */
  AA_LARGE: 3,
  /** Non-text UI components / graphical objects: 3:1. */
  AA_NON_TEXT: 3,
} as const;

/** Parsed sRGB color, channels in the 0-255 range. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Parse a `#rgb`, `#rgba`, `#rrggbb`, or `#rrggbbaa` hex string into sRGB
 * channels. Throws on anything it can't interpret as a hex color — the contract
 * deliberately only covers solid hex tokens (gradients, `rgba()` with real
 * alpha, and CSS keywords are out of scope and must be excluded by the caller).
 */
export function parseHexColor(input: string): Rgb {
  if (!/^#?[0-9a-fA-F]{3,8}$/.test(input.trim())) {
    throw new Error(`Not a hex color: ${input}`);
  }
  const hex = input.trim().replace(/^#/, "");
  const full =
    hex.length === 3 || hex.length === 4
      ? hex
          .slice(0, 3)
          .split("")
          .map((c) => c + c)
          .join("")
      : hex.slice(0, 6);
  if (full.length !== 6) {
    throw new Error(`Not a 6-digit hex color: ${input}`);
  }
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/** True if a string looks like a solid hex color this module can score. */
export function isHexColor(input: unknown): input is string {
  return typeof input === "string" && /^#[0-9a-fA-F]{3,8}$/.test(input.trim());
}

function channelLuminance(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance per WCAG 2.1 (0 = black, 1 = white). */
export function relativeLuminance(color: Rgb): number {
  return (
    0.2126 * channelLuminance(color.r) +
    0.7152 * channelLuminance(color.g) +
    0.0722 * channelLuminance(color.b)
  );
}

/**
 * WCAG contrast ratio between two colors, in the range [1, 21]. Order of
 * arguments does not matter.
 */
export function contrastRatio(a: string | Rgb, b: string | Rgb): number {
  const la = relativeLuminance(typeof a === "string" ? parseHexColor(a) : a);
  const lb = relativeLuminance(typeof b === "string" ? parseHexColor(b) : b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Round a contrast ratio to 2 decimals for stable reporting. */
export function roundRatio(ratio: number): number {
  return Math.round(ratio * 100) / 100;
}

/**
 * A foreground/background pair the design system asserts should be legible.
 * `foreground` and `background` are dotted paths into a resolved design's
 * `semantic` tree (e.g. `color.text` over `color.page`).
 */
export interface ContrastPair {
  readonly id: string;
  /** Dotted path into `semantic`, e.g. `color.text`. */
  readonly foreground: string;
  /** Dotted path into `semantic`, e.g. `color.page`. */
  readonly background: string;
  /** Minimum ratio this pair must meet. Defaults to AA normal text (4.5). */
  readonly minRatio?: number;
}

/**
 * The semantic foreground/background pairs the Frick design system guarantees
 * meet WCAG AA across every resolved theme (mode x density x brand). Adding a
 * new legible-on-surface relationship to the design means adding it here so the
 * contrast suite enforces it.
 */
export const SEMANTIC_CONTRAST_PAIRS: readonly ContrastPair[] = [
  { id: "body-text", foreground: "color.text", background: "color.page" },
  { id: "body-text-on-surface", foreground: "color.text", background: "color.surface" },
  { id: "body-text-on-raised", foreground: "color.text", background: "color.surfaceRaised" },
  { id: "primary-action", foreground: "color.onActionPrimary", background: "color.actionPrimary" },
  { id: "incoming-bubble-text", foreground: "color.text", background: "color.incomingBubble" },
  { id: "outgoing-bubble-text", foreground: "color.text", background: "color.outgoingBubble" },
  // Status tones used for text/icons (e.g. danger/warning copy) against the
  // page must clear the AA normal-text threshold.
  { id: "danger-on-page", foreground: "color.danger", background: "color.page" },
  { id: "warning-on-page", foreground: "color.warning", background: "color.page" },
  { id: "success-on-page", foreground: "color.success", background: "color.page" },
  { id: "info-on-page", foreground: "color.info", background: "color.page" },
  // Muted text is secondary metadata, but the Frick palette holds it to full
  // AA normal-text contrast (matching the design-package style validator) so
  // it stays readable as body-adjacent copy.
  { id: "muted-text", foreground: "color.textMuted", background: "color.page" },
  { id: "muted-text-on-surface", foreground: "color.textMuted", background: "color.surface" },
] as const;

function getByPath(root: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current && typeof current === "object" && segment in (current as Record<string, unknown>)) {
      return (current as Record<string, unknown>)[segment];
    }
    return undefined;
  }, root);
}

/** Result of checking one {@link ContrastPair} against a resolved semantic tree. */
export interface ContrastCheckResult {
  readonly id: string;
  readonly foreground: string;
  readonly background: string;
  readonly foregroundValue: string;
  readonly backgroundValue: string;
  readonly ratio: number;
  readonly minRatio: number;
  readonly passes: boolean;
}

/**
 * Evaluate every {@link ContrastPair} against a resolved design's `semantic`
 * tree. Throws if a referenced path is missing or not a hex color, so a typo or
 * a gradient slipping into a contrast slot fails loudly rather than silently
 * passing.
 */
export function checkContrastPairs(
  semantic: Record<string, unknown>,
  pairs: readonly ContrastPair[] = SEMANTIC_CONTRAST_PAIRS,
): ContrastCheckResult[] {
  return pairs.map((pair) => {
    const fg = getByPath(semantic, pair.foreground);
    const bg = getByPath(semantic, pair.background);
    if (!isHexColor(fg)) {
      throw new Error(`Contrast pair "${pair.id}": foreground ${pair.foreground} is not a hex color (${String(fg)})`);
    }
    if (!isHexColor(bg)) {
      throw new Error(`Contrast pair "${pair.id}": background ${pair.background} is not a hex color (${String(bg)})`);
    }
    const minRatio = pair.minRatio ?? WCAG_CONTRAST.AA_NORMAL;
    const ratio = roundRatio(contrastRatio(fg, bg));
    return {
      id: pair.id,
      foreground: pair.foreground,
      background: pair.background,
      foregroundValue: fg,
      backgroundValue: bg,
      ratio,
      minRatio,
      passes: ratio >= minRatio,
    };
  });
}
