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
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.MailOutline
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.frick.design.generated.FrickIconName

@Composable
public fun FrickSurface(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = modifier,
        color = FrickDesign.colors.surface,
        contentColor = FrickDesign.colors.text,
        shape = RoundedCornerShape(FrickDesign.radius.md),
        tonalElevation = 0.dp,
        shadowElevation = 0.dp,
        content = content,
    )
}

@Composable
public fun FrickStack(
    modifier: Modifier = Modifier,
    spacing: Dp = FrickDesign.spacing.md,
    horizontalAlignment: Alignment.Horizontal = Alignment.Start,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(spacing),
        horizontalAlignment = horizontalAlignment,
        content = content,
    )
}

@Composable
public fun FrickInline(
    modifier: Modifier = Modifier,
    spacing: Dp = FrickDesign.spacing.sm,
    verticalAlignment: Alignment.Vertical = Alignment.CenterVertically,
    content: @Composable RowScope.() -> Unit,
) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(spacing),
        verticalAlignment = verticalAlignment,
        content = content,
    )
}

@Composable
public fun FrickText(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = FrickDesign.colors.text,
    maxLines: Int = Int.MAX_VALUE,
) {
    Text(
        text = text,
        modifier = modifier,
        color = color,
        fontSize = dev.frick.design.generated.FrickTokens.typography.body,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
public fun FrickHeading(
    text: String,
    modifier: Modifier = Modifier,
) {
    Text(
        text = text,
        modifier = modifier,
        color = FrickDesign.colors.text,
        fontSize = dev.frick.design.generated.FrickTokens.typography.heading,
        fontWeight = FontWeight.SemiBold,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
public fun FrickLabel(
    text: String,
    modifier: Modifier = Modifier,
) {
    Text(
        text = text,
        modifier = modifier,
        color = FrickDesign.colors.textMuted,
        fontSize = dev.frick.design.generated.FrickTokens.typography.label,
        fontWeight = FontWeight.Medium,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
public fun FrickDivider(modifier: Modifier = Modifier) {
    HorizontalDivider(modifier = modifier, color = FrickDesign.colors.border)
}

@Composable
public fun FrickSpacer(size: Dp = FrickDesign.spacing.md) {
    Spacer(modifier = Modifier.size(size))
}

@Composable
public fun FrickButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Button(onClick = onClick, modifier = modifier, enabled = enabled) {
        Text(text = text)
    }
}

@Composable
public fun FrickTextButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    TextButton(onClick = onClick, modifier = modifier, enabled = enabled) {
        Text(text = text)
    }
}

@Composable
public fun FrickIcon(
    icon: FrickIconName,
    modifier: Modifier = Modifier,
    contentDescription: String? = null,
) {
    Icon(
        imageVector = frickIconVector(icon),
        contentDescription = contentDescription,
        modifier = modifier,
    )
}

@Composable
public fun FrickIconButton(
    icon: FrickIconName,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    IconButton(onClick = onClick, modifier = modifier, enabled = enabled) {
        FrickIcon(icon = icon, contentDescription = contentDescription)
    }
}

public data class FrickTopBarAction(
    public val icon: FrickIconName,
    public val contentDescription: String,
    public val enabled: Boolean = true,
    public val onClick: () -> Unit,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun FrickTopBar(
    title: String,
    modifier: Modifier = Modifier,
    navigationAction: FrickTopBarAction? = null,
    actions: List<FrickTopBarAction> = emptyList(),
    trailingContent: @Composable RowScope.() -> Unit = {},
) {
    TopAppBar(
        title = { FrickText(text = title, maxLines = 1) },
        modifier = modifier,
        navigationIcon = {
            if (navigationAction != null) {
                FrickIconButton(
                    icon = navigationAction.icon,
                    contentDescription = navigationAction.contentDescription,
                    onClick = navigationAction.onClick,
                    enabled = navigationAction.enabled,
                )
            }
        },
        actions = {
            actions.forEach { action ->
                FrickIconButton(
                    icon = action.icon,
                    contentDescription = action.contentDescription,
                    onClick = action.onClick,
                    enabled = action.enabled,
                )
            }
            trailingContent()
        },
    )
}

@Composable
public fun FrickTextInput(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    isError: Boolean = false,
    supportingText: String? = null,
    keyboardType: KeyboardType = KeyboardType.Text,
    imeAction: ImeAction = ImeAction.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
) {
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
        visualTransformation = visualTransformation,
        singleLine = true,
    )
}

@Composable
public fun FrickWorkspaceListItem(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    meta: String? = null,
    selected: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    NavigationDrawerItem(
        selected = selected,
        onClick = { if (enabled) onClick() },
        modifier = modifier,
        label = {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                FrickText(text = title, maxLines = 1)
                if (subtitle != null) {
                    FrickLabel(text = subtitle)
                }
                if (meta != null) {
                    Text(
                        text = meta,
                        color = FrickDesign.colors.primary,
                        fontSize = dev.frick.design.generated.FrickTokens.typography.label,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        },
    )
}

@Composable
public fun FrickToggle(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    enabled: Boolean = true,
) {
    FrickInline(modifier = modifier) {
        Switch(checked = checked, onCheckedChange = onCheckedChange, enabled = enabled)
        if (label != null) {
            FrickText(text = label)
        }
    }
}

@Composable
public fun FrickSegmentedControl(
    options: List<String>,
    selectedIndex: Int,
    onSelectedIndexChange: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    FrickInline(modifier = modifier) {
        options.forEachIndexed { index, option ->
            FilterChip(
                selected = index == selectedIndex,
                onClick = { onSelectedIndexChange(index) },
                label = { Text(option, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            )
        }
    }
}

@Composable
public fun FrickBadge(
    text: String,
    modifier: Modifier = Modifier,
    status: FrickStatus = FrickStatus.Neutral,
) {
    val colors = FrickDesign.colors
    val color = statusColor(status, colors)
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(FrickDesign.radius.pill))
            .background(color.copy(alpha = 0.14f))
            .padding(horizontal = FrickDesign.spacing.sm, vertical = FrickDesign.spacing.xs),
    ) {
        Text(text = text, color = color, fontSize = dev.frick.design.generated.FrickTokens.typography.label)
    }
}

@Composable
public fun FrickStatusIndicator(
    status: FrickStatus,
    modifier: Modifier = Modifier,
    label: String? = null,
) {
    val color = statusColor(status, FrickDesign.colors)
    FrickInline(modifier = modifier, spacing = FrickDesign.spacing.xs) {
        Box(modifier = Modifier.size(8.dp).clip(CircleShape).background(color))
        if (label != null) {
            FrickLabel(text = label)
        }
    }
}

@Composable
public fun FrickPresence(
    isOnline: Boolean,
    modifier: Modifier = Modifier,
    label: String = if (isOnline) "Online" else "Offline",
) {
    FrickStatusIndicator(
        status = if (isOnline) FrickStatus.Success else FrickStatus.Neutral,
        modifier = modifier,
        label = label,
    )
}

@Composable
public fun FrickProgress(
    modifier: Modifier = Modifier,
    progress: Float? = null,
) {
    if (progress == null) {
        CircularProgressIndicator(modifier = modifier)
    } else {
        LinearProgressIndicator(progress = { progress.coerceIn(0f, 1f) }, modifier = modifier)
    }
}

@Composable
public fun FrickErrorState(
    title: String,
    message: String,
    modifier: Modifier = Modifier,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    FrickStack(modifier = modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        FrickBadge(text = "Error", status = FrickStatus.Danger)
        FrickHeading(text = title)
        FrickText(text = message, color = FrickDesign.colors.textMuted)
        if (actionLabel != null && onAction != null) {
            FrickButton(text = actionLabel, onClick = onAction)
        }
    }
}

@Composable
public fun FrickEmptyState(
    title: String,
    message: String,
    modifier: Modifier = Modifier,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    FrickStack(modifier = modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        FrickHeading(text = title)
        FrickText(text = message, color = FrickDesign.colors.textMuted)
        if (actionLabel != null && onAction != null) {
            FrickButton(text = actionLabel, onClick = onAction)
        }
    }
}

@Composable
public fun FrickMetric(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    delta: String? = null,
    status: FrickStatus = FrickStatus.Neutral,
) {
    FrickSurface(modifier = modifier.fillMaxWidth()) {
        FrickStack(modifier = Modifier.padding(FrickDesign.spacing.md)) {
            FrickLabel(text = label)
            FrickHeading(text = value)
            if (delta != null) {
                FrickBadge(text = delta, status = status)
            }
        }
    }
}

@Composable
public fun FrickTimeline(
    items: List<FrickTimelineItem>,
    modifier: Modifier = Modifier,
) {
    FrickStack(modifier = modifier) {
        items.forEach { item ->
            FrickInline(verticalAlignment = Alignment.Top) {
                FrickStatusIndicator(status = item.status)
                FrickStack(spacing = FrickDesign.spacing.xs) {
                    FrickText(text = item.title)
                    if (item.detail != null) {
                        FrickLabel(text = item.detail)
                    }
                }
            }
        }
    }
}

public data class FrickTimelineItem(
    public val title: String,
    public val detail: String? = null,
    public val status: FrickStatus = FrickStatus.Neutral,
)

@Composable
public fun FrickTable(
    headers: List<String>,
    rows: List<List<String>>,
    modifier: Modifier = Modifier,
) {
    FrickStack(modifier = modifier.fillMaxWidth(), spacing = FrickDesign.spacing.sm) {
        FrickDataRow(values = headers, emphasized = true)
        FrickDivider()
        rows.forEach { row -> FrickDataRow(values = row) }
    }
}

@Composable
public fun FrickDataGrid(
    rows: List<List<String>>,
    modifier: Modifier = Modifier,
) {
    LazyColumn(modifier = modifier) {
        items(rows) { row ->
            FrickDataRow(values = row, modifier = Modifier.padding(vertical = FrickDesign.spacing.xs))
        }
    }
}

@Composable
private fun FrickDataRow(
    values: List<String>,
    modifier: Modifier = Modifier,
    emphasized: Boolean = false,
) {
    Row(modifier = modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(FrickDesign.spacing.sm)) {
        values.forEach { value ->
            Text(
                text = value,
                modifier = Modifier.weight(1f),
                color = if (emphasized) FrickDesign.colors.text else FrickDesign.colors.textMuted,
                fontWeight = if (emphasized) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
public fun FrickDateField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String = "Date",
) {
    FrickTextInput(value = value, onValueChange = onValueChange, label = label, modifier = modifier)
}

@Composable
public fun FrickTimeField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String = "Time",
) {
    FrickTextInput(value = value, onValueChange = onValueChange, label = label, modifier = modifier)
}

@Composable
public fun FrickSparkline(
    points: List<Float>,
    modifier: Modifier = Modifier,
    color: Color = FrickDesign.colors.primary,
) {
    val normalized = remember(points) {
        val min = points.minOrNull() ?: 0f
        val max = points.maxOrNull() ?: 0f
        val range = (max - min).takeIf { it > 0f } ?: 1f
        points.map { (it - min) / range }
    }
    Canvas(modifier = modifier.height(40.dp).fillMaxWidth()) {
        if (normalized.size < 2) {
            return@Canvas
        }
        val path = Path()
        normalized.forEachIndexed { index, value ->
            val x = size.width * (index.toFloat() / (normalized.lastIndex.toFloat()))
            val y = size.height - (size.height * value)
            if (index == 0) {
                path.moveTo(x, y)
            } else {
                path.lineTo(x, y)
            }
        }
        drawPath(path = path, color = color, style = Stroke(width = 3.dp.toPx()))
    }
}

@Composable
public fun FrickChart(
    values: List<Float>,
    modifier: Modifier = Modifier,
) {
    FrickSurface(modifier = modifier.height(120.dp).fillMaxWidth().border(1.dp, FrickDesign.colors.border, RoundedCornerShape(FrickDesign.radius.md))) {
        FrickSparkline(points = values, modifier = Modifier.padding(FrickDesign.spacing.md).fillMaxWidth().height(88.dp))
    }
}

private fun frickIconVector(icon: FrickIconName): ImageVector =
    when (icon) {
        FrickIconName.ActionSend -> Icons.AutoMirrored.Filled.Send
        FrickIconName.ActionReload -> Icons.Filled.Refresh
        FrickIconName.ActionAdd -> Icons.Filled.Add
        FrickIconName.ActionDetails -> Icons.Filled.Info
        FrickIconName.NavigationBack -> Icons.AutoMirrored.Filled.ArrowBack
        FrickIconName.NavigationThreads -> Icons.Filled.MailOutline
        FrickIconName.StatusLive -> Icons.Filled.Refresh
        FrickIconName.ChatMessage -> Icons.Filled.MailOutline
        FrickIconName.ChatAttachment -> Icons.Filled.MailOutline
        FrickIconName.CallVideo -> Icons.Filled.Call
        FrickIconName.WorkspaceSettings -> Icons.Filled.Settings
        FrickIconName.ThemeLight -> Icons.Filled.Settings
        FrickIconName.ThemeDark -> Icons.Filled.Settings
    }
