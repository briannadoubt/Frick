package dev.frick.design

import androidx.compose.ui.unit.dp
import dev.frick.design.generated.FrickDensity
import dev.frick.design.generated.FrickIconName
import dev.frick.design.generated.FrickMode
import dev.frick.design.generated.FrickTokens
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

public class FrickDesignTest {
    @Test
    public fun generatedPlaceholderProvidesDistinctLightAndDarkPalettes() {
        val light = FrickTokens.colors(FrickMode.Light)
        val dark = FrickTokens.colors(FrickMode.Dark)

        assertNotEquals(light.background, dark.background)
        assertNotEquals(light.text, dark.text)
    }

    @Test
    public fun compactDensityKeepsSpacingNoLargerThanComfortableDensity() {
        val comfortable = FrickTokens.spacing(FrickDensity.Comfortable)
        val compact = FrickTokens.spacing(FrickDensity.Compact)

        assertEquals(true, compact.md <= comfortable.md)
        assertEquals(true, compact.lg <= comfortable.lg)
    }

    @Test
    public fun chatBubblesWrapContentUntilTheyHitTheReadableWidthCap() {
        assertEquals(328.dp, FrickChatBubbleDefaults.maxWidthFor(400.dp))
        assertEquals(360.dp, FrickChatBubbleDefaults.maxWidthFor(900.dp))
    }

    @Test
    public fun chatBubblesRequireRealMessageText() {
        assertEquals(true, FrickChatBubbleDefaults.shouldRender("Hello"))
        assertEquals(false, FrickChatBubbleDefaults.shouldRender(""))
        assertEquals(false, FrickChatBubbleDefaults.shouldRender("  \n"))
    }

    @Test
    public fun workspaceDestinationStoresNavigationContract() {
        val destination = FrickWorkspaceDestination(
            id = "chat",
            label = "Chat",
            icon = FrickIconName.ChatMessage,
            enabled = true,
            badge = "2",
        )

        assertEquals("chat", destination.id)
        assertEquals("Chat", destination.label)
        assertEquals(FrickIconName.ChatMessage, destination.icon)
        assertEquals(true, destination.enabled)
        assertEquals("2", destination.badge)
    }

    @Test
    public fun workspaceDefaultsUseExpandedPanesOnlyForWideLayouts() {
        assertEquals(false, FrickWorkspaceDefaults.usesExpandedPanes(600.dp))
        assertEquals(false, FrickWorkspaceDefaults.usesExpandedPanes(840.dp))
        assertEquals(true, FrickWorkspaceDefaults.usesExpandedPanes(1040.dp))
        assertEquals(true, FrickWorkspaceDefaults.usesExpandedPanes(1200.dp))
    }

    @Test
    public fun workspaceDefaultsUseCompactListDetailForNarrowLayouts() {
        assertEquals(true, FrickWorkspaceDefaults.usesCompactListDetail(600.dp))
        assertEquals(true, FrickWorkspaceDefaults.usesCompactListDetail(839.dp))
        assertEquals(false, FrickWorkspaceDefaults.usesCompactListDetail(1040.dp))
    }

    @Test
    public fun workspaceDefaultsReserveReadablePaneWidths() {
        assertEquals(300.dp, FrickWorkspaceDefaults.collectionPaneWidth)
        assertEquals(300.dp, FrickWorkspaceDefaults.inspectorPaneWidth)
    }

    @Test
    public fun workspaceDefaultsUseCanonicalAdaptivePanesWhenACollectionExists() {
        assertEquals(true, FrickWorkspaceDefaults.usesCanonicalAdaptivePanes(hasCollection = true))
        assertEquals(false, FrickWorkspaceDefaults.usesCanonicalAdaptivePanes(hasCollection = false))
    }

    @Test
    public fun chartSeriesNormalizesIntoUnitRange() {
        val normalized = normalizeSeries(listOf(10f, 20f, 30f))

        assertEquals(0f, normalized.first())
        assertEquals(1f, normalized.last())
        assertEquals(0.5f, normalized[1])
    }

    @Test
    public fun chartSeriesHandlesFlatAndEmptyInputWithoutDividingByZero() {
        assertEquals(emptyList<Float>(), normalizeSeries(emptyList()))

        val flat = normalizeSeries(listOf(5f, 5f, 5f))
        assertEquals(3, flat.size)
        assertEquals(true, flat.all { it == 0f })
    }

    @Test
    public fun dataGridColumnCarriesSemanticContract() {
        val column = FrickColumn(key = "name", title = "Name", weight = 2f, sortable = true)

        assertEquals("name", column.key)
        assertEquals("Name", column.title)
        assertEquals(2f, column.weight)
        assertEquals(true, column.sortable)
    }

    @Test
    public fun reactionRowItemsCarryEmojiAndCount() {
        val item = FrickReactionItem(emoji = "👍", count = 3)

        assertEquals("👍", item.emoji)
        assertEquals(3, item.count)
    }

    @Test
    public fun receiptStatesMapToSemanticStatuses() {
        assertEquals(FrickStatus.Success, FrickReceiptState.Delivered.status)
        assertEquals(FrickStatus.Danger, FrickReceiptState.Failed.status)
        assertEquals("Sent", FrickReceiptState.Sent.label)
    }

    @Test
    public fun workspaceTopBarActionStoresNativeChromeContract() {
        val action = FrickTopBarAction(
            icon = FrickIconName.ActionReload,
            contentDescription = "Reload",
            onClick = {},
        )

        assertEquals(FrickIconName.ActionReload, action.icon)
        assertEquals("Reload", action.contentDescription)
        assertEquals(true, action.enabled)
    }
}
