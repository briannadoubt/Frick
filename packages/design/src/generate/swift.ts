import type { ResolvedDesign } from "../model.js";
import { frickDesignDefinition } from "../frick.design.js";
import { resolveDesign } from "../resolver.js";

export function generateSwiftTokens(design: ResolvedDesign): string {
  const lightDesign = resolveSwiftDesign(design, "light");
  const darkDesign = resolveSwiftDesign(design, "dark");
  const lightColor = lightDesign.semantic.color as Record<string, unknown>;
  const darkColor = darkDesign.semantic.color as Record<string, unknown>;
  const bodyType = typographyToken(design, "body");
  const labelType = typographyToken(design, "label");
  const titleType = typographyToken(design, "title");
  const iconCases = Object.entries(design.icons)
    .map(([key, icon]) => `    case ${swiftIconCaseName(key)} = "${icon.name}"`)
    .join("\n");

  return `import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

public enum FrickMode: String, Sendable {
    case system
    case light
    case dark
}

public enum FrickDensity: String, Sendable {
    case compact
    case regular
    case comfortable
}

public enum FrickBrand: String, Sendable {
    case frick
    case frickenChat
}

public enum FrickIconPack: String, Sendable {
    case native
    case frick
}

public struct FrickDesignContext: Sendable {
    public var mode: FrickMode
    public var density: FrickDensity
    public var brand: FrickBrand
    public var iconPack: FrickIconPack

    public init(
        mode: FrickMode = .system,
        density: FrickDensity = .regular,
        brand: FrickBrand = .frick,
        iconPack: FrickIconPack = .native
    ) {
        self.mode = mode
        self.density = density
        self.brand = brand
        self.iconPack = iconPack
    }
}

public enum FrickTokens {
    public enum Spacing {
        public static let none: CGFloat = ${design.semantic.spacing.none}
        public static let extraSmall: CGFloat = ${design.semantic.spacing.extraSmall}
        public static let small: CGFloat = ${design.semantic.spacing.small}
        public static let medium: CGFloat = ${design.semantic.spacing.medium}
        public static let large: CGFloat = ${design.semantic.spacing.large}
        public static let extraLarge: CGFloat = ${design.semantic.spacing.extraLarge}
    }

    public enum Radius {
        public static let control: CGFloat = ${design.semantic.corner.control}
        public static let surface: CGFloat = ${design.semantic.corner.surface}
        public static let bubble: CGFloat = ${design.semantic.corner.bubble}
        public static let pill: CGFloat = ${design.semantic.corner.pill}
    }

    public enum Colors {
        public static let background = ${swiftDynamicColor(lightColor.page, darkColor.page)}
        public static let surface = ${swiftDynamicColor(lightColor.surface, darkColor.surface)}
        public static let surfaceRaised = ${swiftDynamicColor(lightColor.surfaceRaised, darkColor.surfaceRaised)}
        public static let text = ${swiftDynamicColor(lightColor.text, darkColor.text)}
        public static let textMuted = ${swiftDynamicColor(lightColor.textMuted, darkColor.textMuted)}
        public static let border = ${swiftDynamicColor(lightColor.border, darkColor.border)}
        public static let accent = ${swiftDynamicColor(lightColor.actionPrimary, darkColor.actionPrimary)}
        public static let accentForeground = ${swiftDynamicColor(lightColor.onActionPrimary, darkColor.onActionPrimary)}
        public static let success = ${swiftDynamicColor(lightColor.success, darkColor.success)}
        public static let warning = ${swiftDynamicColor(lightColor.warning, darkColor.warning)}
        public static let danger = ${swiftDynamicColor(lightColor.danger, darkColor.danger)}
        public static let info = ${swiftDynamicColor(lightColor.info, darkColor.info)}
        public static let chatIncoming = ${swiftDynamicColor(lightColor.incomingBubble, darkColor.incomingBubble)}
        public static let chatOutgoing = ${swiftDynamicColor(lightColor.outgoingBubble, darkColor.outgoingBubble)}
    }

    public enum Typography {
        public static let heading = Font.system(size: ${titleType.size}, weight: .${swiftWeight(titleType.weight)}, design: .rounded)
        public static let body = Font.system(size: ${bodyType.size}, weight: .${swiftWeight(bodyType.weight)}, design: .default)
        public static let label = Font.system(size: ${labelType.size}, weight: .${swiftWeight(labelType.weight)}, design: .default)
        public static let mono = Font.system(size: ${labelType.size}, weight: .regular, design: .monospaced)
    }

    public enum Component {
        public static let buttonHeight: CGFloat = ${design.component.button.height}
        public static let textFieldHeight: CGFloat = ${design.component.textField.height}
        public static let chatBubblePaddingX: CGFloat = ${design.component.chatBubble.paddingX}
        public static let chatBubblePaddingY: CGFloat = ${design.component.chatBubble.paddingY}
        public static let avatarSize: CGFloat = ${design.component.avatar.size}
    }
}

public enum FrickIconName: String, Sendable {
${iconCases}
}

private struct FrickColorComponents {
    let red: Double
    let green: Double
    let blue: Double

    var color: Color {
        Color(red: red, green: green, blue: blue)
    }

    #if canImport(UIKit)
    var uiColor: UIColor {
        UIColor(red: red, green: green, blue: blue, alpha: 1)
    }
    #elseif canImport(AppKit)
    var nsColor: NSColor {
        NSColor(red: red, green: green, blue: blue, alpha: 1)
    }
    #endif
}

private extension Color {
    static func frickDynamic(light: FrickColorComponents, dark: FrickColorComponents) -> Color {
        #if canImport(UIKit)
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark.uiColor : light.uiColor
        })
        #elseif canImport(AppKit)
        Color(NSColor(name: nil) { appearance in
            let match = appearance.bestMatch(from: [.darkAqua, .aqua])
            return match == .darkAqua ? dark.nsColor : light.nsColor
        })
        #else
        light.color
        #endif
    }
}
`;
}

function resolveSwiftDesign(design: ResolvedDesign, mode: "light" | "dark"): ResolvedDesign {
  return resolveDesign(frickDesignDefinition, {
    ...design.options,
    mode,
    platform: "ios",
  });
}

interface TypographyToken {
  readonly size: number;
  readonly weight: number;
}

function typographyToken(design: ResolvedDesign, name: string): TypographyToken {
  const value = (design.semantic.typography as Record<string, unknown>)[name];
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Partial<TypographyToken>).size !== "number" ||
    typeof (value as Partial<TypographyToken>).weight !== "number"
  ) {
    throw new Error(`Missing typography token ${name}`);
  }
  return value as TypographyToken;
}

function swiftDynamicColor(lightValue: unknown, darkValue: unknown): string {
  return `Color.frickDynamic(light: ${swiftColorComponents(lightValue)}, dark: ${swiftColorComponents(darkValue)})`;
}

function swiftColorComponents(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("#")) {
    return "FrickColorComponents(red: 0, green: 0, blue: 0)";
  }
  const hex = value.slice(1);
  const normalized =
    hex.length === 3
      ? hex
          .split("")
          .map((part) => `${part}${part}`)
          .join("")
      : hex;
  const numeric = Number.parseInt(normalized, 16);
  const red = ((numeric >> 16) & 255) / 255;
  const green = ((numeric >> 8) & 255) / 255;
  const blue = (numeric & 255) / 255;
  return `FrickColorComponents(red: ${red.toFixed(4)}, green: ${green.toFixed(4)}, blue: ${blue.toFixed(4)})`;
}

function swiftWeight(value: number): string {
  if (value >= 800) {
    return "bold";
  }
  if (value >= 650) {
    return "semibold";
  }
  if (value >= 500) {
    return "medium";
  }
  return "regular";
}

function swiftIconCaseName(key: string): string {
  const parts = key.split(".").filter(Boolean);
  return parts
    .map((part, index) => {
      const normalized = part.replace(/[^a-zA-Z0-9]/g, " ");
      const words = normalized.split(/\s+/).filter(Boolean);
      const cased = words
        .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
        .join("");
      if (index === 0) {
        return `${cased[0]?.toLowerCase() ?? ""}${cased.slice(1)}`;
      }
      return cased;
    })
    .join("");
}
