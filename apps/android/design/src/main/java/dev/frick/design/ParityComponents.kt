package dev.frick.design

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.frick.design.generated.FrickTokens

// region Foundation
//
// FrickDesignProvider is the spec-named entry point for installing the Frick
// design context. It is an alias over FrickDesignTheme so app code can use the
// shared Phase-1 name while we keep the Material-backed implementation.

@Composable
public fun FrickDesignProvider(
    mode: dev.frick.design.generated.FrickMode =
        if (androidx.compose.foundation.isSystemInDarkTheme()) {
            dev.frick.design.generated.FrickMode.Dark
        } else {
            dev.frick.design.generated.FrickMode.Light
        },
    density: dev.frick.design.generated.FrickDensity =
        dev.frick.design.generated.FrickDensity.Comfortable,
    content: @Composable () -> Unit,
) {
    FrickDesignTheme(mode = mode, density = density, content = content)
}
// endregion

// region Layout

/**
 * Horizontal cluster that wraps its children with shared rhythm. Distinct from
 * [FrickInline] in that it is intended for grouped, label-like affordances
 * (chips, badges, actions) and centers vertically by default.
 */
@Composable
public fun FrickCluster(
    modifier: Modifier = Modifier,
    spacing: Dp = FrickDesign.spacing.sm,
    content: @Composable RowScope.() -> Unit,
) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(spacing),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

/**
 * The app shell: an optional top bar, primary content, and an optional footer
 * (e.g. a composer). This is the destination-local frame; the workspace-level
 * frame is [FrickWorkspaceShell].
 */
@Composable
public fun FrickAppShell(
    modifier: Modifier = Modifier,
    topBar: @Composable () -> Unit = {},
    footer: @Composable () -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        topBar()
        Column(modifier = Modifier.weight(1f, fill = true).fillMaxWidth()) {
            content()
        }
        footer()
    }
}

/**
 * Frick toolbar: a token-styled horizontal action surface. [FrickTopBar] remains
 * the navigation chrome; FrickToolbar is the lighter inline action band used for
 * destination-local commands.
 */
@Composable
public fun FrickToolbar(
    modifier: Modifier = Modifier,
    leading: @Composable RowScope.() -> Unit = {},
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(FrickDesign.colors.surfaceAlt)
            .padding(horizontal = FrickDesign.spacing.md, vertical = FrickDesign.spacing.sm),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(FrickDesign.spacing.sm),
            verticalAlignment = Alignment.CenterVertically,
            content = leading,
        )
        Row(
            horizontalArrangement = Arrangement.spacedBy(FrickDesign.spacing.sm),
            verticalAlignment = Alignment.CenterVertically,
            content = actions,
        )
    }
}

/** Vertically scrollable region with Frick rhythm. */
@Composable
public fun FrickScrollArea(
    modifier: Modifier = Modifier,
    spacing: Dp = FrickDesign.spacing.md,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier.verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(spacing),
        content = content,
    )
}
// endregion

// region Controls

/**
 * Phase-1-named text field. Single-line by default; set [multiline] for the
 * native multiline text input (the native counterpart to web's FrickTextArea).
 */
@Composable
public fun FrickTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    isError: Boolean = false,
    supportingText: String? = null,
    multiline: Boolean = false,
    minLines: Int = if (multiline) 3 else 1,
    keyboardType: KeyboardType = KeyboardType.Text,
    imeAction: ImeAction = ImeAction.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
) {
    if (!multiline) {
        FrickTextInput(
            value = value,
            onValueChange = onValueChange,
            label = label,
            modifier = modifier,
            enabled = enabled,
            isError = isError,
            supportingText = supportingText,
            keyboardType = keyboardType,
            imeAction = imeAction,
            keyboardActions = keyboardActions,
        )
        return
    }
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier,
        enabled = enabled,
        isError = isError,
        label = { Text(label) },
        supportingText = if (supportingText != null) {
            { Text(supportingText) }
        } else {
            null
        },
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = imeAction),
        keyboardActions = keyboardActions,
        singleLine = false,
        minLines = minLines,
    )
}

/** Multiline text input — the native counterpart to web's FrickTextArea. */
@Composable
public fun FrickTextArea(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    isError: Boolean = false,
    supportingText: String? = null,
    minLines: Int = 3,
) {
    FrickTextField(
        value = value,
        onValueChange = onValueChange,
        label = label,
        modifier = modifier,
        enabled = enabled,
        isError = isError,
        supportingText = supportingText,
        multiline = true,
        minLines = minLines,
    )
}
// endregion

// region Feedback & State

/** Spec-named status chip. Alias over [FrickStatusIndicator]. */
@Composable
public fun FrickStatusChip(
    status: FrickStatus,
    modifier: Modifier = Modifier,
    label: String? = null,
) {
    FrickStatusIndicator(status = status, modifier = modifier, label = label)
}

/** Spec-named presence dot. */
@Composable
public fun FrickPresenceDot(
    isOnline: Boolean,
    modifier: Modifier = Modifier,
    size: Dp = 10.dp,
) {
    val color = if (isOnline) FrickDesign.colors.success else FrickDesign.colors.textMuted
    Box(modifier = modifier.size(size).clip(CircleShape).background(color))
}

/** Spec-named progress ring (indeterminate or determinate). */
@Composable
public fun FrickProgressRing(
    modifier: Modifier = Modifier,
    progress: Float? = null,
) {
    FrickProgress(modifier = modifier, progress = progress)
}

/**
 * Transient banner / toast equivalent. Renders an inline status banner styled by
 * [status]; visibility is app-owned via [visible].
 */
@Composable
public fun FrickToast(
    message: String,
    modifier: Modifier = Modifier,
    visible: Boolean = true,
    status: FrickStatus = FrickStatus.Info,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    if (!visible || message.isBlank()) {
        return
    }
    val color = statusColor(status, FrickDesign.colors)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(FrickDesign.radius.md))
            .background(color.copy(alpha = 0.14f))
            .padding(horizontal = FrickDesign.spacing.md, vertical = FrickDesign.spacing.sm),
        horizontalArrangement = Arrangement.spacedBy(FrickDesign.spacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FrickText(text = message, modifier = Modifier.weight(1f), color = color)
        if (actionLabel != null && onAction != null) {
            FrickTextButton(text = actionLabel, onClick = onAction)
        }
    }
}
// endregion

// region Data Display

/** Spec-named metric card. Alias over [FrickMetric]. */
@Composable
public fun FrickMetricCard(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    delta: String? = null,
    status: FrickStatus = FrickStatus.Neutral,
) {
    FrickMetric(label = label, value = value, modifier = modifier, delta = delta, status = status)
}

/** Semantic table column descriptor. */
public data class FrickColumn(
    public val key: String,
    public val title: String,
    public val weight: Float = 1f,
    public val sortable: Boolean = false,
)

/** Semantic cell value; [emphasized] renders header/primary weight. */
@Composable
public fun FrickCell(
    value: String,
    modifier: Modifier = Modifier,
    weight: Float = 1f,
    emphasized: Boolean = false,
) {
    Text(
        text = value,
        modifier = modifier,
        color = if (emphasized) FrickDesign.colors.text else FrickDesign.colors.textMuted,
        fontSize = FrickTokens.typography.body,
        fontWeight = if (emphasized) FontWeight.SemiBold else FontWeight.Normal,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}
// endregion

// region Date & Time
//
// Phase-1 depth: shared API covers labels, values, ranges, disabled state, and
// validation/error display. These map to token-styled native fields; richer
// platform pickers can be layered later behind the same names.

@Composable
public fun FrickDatePicker(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String = "Date",
    enabled: Boolean = true,
    isError: Boolean = false,
    supportingText: String? = null,
) {
    FrickTextInput(
        value = value,
        onValueChange = onValueChange,
        label = label,
        modifier = modifier,
        enabled = enabled,
        isError = isError,
        supportingText = supportingText,
    )
}

@Composable
public fun FrickTimePicker(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String = "Time",
    enabled: Boolean = true,
    isError: Boolean = false,
    supportingText: String? = null,
) {
    FrickTextInput(
        value = value,
        onValueChange = onValueChange,
        label = label,
        modifier = modifier,
        enabled = enabled,
        isError = isError,
        supportingText = supportingText,
    )
}

@Composable
public fun FrickDateTimePicker(
    dateValue: String,
    timeValue: String,
    onDateChange: (String) -> Unit,
    onTimeChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    dateLabel: String = "Date",
    timeLabel: String = "Time",
    enabled: Boolean = true,
    isError: Boolean = false,
    supportingText: String? = null,
) {
    FrickStack(modifier = modifier, spacing = FrickDesign.spacing.sm) {
        FrickDatePicker(
            value = dateValue,
            onValueChange = onDateChange,
            label = dateLabel,
            enabled = enabled,
            isError = isError,
        )
        FrickTimePicker(
            value = timeValue,
            onValueChange = onTimeChange,
            label = timeLabel,
            enabled = enabled,
            isError = isError,
            supportingText = supportingText,
        )
    }
}

@Composable
public fun FrickDateRangePicker(
    startValue: String,
    endValue: String,
    onStartChange: (String) -> Unit,
    onEndChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    startLabel: String = "Start",
    endLabel: String = "End",
    enabled: Boolean = true,
    isError: Boolean = false,
    supportingText: String? = null,
) {
    FrickStack(modifier = modifier, spacing = FrickDesign.spacing.sm) {
        FrickDatePicker(
            value = startValue,
            onValueChange = onStartChange,
            label = startLabel,
            enabled = enabled,
            isError = isError,
        )
        FrickDatePicker(
            value = endValue,
            onValueChange = onEndChange,
            label = endLabel,
            enabled = enabled,
            isError = isError,
            supportingText = supportingText,
        )
    }
}
// endregion

// region Charts
//
// Phase-1 depth: simple data series, tokenized palette, empty state, basic
// line / bar / area / pie visuals. Not a BI platform.

/** Chart frame: a bordered token surface that hosts a chart body. */
@Composable
public fun FrickChartSurface(
    modifier: Modifier = Modifier,
    height: Dp = 160.dp,
    content: @Composable () -> Unit,
) {
    FrickSurface(
        modifier = modifier
            .fillMaxWidth()
            .height(height)
            .border(1.dp, FrickDesign.colors.border, RoundedCornerShape(FrickDesign.radius.md)),
    ) {
        Box(modifier = Modifier.padding(FrickDesign.spacing.md).fillMaxWidth()) {
            content()
        }
    }
}

internal fun normalizeSeries(points: List<Float>): List<Float> {
    if (points.isEmpty()) return emptyList()
    val min = points.minOrNull() ?: 0f
    val max = points.maxOrNull() ?: 0f
    val range = (max - min).takeIf { it > 0f } ?: 1f
    return points.map { (it - min) / range }
}

@Composable
public fun FrickLineChart(
    points: List<Float>,
    modifier: Modifier = Modifier,
    color: Color = FrickDesign.colors.primary,
) {
    FrickChartSurface(modifier = modifier) {
        if (points.size < 2) {
            FrickEmptyState(title = "No data", message = "There is nothing to chart yet.")
            return@FrickChartSurface
        }
        val normalized = remember(points) { normalizeSeries(points) }
        Canvas(modifier = Modifier.fillMaxWidth().height(120.dp)) {
            val path = Path()
            normalized.forEachIndexed { index, value ->
                val x = size.width * (index.toFloat() / normalized.lastIndex.toFloat())
                val y = size.height - (size.height * value)
                if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
            }
            drawPath(path = path, color = color, style = Stroke(width = 3.dp.toPx()))
        }
    }
}

@Composable
public fun FrickAreaChart(
    points: List<Float>,
    modifier: Modifier = Modifier,
    color: Color = FrickDesign.colors.primary,
) {
    FrickChartSurface(modifier = modifier) {
        if (points.size < 2) {
            FrickEmptyState(title = "No data", message = "There is nothing to chart yet.")
            return@FrickChartSurface
        }
        val normalized = remember(points) { normalizeSeries(points) }
        Canvas(modifier = Modifier.fillMaxWidth().height(120.dp)) {
            val fill = Path()
            fill.moveTo(0f, size.height)
            normalized.forEachIndexed { index, value ->
                val x = size.width * (index.toFloat() / normalized.lastIndex.toFloat())
                val y = size.height - (size.height * value)
                fill.lineTo(x, y)
            }
            fill.lineTo(size.width, size.height)
            fill.close()
            drawPath(path = fill, color = color.copy(alpha = 0.25f))
        }
    }
}

@Composable
public fun FrickBarChart(
    values: List<Float>,
    modifier: Modifier = Modifier,
    color: Color = FrickDesign.colors.primary,
) {
    FrickChartSurface(modifier = modifier) {
        if (values.isEmpty()) {
            FrickEmptyState(title = "No data", message = "There is nothing to chart yet.")
            return@FrickChartSurface
        }
        val normalized = remember(values) { normalizeSeries(values) }
        Canvas(modifier = Modifier.fillMaxWidth().height(120.dp)) {
            val slot = size.width / normalized.size
            val barWidth = slot * 0.6f
            normalized.forEachIndexed { index, value ->
                val barHeight = size.height * value
                val left = index * slot + (slot - barWidth) / 2f
                drawRect(
                    color = color,
                    topLeft = Offset(left, size.height - barHeight),
                    size = Size(barWidth, barHeight),
                )
            }
        }
    }
}

@Composable
public fun FrickPieChart(
    values: List<Float>,
    modifier: Modifier = Modifier,
    colors: List<Color> = emptyList(),
) {
    FrickChartSurface(modifier = modifier) {
        val total = values.sum()
        if (values.isEmpty() || total <= 0f) {
            FrickEmptyState(title = "No data", message = "There is nothing to chart yet.")
            return@FrickChartSurface
        }
        val palette = colors.ifEmpty {
            with(FrickDesign.colors) { listOf(primary, info, success, warning, danger) }
        }
        Canvas(modifier = Modifier.fillMaxWidth().height(120.dp)) {
            var startAngle = -90f
            values.forEachIndexed { index, value ->
                val sweep = (value / total) * 360f
                drawArc(
                    color = palette[index % palette.size],
                    startAngle = startAngle,
                    sweepAngle = sweep,
                    useCenter = true,
                )
                startAngle += sweep
            }
        }
    }
}
// endregion
