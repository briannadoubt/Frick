package dev.frick.demo

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.frick.client.ConversationDto
import dev.frick.client.FrickClient
import dev.frick.client.FrickSession
import dev.frick.client.FrickStreamEvent
import dev.frick.client.SQLiteFrickStorage
import dev.frick.client.UserDto
import dev.frick.client.isVisibleChatMessage
import dev.frick.design.FrickAvatarGroup
import dev.frick.design.FrickButton
import dev.frick.design.FrickChatBubble
import dev.frick.design.FrickComposer
import dev.frick.design.FrickDesignTheme
import dev.frick.design.FrickDivider
import dev.frick.design.FrickHeading
import dev.frick.design.FrickInline
import dev.frick.design.FrickLabel
import dev.frick.design.FrickStack
import dev.frick.design.FrickSurface
import dev.frick.design.FrickText
import dev.frick.design.FrickTextButton
import dev.frick.design.FrickTextInput
import dev.frick.design.FrickWorkspaceDestination
import dev.frick.design.FrickWorkspaceShell
import dev.frick.design.generated.FrickIconName
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

private const val DemoDeviceId = "android-demo-device"
private const val DemoReplicaId = "android-demo"
private const val DemoPlatform = "android"
private const val DefaultConversationId = "conversation-general"
private const val ChatDestinationId = "chat"

private enum class AuthMode {
    Login,
    SignUp,
}

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
    val scope = rememberCoroutineScope()
    val context = LocalContext.current.applicationContext
    val storage = remember(context) { SQLiteFrickStorage(context) }
    val initialSession = remember(storage) { storage.loadSession() }
    val frick = remember(storage) { FrickClient(storage = storage) }
    var users by remember { mutableStateOf<List<UserDto>>(emptyList()) }
    var conversations by remember { mutableStateOf<List<ConversationDto>>(emptyList()) }
    var messages by remember { mutableStateOf<List<FrickStreamEvent>>(emptyList()) }
    var selectedConversationId by remember { mutableStateOf(DefaultConversationId) }
    var newThreadTitle by remember { mutableStateOf("") }
    var threadError by remember { mutableStateOf<String?>(null) }
    var isCreatingThread by remember { mutableStateOf(false) }
    var session by remember { mutableStateOf(initialSession) }
    var draft by remember { mutableStateOf("") }
    var status by remember { mutableStateOf(if (initialSession == null) "Signed out" else "Signed in") }
    var authMode by remember { mutableStateOf(AuthMode.Login) }
    var displayName by remember { mutableStateOf("") }
    var handle by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var authError by remember { mutableStateOf<String?>(null) }
    var isAuthenticating by remember { mutableStateOf(false) }
    var selectedDestination by rememberSaveable { mutableStateOf(ChatDestinationId) }
    var inspectorVisible by rememberSaveable { mutableStateOf(false) }
    val workspaceDestinations = remember {
        listOf(
            FrickWorkspaceDestination(id = ChatDestinationId, label = "Chat", icon = FrickIconName.ChatMessage),
            FrickWorkspaceDestination(
                id = "files",
                label = "Files",
                icon = FrickIconName.ChatMessage,
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
                icon = FrickIconName.ActionReload,
                enabled = false,
                badge = "Soon",
            ),
        )
    }
    val title = conversations.firstOrNull { conversation -> conversation.id == selectedConversationId }?.title
        ?: "Foundation General"
    val activeSession = session

    fun ensureSelectedConversation(nextConversations: List<ConversationDto>) {
        if (nextConversations.isEmpty()) {
            selectedConversationId = DefaultConversationId
            return
        }
        if (nextConversations.none { conversation -> conversation.id == selectedConversationId }) {
            selectedConversationId =
                nextConversations.firstOrNull { conversation -> conversation.id == DefaultConversationId }?.id
                    ?: nextConversations.first().id
        }
    }

    suspend fun authenticate(
        requestedMode: AuthMode = authMode,
        requestedDisplayName: String = displayName,
        requestedHandle: String = handle,
        requestedPassword: String = password,
    ) {
        val normalizedHandle = requestedHandle.trim()
        val normalizedDisplayName = requestedDisplayName.trim()
        if (normalizedHandle.isEmpty() || requestedPassword.isEmpty()) {
            authError = "Enter a handle and password."
            return
        }
        if (requestedMode == AuthMode.SignUp && normalizedDisplayName.isEmpty()) {
            authError = "Enter a display name."
            return
        }

        isAuthenticating = true
        status = if (requestedMode == AuthMode.SignUp) "Creating account" else "Signing in"
        authError = null
        try {
            session = when (requestedMode) {
                AuthMode.Login -> frick.login(
                    identity = normalizedHandle,
                    password = requestedPassword,
                    deviceId = DemoDeviceId,
                    replicaId = DemoReplicaId,
                    platform = DemoPlatform,
                )
                AuthMode.SignUp -> frick.signUp(
                    displayName = normalizedDisplayName,
                    handle = normalizedHandle,
                    password = requestedPassword,
                    deviceId = DemoDeviceId,
                    replicaId = DemoReplicaId,
                    platform = DemoPlatform,
                )
            }
            password = ""
            status = "Signed in"
        } catch (error: Exception) {
            authError = "Could not sign in. Check your handle and password."
            status = error.localizedMessage ?: "Authentication failed"
        } finally {
            isAuthenticating = false
        }
    }

    suspend fun reload(active: FrickSession) {
        status = "Loading"
        try {
            users = frick.fetchUsers()
            conversations = frick.fetchConversations()
            ensureSelectedConversation(conversations)
            messages = frick.fetchMessages(conversationId = selectedConversationId, readUserId = active.userId)
            status = "Loaded"
        } catch (error: Exception) {
            status = error.localizedMessage ?: "Load failed"
        }
    }

    suspend fun send() {
        val body = draft.trim()
        if (body.isEmpty()) {
            return
        }
        draft = ""
        status = "Sending"
        try {
            frick.sendMessage(conversationId = selectedConversationId, body = body)
            status = "Sent"
        } catch (error: Exception) {
            status = error.localizedMessage ?: "Send failed"
        }
    }

    suspend fun createThread() {
        val title = newThreadTitle.trim()
        if (title.isEmpty() || isCreatingThread) {
            return
        }
        newThreadTitle = ""
        isCreatingThread = true
        threadError = null
        status = "Creating thread"
        try {
            val created = frick.createConversation(title = title)
            conversations = mergeConversations(conversations, created.conversation)
            selectedConversationId = created.conversation.id
            messages = emptyList()
            draft = ""
            status = "Thread created"
        } catch (error: Exception) {
            newThreadTitle = title
            threadError = "Could not create thread."
            status = error.localizedMessage ?: "Thread create failed"
        } finally {
            isCreatingThread = false
        }
    }

    LaunchedEffect(activeSession?.sessionToken, selectedConversationId) {
        val connectedSession = activeSession ?: return@LaunchedEffect
        status = "Connecting"
        try {
            users = frick.fetchUsers()
            conversations = frick.fetchConversations()
            ensureSelectedConversation(conversations)
            frick.streamMessages(conversationId = selectedConversationId, readUserId = connectedSession.userId).collect { nextMessages ->
                messages = nextMessages
                status = "Live"
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            status = error.localizedMessage ?: "Sync failed"
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .imePadding()
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        if (activeSession == null) {
            AuthPanel(
                mode = authMode,
                displayName = displayName,
                handle = handle,
                password = password,
                status = authError ?: status,
                isAuthenticating = isAuthenticating,
                onModeChange = { nextMode ->
                    authMode = nextMode
                    authError = null
                },
                onDisplayNameChange = { displayName = it },
                onHandleChange = { handle = it },
                onPasswordChange = { password = it },
                onSubmit = { scope.launch { authenticate() } },
                onCreateDemo = {
                    val suffix = (System.currentTimeMillis() % 1_000_000).toString()
                    val demoName = "New Frick Person"
                    val demoHandle = "person$suffix"
                    val demoPassword = "foundation$suffix"
                    authMode = AuthMode.SignUp
                    displayName = demoName
                    handle = demoHandle
                    password = demoPassword
                    scope.launch {
                        authenticate(
                            requestedMode = AuthMode.SignUp,
                            requestedDisplayName = demoName,
                            requestedHandle = demoHandle,
                            requestedPassword = demoPassword,
                        )
                    }
                },
            )
        } else {
            Header(
                title = title,
                inspectorVisible = inspectorVisible,
                onReload = { scope.launch { reload(activeSession) } },
                onToggleInspector = { inspectorVisible = !inspectorVisible },
                onLogout = {
                    frick.signOut()
                    session = null
                    users = emptyList()
                    conversations = emptyList()
                    messages = emptyList()
                    selectedConversationId = DefaultConversationId
                    newThreadTitle = ""
                    threadError = null
                    isCreatingThread = false
                    draft = ""
                    authMode = AuthMode.Login
                    displayName = ""
                    handle = ""
                    password = ""
                    authError = null
                    isAuthenticating = false
                    selectedDestination = ChatDestinationId
                    inspectorVisible = false
                    status = "Signed out"
                },
            )
            FrickWorkspaceShell(
                destinations = workspaceDestinations,
                selectedDestination = selectedDestination,
                onDestinationSelected = { destination ->
                    val selected = workspaceDestinations.firstOrNull { item -> item.id == destination }
                    if (selected?.enabled == true) {
                        selectedDestination = destination
                    }
                },
                modifier = Modifier.weight(1f),
                collection = {
                    ThreadsPanel(
                        conversations = conversations,
                        selectedConversationId = selectedConversationId,
                        newThreadTitle = newThreadTitle,
                        threadError = threadError,
                        isCreatingThread = isCreatingThread,
                        onNewThreadTitleChange = {
                            newThreadTitle = it
                            threadError = null
                        },
                        onCreateThread = { scope.launch { createThread() } },
                        onSelectConversation = { conversationId ->
                            if (selectedConversationId != conversationId) {
                                selectedConversationId = conversationId
                                messages = emptyList()
                                draft = ""
                                threadError = null
                                status = "Loading"
                            }
                        },
                    )
                },
                inspectorVisible = inspectorVisible,
                onInspectorVisibleChange = { visible -> inspectorVisible = visible },
                inspector = {
                    ChatInspector(status = status, session = activeSession, users = users)
                },
            ) {
                if (selectedDestination == ChatDestinationId) {
                    ChatContent(
                        users = users,
                        messages = messages,
                        localUserId = activeSession.userId,
                        draft = draft,
                        onDraftChange = { nextDraft -> draft = nextDraft },
                        onSend = { scope.launch { send() } },
                    )
                } else {
                    val destinationLabel = workspaceDestinations
                        .firstOrNull { destination -> destination.id == selectedDestination }
                        ?.label
                        ?: selectedDestination
                    PlaceholderDestination(label = destinationLabel)
                }
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
private fun Header(
    title: String,
    inspectorVisible: Boolean,
    onReload: () -> Unit,
    onToggleInspector: () -> Unit,
    onLogout: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        FrickHeading(text = title)
        FrickInline(modifier = Modifier.fillMaxWidth()) {
            FrickButton(
                text = "Reload",
                onClick = onReload,
                modifier = Modifier.weight(1f),
            )
            FrickTextButton(
                text = if (inspectorVisible) "Hide details" else "Details",
                onClick = onToggleInspector,
                modifier = Modifier.weight(1f),
            )
            FrickTextButton(
                text = "Sign out",
                onClick = onLogout,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun UsersRow(users: List<UserDto>) {
    if (users.isEmpty()) {
        return
    }

    FrickInline(modifier = Modifier.fillMaxWidth()) {
        FrickAvatarGroup(initials = users.map { user -> initials(user.displayName) })
        Column(modifier = Modifier.weight(1f)) {
            FrickText(text = users.joinToString { user -> user.displayName }, maxLines = 1)
            FrickLabel(text = "${users.size} synced users")
        }
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
) {
    Column(
        modifier = Modifier.fillMaxSize(),
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
            if (users.isEmpty()) {
                FrickLabel(text = "No synced users yet")
            } else {
                UsersRow(users = users)
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
    selectedConversationId: String,
    newThreadTitle: String,
    threadError: String?,
    isCreatingThread: Boolean,
    onNewThreadTitleChange: (String) -> Unit,
    onCreateThread: () -> Unit,
    onSelectConversation: (String) -> Unit,
) {
    FrickSurface(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            FrickLabel(text = "Threads")
            FrickInline(modifier = Modifier.fillMaxWidth()) {
                FrickTextInput(
                    value = newThreadTitle,
                    onValueChange = onNewThreadTitleChange,
                    label = "New thread",
                    modifier = Modifier.weight(1f),
                    enabled = !isCreatingThread,
                    imeAction = ImeAction.Done,
                    keyboardActions = KeyboardActions(onDone = { onCreateThread() }),
                )
                FrickButton(
                    text = "Create",
                    onClick = onCreateThread,
                    enabled = !isCreatingThread && newThreadTitle.isNotBlank(),
                )
            }
            if (threadError != null) {
                FrickLabel(text = threadError)
            }
            conversations.forEachIndexed { index, conversation ->
                if (index > 0) {
                    FrickDivider()
                }
                FrickTextButton(
                    text = threadTitle(conversation) + if (conversation.id == selectedConversationId) " • Selected" else "",
                    onClick = { onSelectConversation(conversation.id) },
                    modifier = Modifier.fillMaxWidth(),
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

private fun mergeConversations(conversations: List<ConversationDto>, conversation: ConversationDto): List<ConversationDto> =
    (conversations.filterNot { item -> item.id == conversation.id } + conversation)
        .sortedBy { item -> threadTitle(item).lowercase() }

private fun threadTitle(conversation: ConversationDto): String =
    conversation.title?.takeIf { title -> title.isNotBlank() } ?: conversation.id
        .removePrefix("conversation-")
        .split("-", "_", " ")
        .filter { part -> part.isNotBlank() }
        .joinToString(" ") { part -> part.replaceFirstChar { char -> char.uppercaseChar() } }

private fun initials(name: String): String =
    name
        .split(" ")
        .filter { part -> part.isNotBlank() }
        .take(2)
        .joinToString("") { part -> part.first().uppercaseChar().toString() }
        .ifBlank { "?" }

private fun messageMetadata(users: List<UserDto>, message: FrickStreamEvent): String =
    listOfNotNull(
        displayName(users, message.payload["senderId"].orEmpty()),
        message.payload["createdAt"]?.substringAfter("T")?.take(5),
    ).joinToString(" • ")
