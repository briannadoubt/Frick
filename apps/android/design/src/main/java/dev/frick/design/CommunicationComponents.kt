package dev.frick.design

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Call
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

@Composable
public fun FrickAvatar(
    initials: String,
    modifier: Modifier = Modifier,
    backgroundColor: Color = FrickDesign.colors.primary,
    contentColor: Color = FrickDesign.colors.onPrimary,
) {
    Box(
        modifier = modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(backgroundColor),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = initials.take(2).uppercase(),
            color = contentColor,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Clip,
        )
    }
}

@Composable
public fun FrickAvatarGroup(
    initials: List<String>,
    modifier: Modifier = Modifier,
    maxVisible: Int = 4,
) {
    Row(modifier = modifier, horizontalArrangement = Arrangement.spacedBy((-8).dp)) {
        initials.take(maxVisible).forEach { value ->
            FrickAvatar(initials = value)
        }
        val hidden = initials.size - maxVisible
        if (hidden > 0) {
            FrickAvatar(initials = "+$hidden", backgroundColor = FrickDesign.colors.surfaceAlt, contentColor = FrickDesign.colors.text)
        }
    }
}

@Composable
public fun FrickUserRow(
    name: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    initials: String = name.initials(),
    trailing: (@Composable () -> Unit)? = null,
) {
    FrickInline(modifier = modifier.fillMaxWidth(), spacing = FrickDesign.spacing.md) {
        FrickAvatar(initials = initials)
        FrickStack(modifier = Modifier.weight(1f), spacing = FrickDesign.spacing.xs) {
            FrickText(text = name, maxLines = 1)
            if (subtitle != null) {
                FrickLabel(text = subtitle)
            }
        }
        if (trailing != null) {
            trailing()
        }
    }
}

@Composable
public fun FrickChatBubble(
    text: String,
    modifier: Modifier = Modifier,
    outgoing: Boolean = false,
    metadata: String? = null,
) {
    if (!FrickChatBubbleDefaults.shouldRender(text)) {
        return
    }

    val colors = FrickDesign.colors
    val bubbleColor = if (outgoing) colors.chatOutgoing else colors.chatIncoming
    val alignment = if (outgoing) Alignment.CenterEnd else Alignment.CenterStart
    BoxWithConstraints(modifier = modifier.fillMaxWidth(), contentAlignment = alignment) {
        FrickStack(
            modifier = Modifier
                .widthIn(max = FrickChatBubbleDefaults.maxWidthFor(maxWidth))
                .clip(RoundedCornerShape(FrickDesign.radius.lg))
                .background(bubbleColor)
                .padding(FrickDesign.spacing.md),
            spacing = FrickDesign.spacing.xs,
        ) {
            FrickText(text = text)
            if (!metadata.isNullOrBlank()) {
                FrickLabel(text = metadata)
            }
        }
    }
}

public object FrickChatBubbleDefaults {
    public const val MaxWidthFraction: Float = 0.82f
    public val MaxWidth: Dp = 360.dp

    public fun maxWidthFor(containerWidth: Dp): Dp =
        minOf(containerWidth * MaxWidthFraction, MaxWidth)

    public fun shouldRender(text: String): Boolean =
        text.isNotBlank()
}

@Composable
public fun FrickMessageList(
    messages: List<FrickMessage>,
    modifier: Modifier = Modifier,
) {
    LazyColumn(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(FrickDesign.spacing.sm),
    ) {
        items(messages) { message ->
            FrickChatBubble(text = message.text, outgoing = message.outgoing, metadata = message.metadata)
        }
    }
}

public data class FrickMessage(
    public val text: String,
    public val outgoing: Boolean = false,
    public val metadata: String? = null,
)

@Composable
public fun FrickComposer(
    value: String,
    onValueChange: (String) -> Unit,
    onSend: () -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "Message",
    enabled: Boolean = true,
) {
    FrickInline(modifier = modifier.fillMaxWidth()) {
        FrickTextInput(
            value = value,
            onValueChange = onValueChange,
            label = placeholder,
            modifier = Modifier.weight(1f),
            enabled = enabled,
            imeAction = ImeAction.Send,
            keyboardActions = KeyboardActions(
                onSend = {
                    if (enabled && value.isNotBlank()) {
                        onSend()
                    }
                },
            ),
        )
        IconButton(onClick = onSend, enabled = enabled && value.isNotBlank()) {
            Icon(imageVector = Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
        }
    }
}

@Composable
public fun FrickTypingIndicator(
    names: List<String>,
    modifier: Modifier = Modifier,
) {
    val label = when (names.size) {
        0 -> "Typing..."
        1 -> "${names.first()} is typing..."
        2 -> "${names[0]} and ${names[1]} are typing..."
        else -> "${names.take(2).joinToString(", ")} and ${names.size - 2} more are typing..."
    }
    FrickLabel(text = label, modifier = modifier)
}

@Composable
public fun FrickReceipt(
    state: FrickReceiptState,
    modifier: Modifier = Modifier,
) {
    FrickBadge(text = state.label, modifier = modifier, status = state.status)
}

public enum class FrickReceiptState(
    public val label: String,
    public val status: FrickStatus,
) {
    Sending("Sending", FrickStatus.Neutral),
    Sent("Sent", FrickStatus.Info),
    Delivered("Delivered", FrickStatus.Success),
    Failed("Failed", FrickStatus.Danger),
}

@Composable
public fun FrickReaction(
    emoji: String,
    count: Int,
    modifier: Modifier = Modifier,
) {
    FrickBadge(text = "$emoji $count", modifier = modifier, status = FrickStatus.Neutral)
}

public data class FrickReactionItem(
    public val emoji: String,
    public val count: Int,
)

/** A row of reactions; the spec-named container around [FrickReaction]. */
@Composable
public fun FrickReactionRow(
    reactions: List<FrickReactionItem>,
    modifier: Modifier = Modifier,
) {
    FrickInline(modifier = modifier, spacing = FrickDesign.spacing.xs) {
        reactions.forEach { reaction ->
            FrickReaction(emoji = reaction.emoji, count = reaction.count)
        }
    }
}

@Composable
public fun FrickSignal(
    strength: Int,
    modifier: Modifier = Modifier,
    label: String? = null,
) {
    FrickInline(modifier = modifier, spacing = FrickDesign.spacing.xs) {
        repeat(4) { index ->
            val active = index < strength.coerceIn(0, 4)
            Box(
                modifier = Modifier
                    .size(width = 4.dp, height = (8 + index * 3).dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(if (active) FrickDesign.colors.success else FrickDesign.colors.border)
                    .align(Alignment.Bottom),
            )
        }
        if (label != null) {
            FrickLabel(text = label)
        }
    }
}

@Composable
public fun FrickCallStatus(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    active: Boolean = false,
) {
    FrickSurface(modifier = modifier.fillMaxWidth()) {
        FrickInline(modifier = Modifier.padding(FrickDesign.spacing.md), spacing = FrickDesign.spacing.md) {
            FrickStatusIndicator(status = if (active) FrickStatus.Success else FrickStatus.Neutral)
            FrickStack(modifier = Modifier.weight(1f), spacing = FrickDesign.spacing.xs) {
                FrickText(text = title, maxLines = 1)
                if (subtitle != null) {
                    FrickLabel(text = subtitle)
                }
            }
        }
    }
}

/**
 * Spec-named signal panel: a labeled surface presenting connection strength and
 * an optional status line. Wraps [FrickSignal] in a token surface.
 */
@Composable
public fun FrickSignalPanel(
    strength: Int,
    modifier: Modifier = Modifier,
    title: String = "Signal",
    detail: String? = null,
) {
    FrickSurface(modifier = modifier.fillMaxWidth()) {
        FrickInline(modifier = Modifier.padding(FrickDesign.spacing.md), spacing = FrickDesign.spacing.md) {
            FrickSignal(strength = strength)
            FrickStack(modifier = Modifier.weight(1f), spacing = FrickDesign.spacing.xs) {
                FrickText(text = title, maxLines = 1)
                if (detail != null) {
                    FrickLabel(text = detail)
                }
            }
        }
    }
}

/** Spec-named call affordance: a circular call/end button styled by [active]. */
@Composable
public fun FrickCallButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    active: Boolean = false,
    enabled: Boolean = true,
    contentDescription: String = if (active) "End call" else "Start call",
) {
    val background = if (active) FrickDesign.colors.danger else FrickDesign.colors.success
    IconButton(
        onClick = onClick,
        modifier = modifier
            .size(FrickDesign.spacing.xl + FrickDesign.spacing.md)
            .clip(CircleShape)
            .background(background),
        enabled = enabled,
    ) {
        Icon(
            imageVector = Icons.Filled.Call,
            contentDescription = contentDescription,
            tint = FrickDesign.colors.onPrimary,
        )
    }
}

private fun String.initials(): String =
    split(" ")
        .filter { it.isNotBlank() }
        .take(2)
        .joinToString("") { it.first().uppercaseChar().toString() }
        .ifBlank { "?" }
