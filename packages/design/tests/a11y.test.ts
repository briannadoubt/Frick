import { describe, expect, it } from "vitest";
import { frickDesignDefinition } from "../src/frick.design.js";
import { resolveDesign } from "../src/resolver.js";
import type { FrickBrand, FrickDensity, FrickMode } from "../src/model.js";
import {
  SEMANTIC_CONTRAST_PAIRS,
  checkContrastPairs,
  contrastRatio,
  isHexColor,
  parseHexColor,
  relativeLuminance,
} from "../src/a11y.js";

describe("contrast math", () => {
  it("scores black-on-white at the maximum 21:1", () => {
    expect(Math.round(contrastRatio("#000000", "#ffffff"))).toBe(21);
  });

  it("scores identical colors at 1:1", () => {
    expect(contrastRatio("#168463", "#168463")).toBeCloseTo(1, 5);
  });

  it("is order-independent", () => {
    expect(contrastRatio("#111917", "#f6fbf8")).toBeCloseTo(contrastRatio("#f6fbf8", "#111917"), 10);
  });

  it("expands 3-digit hex", () => {
    expect(parseHexColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColor("#000")).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("computes white luminance as 1 and black as 0", () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
  });

  it("rejects non-hex values", () => {
    expect(isHexColor("linear-gradient(...)")).toBe(false);
    expect(isHexColor("rgba(0,0,0,0.5)")).toBe(false);
    expect(isHexColor("#168463")).toBe(true);
    expect(() => parseHexColor("not-a-color")).toThrow();
  });
});

const MODES: FrickMode[] = ["light", "dark"];
const DENSITIES: FrickDensity[] = ["compact", "regular", "comfortable"];
const BRANDS: FrickBrand[] = ["frick", "frickenChat"];

describe("design token contrast contract (WCAG AA)", () => {
  for (const mode of MODES) {
    for (const density of DENSITIES) {
      for (const brand of BRANDS) {
        it(`every semantic pair meets its threshold in ${mode}/${density}/${brand}`, () => {
          const design = resolveDesign(frickDesignDefinition, {
            mode,
            density,
            brand,
            iconPack: "native",
            platform: "web",
          });
          const results = checkContrastPairs(design.semantic as Record<string, unknown>);
          const failures = results.filter((r) => !r.passes);
          expect(
            failures,
            `failing pairs: ${failures
              .map((f) => `${f.id} ${f.foregroundValue} on ${f.backgroundValue} = ${f.ratio} (< ${f.minRatio})`)
              .join("; ")}`,
          ).toEqual([]);
        });
      }
    }
  }

  it("checks every declared pair (no silently-skipped contract entries)", () => {
    const design = resolveDesign(frickDesignDefinition, {
      mode: "light",
      density: "regular",
      brand: "frick",
      iconPack: "native",
      platform: "web",
    });
    const results = checkContrastPairs(design.semantic as Record<string, unknown>);
    expect(results).toHaveLength(SEMANTIC_CONTRAST_PAIRS.length);
  });
});

describe("contrast contract integrity (FR-104)", () => {
  it("declares pairs with unique ids and a meetable threshold", () => {
    const ids = SEMANTIC_CONTRAST_PAIRS.map((p) => p.id);
    expect(new Set(ids).size, "duplicate contrast-pair ids").toBe(ids.length);
    for (const pair of SEMANTIC_CONTRAST_PAIRS) {
      const min = pair.minRatio ?? 4.5;
      // Thresholds live in the WCAG-meaningful [1, 21] range.
      expect(min).toBeGreaterThanOrEqual(1);
      expect(min).toBeLessThanOrEqual(21);
    }
  });

  it("every declared pair resolves to a real hex token in EVERY resolved theme", () => {
    // checkContrastPairs throws if a foreground/background path is missing or
    // is not a hex color, so a typo or a gradient slipping into a contrast slot
    // fails loudly here — across all 12 themes, not just one.
    for (const mode of MODES) {
      for (const density of DENSITIES) {
        for (const brand of BRANDS) {
          const design = resolveDesign(frickDesignDefinition, {
            mode,
            density,
            brand,
            iconPack: "native",
            platform: "web",
          });
          const results = checkContrastPairs(design.semantic as Record<string, unknown>);
          expect(
            results,
            `${mode}/${density}/${brand} resolved a different number of pairs`,
          ).toHaveLength(SEMANTIC_CONTRAST_PAIRS.length);
          for (const r of results) {
            expect(isHexColor(r.foregroundValue), `${r.id} fg not hex in ${mode}/${density}/${brand}`).toBe(true);
            expect(isHexColor(r.backgroundValue), `${r.id} bg not hex in ${mode}/${density}/${brand}`).toBe(true);
            expect(r.ratio).toBeGreaterThanOrEqual(1);
          }
        }
      }
    }
  });
});
