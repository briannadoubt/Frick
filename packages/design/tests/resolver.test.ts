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

  it("resolves mode-specific colors so switching mode changes resolved values", () => {
    const light = resolveDesign(frickDesignDefinition, {
      mode: "light",
      density: "regular",
      brand: "frick",
      iconPack: "native",
      platform: "web",
    });
    const dark = resolveDesign(frickDesignDefinition, {
      mode: "dark",
      density: "regular",
      brand: "frick",
      iconPack: "native",
      platform: "web",
    });

    expect(light.semantic.color.page).toBe("#f6fbf8");
    expect(light.semantic.color.surface).toBe("#ffffff");
    expect(dark.semantic.color.page).toBe("#0c1110");
    expect(dark.semantic.color.surface).toBe("#17211f");
    expect(dark.semantic.color.page).not.toBe(light.semantic.color.page);
  });

  it("resolves brand-specific colors so switching brand changes resolved values", () => {
    const frick = resolveDesign(frickDesignDefinition, {
      mode: "light",
      density: "regular",
      brand: "frick",
      iconPack: "native",
      platform: "web",
    });
    const frickenChat = resolveDesign(frickDesignDefinition, {
      mode: "light",
      density: "regular",
      brand: "frickenChat",
      iconPack: "native",
      platform: "web",
    });

    expect(frick.semantic.color.actionPrimary).toBe("#168463");
    // frickenChat uses a darker blue so white `onActionPrimary` clears WCAG AA
    // on the action fill (FR-101 contrast contract).
    expect(frickenChat.semantic.color.actionPrimary).toBe("#3a5cbf");
    expect(frick.component.button.background).toBe("#168463");
    expect(frickenChat.component.button.background).toBe("#3a5cbf");
    // frickenChat no longer overrides the outgoing bubble; it inherits the
    // mode-aware mint treatment (light mint in light mode) so it stays legible.
    expect(frickenChat.semantic.color.outgoingBubble).toBe("#c8f7e8");
  });

  it("falls back to the brand icon family when the icon pack is not native", () => {
    const native = resolveDesign(frickDesignDefinition, {
      mode: "light",
      density: "regular",
      brand: "frick",
      iconPack: "native",
      platform: "web",
    });
    const frickPack = resolveDesign(frickDesignDefinition, {
      mode: "light",
      density: "regular",
      brand: "frick",
      iconPack: "frick",
      platform: "web",
    });

    expect(native.icons["action.send"]).toEqual({ family: "lucide", name: "Send" });
    expect(frickPack.icons["action.send"]).toEqual({ family: "frick", name: "send" });
    expect(frickPack.icons["action.send"]).not.toEqual(native.icons["action.send"]);
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
