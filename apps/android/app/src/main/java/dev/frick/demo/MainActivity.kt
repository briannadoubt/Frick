package dev.frick.demo

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.frick.client.ConversationDto
import dev.frick.client.FrickSession
import dev.frick.client.FrickStreamEvent
import dev.frick.client.RoomMemberDto
import dev.frick.client.UserDto
import dev.frick.client.isVisibleChatMessage
import dev.frick.design.FrickButton
import dev.frick.design.FrickChatBubble
import dev.frick.design.FrickComposer
import dev.frick.design.FrickDesignTheme
import dev.frick.design.FrickDivider
import dev.frick.design.FrickHeading
import dev.frick.design.FrickInline
import dev.frick.design.FrickLabel
import dev.frick.design.FrickSegmentedControl
import dev.frick.design.FrickStack
import dev.frick.design.FrickSurface
import dev.frick.design.FrickText
import dev.frick.design.FrickTextButton
import dev.frick.design.FrickTextInput
import dev.frick.design.FrickTopBar
import dev.frick.design.FrickTopBarAction
import dev.frick.design.FrickUserRow
import dev.frick.design.FrickWorkspaceDestination
import dev.frick.design.FrickWorkspaceListItem
import dev.frick.design.FrickWorkspaceShell
import dev.frick.design.generated.FrickIconName

private val WorkspaceDestinations = listOf(
    FrickWorkspaceDestination(id = ChatDestinationId, label = "Chat", icon = FrickIconName.ChatMessage),
    FrickWorkspaceDestination(
        id = "files",
        label = "Files",
        icon = FrickIconName.ChatAttachment,
        enabled = false,
        badge = "Soon",
    ),
    FrickWorkspaceDestination(
        id = "calls",
        label = "Calls",
        icon = FrickIconName.CallVideo,
        enabled = false,
        badge = "Soon",
    ),
    FrickWorkspaceDestination(
        id = "admin",
        label = "Admin",
        icon = FrickIconName.WorkspaceSettings,
        enabled = false,
        badge = "Soon",
    ),
)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        setContent {
            FrickDesignTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    FrickDemo()
                }
            }
        }
    }
}

@Composable
fun FrickDemo() {
    val viewModel: FoundationViewModel = viewModel()
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val activeSession = state.activeSession

    if (activeSession == null) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .imePadding()
                .padding(horizontal = 20.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            AuthPanel(
                mode = state.authMode,
                displayName = state.displayName,
                handle = state.handle,
                password = state.password,
                status = state.authError ?: state.status,
                isAuthenticating = state.isAuthenticating,
                onModeChange = viewModel::setAuthMode,
                onDisplayNameChange = viewModel::setDisplayName,
                onHandleChange = viewModel::setHandle,
                onPasswordChange = viewModel::setPassword,
                onSubmit = viewModel::authenticate,
                onCreateDemo = viewModel::createDemoAccount,
            )
        }
    } else {
        FrickWorkspaceShell(
            destinations = WorkspaceDestinations,
            selectedDestination = state.selectedDestination,
            onDestinationSelected = { destination ->
                val selected = WorkspaceDestinations.firstOrNull { item -> item.id == destination }
                if (selected?.enabled == true) {
                    viewModel.selectDestination(destination)
                }
            },
            modifier = Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .imePadding(),
            collection = {
                ThreadListScreen(
                    conversations = state.conversations,
                    users = state.users,
                    roomMembers = state.roomMembers,
                    activeUserId = activeSession.userId,
                    selectedConversationId = state.selectedConversationId,
                    newThreadTitle = state.newThreadTitle,
                    newThreadKind = state.newThreadKind,
                    selectedParticipantIds = state.newThreadParticipantIds,
                    availableParticipants = state.availableThreadParticipants,
                    threadError = state.threadError,
                    isCreatingThread = state.isCreatingThread,
                    isCreateThreadDisabled = state.isCreateThreadDisabled,
                    onNewThreadTitleChange = viewModel::setNewThreadTitle,
                    onNewThreadKindChange = viewModel::setNewThreadKind,
                    onToggleParticipant = viewModel::toggleNewThreadParticipant,
                    onCreateThread = viewModel::createThread,
                    onSelectConversation = viewModel::selectConversation,
                    onReload = viewModel::reload,
                    onLogout = viewModel::logout,
                )
            },
            collectionVisible = state.threadListVisible,
            onCollectionVisibleChange = viewModel::setThreadListVisible,
            inspectorVisible = state.inspectorVisible,
            onInspectorVisibleChange = viewModel::setInspectorVisible,
            inspector = {
                ChatInspector(
                    status = state.status,
                    session = activeSession,
                    users = state.users,
                    members = state.selectedMembers,
                )
            },
        ) {
            if (state.selectedDestination == ChatDestinationId) {
                ChatDetailScreen(
                    title = state.title,
                    inspectorVisible = state.inspectorVisible,
                    users = state.users,
                    messages = state.messages,
                    localUserId = activeSession.userId,
                    draft = state.draft,
                    onDraftChange = viewModel::setDraft,
                    onSend = viewModel::send,
                    onBackToThreads = viewModel::backToThreads,
                    onReload = viewModel::reload,
                    onToggleInspector = viewModel::toggleInspector,
                    onLogout = viewModel::logout,
                )
            } else {
                val destinationLabel = WorkspaceDestinations
                    .firstOrNull { destination -> destination.id == state.selectedDestination }
                    ?.label
                    ?: state.selectedDestination
                PlaceholderDestination(label = destinationLabel)
            }
        }
    }
}

@Composable
private fun AuthPanel(
    mode: AuthMode,
    displayName: String,
    handle: String,
    password: String,
    status: String,
    isAuthenticating: Boolean,
    onModeChange: (AuthMode) -> Unit,
    onDisplayNameChange: (String) -> Unit,
    onHandleChange: (String) -> Unit,
    onPasswordChange: (String) -> Unit,
    onSubmit: () -> Unit,
    onCreateDemo: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        FrickHeading(text = "Foundation General")
        FrickInline(modifier = Modifier.fillMaxWidth()) {
            FrickButton(
                text = "Log in",
                onClick = { onModeChange(AuthMode.Login) },
                enabled = mode != AuthMode.Login,
                modifier = Modifier.weight(1f),
            )
            FrickButton(
                text = "Sign up",
                onClick = { onModeChange(AuthMode.SignUp) },
                enabled = mode != AuthMode.SignUp,
                modifier = Modifier.weight(1f),
            )
        }

        FrickSurface(modifier = Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (mode == AuthMode.SignUp) {
                    FrickTextInput(
                        value = displayName,
                        onValueChange = onDisplayNameChange,
                        label = "Display name",
                        modifier = Modifier.fillMaxWidth(),
                        enabled = !isAuthenticating,
                        imeAction = ImeAction.Next,
                    )
                }
                FrickTextInput(
                    value = handle,
                    onValueChange = onHandleChange,
                    label = "Handle",
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !isAuthenticating,
                    keyboardType = KeyboardType.Ascii,
                    imeAction = ImeAction.Next,
                )
                FrickTextInput(
                    value = password,
                    onValueChange = onPasswordChange,
                    label = "Password",
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !isAuthenticating,
                    keyboardType = KeyboardType.Password,
                    imeAction = ImeAction.Go,
                    keyboardActions = KeyboardActions(onGo = { onSubmit() }),
                    visualTransformation = PasswordVisualTransformation(),
                )
                FrickLabel(text = status)
                FrickButton(
                    text = if (mode == AuthMode.SignUp) "Create person" else "Log in",
                    onClick = onSubmit,
                    enabled = !isAuthenticating &&
                        handle.isNotBlank() &&
                        password.isNotBlank() &&
                        (mode == AuthMode.Login || displayName.isNotBlank()),
                    modifier = Modifier.fillMaxWidth(),
                )
                FrickTextButton(
                    text = "Make demo person",
                    onClick = onCreateDemo,
                    enabled = !isAuthenticating,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

@Composable
private fun ThreadListScreen(
    conversations: List<ConversationDto>,
    users: List<UserDto>,
    roomMembers: List<RoomMemberDto>,
    activeUserId: String,
    selectedConversationId: String,
    newThreadTitle: String,
    newThreadKind: NewThreadKind,
    selectedParticipantIds: List<String>,
    availableParticipants: List<UserDto>,
    threadError: String?,
    isCreatingThread: Boolean,
    isCreateThreadDisabled: Boolean,
    onNewThreadTitleChange: (String) -> Unit,
    onNewThreadKindChange: (NewThreadKind) -> Unit,
    onToggleParticipant: (String) -> Unit,
    onCreateThread: () -> Unit,
    onSelectConversation: (String) -> Unit,
    onReload: () -> Unit,
    onLogout: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        FrickTopBar(
            title = "Threads",
            actions = listOf(
                FrickTopBarAction(
                    icon = FrickIconName.ActionReload,
                    contentDescription = "Reload",
                    onClick = onReload,
                ),
            ),
            trailingContent = {
                FrickTextButton(text = "Sign out", onClick = onLogout)
            },
        )
        ThreadsPanel(
            conversations = conversations,
            users = users,
            roomMembers = roomMembers,
            activeUserId = activeUserId,
            selectedConversationId = selectedConversationId,
            newThreadTitle = newThreadTitle,
            newThreadKind = newThreadKind,
            selectedParticipantIds = selectedParticipantIds,
            availableParticipants = availableParticipants,
            threadError = threadError,
            isCreatingThread = isCreatingThread,
            isCreateThreadDisabled = isCreateThreadDisabled,
            onNewThreadTitleChange = onNewThreadTitleChange,
            onNewThreadKindChange = onNewThreadKindChange,
            onToggleParticipant = onToggleParticipant,
            onCreateThread = onCreateThread,
            onSelectConversation = onSelectConversation,
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = 16.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun ChatDetailScreen(
    title: String,
    inspectorVisible: Boolean,
    users: List<UserDto>,
    messages: List<FrickStreamEvent>,
    localUserId: String,
    draft: String,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    onBackToThreads: () -> Unit,
    onReload: () -> Unit,
    onToggleInspector: () -> Unit,
    onLogout: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        FrickTopBar(
            title = title,
            navigationAction = FrickTopBarAction(
                icon = FrickIconName.NavigationBack,
                contentDescription = "Threads",
                onClick = onBackToThreads,
            ),
            actions = listOf(
                FrickTopBarAction(
                    icon = FrickIconName.ActionDetails,
                    contentDescription = if (inspectorVisible) "Hide details" else "Details",
                    onClick = onToggleInspector,
                ),
                FrickTopBarAction(
                    icon = FrickIconName.ActionReload,
                    contentDescription = "Reload",
                    onClick = onReload,
                ),
            ),
            trailingContent = {
                FrickTextButton(text = "Sign out", onClick = onLogout)
            },
        )
        ChatContent(
            users = users,
            messages = messages,
            localUserId = localUserId,
            draft = draft,
            onDraftChange = onDraftChange,
            onSend = onSend,
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = 16.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun ChatContent(
    users: List<UserDto>,
    messages: List<FrickStreamEvent>,
    localUserId: String,
    draft: String,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        MessagesList(
            users = users,
            messages = messages,
            localUserId = localUserId,
            modifier = Modifier.weight(1f),
        )
        Composer(draft = draft, onDraftChange = onDraftChange, onSend = onSend)
    }
}

@Composable
private fun ChatInspector(
    status: String,
    session: FrickSession,
    users: List<UserDto>,
    members: List<RoomMemberDto>,
) {
    FrickSurface(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            FrickLabel(text = "Status")
            FrickText(text = status)
            FrickDivider()
            FrickLabel(text = sessionLabel(session, users))
            if (members.isEmpty()) {
                FrickLabel(text = "No members yet")
            } else {
                members.forEach { member ->
                    FrickUserRow(
                        name = displayName(users, member.userId),
                        subtitle = member.role.replaceFirstChar { char -> char.uppercaseChar() },
                    )
                }
            }
        }
    }
}

@Composable
private fun PlaceholderDestination(label: String) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        FrickStack(horizontalAlignment = Alignment.CenterHorizontally) {
            FrickHeading(text = label)
            FrickLabel(text = "This workspace destination is ready for a real module.")
        }
    }
}

@Composable
private fun ThreadsPanel(
    conversations: List<ConversationDto>,
    users: List<UserDto>,
    roomMembers: List<RoomMemberDto>,
    activeUserId: String,
    selectedConversationId: String,
    newThreadTitle: String,
    newThreadKind: NewThreadKind,
    selectedParticipantIds: List<String>,
    availableParticipants: List<UserDto>,
    threadError: String?,
    isCreatingThread: Boolean,
    isCreateThreadDisabled: Boolean,
    onNewThreadTitleChange: (String) -> Unit,
    onNewThreadKindChange: (NewThreadKind) -> Unit,
    onToggleParticipant: (String) -> Unit,
    onCreateThread: () -> Unit,
    onSelectConversation: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    FrickSurface(modifier = modifier.fillMaxSize()) {
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item {
                FrickLabel(text = "Threads")
            }
            item {
                FrickSegmentedControl(
                    options = NewThreadKind.entries.map { kind -> kind.label },
                    selectedIndex = NewThreadKind.entries.indexOf(newThreadKind),
                    onSelectedIndexChange = { index -> onNewThreadKindChange(NewThreadKind.entries[index]) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (newThreadKind == NewThreadKind.Group) {
                item {
                    FrickTextInput(
                        value = newThreadTitle,
                        onValueChange = onNewThreadTitleChange,
                        label = "New thread",
                        modifier = Modifier.fillMaxWidth(),
                        enabled = !isCreatingThread,
                        imeAction = ImeAction.Done,
                        keyboardActions = KeyboardActions(onDone = { onCreateThread() }),
                    )
                }
            }

            items(availableParticipants, key = { user -> user.id }) { user ->
                val selected = selectedParticipantIds.contains(user.id)
                FrickUserRow(
                    name = user.displayName,
                    subtitle = user.id,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable(enabled = !isCreatingThread) { onToggleParticipant(user.id) }
                        .padding(vertical = 6.dp),
                    trailing = {
                        if (selected) {
                            FrickText(text = "✓")
                        }
                    },
                )
            }

            item {
                FrickButton(
                    text = if (newThreadKind == NewThreadKind.Direct) "Start direct" else "Create group",
                    onClick = onCreateThread,
                    enabled = !isCreateThreadDisabled,
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            if (threadError != null) {
                item {
                    FrickLabel(text = threadError)
                }
            }

            items(conversations, key = { conversation -> conversation.id }) { conversation ->
                val members = roomMembers.filter { member -> member.conversationId == conversation.id }
                FrickWorkspaceListItem(
                    title = threadTitle(
                        conversation = conversation,
                        users = users,
                        members = members,
                        activeUserId = activeUserId,
                    ),
                    subtitle = conversation.kind.replaceFirstChar { char -> char.uppercaseChar() },
                    selected = conversation.id == selectedConversationId,
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { onSelectConversation(conversation.id) },
                )
            }
        }
    }
}

@Composable
private fun MessagesList(
    users: List<UserDto>,
    messages: List<FrickStreamEvent>,
    localUserId: String,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    val visibleMessages = messages.filter { message -> message.isVisibleChatMessage() }

    LaunchedEffect(visibleMessages.lastOrNull()?.eventId, visibleMessages.size) {
        if (visibleMessages.isNotEmpty()) {
            listState.animateScrollToItem(visibleMessages.lastIndex)
        }
    }

    LazyColumn(
        modifier = modifier.fillMaxWidth(),
        state = listState,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        items(visibleMessages, key = { message -> message.eventId }) { message ->
            FrickChatBubble(
                text = message.payload["body"].orEmpty(),
                outgoing = message.payload["senderId"] == localUserId,
                metadata = messageMetadata(users, message),
            )
        }
    }
}

@Composable
private fun Composer(
    draft: String,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
) {
    FrickComposer(
        value = draft,
        onValueChange = onDraftChange,
        onSend = onSend,
        placeholder = "Message the foundation",
    )
}

private fun sessionLabel(session: FrickSession, users: List<UserDto>): String {
    val name = session.displayName ?: displayName(users, session.userId)
    val handle = session.handle?.let { value -> " @$value" }.orEmpty()
    return "Signed in as $name$handle"
}

private fun displayName(users: List<UserDto>, userId: String): String =
    users.firstOrNull { user -> user.id == userId }?.displayName ?: userId

private fun messageMetadata(users: List<UserDto>, message: FrickStreamEvent): String =
    listOfNotNull(
        displayName(users, message.payload["senderId"].orEmpty()),
        message.payload["createdAt"]?.substringAfter("T")?.take(5),
    ).joinToString(" • ")
