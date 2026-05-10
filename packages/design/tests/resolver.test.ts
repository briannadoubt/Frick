import { describe, expect, it } from "vitest";
import { frickDesignDefinition } from "../src/frick.design.js";
import { resolveDesign } from "../src/resolver.js";

describe("Frick design resolver", () => {
  it("resolves regular density semantic aliases from the 4-point scale", () => {
    const design = resolveDesign(frickDesignDefinition, {
      mode: "light",
      density: "regular",
      brand: "frick",
      iconPack: "native",
      platform: "web",
    });

    expect(design.semantic.spacing.extraSmall).toBe(4);
    expect(design.semantic.spacing.medium).toBe(16);
    expect(design.component.chatBubble.paddingX).toBe(16);
    expect(design.component.button.height).toBe(40);
  });

  it("resolves compact and comfortable density overrides", () => {
    const compact = resolveDesign(frickDesignDefinition, {
      mode: "light",
      density: "compact",
      brand: "frick",
      iconPack: "native",
      platform: "web",
    });
    const comfortable = resolveDesign(frickDesignDefinition, {
      mode: "light",
      density: "comfortable",
      brand: "frick",
      iconPack: "native",
      platform: "web",
    });

    expect(compact.semantic.spacing.medium).toBe(12);
    expect(compact.component.button.height).toBe(32);
    expect(comfortable.semantic.spacing.medium).toBe(20);
    expect(comfortable.component.button.height).toBe(48);
  });

  it("resolves semantic icon aliases for platform-native packs", () => {
    const web = resolveDesign(frickDesignDefinition, {
      mode: "dark",
      density: "regular",
      brand: "frick",
      iconPack: "native",
      platform: "web",
    });
    const ios = resolveDesign(frickDesignDefinition, {
      mode: "dark",
      density: "regular",
      brand: "frick",
      iconPack: "native",
      platform: "ios",
    });

    expect(web.icons["action.send"]).toEqual({ family: "lucide", name: "Send" });
    expect(ios.icons["action.send"]).toEqual({ family: "sf", name: "paperplane.fill" });
    expect(web.icons["chat.attachment"]).toEqual({ family: "lucide", name: "Paperclip" });
    expect(ios.icons["workspace.settings"]).toEqual({ family: "sf", name: "gearshape" });
  });

  it("rejects unresolved aliases", () => {
    expect(() =>
      resolveDesign(
        {
          ...frickDesignDefinition,
          semantic: {
            ...frickDesignDefinition.semantic,
            spacing: { broken: { $alias: "primitive.space.999" } },
          },
        },
        {
          mode: "light",
          density: "regular",
          brand: "frick",
          iconPack: "native",
          platform: "web",
        },
      ),
    ).toThrow("Unresolved alias primitive.space.999");
  });
});
