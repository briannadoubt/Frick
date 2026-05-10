package dev.frick.design

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Badge
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.adaptive.layout.AnimatedPane
import androidx.compose.material3.adaptive.layout.ListDetailPaneScaffoldRole
import androidx.compose.material3.adaptive.navigation.BackNavigationBehavior
import androidx.compose.material3.adaptive.navigation.NavigableListDetailPaneScaffold
import androidx.compose.material3.adaptive.navigation.rememberListDetailPaneScaffoldNavigator
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteItem
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.window.core.layout.WindowSizeClass
import dev.frick.design.generated.FrickIconName

private const val ListPaneKey = "frick-list-pane"
private const val DetailPaneKey = "frick-detail-pane"

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

    public fun usesCompactListDetail(width: Dp): Boolean =
        !usesExpandedPanes(width)

    public fun usesCanonicalAdaptivePanes(hasCollection: Boolean): Boolean =
        hasCollection
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3AdaptiveApi::class)
@Composable
public fun FrickWorkspaceShell(
    destinations: List<FrickWorkspaceDestination>,
    selectedDestination: String,
    onDestinationSelected: (String) -> Unit,
    modifier: Modifier = Modifier,
    collection: (@Composable () -> Unit)? = null,
    collectionVisible: Boolean = false,
    onCollectionVisibleChange: (Boolean) -> Unit = {},
    inspectorVisible: Boolean = false,
    onInspectorVisibleChange: (Boolean) -> Unit = {},
    inspector: @Composable () -> Unit = {},
    content: @Composable () -> Unit,
) {
    NavigationSuiteScaffold(
        navigationItems = {
            destinations.forEach { destination ->
                NavigationSuiteItem(
                    selected = destination.id == selectedDestination,
                    onClick = { onDestinationSelected(destination.id) },
                    icon = { FrickIcon(icon = destination.icon) },
                    enabled = destination.enabled,
                    label = { Text(destination.label) },
                    badge = destination.badge?.let { badge -> { Badge { Text(badge) } } },
                )
            }
        },
        modifier = modifier.fillMaxSize(),
    ) {
        if (collection == null) {
            Box(modifier = Modifier.fillMaxSize().padding(16.dp)) {
                content()
            }
            if (inspectorVisible) {
                ModalBottomSheet(onDismissRequest = { onInspectorVisibleChange(false) }) {
                    Box(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
                        inspector()
                    }
                }
            }
            return@NavigationSuiteScaffold
        }

        val adaptiveInfo = currentWindowAdaptiveInfo()
        val isSinglePaneWidth = !adaptiveInfo.windowSizeClass.isWidthAtLeastBreakpoint(
            WindowSizeClass.WIDTH_DP_EXPANDED_LOWER_BOUND,
        )
        val navigator = rememberListDetailPaneScaffoldNavigator<String>()

        LaunchedEffect(collectionVisible, isSinglePaneWidth) {
            val targetPane =
                if (collectionVisible && isSinglePaneWidth) ListDetailPaneScaffoldRole.List else ListDetailPaneScaffoldRole.Detail
            val targetKey = if (targetPane == ListDetailPaneScaffoldRole.List) ListPaneKey else DetailPaneKey
            navigator.navigateTo(targetPane, targetKey)
        }

        BackHandler(enabled = isSinglePaneWidth && !collectionVisible && !inspectorVisible) {
            onCollectionVisibleChange(true)
        }

        NavigableListDetailPaneScaffold(
            navigator = navigator,
            defaultBackBehavior = BackNavigationBehavior.PopUntilScaffoldValueChange,
            modifier = Modifier.fillMaxSize(),
            listPane = {
                AnimatedPane {
                    Box(modifier = Modifier.fillMaxSize().padding(16.dp)) {
                        collection()
                    }
                }
            },
            detailPane = {
                AnimatedPane {
                    Box(modifier = Modifier.fillMaxSize().padding(16.dp)) {
                        content()
                    }
                }
            },
        )

        if (inspectorVisible) {
            ModalBottomSheet(onDismissRequest = { onInspectorVisibleChange(false) }) {
                Box(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
                    inspector()
                }
            }
        }
    }
}
