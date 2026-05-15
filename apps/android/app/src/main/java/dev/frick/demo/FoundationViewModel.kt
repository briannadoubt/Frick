package dev.frick.demo

import android.app.Application
import android.content.Context
import androidx.core.content.edit
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.frick.client.ConversationDto
import dev.frick.client.FrickClient
import dev.frick.client.FrickInboundEvent
import dev.frick.client.FrickSession
import dev.frick.client.FrickStreamEvent
import dev.frick.client.FrickSyncSocket
import dev.frick.client.FrickSyncStatus
import dev.frick.client.RoomMemberDto
import dev.frick.client.SQLiteFrickStorage
import dev.frick.client.UserDto
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
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
internal val DemoBaseUrl: String = BuildConfig.FRICK_BASE_URL
private const val TypingDebounceMs = 800L
private const val PrefsName = "frick-demo-prefs"
private const val PrefPushRegistrationId = "push.registrationId"
private const val PrefPushEnabled = "push.enabled"

internal enum class AuthMode { Login, SignUp }

internal enum class NewThreadKind(val label: String, val wireKind: String) {
    Direct(label = "Direct", wireKind = "dm"),
    Group(label = "Group", wireKind = "group"),
}

internal enum class SyncIndicator { Green, Yellow, Red }

internal data class SyncStatusUi(
    val indicator: SyncIndicator,
    val description: String,
    val lastErrorCode: String? = null,
    val lastErrorMessage: String? = null,
)

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
    val sync: SyncStatusUi = SyncStatusUi(SyncIndicator.Red, "Disconnected"),
    val syncDialogVisible: Boolean = false,
    val typingUserIds: List<String> = emptyList(),
    val pushEnabled: Boolean = false,
    val pushBusy: Boolean = false,
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
    private val frick = FrickClient(baseUrl = DemoBaseUrl, storage = storage)
    private val prefs = application.getSharedPreferences(PrefsName, Context.MODE_PRIVATE)
    private var streamJob: Job? = null
    private var socket: FrickSyncSocket? = null
    // Exposed for `rememberFrickStreamEvents` / `rememberFrickProjection`
    // in the chat composable. Mirrors the iOS demo's `Environment` socket
    // injection — Compose subscribes off the typed wrappers instead of
    // this ViewModel running its own `events.collect { … }`.
    private val _socketFlow = MutableStateFlow<FrickSyncSocket?>(null)
    val socketFlow: StateFlow<FrickSyncSocket?> = _socketFlow.asStateFlow()
    private var socketStatusJob: Job? = null
    private var socketEventsJob: Job? = null
    private var typingJob: Job? = null

    private val initialSession = storage.loadSession()
    private val _uiState = MutableStateFlow(
        FoundationUiState(
            session = initialSession,
            status = if (initialSession == null) "Signed out" else "Signed in",
            pushEnabled = prefs.getBoolean(PrefPushEnabled, false),
        ),
    )

    val uiState: StateFlow<FoundationUiState> = _uiState.asStateFlow()

    init {
        if (initialSession != null) {
            connectSocket()
            startMessageStream()
        }
    }

    fun setAuthMode(mode: AuthMode) = _uiState.update { state -> state.copy(authMode = mode, authError = null) }
    fun setDisplayName(displayName: String) = _uiState.update { state -> state.copy(displayName = displayName) }
    fun setHandle(handle: String) = _uiState.update { state -> state.copy(handle = handle) }
    fun setPassword(password: String) = _uiState.update { state -> state.copy(password = password) }
    fun setDraft(draft: String) {
        _uiState.update { state -> state.copy(draft = draft) }
        scheduleTypingPing(draft)
    }
    fun setNewThreadTitle(title: String) = _uiState.update { state -> state.copy(newThreadTitle = title, threadError = null) }

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

    fun setThreadListVisible(visible: Boolean) =
        _uiState.update { state -> state.copy(threadListVisible = visible, inspectorVisible = if (visible) false else state.inspectorVisible) }

    fun backToThreads() = _uiState.update { state -> state.copy(threadListVisible = true, inspectorVisible = false) }
    fun setInspectorVisible(visible: Boolean) = _uiState.update { state -> state.copy(inspectorVisible = visible) }
    fun toggleInspector() = _uiState.update { state -> state.copy(inspectorVisible = !state.inspectorVisible) }
    fun showSyncDialog() = _uiState.update { state -> state.copy(syncDialogVisible = true) }
    fun dismissSyncDialog() = _uiState.update { state -> state.copy(syncDialogVisible = false) }

    fun setPushEnabled(enabled: Boolean) {
        val session = _uiState.value.session ?: return
        _uiState.update { state -> state.copy(pushBusy = true) }
        viewModelScope.launch {
            try {
                if (enabled) {
                    val token = UUID.randomUUID().toString()
                    val result = FrickDemoHttp.registerPush(
                        session = session,
                        deviceId = DemoDeviceId,
                        platform = "fcm",
                        token = token,
                    )
                    if (result != null) {
                        prefs.edit {
                            putString(PrefPushRegistrationId, result.registrationId)
                            putBoolean(PrefPushEnabled, true)
                        }
                        _uiState.update { state -> state.copy(pushEnabled = true, status = "Push registered") }
                    } else {
                        _uiState.update { state -> state.copy(status = "Push register failed") }
                    }
                } else {
                    val id = prefs.getString(PrefPushRegistrationId, null)
                    val ok = if (id != null) FrickDemoHttp.unregisterPush(session, id) else true
                    prefs.edit {
                        remove(PrefPushRegistrationId)
                        putBoolean(PrefPushEnabled, false)
                    }
                    _uiState.update { state ->
                        state.copy(
                            pushEnabled = false,
                            status = if (ok) "Push unregistered" else "Push unregister failed",
                        )
                    }
                }
            } finally {
                _uiState.update { state -> state.copy(pushBusy = false) }
            }
        }
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
            state.copy(authMode = AuthMode.SignUp, displayName = demoName, handle = demoHandle, password = demoPassword)
        }
        authenticate(
            requestedMode = AuthMode.SignUp,
            requestedDisplayName = demoName,
            requestedHandle = demoHandle,
            requestedPassword = demoPassword,
        )
    }

    fun reload() {
        viewModelScope.launch { reloadMessages() }
    }

    fun send() {
        val body = _uiState.value.draft.trim()
        if (body.isEmpty()) return
        val convoId = _uiState.value.selectedConversationId
        val senderId = _uiState.value.session?.userId ?: return
        _uiState.update { state -> state.copy(draft = "", status = "Sending") }
        // Stop the typing hint as soon as the user commits a message —
        // mirrors the iOS demo's `setTyping(false)` post-send call.
        scheduleTypingPing(draft = "")
        viewModelScope.launch {
            val current = socket
            try {
                if (current != null && current.status.value is FrickSyncStatus.Ready) {
                    current.append(
                        stream = "MessageStream",
                        key = convoId,
                        event = "MessageSent",
                        payload = mapOf(
                            "messageId" to "message-${UUID.randomUUID()}",
                            "senderId" to senderId,
                            "body" to body,
                            "createdAt" to Instant.now().toString(),
                        ),
                    )
                    _uiState.update { state -> state.copy(status = "Sent (ws)") }
                } else {
                    frick.sendMessage(conversationId = convoId, body = body)
                    _uiState.update { state -> state.copy(status = "Sent (http)") }
                }
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
                current.copy(threadError = if (current.newThreadKind == NewThreadKind.Direct) "Choose one person." else "Choose people and a title.")
            }
            return
        }
        _uiState.update { it.copy(isCreatingThread = true, threadError = null, status = "Creating thread") }
        viewModelScope.launch {
            try {
                val created = frick.createConversation(
                    title = if (state.newThreadKind == NewThreadKind.Group) title else null,
                    kind = state.newThreadKind.wireKind,
                    participantUserIds = state.newThreadParticipantIds,
                )
                _uiState.update { current ->
                    current.copy(
                        conversations = mergeConversations(current.conversations, created.conversation),
                        roomMembers = mergeRoomMembers(current.roomMembers, created.members),
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
                _uiState.update { current ->
                    current.copy(
                        newThreadTitle = title,
                        threadError = "Could not create thread.",
                        status = error.localizedMessage ?: "Thread create failed",
                    )
                }
            } finally {
                _uiState.update { current -> current.copy(isCreatingThread = false) }
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
                typingUserIds = if (conversationId == previousConversationId) state.typingUserIds else emptyList(),
            )
        }
        if (conversationId != previousConversationId) {
            startMessageStream()
        }
    }

    fun logout() {
        val session = _uiState.value.session
        val registrationId = prefs.getString(PrefPushRegistrationId, null)
        streamJob?.cancel(); streamJob = null
        closeSocket()
        _uiState.update { state -> state.copy(status = "Signing out", pushBusy = registrationId != null) }
        viewModelScope.launch {
            if (session != null && registrationId != null) {
                FrickDemoHttp.unregisterPush(session, registrationId)
            }
            prefs.edit {
                remove(PrefPushRegistrationId)
                putBoolean(PrefPushEnabled, false)
            }
            FrickSyncWorker.cancel(getApplication())
            frick.signOut()
            _uiState.value = FoundationUiState()
        }
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
                        identity = normalizedHandle, password = requestedPassword,
                        deviceId = DemoDeviceId, replicaId = DemoReplicaId, platform = DemoPlatform,
                    )
                    AuthMode.SignUp -> frick.signUp(
                        displayName = normalizedDisplayName, handle = normalizedHandle, password = requestedPassword,
                        deviceId = DemoDeviceId, replicaId = DemoReplicaId, platform = DemoPlatform,
                    )
                }
                _uiState.update { state ->
                    state.copy(session = nextSession, password = "", status = "Signed in", threadListVisible = true)
                }
                connectSocket()
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
                    users = users, conversations = conversations, roomMembers = roomMembers,
                    selectedConversationId = selectedConversationId, messages = messages, status = "Loaded",
                )
            }
        } catch (error: Exception) {
            _uiState.update { state -> state.copy(status = error.localizedMessage ?: "Load failed") }
        }
    }

    // WebSocket sync socket lifecycle. FrickSyncSocket negotiates a HelloAck
    // and then exposes subscribe/append/upsert plus an `events` flow. Live
    // stream events arrive as `FrickInboundEvent.Delta` carrying named-field
    // maps decoded from the wire's PackedStreamEvent tuples via the generated
    // FRICK_* descriptor tables. SSE streamMessages() is still used for the
    // initial cold-start (history backfill), but live updates flow over WS.
    private fun connectSocket() {
        val session = _uiState.value.session ?: return
        if (socket != null) return
        val newSocket = frick.connectSync(baseUrl = DemoBaseUrl)
        socket = newSocket
        _socketFlow.value = newSocket
        newSocket.connect()
        socketStatusJob = viewModelScope.launch {
            newSocket.status.collect { status ->
                val ui = mapSyncStatus(status)
                _uiState.update { state -> state.copy(sync = ui) }
            }
        }
        socketEventsJob = viewModelScope.launch {
            newSocket.events.collect { event -> handleInboundEvent(event) }
        }
        // No explicit subscribe(stream) / subscribeProjection(typing) here:
        // `ChatLiveWiring` in MainActivity uses `rememberFrickStreamEvents`
        // and `rememberFrickProjection`, which subscribe lazily when the
        // chat composable mounts and re-bind on convo switch.
        @Suppress("UNUSED_VARIABLE") val ref = session
    }

    private fun closeSocket() {
        socketStatusJob?.cancel(); socketStatusJob = null
        socketEventsJob?.cancel(); socketEventsJob = null
        typingJob?.cancel(); typingJob = null
        socket?.close(); socket = null
        _socketFlow.value = null
        _uiState.update { state -> state.copy(sync = SyncStatusUi(SyncIndicator.Red, "Disconnected")) }
    }

    private fun mapSyncStatus(status: FrickSyncStatus): SyncStatusUi =
        when (status) {
            is FrickSyncStatus.Ready -> SyncStatusUi(SyncIndicator.Green, "Connected")
            FrickSyncStatus.Connecting, FrickSyncStatus.HelloSent ->
                SyncStatusUi(SyncIndicator.Yellow, "Connecting")
            FrickSyncStatus.Disconnected -> SyncStatusUi(SyncIndicator.Red, "Disconnected")
            is FrickSyncStatus.Failed -> SyncStatusUi(
                indicator = SyncIndicator.Red,
                description = "Failed",
                lastErrorCode = "sync.failure",
                lastErrorMessage = status.reason,
            )
        }

    private fun handleInboundEvent(event: FrickInboundEvent) {
        when (event) {
            // FrickInboundEvent.Delta and ProjectionDelta are consumed by
            // the chat composable via `rememberFrickStreamEvents` and
            // `rememberFrickProjection`, which call back into
            // [ingestStreamEvents] / [applyTypingUsers] below.
            is FrickInboundEvent.Nack -> {
                _uiState.update { state ->
                    state.copy(
                        sync = state.sync.copy(
                            lastErrorCode = event.error.code,
                            lastErrorMessage = event.error.message,
                        ),
                    )
                }
            }
            else -> Unit
        }
    }

    /**
     * Called by the chat composable's `rememberFrickStreamEvents`
     * wrapper. Merges the wrapper's accumulated live tail into the
     * cold-start history that [startMessageStream] loaded over SSE.
     * The wrapper already de-dupes by `eventId` and sorts by `sequence`;
     * we re-do the merge here to combine across the two sources.
     */
    fun ingestStreamEvents(events: List<FrickStreamEvent>) {
        if (events.isEmpty()) return
        _uiState.update { state ->
            val combined = (state.messages + events)
                .distinctBy { e -> e.eventId }
                .sortedBy { e -> e.sequence }
            state.copy(messages = combined, status = "Live")
        }
    }

    /**
     * Called by the chat composable's `rememberFrickProjection`
     * wrapper for `TypingState/{conversationId}`. The wrapper returns
     * a `Map<key, row?>` of the projection; this VM filters out the
     * local user and stores the resulting user-id list for the UI.
     */
    fun applyTypingUsers(rows: Map<String, Map<String, Any?>?>) {
        val selfId = _uiState.value.session?.userId
        val typing = rows.values
            .filterNotNull()
            .mapNotNull { row -> row["userId"]?.toString() }
            .filter { id -> id != selfId }
            .distinct()
        _uiState.update { state -> state.copy(typingUserIds = typing) }
    }

    private fun scheduleTypingPing(draft: String) {
        val active = _uiState.value.session ?: return
        val current = socket ?: return
        val convoId = _uiState.value.selectedConversationId
        // Mirrors the iOS demo's typing key shape so the server's
        // TypingState projection rows from web / iOS / Android all
        // collapse to the same `(convo, user, device)` triple.
        val key = "$convoId:${active.userId}:$DemoDeviceId"
        if (draft.isBlank()) {
            typingJob?.cancel()
            typingJob = viewModelScope.launch {
                try { current.clearPresence(name = "TypingState", key = key) } catch (_: Exception) {}
            }
            return
        }
        if (typingJob?.isActive == true) return
        typingJob = viewModelScope.launch {
            try {
                current.setPresence(
                    name = "TypingState",
                    key = key,
                    value = mapOf(
                        "isTyping" to true,
                        "conversationId" to convoId,
                        "userId" to active.userId,
                        "deviceId" to DemoDeviceId,
                    ),
                )
                delay(TypingDebounceMs)
            } catch (_: CancellationException) {
                throw CancellationException("typing cancelled")
            } catch (_: Exception) {
                // best-effort — presence is a hint, not authoritative.
            }
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
                    state.copy(users = users, conversations = conversations, roomMembers = roomMembers, selectedConversationId = selectedConversationId)
                }
                frick.streamMessages(conversationId = selectedConversationId, readUserId = connectedSession.userId).collect { nextMessages ->
                    _uiState.update { state -> state.copy(messages = nextMessages, status = "Live") }
                    advanceReceiptOverSocket(selectedConversationId, connectedSession.userId, nextMessages)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                _uiState.update { state -> state.copy(status = error.localizedMessage ?: "Sync failed") }
            }
        }
    }

    private var lastReceiptSequence: Int = 0

    private fun advanceReceiptOverSocket(
        conversationId: String,
        userId: String,
        messages: List<FrickStreamEvent>,
    ) {
        val current = socket ?: return
        if (current.status.value !is FrickSyncStatus.Ready) return
        val sequence = messages
            .filterNot { event -> event.event == "ReceiptAdvanced" }
            .maxOfOrNull { event -> event.sequence } ?: 0
        if (sequence <= lastReceiptSequence) return
        lastReceiptSequence = sequence
        viewModelScope.launch {
            try {
                current.append(
                    stream = "MessageStream",
                    key = conversationId,
                    event = "ReceiptAdvanced",
                    payload = mapOf(
                        "userId" to userId,
                        "sequence" to sequence,
                    ),
                )
            } catch (_: Exception) {
                // best-effort — FrickClient.streamMessages already issues an HTTP receipt
            }
        }
    }

    override fun onCleared() {
        streamJob?.cancel()
        closeSocket()
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
