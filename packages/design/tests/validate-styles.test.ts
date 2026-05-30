import { describe, expect, it } from "vitest";
import { lintComponentStyles } from "../src/validate-styles.js";

describe("component style linting", () => {
  it("accepts token-backed declarations and structural numerics", () => {
    const css = `:root {
  --frick-color-bg: var(--frick-color-page);
  --frick-border-width: 1px;
  --frick-line-height-normal: 1.5;
  --frick-opacity-disabled: 0.48;
}

.frick-button {
  background: var(--frick-color-primary);
  color: var(--frick-color-primary-fg);
  border: var(--frick-border-width) solid var(--frick-color-border);
  inline-size: 100%;
  min-block-size: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  aspect-ratio: 1;
  opacity: 0;
  transform: rotate(-90deg);
}

@media (min-width: 641px) {
  .frick-shell { grid-column: 1 / -1; }
}
`;
    expect(lintComponentStyles(css)).toEqual([]);
  });

  it("rejects a hex color literal in a component rule", () => {
    const css = `.frick-button {
  background: #168463;
}
`;
    const issues = lintComponentStyles(css);
    expect(issues).toHaveLength(1);
    expect(issues[0].line).toBe(2);
    expect(issues[0].message).toContain("raw color literal");
  });

  it("rejects an rgb()/rgba() color literal", () => {
    const css = `.frick-surface {
  box-shadow: 0 14px 48px rgba(23, 54, 45, 0.12);
}
`;
    const issues = lintComponentStyles(css);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("raw color literal");
  });

  it("rejects a fractional opacity literal", () => {
    const css = `.frick-disabled {
  opacity: 0.48;
}
`;
    const issues = lintComponentStyles(css);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("raw opacity literal");
  });

  it("exempts opacity: 0 and opacity: 1 as structural extremes", () => {
    const css = `.frick-hidden { opacity: 0; }
.frick-shown { opacity: 1; }
`;
    expect(lintComponentStyles(css)).toEqual([]);
  });

  it("ignores literals inside block comments", () => {
    const css = `/* legacy: background: #ff0000; opacity: 0.5; */
.frick-button {
  background: var(--frick-color-primary);
}
`;
    expect(lintComponentStyles(css)).toEqual([]);
  });

  it("exempts color literals in the --frick-* bridge layer", () => {
    const css = `:root {
  --frick-shadow-soft: 0 1px 2px rgba(0, 0, 0, 0.1);
}
`;
    expect(lintComponentStyles(css)).toEqual([]);
  });
});
