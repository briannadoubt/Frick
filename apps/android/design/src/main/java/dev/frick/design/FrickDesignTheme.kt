package dev.frick.design

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import dev.frick.design.generated.FrickColorTokens
import dev.frick.design.generated.FrickDensity
import dev.frick.design.generated.FrickMode
import dev.frick.design.generated.FrickRadiusTokens
import dev.frick.design.generated.FrickSpacingTokens
import dev.frick.design.generated.FrickTokens

@Immutable
public data class FrickDesignContext(
    public val mode: FrickMode,
    public val density: FrickDensity,
)

public val LocalFrickDesignContext: androidx.compose.runtime.ProvidableCompositionLocal<FrickDesignContext> =
    compositionLocalOf { FrickDesignContext(FrickMode.Light, FrickDensity.Comfortable) }

public val LocalFrickColors: androidx.compose.runtime.ProvidableCompositionLocal<FrickColorTokens> =
    staticCompositionLocalOf { FrickTokens.colors(FrickMode.Light) }

public val LocalFrickSpacing: androidx.compose.runtime.ProvidableCompositionLocal<FrickSpacingTokens> =
    staticCompositionLocalOf { FrickTokens.spacing(FrickDensity.Comfortable) }

public val LocalFrickRadius: androidx.compose.runtime.ProvidableCompositionLocal<FrickRadiusTokens> =
    staticCompositionLocalOf { FrickTokens.radius(FrickDensity.Comfortable) }

public object FrickDesign {
    public val context: FrickDesignContext
        @Composable get() = LocalFrickDesignContext.current

    public val colors: FrickColorTokens
        @Composable get() = LocalFrickColors.current

    public val spacing: FrickSpacingTokens
        @Composable get() = LocalFrickSpacing.current

    public val radius: FrickRadiusTokens
        @Composable get() = LocalFrickRadius.current
}

@Composable
public fun FrickDesignTheme(
    mode: FrickMode = if (isSystemInDarkTheme()) FrickMode.Dark else FrickMode.Light,
    density: FrickDensity = FrickDensity.Comfortable,
    content: @Composable () -> Unit,
) {
    val colors = FrickTokens.colors(mode)
    val spacing = FrickTokens.spacing(density)
    val radius = FrickTokens.radius(density)
    val materialColors = colors.toMaterialColorScheme(mode)

    CompositionLocalProvider(
        LocalFrickDesignContext provides FrickDesignContext(mode, density),
        LocalFrickColors provides colors,
        LocalFrickSpacing provides spacing,
        LocalFrickRadius provides radius,
    ) {
        MaterialTheme(
            colorScheme = materialColors,
            typography = Typography(),
            content = content,
        )
    }
}

private fun FrickColorTokens.toMaterialColorScheme(mode: FrickMode): ColorScheme {
    val neutralVariant = surfaceAlt

    return when (mode) {
        FrickMode.Light,
        FrickMode.System -> lightColorScheme(
            primary = primary,
            onPrimary = onPrimary,
            background = background,
            onBackground = text,
            surface = surface,
            onSurface = text,
            surfaceVariant = neutralVariant,
            onSurfaceVariant = textMuted,
            outline = border,
            error = danger,
            tertiary = info,
            secondary = success,
        )
        FrickMode.Dark -> darkColorScheme(
            primary = primary,
            onPrimary = onPrimary,
            background = background,
            onBackground = text,
            surface = surface,
            onSurface = text,
            surfaceVariant = neutralVariant,
            onSurfaceVariant = textMuted,
            outline = border,
            error = danger,
            tertiary = info,
            secondary = success,
        )
    }
}

internal fun statusColor(status: FrickStatus, colors: FrickColorTokens): Color =
    when (status) {
        FrickStatus.Neutral -> colors.textMuted
        FrickStatus.Info -> colors.info
        FrickStatus.Success -> colors.success
        FrickStatus.Warning -> colors.warning
        FrickStatus.Danger -> colors.danger
    }

public enum class FrickStatus {
    Neutral,
    Info,
    Success,
    Warning,
    Danger,
}
