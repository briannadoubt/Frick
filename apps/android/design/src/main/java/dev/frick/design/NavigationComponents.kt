package dev.frick.design

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteItem
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.frick.design.generated.FrickIconName

public data class FrickWorkspaceDestination(
    public val id: String,
    public val label: String,
    public val icon: FrickIconName,
    public val enabled: Boolean = true,
    public val badge: String? = null,
)

public object FrickWorkspaceDefaults {
    public val expandedPaneBreakpoint: Dp = 1040.dp
    public val collectionPaneWidth: Dp = 300.dp
    public val inspectorPaneWidth: Dp = 300.dp
    public val compactCollectionMaxHeight: Dp = 260.dp

    public fun usesExpandedPanes(width: Dp): Boolean =
        width >= expandedPaneBreakpoint
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun FrickWorkspaceShell(
    destinations: List<FrickWorkspaceDestination>,
    selectedDestination: String,
    onDestinationSelected: (String) -> Unit,
    modifier: Modifier = Modifier,
    collection: (@Composable () -> Unit)? = null,
    inspectorVisible: Boolean = false,
    onInspectorVisibleChange: (Boolean) -> Unit = {},
    inspector: @Composable () -> Unit = {},
    content: @Composable () -> Unit,
) {
    BoxWithConstraints(modifier = modifier.fillMaxSize()) {
        val usesExpandedPanes = FrickWorkspaceDefaults.usesExpandedPanes(maxWidth)

        NavigationSuiteScaffold(
            navigationItems = {
                destinations.forEach { destination ->
                    NavigationSuiteItem(
                        selected = destination.id == selectedDestination,
                        onClick = { onDestinationSelected(destination.id) },
                        icon = { FrickWorkspaceIcon(destination.icon) },
                        enabled = destination.enabled,
                        label = { Text(destination.label) },
                        badge = destination.badge?.let { badge -> { Text(badge) } },
                    )
                }
            },
        ) {
            if (usesExpandedPanes) {
                Row(modifier = Modifier.fillMaxSize().fillMaxWidth()) {
                    if (collection != null) {
                        Box(
                            modifier = Modifier
                                .width(FrickWorkspaceDefaults.collectionPaneWidth)
                                .fillMaxHeight()
                                .padding(16.dp),
                        ) {
                            collection()
                        }
                    }
                    Box(modifier = Modifier.weight(1f).fillMaxSize().padding(16.dp)) {
                        content()
                    }
                    if (inspectorVisible) {
                        Box(
                            modifier = Modifier
                                .width(FrickWorkspaceDefaults.inspectorPaneWidth)
                                .fillMaxHeight()
                                .padding(16.dp),
                        ) {
                            inspector()
                        }
                    }
                }
            } else {
                Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
                    if (collection != null) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(max = FrickWorkspaceDefaults.compactCollectionMaxHeight)
                                .padding(bottom = 16.dp),
                        ) {
                            collection()
                        }
                    }
                    Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                        content()
                    }
                }
                if (inspectorVisible) {
                    ModalBottomSheet(onDismissRequest = { onInspectorVisibleChange(false) }) {
                        Box(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
                            inspector()
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FrickWorkspaceIcon(name: FrickIconName) {
    val label = when (name) {
        FrickIconName.ActionSend -> "Send"
        FrickIconName.ActionReload -> "Reload"
        FrickIconName.StatusLive -> "Live"
        FrickIconName.ChatMessage -> "Chat"
        FrickIconName.CallVideo -> "Video"
    }

    Text(label)
}
