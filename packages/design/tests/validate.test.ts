import { describe, expect, it } from "vitest";
import { alias } from "../src/define.js";
import { frickDesignDefinition } from "../src/frick.design.js";
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
