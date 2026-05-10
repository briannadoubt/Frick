package dev.frick.demo

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.frick.client.ConversationDto
import dev.frick.client.FrickClient
import dev.frick.client.FrickSession
import dev.frick.client.FrickStreamEvent
import dev.frick.client.RoomMemberDto
import dev.frick.client.SQLiteFrickStorage
import dev.frick.client.UserDto
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal const val DemoDeviceId = "android-demo-device"
internal const val DemoReplicaId = "android-demo"
internal const val DemoPlatform = "android"
internal const val DefaultConversationId = "conversation-general"
internal const val ChatDestinationId = "chat"

internal enum class AuthMode {
    Login,
    SignUp,
}

internal enum class NewThreadKind(val label: String, val wireKind: String) {
    Direct(label = "Direct", wireKind = "dm"),
    Group(label = "Group", wireKind = "group"),
}

internal data class FoundationUiState(
    val users: List<UserDto> = emptyList(),
    val conversations: List<ConversationDto> = emptyList(),
    val roomMembers: List<RoomMemberDto> = emptyList(),
    val messages: List<FrickStreamEvent> = emptyList(),
    val selectedConversationId: String = DefaultConversationId,
    val newThreadTitle: String = "",
    val newThreadKind: NewThreadKind = NewThreadKind.Direct,
    val newThreadParticipantIds: List<String> = emptyList(),
    val threadError: String? = null,
    val isCreatingThread: Boolean = false,
    val session: FrickSession? = null,
    val draft: String = "",
    val status: String = "Signed out",
    val authMode: AuthMode = AuthMode.Login,
    val displayName: String = "",
    val handle: String = "",
    val password: String = "",
    val authError: String? = null,
    val isAuthenticating: Boolean = false,
    val selectedDestination: String = ChatDestinationId,
    val inspectorVisible: Boolean = false,
    val threadListVisible: Boolean = true,
) {
    val selectedConversation: ConversationDto? =
        conversations.firstOrNull { conversation -> conversation.id == selectedConversationId }

    val selectedMembers: List<RoomMemberDto> =
        roomMembers
            .filter { member -> member.conversationId == selectedConversationId }
            .sortedWith(compareBy<RoomMemberDto> { member -> if (member.role == "owner") 0 else 1 }.thenBy { member -> member.userId })

    val availableThreadParticipants: List<UserDto> =
        users
            .filter { user -> user.id != session?.userId }
            .sortedBy { user -> user.displayName.lowercase() }

    val title: String =
        selectedConversation?.let { conversation ->
            threadTitle(
                conversation = conversation,
                users = users,
                members = selectedMembers,
                activeUserId = session?.userId,
            )
        } ?: "Foundation General"

    val isCreateThreadDisabled: Boolean =
        isCreatingThread ||
            when (newThreadKind) {
                NewThreadKind.Direct -> newThreadParticipantIds.size != 1
                NewThreadKind.Group -> newThreadTitle.isBlank() || newThreadParticipantIds.isEmpty()
            }

    val activeSession: FrickSession? = session
}

internal class FoundationViewModel(application: Application) : AndroidViewModel(application) {
    private val storage = SQLiteFrickStorage(application)
    private val frick = FrickClient(storage = storage)
    private var streamJob: Job? = null
    private val initialSession = storage.loadSession()
    private val _uiState = MutableStateFlow(
        FoundationUiState(
            session = initialSession,
            status = if (initialSession == null) "Signed out" else "Signed in",
        ),
    )

    val uiState: StateFlow<FoundationUiState> = _uiState.asStateFlow()

    init {
        if (initialSession != null) {
            startMessageStream()
        }
    }

    fun setAuthMode(mode: AuthMode) {
        _uiState.update { state -> state.copy(authMode = mode, authError = null) }
    }

    fun setDisplayName(displayName: String) {
        _uiState.update { state -> state.copy(displayName = displayName) }
    }

    fun setHandle(handle: String) {
        _uiState.update { state -> state.copy(handle = handle) }
    }

    fun setPassword(password: String) {
        _uiState.update { state -> state.copy(password = password) }
    }

    fun setDraft(draft: String) {
        _uiState.update { state -> state.copy(draft = draft) }
    }

    fun setNewThreadTitle(title: String) {
        _uiState.update { state -> state.copy(newThreadTitle = title, threadError = null) }
    }

    fun setNewThreadKind(kind: NewThreadKind) {
        _uiState.update { state ->
            state.copy(
                newThreadKind = kind,
                newThreadParticipantIds = if (kind == NewThreadKind.Direct) state.newThreadParticipantIds.take(1) else state.newThreadParticipantIds,
                threadError = null,
            )
        }
    }

    fun toggleNewThreadParticipant(userId: String) {
        _uiState.update { state ->
            val participantIds = when (state.newThreadKind) {
                NewThreadKind.Direct -> if (state.newThreadParticipantIds.firstOrNull() == userId) emptyList() else listOf(userId)
                NewThreadKind.Group ->
                    if (state.newThreadParticipantIds.contains(userId)) {
                        state.newThreadParticipantIds.filterNot { candidate -> candidate == userId }
                    } else {
                        state.newThreadParticipantIds + userId
                    }
            }
            state.copy(newThreadParticipantIds = participantIds, threadError = null)
        }
    }

    fun selectDestination(destination: String) {
        _uiState.update { state ->
            state.copy(
                selectedDestination = destination,
                threadListVisible = destination == ChatDestinationId,
                inspectorVisible = false,
            )
        }
    }

    fun setThreadListVisible(visible: Boolean) {
        _uiState.update { state ->
            state.copy(
                threadListVisible = visible,
                inspectorVisible = if (visible) false else state.inspectorVisible,
            )
        }
    }

    fun backToThreads() {
        _uiState.update { state -> state.copy(threadListVisible = true, inspectorVisible = false) }
    }

    fun setInspectorVisible(visible: Boolean) {
        _uiState.update { state -> state.copy(inspectorVisible = visible) }
    }

    fun toggleInspector() {
        _uiState.update { state -> state.copy(inspectorVisible = !state.inspectorVisible) }
    }

    fun authenticate() {
        val state = _uiState.value
        authenticate(
            requestedMode = state.authMode,
            requestedDisplayName = state.displayName,
            requestedHandle = state.handle,
            requestedPassword = state.password,
        )
    }

    fun createDemoAccount() {
        val suffix = (System.currentTimeMillis() % 1_000_000).toString()
        val demoName = "New Frick Person"
        val demoHandle = "person$suffix"
        val demoPassword = "foundation$suffix"

        _uiState.update { state ->
            state.copy(
                authMode = AuthMode.SignUp,
                displayName = demoName,
                handle = demoHandle,
                password = demoPassword,
            )
        }
        authenticate(
            requestedMode = AuthMode.SignUp,
            requestedDisplayName = demoName,
            requestedHandle = demoHandle,
            requestedPassword = demoPassword,
        )
    }

    fun reload() {
        viewModelScope.launch {
            reloadMessages()
        }
    }

    fun send() {
        val body = _uiState.value.draft.trim()
        if (body.isEmpty()) {
            return
        }

        _uiState.update { state -> state.copy(draft = "", status = "Sending") }
        viewModelScope.launch {
            try {
                frick.sendMessage(conversationId = _uiState.value.selectedConversationId, body = body)
                _uiState.update { state -> state.copy(status = "Sent") }
            } catch (error: Exception) {
                _uiState.update { state -> state.copy(draft = body, status = error.localizedMessage ?: "Send failed") }
            }
        }
    }

    fun createThread() {
        val state = _uiState.value
        val title = state.newThreadTitle.trim()
        if (state.isCreateThreadDisabled) {
            _uiState.update { current ->
                current.copy(
                    threadError = if (current.newThreadKind == NewThreadKind.Direct) {
                        "Choose one person."
                    } else {
                        "Choose people and a title."
                    },
                )
            }
            return
        }

        _uiState.update { state ->
            state.copy(
                isCreatingThread = true,
                threadError = null,
                status = "Creating thread",
            )
        }
        viewModelScope.launch {
            try {
                val created = frick.createConversation(
                    title = if (state.newThreadKind == NewThreadKind.Group) title else null,
                    kind = state.newThreadKind.wireKind,
                    participantUserIds = state.newThreadParticipantIds,
                )
                _uiState.update { state ->
                    state.copy(
                        conversations = mergeConversations(state.conversations, created.conversation),
                        roomMembers = mergeRoomMembers(state.roomMembers, created.members),
                        selectedConversationId = created.conversation.id,
                        newThreadTitle = "",
                        newThreadParticipantIds = emptyList(),
                        messages = emptyList(),
                        draft = "",
                        threadListVisible = false,
                        status = "Thread created",
                    )
                }
                startMessageStream()
            } catch (error: Exception) {
                _uiState.update { state ->
                    state.copy(
                        newThreadTitle = title,
                        threadError = "Could not create thread.",
                        status = error.localizedMessage ?: "Thread create failed",
                    )
                }
            } finally {
                _uiState.update { state -> state.copy(isCreatingThread = false) }
            }
        }
    }

    fun selectConversation(conversationId: String) {
        val previousConversationId = _uiState.value.selectedConversationId
        _uiState.update { state ->
            state.copy(
                selectedConversationId = conversationId,
                messages = if (conversationId == previousConversationId) state.messages else emptyList(),
                draft = if (conversationId == previousConversationId) state.draft else "",
                threadError = null,
                threadListVisible = false,
                status = if (conversationId == previousConversationId) state.status else "Loading",
            )
        }
        if (conversationId != previousConversationId) {
            startMessageStream()
        }
    }

    fun logout() {
        streamJob?.cancel()
        streamJob = null
        frick.signOut()
        _uiState.value = FoundationUiState()
    }

    private fun authenticate(
        requestedMode: AuthMode,
        requestedDisplayName: String,
        requestedHandle: String,
        requestedPassword: String,
    ) {
        val normalizedHandle = requestedHandle.trim()
        val normalizedDisplayName = requestedDisplayName.trim()
        if (normalizedHandle.isEmpty() || requestedPassword.isEmpty()) {
            _uiState.update { state -> state.copy(authError = "Enter a handle and password.") }
            return
        }
        if (requestedMode == AuthMode.SignUp && normalizedDisplayName.isEmpty()) {
            _uiState.update { state -> state.copy(authError = "Enter a display name.") }
            return
        }

        _uiState.update { state ->
            state.copy(
                isAuthenticating = true,
                status = if (requestedMode == AuthMode.SignUp) "Creating account" else "Signing in",
                authError = null,
            )
        }
        viewModelScope.launch {
            try {
                val nextSession = when (requestedMode) {
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
                _uiState.update { state ->
                    state.copy(
                        session = nextSession,
                        password = "",
                        status = "Signed in",
                        threadListVisible = true,
                    )
                }
                startMessageStream()
            } catch (error: Exception) {
                _uiState.update { state ->
                    state.copy(
                        authError = "Could not sign in. Check your handle and password.",
                        status = error.localizedMessage ?: "Authentication failed",
                    )
                }
            } finally {
                _uiState.update { state -> state.copy(isAuthenticating = false) }
            }
        }
    }

    private suspend fun reloadMessages() {
        val active = _uiState.value.session ?: return
        _uiState.update { state -> state.copy(status = "Loading") }
        try {
            val users = frick.fetchUsers()
            val conversations = frick.fetchConversations()
            val roomMembers = frick.fetchRoomMembers()
            val selectedConversationId = resolvedConversationId(
                currentConversationId = _uiState.value.selectedConversationId,
                conversations = conversations,
            )
            val messages = frick.fetchMessages(conversationId = selectedConversationId, readUserId = active.userId)
            _uiState.update { state ->
                state.copy(
                    users = users,
                    conversations = conversations,
                    roomMembers = roomMembers,
                    selectedConversationId = selectedConversationId,
                    messages = messages,
                    status = "Loaded",
                )
            }
        } catch (error: Exception) {
            _uiState.update { state -> state.copy(status = error.localizedMessage ?: "Load failed") }
        }
    }

    private fun startMessageStream() {
        streamJob?.cancel()
        val connectedSession = _uiState.value.session ?: return
        streamJob = viewModelScope.launch {
            _uiState.update { state -> state.copy(status = "Connecting") }
            try {
                val users = frick.fetchUsers()
                val conversations = frick.fetchConversations()
                val roomMembers = frick.fetchRoomMembers()
                val selectedConversationId = resolvedConversationId(
                    currentConversationId = _uiState.value.selectedConversationId,
                    conversations = conversations,
                )
                _uiState.update { state ->
                    state.copy(
                        users = users,
                        conversations = conversations,
                        roomMembers = roomMembers,
                        selectedConversationId = selectedConversationId,
                    )
                }
                frick.streamMessages(
                    conversationId = selectedConversationId,
                    readUserId = connectedSession.userId,
                ).collect { nextMessages ->
                    _uiState.update { state -> state.copy(messages = nextMessages, status = "Live") }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                _uiState.update { state -> state.copy(status = error.localizedMessage ?: "Sync failed") }
            }
        }
    }

    override fun onCleared() {
        streamJob?.cancel()
        super.onCleared()
    }
}

private fun resolvedConversationId(
    currentConversationId: String,
    conversations: List<ConversationDto>,
): String =
    when {
        conversations.isEmpty() -> DefaultConversationId
        conversations.any { conversation -> conversation.id == currentConversationId } -> currentConversationId
        else -> conversations.firstOrNull { conversation -> conversation.id == DefaultConversationId }?.id
            ?: conversations.first().id
    }

private fun mergeConversations(conversations: List<ConversationDto>, conversation: ConversationDto): List<ConversationDto> =
    (conversations.filterNot { item -> item.id == conversation.id } + conversation)
        .sortedBy { item -> item.titleForSorting.lowercase() }

private fun mergeRoomMembers(members: List<RoomMemberDto>, newMembers: List<RoomMemberDto>): List<RoomMemberDto> =
    (members.filterNot { current -> newMembers.any { next -> next.id == current.id } } + newMembers)
        .sortedWith(compareBy<RoomMemberDto> { member -> member.conversationId }.thenBy { member -> member.userId })

private val ConversationDto.titleForSorting: String
    get() = title?.takeIf { value -> value.isNotBlank() } ?: id

private fun displayName(users: List<UserDto>, userId: String): String =
    users.firstOrNull { user -> user.id == userId }?.displayName ?: userId

internal fun threadTitle(
    conversation: ConversationDto,
    users: List<UserDto>,
    members: List<RoomMemberDto>,
    activeUserId: String?,
): String {
    conversation.title?.takeIf { title -> title.isNotBlank() }?.let { title -> return title }
    if (conversation.kind == "dm") {
        val peer = members.firstOrNull { member -> member.userId != activeUserId } ?: members.firstOrNull()
        return peer?.let { member -> displayName(users, member.userId) } ?: "Direct message"
    }
    val participantNames = members
        .filter { member -> member.userId != activeUserId }
        .take(3)
        .map { member -> displayName(users, member.userId) }
    return participantNames.takeIf { names -> names.isNotEmpty() }?.joinToString(", ")
        ?: titleFromConversationId(conversation.id)
}

private fun titleFromConversationId(conversationId: String): String =
    conversationId
        .removePrefix("conversation-")
        .split("-", "_", " ")
        .filter { part -> part.isNotBlank() }
        .joinToString(" ") { part -> part.replaceFirstChar { char -> char.uppercaseChar() } }
