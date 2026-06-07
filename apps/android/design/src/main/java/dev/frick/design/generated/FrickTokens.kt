package dev.frick.design.generated

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
        body = 15.sp,
        heading = 28.sp,
        label = 13.sp,
    )

    object Spacing {
        val none = 0.dp
        val extraSmall = 4.dp
        val small = 8.dp
        val medium = 16.dp
        val large = 24.dp
        val extraLarge = 32.dp
    }

    object Radius {
        val control = 12.dp
        val surface = 16.dp
        val bubble = 20.dp
        val pill = 999.dp
    }

    object Component {
        val buttonHeight = 40.dp
        val textFieldHeight = 40.dp
        val chatBubblePaddingX = 16.dp
        val chatBubblePaddingY = 8.dp
        val avatarSize = 40.dp
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

    private val lightColors = FrickColorTokens(
        background = Color(0xFFF6FBF8),
        surface = Color(0xFFFFFFFF),
        surfaceAlt = Color(0xFFE7F0EC),
        text = Color(0xFF111917),
        textMuted = Color(0xFF51655F),
        border = Color(0xFFD7E5DF),
        primary = Color(0xFF168463),
        onPrimary = Color(0xFFFFFFFF),
        success = Color(0xFF107A5B),
        warning = Color(0xFF8A5A00),
        danger = Color(0xFF9E334F),
        info = Color(0xFF4169C4),
        chatIncoming = Color(0xFFFFFFFF),
        chatOutgoing = Color(0xFFC8F7E8),
    )
    private val darkColors = FrickColorTokens(
        background = Color(0xFF0C1110),
        surface = Color(0xFF17211F),
        surfaceAlt = Color(0xFF202E2A),
        text = Color(0xFFEEF8F3),
        textMuted = Color(0xFFA8BBB4),
        border = Color(0xFF354943),
        primary = Color(0xFF168463),
        onPrimary = Color(0xFFFFFFFF),
        success = Color(0xFF54D8AC),
        warning = Color(0xFFE2B65C),
        danger = Color(0xFFFF8AA3),
        info = Color(0xFF7DA2FF),
        chatIncoming = Color(0xFF202E2A),
        chatOutgoing = Color(0xFF0E352D),
    )
    private val compactSpacing = FrickSpacingTokens(
        none = 0.dp,
        xs = 4.dp,
        sm = 8.dp,
        md = 12.dp,
        lg = 20.dp,
        xl = 32.dp,
        xxl = 32.dp,
    )
    private val regularSpacing = FrickSpacingTokens(
        none = 0.dp,
        xs = 4.dp,
        sm = 8.dp,
        md = 16.dp,
        lg = 24.dp,
        xl = 32.dp,
        xxl = 32.dp,
    )
    private val comfortableSpacing = FrickSpacingTokens(
        none = 0.dp,
        xs = 4.dp,
        sm = 8.dp,
        md = 20.dp,
        lg = 32.dp,
        xl = 32.dp,
        xxl = 32.dp,
    )
    private val compactRadius = FrickRadiusTokens(
        sm = 12.dp,
        md = 16.dp,
        lg = 20.dp,
        pill = 999.dp,
    )
    private val regularRadius = FrickRadiusTokens(
        sm = 12.dp,
        md = 16.dp,
        lg = 20.dp,
        pill = 999.dp,
    )
    private val comfortableRadius = FrickRadiusTokens(
        sm = 12.dp,
        md = 16.dp,
        lg = 20.dp,
        pill = 999.dp,
    )
}

enum class FrickIconName {
    ActionSend,
    ActionReload,
    ActionAdd,
    ActionDetails,
    NavigationBack,
    NavigationThreads,
    StatusLive,
    ChatMessage,
    ChatAttachment,
    CallVideo,
    WorkspaceSettings,
    ThemeLight,
    ThemeDark,
}
