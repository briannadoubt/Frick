package dev.frick.client

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * FR-15 (FR-80 / FR-82) — Android call control-plane client.
 *
 * Kotlin parity with the TypeScript reference (`packages/core/src/calls.ts`):
 * thin suspend verbs over [FrickSyncSocket.callCommand] (issuing `CallCommand`
 * frames, correlating the `CallCommandResult` / `Nack` reply by requestId) plus
 * an observable [StateFlow]<[CallState]> composed from the synced `CallRoom` +
 * `CallParticipant` object records. Mirrors the [FrickSessionManager] /
 * [FrickSharingService] / [FrickObservableStore] idioms (immutable data +
 * StateFlow, suspend verbs).
 *
 * The control plane is server-authoritative: these verbs only issue commands
 * and read back the synced records — they never mutate call state locally.
 * Media (SDP/ICE) is out of scope: it rides the existing `SignalSend` /
 * `SignalDeliver` relay. The [CallMediaGrant] returned by [join] is what the
 * caller hands to its media (WebRTC/SFU) layer to actually connect.
 */

// -- object type names (mirror the server schema + TS CALL_*_TYPE) -----------

/** Object type name for the synced call-room record. */
public const val CALL_ROOM_TYPE: String = "CallRoom"

/** Object type name for the synced call-invite record. */
public const val CALL_INVITE_TYPE: String = "CallInvite"

/** Object type name for the synced call-participant record. */
public const val CALL_PARTICIPANT_TYPE: String = "CallParticipant"

// -- record value types (mirror packages/protocol/src/calls.ts) --------------

/** Audio-only vs audio+video call (FR-79). */
public enum class CallKind(public val wire: String) {
    Audio("audio"),
    Video("video");

    public companion object {
        public fun fromWire(value: String?): CallKind =
            entries.firstOrNull { it.wire == value } ?: Audio
    }
}

/** Lifecycle states a [CallRoomRecord] moves through. */
public enum class CallRoomState(public val wire: String) {
    Ringing("ringing"),
    Active("active"),
    Ended("ended");

    public companion object {
        public fun fromWire(value: String?): CallRoomState =
            entries.firstOrNull { it.wire == value } ?: Ringing
    }
}

/** Lifecycle states a [CallInviteRecord] moves through. */
public enum class CallInviteState(public val wire: String) {
    Ringing("ringing"),
    Accepted("accepted"),
    Declined("declined"),
    Cancelled("cancelled");

    public companion object {
        public fun fromWire(value: String?): CallInviteState =
            entries.firstOrNull { it.wire == value } ?: Ringing
    }
}

/** Lifecycle states a [CallParticipantRecord] moves through. */
public enum class CallParticipantState(public val wire: String) {
    Joined("joined"),
    Left("left");

    public companion object {
        public fun fromWire(value: String?): CallParticipantState =
            entries.firstOrNull { it.wire == value } ?: Joined
    }
}

/** Coarse network-quality bucket surfaced on the participant model (FR-82). */
public enum class CallNetworkQuality(public val wire: String) {
    Unknown("unknown"),
    Poor("poor"),
    Fair("fair"),
    Good("good"),
    Excellent("excellent");

    public companion object {
        public fun fromWire(value: String?): CallNetworkQuality =
            entries.firstOrNull { it.wire == value } ?: Unknown
    }
}

/** Server-authoritative call room record. Mirrors the protocol `CallRoomRecord`. */
public data class CallRoomRecord(
    public val id: String,
    public val conversationId: String,
    public val state: CallRoomState,
    public val createdBy: String,
    public val kind: CallKind,
    public val createdAt: String,
    public val startedAt: String? = null,
    public val endedAt: String? = null,
    public val mediaSessionId: String? = null,
    public val transport: String? = null,
)

/** Server-authoritative invite record. Mirrors the protocol `CallInviteRecord`. */
public data class CallInviteRecord(
    public val id: String,
    public val callId: String,
    public val inviteeUserId: String,
    public val status: CallInviteState,
    public val invitedBy: String,
    public val invitedAt: String,
    public val respondedAt: String? = null,
)

/**
 * Server-authoritative participant record. Mirrors the protocol
 * `CallParticipantRecord`, carrying the FR-82 per-participant presence surface
 * (mic / camera / screen-share, plus optional `speaking` / `networkQuality`).
 */
public data class CallParticipantRecord(
    public val id: String,
    public val callId: String,
    public val userId: String,
    public val deviceId: String,
    public val state: CallParticipantState,
    public val joinedAt: String,
    public val leftAt: String? = null,
    public val micEnabled: Boolean,
    public val cameraEnabled: Boolean,
    public val screenSharing: Boolean,
    /** FR-82: whether the participant is currently detected as speaking. */
    public val speaking: Boolean? = null,
    /** FR-82: coarse network-quality bucket for this participant's media link. */
    public val networkQuality: CallNetworkQuality? = null,
)

/**
 * A short-lived, participant-scoped credential the client presents to the media
 * plane to join the actual media session (FR-78). Mirrors `CallMediaGrant`.
 */
public data class CallMediaGrant(
    public val callId: String,
    public val mediaSessionId: String,
    public val userId: String,
    public val deviceId: String,
    public val token: String,
    public val expiresAt: String,
    public val connection: Map<String, String> = emptyMap(),
)

/** Partial media-state mutation for the `setMediaState` command (FR-82). */
public data class CallMediaStatePatch(
    public val micEnabled: Boolean? = null,
    public val cameraEnabled: Boolean? = null,
    public val screenSharing: Boolean? = null,
)

// -- command results ----------------------------------------------------------

/** Result of [FrickCallManager.create]: the new room + per-invitee invites. */
public data class CreateCallResult(
    public val room: CallRoomRecord,
    public val invites: List<CallInviteRecord>,
)

/** Result of [FrickCallManager.join]: room + your participant + media grant. */
public data class JoinCallResult(
    public val room: CallRoomRecord,
    public val participant: CallParticipantRecord,
    public val mediaGrant: CallMediaGrant,
)

// -- observable call state (FR-82) -------------------------------------------

/**
 * FR-82 — the per-participant presence surface a call UI renders: identity plus
 * mic / camera / screen-share, the live `speaking` flag, and a coarse
 * `networkQuality` bucket. `mic`/`camera`/`screenSharing` come straight off the
 * server-authoritative participant record; `speaking`/`networkQuality` are
 * carried on the same record when a media adapter reports them (defaulting to
 * `false` / [CallNetworkQuality.Unknown]).
 */
public data class CallParticipantPresence(
    public val userId: String,
    public val deviceId: String,
    public val state: CallParticipantState,
    public val micEnabled: Boolean,
    public val cameraEnabled: Boolean,
    public val screenSharing: Boolean,
    public val speaking: Boolean,
    public val networkQuality: CallNetworkQuality,
)

/**
 * Immutable, observable view of a single call: the room record, every
 * participant's presence, and convenience flags. A `null` [room] means the call
 * isn't known to this client yet (not synced, or wrong id). Kotlin analogue of
 * the TS `CallState`; collect off [FrickCallManager.state] with Compose
 * `collectAsState()`.
 */
public data class CallState(
    public val callId: String,
    public val room: CallRoomRecord? = null,
    public val participants: List<CallParticipantPresence> = emptyList(),
) {
    public val isActive: Boolean get() = room?.state == CallRoomState.Active
    public val isEnded: Boolean get() = room?.state == CallRoomState.Ended
}

// -- record decoding off the `{ type, id, value }` record shape --------------

internal fun decodeCallRoom(record: Map<String, Any?>): CallRoomRecord? {
    val value = record.mapField("value") ?: return null
    val id = value.stringField("id") ?: record.stringField("id") ?: return null
    return CallRoomRecord(
        id = id,
        conversationId = value.stringField("conversationId") ?: return null,
        state = CallRoomState.fromWire(value.stringField("state")),
        createdBy = value.stringField("createdBy") ?: "",
        kind = CallKind.fromWire(value.stringField("kind")),
        createdAt = value.stringField("createdAt") ?: "",
        startedAt = value.stringField("startedAt"),
        endedAt = value.stringField("endedAt"),
        mediaSessionId = value.stringField("mediaSessionId"),
        transport = value.stringField("transport"),
    )
}

internal fun decodeCallInvite(record: Map<String, Any?>): CallInviteRecord? {
    val value = record.mapField("value") ?: return null
    val id = value.stringField("id") ?: record.stringField("id") ?: return null
    return CallInviteRecord(
        id = id,
        callId = value.stringField("callId") ?: return null,
        inviteeUserId = value.stringField("inviteeUserId") ?: "",
        status = CallInviteState.fromWire(value.stringField("status")),
        invitedBy = value.stringField("invitedBy") ?: "",
        invitedAt = value.stringField("invitedAt") ?: "",
        respondedAt = value.stringField("respondedAt"),
    )
}

internal fun decodeCallParticipant(record: Map<String, Any?>): CallParticipantRecord? {
    val value = record.mapField("value") ?: return null
    val id = value.stringField("id") ?: record.stringField("id") ?: return null
    return CallParticipantRecord(
        id = id,
        callId = value.stringField("callId") ?: return null,
        userId = value.stringField("userId") ?: "",
        deviceId = value.stringField("deviceId") ?: "",
        state = CallParticipantState.fromWire(value.stringField("state")),
        joinedAt = value.stringField("joinedAt") ?: "",
        leftAt = value.stringField("leftAt"),
        micEnabled = value["micEnabled"] == true,
        cameraEnabled = value["cameraEnabled"] == true,
        screenSharing = value["screenSharing"] == true,
        speaking = value["speaking"] as? Boolean,
        networkQuality = (value["networkQuality"] as? String)?.let(CallNetworkQuality::fromWire),
    )
}

private fun decodeMediaGrant(raw: Map<String, Any?>): CallMediaGrant? {
    return CallMediaGrant(
        callId = raw.stringField("callId") ?: return null,
        mediaSessionId = raw.stringField("mediaSessionId") ?: "",
        userId = raw.stringField("userId") ?: "",
        deviceId = raw.stringField("deviceId") ?: "",
        token = raw.stringField("token") ?: "",
        expiresAt = raw.stringField("expiresAt") ?: "",
        connection = asStringMap(raw["connection"])
            ?.mapValues { (_, v) -> v?.toString() ?: "" }
            ?: emptyMap(),
    )
}

private fun CallParticipantRecord.toPresence(): CallParticipantPresence =
    CallParticipantPresence(
        userId = userId,
        deviceId = deviceId,
        state = state,
        micEnabled = micEnabled,
        cameraEnabled = cameraEnabled,
        screenSharing = screenSharing,
        speaking = speaking ?: false,
        networkQuality = networkQuality ?: CallNetworkQuality.Unknown,
    )

/**
 * Observable, stateful call layer over [FrickSyncSocket] — Android parity with
 * the TS `callCommand()` verbs + `callState()`.
 *
 * Construct one per call (`callId`) and [start] it: it subscribes to the
 * `CallRoom` + `CallParticipant` object types and composes them into the live
 * [state] StateFlow. The suspend verbs ([create] / [join] / [accept] / [leave] /
 * [end] / [setMediaState]) issue `CallCommand` frames and return the decoded
 * result; a server `Nack` surfaces as a [FrickHttpException].
 *
 * Records also arrive over sync, so [state] updates on its own as the server
 * fans out joins / mutes / leaves / end — the verbs do not mutate it locally.
 */
public class FrickCallManager(
    private val socket: FrickSyncSocket,
    public val callId: String,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) : AutoCloseable {

    private val lock = Any()
    // Latest room record keyed by id, and participants keyed by participant id.
    private var room: CallRoomRecord? = null
    private val participants = LinkedHashMap<String, CallParticipantRecord>()

    private val _state = MutableStateFlow(CallState(callId = callId))

    /** The live call state. Collect with Compose `collectAsState()`. */
    public val state: StateFlow<CallState> = _state.asStateFlow()

    @Volatile private var collectJob: Job? = null
    @Volatile private var statusJob: Job? = null
    @Volatile private var started = false
    @Volatile private var lastReady = false
    @Volatile private var closed = false

    /**
     * Begin syncing: subscribe to the `CallRoom` + `CallParticipant` object
     * types and start composing [state] off inbound deltas. Idempotent. Drives
     * (re)subscription off the socket's Ready transitions so a reconnect replays
     * fresh snapshots, matching [FrickObservableStore].
     */
    public fun start() {
        if (closed) return
        synchronized(lock) {
            if (started) return
            started = true
        }
        collectJob = scope.launch {
            socket.events.collect { event -> onEvent(event) }
        }
        statusJob = scope.launch {
            socket.status.collect { status ->
                val ready = status is FrickSyncStatus.Ready
                if (ready && !lastReady) {
                    socket.subscribeObject(CALL_ROOM_TYPE)
                    socket.subscribeObject(CALL_PARTICIPANT_TYPE)
                }
                lastReady = ready
            }
        }
        socket.connect()
    }

    /**
     * Apply a single inbound event to the composed state. Internal seam used by
     * the live collector ([start]) and exercised directly by unit tests that
     * inject [FrickInboundEvent.Delta]s without standing up a socket.
     */
    internal fun onEvent(event: FrickInboundEvent) {
        when (event) {
            is FrickInboundEvent.Delta -> applyDelta(event)
            else -> Unit
        }
    }

    private fun applyDelta(delta: FrickInboundEvent.Delta) {
        var changed = false
        synchronized(lock) {
            for (record in delta.objects) {
                when (record.stringField("type")) {
                    CALL_ROOM_TYPE -> {
                        val decoded = decodeCallRoom(record) ?: continue
                        if (decoded.id == callId) {
                            room = decoded
                            changed = true
                        }
                    }
                    CALL_PARTICIPANT_TYPE -> {
                        val decoded = decodeCallParticipant(record) ?: continue
                        if (decoded.callId == callId) {
                            participants[decoded.id] = decoded
                            changed = true
                        }
                    }
                }
            }
            for (removal in delta.removed) {
                when (removal.type) {
                    CALL_ROOM_TYPE -> if (removal.id == callId && room != null) {
                        room = null
                        changed = true
                    }
                    CALL_PARTICIPANT_TYPE -> if (participants.remove(removal.id) != null) {
                        changed = true
                    }
                }
            }
        }
        if (changed) publish()
    }

    private fun publish() {
        val snapshot = synchronized(lock) {
            CallState(
                callId = callId,
                room = room,
                // Stable order so UIs don't reshuffle tiles on every delta.
                participants = participants.values
                    .map { it.toPresence() }
                    .sortedWith(
                        compareBy({ it.userId }, { it.deviceId }),
                    ),
            )
        }
        _state.value = snapshot
    }

    // MARK: - Command verbs (mirror TS createCall/joinCall/... )

    /**
     * Create a call in [conversationId], inviting [inviteeUserIds] (must exclude
     * the caller). Returns the freshly-created room (state `ringing`) and the
     * per-invitee invites.
     */
    public suspend fun create(
        conversationId: String,
        inviteeUserIds: List<String>,
        kind: CallKind? = null,
        regionHint: String? = null,
    ): CreateCallResult {
        val command = buildMap<String, Any?> {
            put("op", "create")
            put("conversationId", conversationId)
            put("inviteeUserIds", inviteeUserIds)
            kind?.let { put("kind", it.wire) }
            regionHint?.let { put("regionHint", it) }
        }
        val result = issue(command)
        val room = result.mapField("room")?.let(::wrapValue)?.let(::decodeCallRoom)
            ?: error("create result missing room")
        val invites = (result.listField("invites") ?: emptyList())
            .mapNotNull { asStringMap(it)?.let(::wrapValue)?.let(::decodeCallInvite) }
        return CreateCallResult(room, invites)
    }

    /**
     * Join a call. Returns the (now `active`) room, your participant record, and
     * the [CallMediaGrant] to present to the media layer. Joining implicitly
     * accepts a still-ringing invite.
     */
    public suspend fun join(callId: String = this.callId): JoinCallResult {
        val result = issue(mapOf("op" to "join", "callId" to callId))
        val room = result.mapField("room")?.let(::wrapValue)?.let(::decodeCallRoom)
            ?: error("join result missing room")
        val participant = result.mapField("participant")?.let(::wrapValue)?.let(::decodeCallParticipant)
            ?: error("join result missing participant")
        val grant = result.mapField("mediaGrant")?.let(::decodeMediaGrant)
            ?: error("join result missing mediaGrant")
        return JoinCallResult(room, participant, grant)
    }

    /** Accept a ringing invite without joining yet. */
    public suspend fun accept(callId: String = this.callId): CallInviteRecord {
        val result = issue(mapOf("op" to "accept", "callId" to callId))
        return result.mapField("invite")?.let(::wrapValue)?.let(::decodeCallInvite)
            ?: error("accept result missing invite")
    }

    /** Leave a call. The last active participant leaving auto-ends the call. */
    public suspend fun leave(callId: String = this.callId): CallRoomRecord {
        val result = issue(mapOf("op" to "leave", "callId" to callId))
        return result.mapField("room")?.let(::wrapValue)?.let(::decodeCallRoom)
            ?: error("leave result missing room")
    }

    /** End a call. Only the creator may end it explicitly. */
    public suspend fun end(callId: String = this.callId): CallRoomRecord {
        val result = issue(mapOf("op" to "end", "callId" to callId))
        return result.mapField("room")?.let(::wrapValue)?.let(::decodeCallRoom)
            ?: error("end result missing room")
    }

    /**
     * Update your own media state (mic / camera / screen-share) — the FR-82
     * call-presence surface. Returns the updated participant record.
     */
    public suspend fun setMediaState(
        media: CallMediaStatePatch,
        callId: String = this.callId,
    ): CallParticipantRecord {
        val patch = buildMap<String, Any?> {
            media.micEnabled?.let { put("micEnabled", it) }
            media.cameraEnabled?.let { put("cameraEnabled", it) }
            media.screenSharing?.let { put("screenSharing", it) }
        }
        val result = issue(mapOf("op" to "setMediaState", "callId" to callId, "media" to patch))
        return result.mapField("participant")?.let(::wrapValue)?.let(::decodeCallParticipant)
            ?: error("setMediaState result missing participant")
    }

    private suspend fun issue(command: Map<String, Any?>): Map<String, Any?> =
        when (val r = socket.callCommand(command)) {
            is CallCommandResult.Ok -> r.result
            is CallCommandResult.Failed -> throw FrickHttpException(
                statusCode = 0,
                envelope = r.envelope,
                responseBody = "",
                message = r.envelope.message,
            )
        }

    override fun close() {
        if (closed) return
        closed = true
        collectJob?.cancel()
        statusJob?.cancel()
        scope.cancel()
    }
}

/**
 * Wrap a flat record map (as it arrives inline in a CallCommandResult — the
 * record's own fields at top level) into the `{ value: ... }` shape the
 * `decodeCall*` decoders expect (mirroring the `{ type, id, value }` sync record
 * shape). Inline command results carry the record fields directly, whereas the
 * sync delta path nests them under `value` — this adapts the former to the
 * shared decoder.
 */
private fun wrapValue(flat: Map<String, Any?>): Map<String, Any?> =
    mapOf("id" to flat["id"], "value" to flat)

/** Narrow an untyped wire value to a string-keyed map, or null. */
@Suppress("UNCHECKED_CAST")
private fun asStringMap(raw: Any?): Map<String, Any?>? = raw as? Map<String, Any?>
