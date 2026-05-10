import type { FrickDensity, FrickMode, ResolvedDesign } from "../model.js";
import { frickDesignDefinition } from "../frick.design.js";
import { resolveDesign } from "../resolver.js";

export function generateKotlinTokens(design: ResolvedDesign): string {
  const light = androidDesign("light", "regular");
  const dark = androidDesign("dark", "regular");
  const compact = androidDesign("light", "compact");
  const regular = design;
  const comfortable = androidDesign("light", "comfortable");
  const bodyType = typographyToken(design, "body");
  const labelType = typographyToken(design, "label");
  const titleType = typographyToken(design, "title");
  const iconCases = Object.keys(design.icons)
    .map((key) => `    ${kotlinIconCaseName(key)},`)
    .join("\n");

  return `package dev.frick.design.generated

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

enum class FrickMode {
    System,
    Light,
    Dark,
}

enum class FrickDensity {
    Compact,
    Regular,
    Comfortable,
}

enum class FrickBrand {
    Frick,
    FrickenChat,
}

enum class FrickIconPack {
    Native,
    Frick,
}

@Immutable
data class FrickColorTokens(
    val background: Color,
    val surface: Color,
    val surfaceAlt: Color,
    val text: Color,
    val textMuted: Color,
    val border: Color,
    val primary: Color,
    val onPrimary: Color,
    val success: Color,
    val warning: Color,
    val danger: Color,
    val info: Color,
    val chatIncoming: Color,
    val chatOutgoing: Color,
)

@Immutable
data class FrickSpacingTokens(
    val none: Dp,
    val xs: Dp,
    val sm: Dp,
    val md: Dp,
    val lg: Dp,
    val xl: Dp,
    val xxl: Dp,
) {
    val extraSmall: Dp get() = xs
    val small: Dp get() = sm
    val medium: Dp get() = md
    val large: Dp get() = lg
    val extraLarge: Dp get() = xl
}

@Immutable
data class FrickRadiusTokens(
    val sm: Dp,
    val md: Dp,
    val lg: Dp,
    val pill: Dp,
) {
    val control: Dp get() = sm
    val surface: Dp get() = md
    val bubble: Dp get() = lg
}

@Immutable
data class FrickTypographyTokens(
    val body: TextUnit,
    val heading: TextUnit,
    val label: TextUnit,
)

object FrickTokens {
    val typography = FrickTypographyTokens(
        body = ${bodyType.size}.sp,
        heading = ${titleType.size}.sp,
        label = ${labelType.size}.sp,
    )

    object Spacing {
        val none = ${regular.semantic.spacing.none}.dp
        val extraSmall = ${regular.semantic.spacing.extraSmall}.dp
        val small = ${regular.semantic.spacing.small}.dp
        val medium = ${regular.semantic.spacing.medium}.dp
        val large = ${regular.semantic.spacing.large}.dp
        val extraLarge = ${regular.semantic.spacing.extraLarge}.dp
    }

    object Radius {
        val control = ${regular.semantic.corner.control}.dp
        val surface = ${regular.semantic.corner.surface}.dp
        val bubble = ${regular.semantic.corner.bubble}.dp
        val pill = ${regular.semantic.corner.pill}.dp
    }

    object Component {
        val buttonHeight = ${regular.component.button.height}.dp
        val textFieldHeight = ${regular.component.textField.height}.dp
        val chatBubblePaddingX = ${regular.component.chatBubble.paddingX}.dp
        val chatBubblePaddingY = ${regular.component.chatBubble.paddingY}.dp
        val avatarSize = ${regular.component.avatar.size}.dp
    }

    fun colors(mode: FrickMode): FrickColorTokens = when (mode) {
        FrickMode.Dark -> darkColors
        FrickMode.Light,
        FrickMode.System -> lightColors
    }

    fun spacing(density: FrickDensity): FrickSpacingTokens = when (density) {
        FrickDensity.Compact -> compactSpacing
        FrickDensity.Regular -> regularSpacing
        FrickDensity.Comfortable -> comfortableSpacing
    }

    fun radius(density: FrickDensity): FrickRadiusTokens = when (density) {
        FrickDensity.Compact -> compactRadius
        FrickDensity.Regular -> regularRadius
        FrickDensity.Comfortable -> comfortableRadius
    }

    private val lightColors = ${kotlinColors(light)}
    private val darkColors = ${kotlinColors(dark)}
    private val compactSpacing = ${kotlinSpacing(compact)}
    private val regularSpacing = ${kotlinSpacing(regular)}
    private val comfortableSpacing = ${kotlinSpacing(comfortable)}
    private val compactRadius = ${kotlinRadius(compact)}
    private val regularRadius = ${kotlinRadius(regular)}
    private val comfortableRadius = ${kotlinRadius(comfortable)}
}

enum class FrickIconName {
${iconCases}
}
`;
}

interface TypographyToken {
  readonly size: number;
}

function typographyToken(design: ResolvedDesign, name: string): TypographyToken {
  const value = (design.semantic.typography as Record<string, unknown>)[name];
  if (typeof value !== "object" || value === null || typeof (value as Partial<TypographyToken>).size !== "number") {
    throw new Error(`Missing typography token ${name}`);
  }
  return value as TypographyToken;
}

function androidDesign(mode: FrickMode, density: FrickDensity): ResolvedDesign {
  return resolveDesign(frickDesignDefinition, {
    mode,
    density,
    brand: "frick",
    iconPack: "native",
    platform: "android",
  });
}

function kotlinColors(design: ResolvedDesign): string {
  const color = design.semantic.color as Record<string, unknown>;
  return `FrickColorTokens(
        background = ${kotlinColor(color.page)},
        surface = ${kotlinColor(color.surface)},
        surfaceAlt = ${kotlinColor(color.surfaceRaised)},
        text = ${kotlinColor(color.text)},
        textMuted = ${kotlinColor(color.textMuted)},
        border = ${kotlinColor(color.border)},
        primary = ${kotlinColor(color.actionPrimary)},
        onPrimary = ${kotlinColor(color.onActionPrimary)},
        success = ${kotlinColor(color.success)},
        warning = ${kotlinColor(color.warning)},
        danger = ${kotlinColor(color.danger)},
        info = ${kotlinColor(color.info)},
        chatIncoming = ${kotlinColor(color.incomingBubble)},
        chatOutgoing = ${kotlinColor(color.outgoingBubble)},
    )`;
}

function kotlinSpacing(design: ResolvedDesign): string {
  const spacing = design.semantic.spacing;
  return `FrickSpacingTokens(
        none = ${spacing.none}.dp,
        xs = ${spacing.extraSmall}.dp,
        sm = ${spacing.small}.dp,
        md = ${spacing.medium}.dp,
        lg = ${spacing.large}.dp,
        xl = ${spacing.extraLarge}.dp,
        xxl = ${spacing.extraLarge}.dp,
    )`;
}

function kotlinRadius(design: ResolvedDesign): string {
  const corner = design.semantic.corner;
  return `FrickRadiusTokens(
        sm = ${corner.control}.dp,
        md = ${corner.surface}.dp,
        lg = ${corner.bubble}.dp,
        pill = ${corner.pill}.dp,
    )`;
}

function kotlinColor(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("#")) {
    return "Color.Unspecified";
  }
  const hex = value.slice(1);
  const normalized =
    hex.length === 3
      ? hex
          .split("")
          .map((part) => `${part}${part}`)
          .join("")
      : hex;
  return `Color(0xFF${normalized.toUpperCase()})`;
}

function kotlinIconCaseName(key: string): string {
  return key
    .split(".")
    .filter(Boolean)
    .map((part) =>
      part
        .replace(/[^a-zA-Z0-9]/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
        .join(""),
    )
    .join("");
}
