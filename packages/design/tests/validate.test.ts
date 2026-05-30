import { describe, expect, it } from "vitest";
import { alias } from "../src/define.js";
import { frickDesignDefinition } from "../src/frick.design.js";
import type { FrickDesignDefinition } from "../src/model.js";
import { validateDesign } from "../src/validate.js";

describe("Frick design validation", () => {
  it("accepts the canonical design definition", () => {
    expect(validateDesign(frickDesignDefinition)).toEqual([]);
  });

  it("rejects off-scale numeric spacing values", () => {
    const issues = validateDesign({
      ...frickDesignDefinition,
      semantic: {
        ...frickDesignDefinition.semantic,
        spacing: { medium: 14 },
      },
    });

    expect(issues).toContain("semantic.spacing.medium must be a 4-point metric or an alias");
  });

  it("rejects component icon references that are not semantic aliases", () => {
    const issues = validateDesign({
      ...frickDesignDefinition,
      component: {
        ...frickDesignDefinition.component,
        iconButton: { icon: "paperplane.fill" },
      },
    });

    expect(issues).toContain("component.iconButton.icon must reference icon.* semantic aliases");
  });

  it("accepts component icon semantic references", () => {
    const issues = validateDesign({
      ...frickDesignDefinition,
      component: {
        ...frickDesignDefinition.component,
        iconButton: { icon: alias("icon.action.send") },
      },
    });

    expect(issues).toEqual([]);
  });
});

describe("off-scale spacing/radius validation", () => {
  it("rejects a 4-point spacing value that is not a member of primitive.space", () => {
    // 36 is on the 4-point grid but is not declared in primitive.space, so the legacy
    // `% 4` check would miss it while the scale-membership check catches it.
    const issues = validateDesign({
      ...frickDesignDefinition,
      semantic: {
        ...frickDesignDefinition.semantic,
        spacing: { ...(frickDesignDefinition.semantic.spacing as object), medium: 36 },
      },
    });

    expect(issues).toContain("semantic.spacing.medium value 36 is off-scale (not a member of primitive.space)");
  });

  it("rejects an off-scale literal corner radius", () => {
    const issues = validateDesign({
      ...frickDesignDefinition,
      semantic: {
        ...frickDesignDefinition.semantic,
        corner: { ...(frickDesignDefinition.semantic.corner as object), control: 7 },
      },
    });

    expect(issues).toContain("semantic.corner.control value 7 is off-scale (not a member of primitive.radius)");
  });

  it("rejects an off-scale literal introduced by a density override", () => {
    const issues = validateDesign({
      ...frickDesignDefinition,
      density: {
        ...frickDesignDefinition.density,
        compact: { semantic: { spacing: { medium: 14 } } },
      },
    });

    expect(issues).toContain(
      "density.compact.semantic.spacing.medium value 14 is off-scale (not a member of primitive.space)",
    );
  });

  it("accepts an on-scale literal that exists in primitive.space", () => {
    const issues = validateDesign({
      ...frickDesignDefinition,
      semantic: {
        ...frickDesignDefinition.semantic,
        spacing: { ...(frickDesignDefinition.semantic.spacing as object), medium: 32 },
      },
    });

    expect(issues).toEqual([]);
  });
});

describe("missing icon mapping validation", () => {
  it("rejects a component icon alias that has no matching icons entry", () => {
    const issues = validateDesign({
      ...frickDesignDefinition,
      component: {
        ...frickDesignDefinition.component,
        iconButton: { icon: alias("icon.action.nope") },
      },
    });

    expect(issues).toContain('component.iconButton.icon references missing icon mapping "action.nope"');
  });

  it("accepts a component icon alias that maps to a defined icon", () => {
    const issues = validateDesign({
      ...frickDesignDefinition,
      component: {
        ...frickDesignDefinition.component,
        iconButton: { icon: alias("icon.action.reload") },
      },
    });

    expect(issues).toEqual([]);
  });
});

describe("circular alias validation", () => {
  it("rejects a direct self-referential alias cycle", () => {
    const issues = validateDesign({
      ...frickDesignDefinition,
      semantic: {
        ...frickDesignDefinition.semantic,
        spacing: {
          ...(frickDesignDefinition.semantic.spacing as object),
          medium: alias("semantic.spacing.large"),
          large: alias("semantic.spacing.medium"),
        },
      },
    });

    expect(issues.some((issue) => issue.startsWith("Circular alias"))).toBe(true);
  });

  it("rejects a cycle that only exists inside a non-default layer", () => {
    // This cycle lives entirely in the dark-mode override layer, which the single
    // resolve in validateResolvable (light mode) never merges in.
    const issues = validateDesign({
      ...frickDesignDefinition,
      modes: {
        ...frickDesignDefinition.modes,
        dark: {
          semantic: {
            color: {
              text: alias("semantic.color.surface"),
              surface: alias("semantic.color.text"),
            },
          },
        },
      },
    });

    expect(issues.some((issue) => issue.startsWith("Circular alias"))).toBe(true);
  });
});

describe("color-contrast validation", () => {
  it("rejects low-contrast body text against its background", () => {
    const issues = validateDesign({
      ...frickDesignDefinition,
      semantic: {
        ...frickDesignDefinition.semantic,
        color: {
          ...(frickDesignDefinition.semantic.color as object),
          // Near-white text on the near-white page fails AA.
          text: "#f4f4f4",
        },
      },
    } as FrickDesignDefinition);

    expect(issues.some((issue) => issue.includes("text on page contrast"))).toBe(true);
  });

  it("rejects low-contrast action button labels", () => {
    const issues = validateDesign({
      ...frickDesignDefinition,
      semantic: {
        ...frickDesignDefinition.semantic,
        color: {
          ...(frickDesignDefinition.semantic.color as object),
          onActionPrimary: "#3aa07f",
        },
      },
    } as FrickDesignDefinition);

    expect(issues.some((issue) => issue.includes("onActionPrimary on actionPrimary contrast"))).toBe(true);
  });

  it("accepts the canonical palette which meets WCAG minimums", () => {
    const contrastIssues = validateDesign(frickDesignDefinition).filter((issue) => issue.includes("contrast"));
    expect(contrastIssues).toEqual([]);
  });
});
