package dev.frick.client

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URI
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.msgpack.core.MessagePack
import org.msgpack.core.MessagePacker
import org.msgpack.core.MessageUnpacker
import org.msgpack.value.ValueType

// FrickSyncSocket: WebSocket transport for the Android SDK.
//
// Codec choice: org.msgpack:msgpack-core (low-level packer/unpacker). The wire
// payloads use the [FrameKind, payload] 2-tuple shape from
// packages/protocol/src/frame.ts; manual encode/decode of plain Map/List/Number
// values is straightforward and avoids pulling in jackson-dataformat-msgpack.

/** Public-facing connection status of [FrickSyncSocket]. */
sealed class FrickSyncStatus {
    object Disconnected : FrickSyncStatus()
    object Connecting : FrickSyncStatus()
    /** WebSocket open, Hello sent, awaiting HelloAck. */
    object HelloSent : FrickSyncStatus()
    /** HelloAck received and capabilities negotiated. */
    data class Ready(
        val schemaHash: String,
        val schemaId: String,
        val schemaRevision: Int,
    ) : FrickSyncStatus()
    data class Failed(val reason: String) : FrickSyncStatus()
}

/** Typed inbound events fanned out via [FrickSyncSocket.events]. */
sealed class FrickInboundEvent {
    data class Ack(val requestId: String, val cursor: Int?, val version: Int?) : FrickInboundEvent()
    data class Nack(val requestId: String, val error: FrickErrorEnvelope) : FrickInboundEvent()
    data class Delta(
        val objects: List<Map<String, Any?>>,
        val events: List<Map<String, Any?>>,
        val cursor: Int,
        /**
         * Object removals (FR-142/FR-144). Populated when a Delta frame carries
         * a `removed` list so consumers can drop the deleted rows directly
         * without a refetch. The server also emits a back-compat tombstone
         * record in `objects`; apply removals after upserts so a delete wins
         * over its own tombstone. Defaults to empty for back-compat.
         */
        val removed: List<ObjectRemoval> = emptyList(),
    ) : FrickInboundEvent()
    data class ProjectionDelta(val projection: String, val changes: List<ProjectionChange>) : FrickInboundEvent()
    data class ObjectUpsertResult(val requestId: String, val version: Int) : FrickInboundEvent()
    /**
     * FR-15 — the server's reply to a [FrameKindCodes.CALL_COMMAND] frame
     * (`CallCommandResult`, kind 22). [op] echoes the issued command op; [result]
     * is the raw decoded payload map (`room` / `invites` / `participant` /
     * `mediaGrant` / `invite`), left untyped here so the call client layer
     * (`FrickCallManager`) owns the record decoding. Correlated to the issuing
     * verb by [requestId]; failures arrive as a [Nack] keyed by the same id.
     */
    data class CallCommandResult(
        val requestId: String,
        val op: String,
        val result: Map<String, Any?>,
    ) : FrickInboundEvent()
    data class Schema(val raw: Map<String, Any?>) : FrickInboundEvent()
    data class SyncStatus(val connected: Boolean, val cursors: Map<String, Int>, val inFlight: Int) : FrickInboundEvent()
    object Disconnected : FrickInboundEvent()
    /**
     * Presence broadcast from the server. `records` carries the live
     * presence rows for the subscription, `cleared` lists keys whose
     * leases were revoked. Each record is shaped `{ type, key, value }`
     * after the wire's PackedPresenceRecord tuple is decoded via the
     * generated [FRICK_OBJECT_NAMES] / field tables.
     */
    data class PresenceDelta(val name: String, val records: List<Map<String, Any?>>, val cleared: List<String>) : FrickInboundEvent()
}

data class ProjectionChange(val key: String, val value: Map<String, Any?>?)

/**
 * A single object removal carried in a Delta frame's `removed` list
 * (FR-142/FR-144). Identifies the deleted row by its object [type] and [id] so
 * consumers can drop it directly without a refetch.
 */
data class ObjectRemoval(val type: String, val id: String)

internal sealed class ObjectWriteResult {
    data class Ok(val version: Int) : ObjectWriteResult()
    data class Failed(val envelope: FrickErrorEnvelope) : ObjectWriteResult()
}

/**
 * FR-15 — the awaited outcome of a [FrickSyncSocket.callCommand]: either the
 * decoded `CallCommandResult` payload ([op] + raw `result` map) or a server
 * [FrickErrorEnvelope] from a `Nack` keyed by the same requestId.
 */
internal sealed class CallCommandResult {
    data class Ok(val op: String, val result: Map<String, Any?>) : CallCommandResult()
    data class Failed(val envelope: FrickErrorEnvelope) : CallCommandResult()
}

/** Mirrors `FrameKind` values from packages/protocol/src/frame.ts. Numbers are wire-stable. */
internal object FrameKindCodes {
    const val HELLO = 0
    const val SCHEMA = 1
    const val SUBSCRIBE = 2
    const val SNAPSHOT = 3
    const val STREAM_PAGE = 4
    const val APPEND = 5
    const val ACK = 6
    const val NACK = 7
    const val DELTA = 8
    const val PRESENCE_SET = 9
    const val PRESENCE_CLEAR = 10
    const val PRESENCE_DELTA = 11
    const val SIGNAL_SEND = 12
    const val SIGNAL_DELIVER = 13
    const val CURSOR_COMMIT = 14
    const val PING = 15
    const val PONG = 16
    const val SYNC_STATUS = 17
    const val HELLO_ACK = 18
    const val PROJECTION_DELTA = 19
    const val OBJECT_UPSERT = 20
    const val CALL_COMMAND = 21
    const val CALL_COMMAND_RESULT = 22
}

/**
 * Map a wire frame-kind code to the label used in telemetry frame counters.
 * Mirrors the TypeScript `frameKindLabel` (which resolves `FrameKind[kind]`)
 * and the Swift parity: the PascalCase enum name, or `"unknown"` for codes
 * outside the enum. Keys identical across TS/Swift/Android so dashboards group.
 */
internal fun frickFrameKindLabel(kind: Int): String =
    when (kind) {
        FrameKindCodes.HELLO -> "Hello"
        FrameKindCodes.SCHEMA -> "Schema"
        FrameKindCodes.SUBSCRIBE -> "Subscribe"
        FrameKindCodes.SNAPSHOT -> "Snapshot"
        FrameKindCodes.STREAM_PAGE -> "StreamPage"
        FrameKindCodes.APPEND -> "Append"
        FrameKindCodes.ACK -> "Ack"
        FrameKindCodes.NACK -> "Nack"
        FrameKindCodes.DELTA -> "Delta"
        FrameKindCodes.PRESENCE_SET -> "PresenceSet"
        FrameKindCodes.PRESENCE_CLEAR -> "PresenceClear"
        FrameKindCodes.PRESENCE_DELTA -> "PresenceDelta"
        FrameKindCodes.SIGNAL_SEND -> "SignalSend"
        FrameKindCodes.SIGNAL_DELIVER -> "SignalDeliver"
        FrameKindCodes.CURSOR_COMMIT -> "CursorCommit"
        FrameKindCodes.PING -> "Ping"
        FrameKindCodes.PONG -> "Pong"
        FrameKindCodes.SYNC_STATUS -> "SyncStatus"
        FrameKindCodes.HELLO_ACK -> "HelloAck"
        FrameKindCodes.PROJECTION_DELTA -> "ProjectionDelta"
        FrameKindCodes.OBJECT_UPSERT -> "ObjectUpsert"
        FrameKindCodes.CALL_COMMAND -> "CallCommand"
        FrameKindCodes.CALL_COMMAND_RESULT -> "CallCommandResult"
        else -> "unknown"
    }

/**
 * Categorize a WebSocket close code for the `frick.ws.close_category` span
 * attribute and the connection-duration histogram label. Mirrors the
 * TypeScript `webSocketCloseCategory` and the Swift parity exactly.
 */
internal fun frickWebSocketCloseCategory(code: Int?): String =
    when (code) {
        1000 -> "normal"
        1001 -> "going_away"
        1002 -> "protocol_error"
        1003 -> "unsupported_data"
        1005 -> "no_status"
        1006 -> "abnormal"
        1007 -> "invalid_payload"
        1008 -> "policy_violation"
        1009 -> "too_large"
        1010 -> "mandatory_extension"
        1011 -> "internal_error"
        1012 -> "service_restart"
        1013 -> "try_again_later"
        1014 -> "bad_gateway"
        1015 -> "tls_handshake"
        else -> if (code != null && code in 4000..4999) "private" else "unknown"
    }

/**
 * Extract the URL path for the `url.path` span attribute, mirroring the
 * TypeScript `urlPath` helper: the parsed pathname, or `"/"` on failure.
 */
internal fun frickWebSocketUrlPath(url: String): String =
    runCatching {
        URI(url).path?.takeIf { it.isNotEmpty() } ?: "/"
    }.getOrDefault("/")

/** Build the default capability bundle the Android SDK advertises in Hello. */
fun defaultAndroidCapabilities(sdkVersion: String = "0.1.0"): Map<String, Any?> =
    mapOf(
        "platform" to "android",
        "sdkVersion" to sdkVersion,
        "schema" to mapOf(
            "schemaId" to FRICK_SCHEMA_ID,
            "schemaRevision" to FRICK_SCHEMA_REVISION,
            "schemaHash" to FRICK_SCHEMA_HASH,
        ),
        "transports" to listOf("websocket"),
        "encodings" to listOf("msgpack"),
        "primitives" to listOf("objects", "streams", "presence", "signals"),
        "offline" to mapOf("cache" to true, "pendingAppends" to true),
        "blobUploads" to listOf("direct"),
        "push" to emptyList<String>(),
        "experimental" to emptyList<String>(),
        "required" to emptyList<String>(),
    )

/**
 * Configuration knobs for the socket. Defaults are tuned for production but
 * tests inject smaller windows.
 */
data class FrickSyncSocketConfig(
    val replicaId: String = "android-demo",
    val deviceId: String = "android-device",
    val sdkVersion: String = "0.1.0",
    val initialBackoffMs: Long = 250,
    val maxBackoffMs: Long = 30_000,
    val pongTimeoutMs: Long = 10_000,
    val helloAckTimeoutMs: Long = 10_000,
)

internal fun buildSyncUrl(baseUrl: String): String {
    val trimmed = baseUrl.trim()
    val httpUrlText = when {
        trimmed.startsWith("wss://") -> "https://" + trimmed.removePrefix("wss://")
        trimmed.startsWith("ws://") -> "http://" + trimmed.removePrefix("ws://")
        trimmed.startsWith("https://") || trimmed.startsWith("http://") -> trimmed
        else -> "http://$trimmed"
    }
    val parsed = httpUrlText.toHttpUrl()
    val builder = parsed.newBuilder()
        .removeAllQueryParameters("sessionToken")

    val encodedPath = parsed.encodedPath.trimEnd('/')
    if (encodedPath.isEmpty()) {
        builder.encodedPath("/_frick/sync")
    } else if (!encodedPath.endsWith("/_frick/sync")) {
        builder.encodedPath("$encodedPath/_frick/sync")
    }

    val httpUrl = builder.build().toString()
    return when {
        httpUrl.startsWith("https://") -> "wss://" + httpUrl.removePrefix("https://")
        httpUrl.startsWith("http://") -> "ws://" + httpUrl.removePrefix("http://")
        else -> httpUrl
    }
}

// ----- msgpack encode/decode helpers -----

internal object FrickMsgPack {
    // Bounds on the decode path so a malicious/compromised server can't OOM or
    // stack-overflow the client with a single small frame (FR audit
    // native-android-4). A msgpack array/map/binary header declares its length
    // BEFORE the element bytes, so a tiny frame can claim e.g. ~2.1e9 entries and
    // trigger a huge backing-array allocation before any payload is read. We cap
    // the *pre-sized* allocation (collections then grow incrementally only if the
    // bytes really are there) and bound recursion depth.
    //
    // The caps are far above any legitimate frame: real Delta/Snapshot frames
    // carry on the order of hundreds of rows and shallow nesting.
    internal const val MAX_PRESIZE = 1 shl 16 // 65_536 entries pre-allocated
    internal const val MAX_BINARY_LENGTH = 16 * 1024 * 1024 // 16 MiB
    internal const val MAX_DEPTH = 64

    /** Raised when a frame's declared structure exceeds the decode safety bounds. */
    class DecodeBoundsException(message: String) : IllegalArgumentException(message)

    fun encodeFrame(kind: Int, payload: Map<String, Any?>): ByteArray {
        val out = ByteArrayOutputStream()
        MessagePack.newDefaultPacker(out).use { packer ->
            packer.packArrayHeader(2)
            packer.packInt(kind)
            packMap(packer, payload)
        }
        return out.toByteArray()
    }

    fun decodeFrame(bytes: ByteArray): Pair<Int, Map<String, Any?>>? {
        MessagePack.newDefaultUnpacker(ByteArrayInputStream(bytes)).use { unpacker ->
            if (!unpacker.hasNext()) return null
            val arity = unpacker.unpackArrayHeader()
            if (arity < 2) return null
            val kind = unpacker.unpackInt()
            @Suppress("UNCHECKED_CAST")
            val map = (unpackAny(unpacker, depth = 0) as? Map<String, Any?>) ?: emptyMap()
            return kind to map
        }
    }

    private fun packMap(packer: MessagePacker, value: Map<String, Any?>) {
        packer.packMapHeader(value.size)
        for ((k, v) in value) {
            packer.packString(k)
            packValue(packer, v)
        }
    }

    private fun packValue(packer: MessagePacker, value: Any?) {
        when (value) {
            null -> packer.packNil()
            is Boolean -> packer.packBoolean(value)
            is Byte -> packer.packByte(value)
            is Short -> packer.packShort(value)
            is Int -> packer.packInt(value)
            is Long -> packer.packLong(value)
            is Float -> packer.packFloat(value)
            is Double -> packer.packDouble(value)
            is String -> packer.packString(value)
            is ByteArray -> {
                packer.packBinaryHeader(value.size)
                packer.writePayload(value)
            }
            is Map<*, *> -> {
                packer.packMapHeader(value.size)
                for ((k, v) in value) {
                    packer.packString(k?.toString() ?: "")
                    packValue(packer, v)
                }
            }
            is List<*> -> {
                packer.packArrayHeader(value.size)
                for (item in value) packValue(packer, item)
            }
            is Array<*> -> {
                packer.packArrayHeader(value.size)
                for (item in value) packValue(packer, item)
            }
            else -> packer.packString(value.toString())
        }
    }

    private fun unpackAny(unpacker: MessageUnpacker, depth: Int): Any? {
        if (depth > MAX_DEPTH) {
            // Bound recursion so a deeply-nested array/map frame can't blow the
            // stack (StackOverflowError) — caught by onMessage as a decode error.
            throw DecodeBoundsException("msgpack nesting deeper than $MAX_DEPTH")
        }
        if (!unpacker.hasNext()) return null
        val format = unpacker.nextFormat
        return when (format.valueType) {
            ValueType.NIL -> { unpacker.unpackNil(); null }
            ValueType.BOOLEAN -> unpacker.unpackBoolean()
            ValueType.INTEGER -> unpacker.unpackLong()
            ValueType.FLOAT -> unpacker.unpackDouble()
            ValueType.STRING -> unpacker.unpackString()
            ValueType.BINARY -> {
                val len = unpacker.unpackBinaryHeader()
                if (len < 0 || len > MAX_BINARY_LENGTH) {
                    throw DecodeBoundsException("binary length $len exceeds cap $MAX_BINARY_LENGTH")
                }
                unpacker.readPayload(len)
            }
            ValueType.ARRAY -> {
                val len = unpacker.unpackArrayHeader()
                if (len < 0 || len > MAX_PRESIZE) {
                    // Reject (don't pre-size or loop) any array whose declared
                    // length exceeds the cap. A msgpack header declares its length
                    // before the elements, so an attacker can claim ~2.1e9 entries
                    // in a tiny frame; pre-sizing OOMs and even an incremental loop
                    // would spin len times. Legitimate frames stay well under the
                    // cap.
                    throw DecodeBoundsException("array length $len exceeds cap $MAX_PRESIZE")
                }
                val list = ArrayList<Any?>(len)
                repeat(len) { list.add(unpackAny(unpacker, depth + 1)) }
                list
            }
            ValueType.MAP -> {
                val len = unpacker.unpackMapHeader()
                if (len < 0 || len > MAX_PRESIZE) {
                    throw DecodeBoundsException("map length $len exceeds cap $MAX_PRESIZE")
                }
                val map = LinkedHashMap<String, Any?>(len)
                repeat(len) {
                    val key = unpackAny(unpacker, depth + 1)?.toString() ?: ""
                    val value = unpackAny(unpacker, depth + 1)
                    map[key] = value
                }
                map
            }
            ValueType.EXTENSION -> {
                // Skip extension types — protocol does not use them today.
                unpacker.skipValue()
                null
            }
            else -> { unpacker.skipValue(); null }
        }
    }
}

// ----- payload extraction helpers -----

internal fun Map<String, Any?>.intField(name: String): Int? =
    when (val v = this[name]) {
        is Number -> v.toInt()
        is String -> v.toIntOrNull()
        else -> null
    }

internal fun Map<String, Any?>.stringField(name: String): String? =
    this[name]?.toString()

@Suppress("UNCHECKED_CAST")
internal fun Map<String, Any?>.mapField(name: String): Map<String, Any?>? =
    this[name] as? Map<String, Any?>

@Suppress("UNCHECKED_CAST")
internal fun Map<String, Any?>.listField(name: String): List<Any?>? =
    this[name] as? List<Any?>

// ----- the socket -----

/**
 * The WebSocket sync transport. Use [FrickClient.connectSync] to construct.
 *
 * The socket opens lazily; [status] transitions to [FrickSyncStatus.Ready] once
 * the HelloAck arrives. Send-path APIs may be called before Ready: they queue
 * in-memory and flush on (re)connect.
 */
class FrickSyncSocket internal constructor(
    private val baseUrl: String,
    private val sessionTokenProvider: () -> String?,
    private val config: FrickSyncSocketConfig,
    private val httpClient: OkHttpClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    private val telemetry: FrickClientTelemetryRuntime = NoopFrickClientTelemetryRuntime,
) : AutoCloseable {
    private val _status = MutableStateFlow<FrickSyncStatus>(FrickSyncStatus.Disconnected)
    val status: StateFlow<FrickSyncStatus> = _status.asStateFlow()

    private val _events = MutableSharedFlow<FrickInboundEvent>(
        replay = 0,
        extraBufferCapacity = 64,
    )
    val events: SharedFlow<FrickInboundEvent> = _events.asSharedFlow()

    @Volatile private var closed = false
    @Volatile private var webSocket: WebSocket? = null
    @Volatile private var activeSessionToken: String? = null
    @Volatile private var helloAcked = CompletableDeferred<Unit>()
    @Volatile private var connectJob: Job? = null

    // Pending appends/upserts queued before connect or replayed after reconnect.
    // Each entry pairs the encoded frame with its FrameKind so the sent-frame
    // telemetry counter can be labelled by kind when the frame actually flushes.
    private val pendingFrames: MutableList<Pair<Int, ByteArray>> = java.util.Collections.synchronizedList(mutableListOf())

    // requestId -> awaitable result (Ack or Nack). Used by upsertObject().
    private val pendingObjectWrites = ConcurrentHashMap<String, CompletableDeferred<ObjectWriteResult>>()

    // requestId -> awaitable result (CallCommandResult or Nack). Used by
    // callCommand() (FR-15). Mirrors pendingObjectWrites' correlation plumbing.
    private val pendingCallCommands = ConcurrentHashMap<String, CompletableDeferred<CallCommandResult>>()

    // FR-256 (client half): waiters parked by subscribeObject / subscribe(stream)
    // / subscribeProjection, resolved when the server's initial Snapshot /
    // StreamPage / ProjectionDelta confirms the subscription is registered.
    // Keyed by subscriptionId (objects/streams) or projection name (projections).
    private val pendingRegistrations =
        ConcurrentHashMap<String, MutableList<CompletableDeferred<Unit>>>()

    init {
        URI(buildSyncUrl(baseUrl))
    }

    // Per-connection telemetry span + start time, mirroring the TS client's
    // `#socketTelemetry` map (one entry per live WebSocket) and Swift FR-74.
    // The span opens at connect (openSocketOnce) and finishes exactly once on
    // close/failure, recording the connection-duration histogram alongside.
    private val telemetrySpan = AtomicReference<FrickClientTelemetrySpan?>(null)
    private val telemetryStartedAtMs = AtomicReference<Long?>(null)

    @Volatile private var reconnectEnabled: Boolean = true
    private val backoffState = AtomicReference(config.initialBackoffMs)
    @Volatile private var disconnectedSignal: CompletableDeferred<Unit> = CompletableDeferred()

    /** Begin connecting if not already in flight. Idempotent. */
    fun connect() {
        if (closed) return
        if (connectJob?.isActive == true) return
        connectJob = scope.launch { connectLoop() }
    }

    private suspend fun connectLoop() {
        while (!closed && reconnectEnabled) {
            try {
                openSocketOnce()
                disconnectedSignal.await()
            } catch (t: Throwable) {
                _status.value = FrickSyncStatus.Failed(t.message ?: "connect failure")
            }
            if (closed || !reconnectEnabled) break
            val wait = backoffState.get()
            delay(wait)
            backoffState.set(minOf(wait * 2, config.maxBackoffMs))
        }
    }

    private fun openSocketOnce() {
        helloAcked = CompletableDeferred()
        disconnectedSignal = CompletableDeferred()
        _status.value = FrickSyncStatus.Connecting
        val sessionToken = sessionTokenProvider()?.takeIf { token -> token.isNotBlank() }
        activeSessionToken = sessionToken
        val url = buildSyncUrl(baseUrl)
        startConnectionTelemetrySpan(url, authenticated = sessionToken != null)
        val requestBuilder = Request.Builder()
            .url(url.replace("ws://", "http://").replace("wss://", "https://"))
        if (sessionToken != null) {
            requestBuilder.header("Authorization", "Bearer $sessionToken")
        }
        val request = requestBuilder.build()
        val ws = httpClient.newWebSocket(request, Listener())
        webSocket = ws
    }

    private fun signalDisconnected() {
        if (!disconnectedSignal.isCompleted) disconnectedSignal.complete(Unit)
    }

    /**
     * Fail every outstanding [upsertObject] / [callCommand] deferred with a
     * synthetic "connection closed" envelope so their awaiting caller coroutines
     * resume instead of hanging forever. Called on every disconnect path
     * (onClosed / onFailure / close()): a write/call frame sent just before a
     * transport drop, server crash, or token expiry would otherwise leave its
     * awaiter suspended indefinitely with no timeout and no error surfaced.
     *
     * Drains both maps by snapshotting and removing entries first so the
     * `invokeOnCompletion` eviction registered per request can't race the
     * iteration. Completing an already-settled deferred is a no-op, so this is
     * safe to call repeatedly and from multiple close paths.
     */
    private fun failPendingRequests(reason: String) {
        val envelope = FrickErrorEnvelope(
            code = FrickErrorCodes.SyncReconnectExhausted,
            message = reason,
            requestId = "",
            retryable = true,
        )
        val writes = pendingObjectWrites.keys.toList()
        for (requestId in writes) {
            pendingObjectWrites.remove(requestId)?.complete(ObjectWriteResult.Failed(envelope))
        }
        val calls = pendingCallCommands.keys.toList()
        for (requestId in calls) {
            pendingCallCommands.remove(requestId)?.complete(CallCommandResult.Failed(envelope))
        }
        // Don't leave subscribe...() callers awaiting a snapshot that won't
        // arrive on a reset connection (FR-256); the subscribe replays on
        // reconnect, which re-snapshots.
        resolveAllRegistrations()
    }

    /**
     * Open the per-connection telemetry span. Mirrors the TS
     * `#startWebSocketTelemetrySpan`: span name `"WebSocket /_frick/sync"`,
     * client kind, with the shared `network.protocol.name` / `url.path` /
     * `frick.schema_id` / `frick.schema_revision` / `frick.authenticated`
     * attributes. Records the start time for the duration histogram on close.
     */
    private fun startConnectionTelemetrySpan(url: String, authenticated: Boolean) {
        val span = startFrickClientTelemetrySpan(
            telemetry,
            FrickClientTelemetrySpanStart(
                name = "WebSocket /_frick/sync",
                kind = FrickClientTelemetrySpanKind.CLIENT,
                attributes = mapOf(
                    "network.protocol.name" to JsonPrimitive("websocket"),
                    "url.path" to JsonPrimitive(frickWebSocketUrlPath(url)),
                    "frick.schema_id" to JsonPrimitive(FRICK_SCHEMA_ID),
                    "frick.schema_revision" to JsonPrimitive(FRICK_SCHEMA_REVISION),
                    "frick.authenticated" to JsonPrimitive(authenticated),
                ),
            ),
        )
        telemetrySpan.set(span)
        telemetryStartedAtMs.set(System.currentTimeMillis())
    }

    /**
     * Finish the active connection span (if any) and record the
     * `frick.client.ws.connection.duration_ms` histogram. Mirrors the TS
     * `#finishWebSocketTelemetrySpan`: status ok when the close category is
     * `"normal"`, else error, with `frick.ws.close_code` (when known) and
     * `frick.ws.close_category` span attributes plus the histogram labelled by
     * `closeCategory`. Idempotent — the first caller per connection wins so a
     * close that follows a failure (or vice versa) does not double-record.
     */
    private fun finishConnectionTelemetrySpan(closeCode: Int?) {
        val span = telemetrySpan.getAndSet(null) ?: return
        val startedAt = telemetryStartedAtMs.getAndSet(null)
        val closeCategory = frickWebSocketCloseCategory(closeCode)
        val attributes = buildMap<String, JsonPrimitive> {
            if (closeCode != null) put("frick.ws.close_code", JsonPrimitive(closeCode))
            put("frick.ws.close_category", JsonPrimitive(closeCategory))
        }
        finishFrickClientTelemetrySpan(
            span,
            FrickClientTelemetrySpanResult(
                status = if (closeCategory == "normal") {
                    FrickClientTelemetrySpanStatus.OK
                } else {
                    FrickClientTelemetrySpanStatus.ERROR
                },
                attributes = attributes,
            ),
        )
        if (startedAt != null) {
            val durationMs = (System.currentTimeMillis() - startedAt).coerceAtLeast(0L)
            recordFrickClientTelemetryHistogram(
                telemetry,
                name = "frick.client.ws.connection.duration_ms",
                value = durationMs.toDouble(),
                attributes = mapOf("closeCategory" to JsonPrimitive(closeCategory)),
            )
        }
    }

    /**
     * Record a per-frame counter. Mirrors the TS
     * `#recordWebSocketFrameTelemetry`: increments
     * `frick.client.ws.frames.{sent,received}.total` with a `kind` label
     * resolved via [frickFrameKindLabel].
     */
    private fun recordFrameTelemetry(direction: String, kind: Int) {
        recordFrickClientTelemetryCounter(
            telemetry,
            name = "frick.client.ws.frames.$direction.total",
            value = 1.0,
            attributes = mapOf("kind" to JsonPrimitive(frickFrameKindLabel(kind))),
        )
    }

    private fun sendHello() {
        val payload = buildMap<String, Any?> {
            put("replicaId", config.replicaId)
            put("deviceId", config.deviceId)
            activeSessionToken?.let { token -> put("sessionToken", token) }
            put("schemaHash", FRICK_SCHEMA_HASH)
            put("knownCursors", emptyMap<String, Int>())
            put("clientCapabilities", defaultAndroidCapabilities(config.sdkVersion))
        }
        val bytes = FrickMsgPack.encodeFrame(FrameKindCodes.HELLO, payload)
        if (webSocket?.send(bytes.toByteString()) == true) {
            recordFrameTelemetry("sent", FrameKindCodes.HELLO)
            _status.value = FrickSyncStatus.HelloSent
        }
    }

    /**
     * Suspend until the socket reaches Ready (HelloAck) or the timeout in the
     * config elapses. Returns the Ready status, or `null` on timeout.
     */
    suspend fun awaitReady(): FrickSyncStatus.Ready? {
        if (_status.value is FrickSyncStatus.Ready) return _status.value as FrickSyncStatus.Ready
        return withTimeoutOrNull(config.helloAckTimeoutMs) {
            helloAcked.await()
            _status.value as? FrickSyncStatus.Ready
        }
    }

    /** Send an Append frame. Queues if the socket is not yet Ready. */
    suspend fun append(stream: String, key: String, event: String, payload: Map<String, Any?>) {
        val requestId = UUID.randomUUID().toString()
        val frame = FrickMsgPack.encodeFrame(
            FrameKindCodes.APPEND,
            mapOf(
                "requestId" to requestId,
                "stream" to stream,
                "key" to key,
                "event" to event,
                "payload" to payload,
            ),
        )
        sendOrQueue(FrameKindCodes.APPEND, frame)
    }

    /** Subscribe to a stream by key. */
    suspend fun subscribe(stream: String, key: String) {
        val subId = UUID.randomUUID().toString()
        val frame = FrickMsgPack.encodeFrame(
            FrameKindCodes.SUBSCRIBE,
            mapOf(
                "subscriptionId" to subId,
                "kind" to "stream",
                "name" to stream,
                "key" to key,
            ),
        )
        sendOrQueue(FrameKindCodes.SUBSCRIBE, frame)
        awaitRegistration(subId)
    }

    /**
     * Subscribe to a presence channel. Receive deltas via
     * [FrickInboundEvent.PresenceDelta]. Closes parity with the Swift
     * SDK and the TypeScript `client.presence(...)` surface.
     */
    suspend fun subscribePresence(name: String, key: String) {
        val frame = FrickMsgPack.encodeFrame(
            FrameKindCodes.SUBSCRIBE,
            mapOf(
                "subscriptionId" to UUID.randomUUID().toString(),
                "kind" to "presence",
                "name" to name,
                "key" to key,
            ),
        )
        sendOrQueue(FrameKindCodes.SUBSCRIBE, frame)
    }

    /**
     * Set a presence row (e.g. `setPresence("CursorState", "$doc:$user:$device", mapOf("active" to true))`).
     * The server applies the row's `ttlMs` and broadcasts a
     * [FrickInboundEvent.PresenceDelta] to every subscriber.
     */
    suspend fun setPresence(name: String, key: String, value: Map<String, Any?>) {
        val frame = FrickMsgPack.encodeFrame(
            FrameKindCodes.PRESENCE_SET,
            mapOf(
                "requestId" to UUID.randomUUID().toString(),
                "name" to name,
                "key" to key,
                "value" to value,
            ),
        )
        sendOrQueue(FrameKindCodes.PRESENCE_SET, frame)
    }

    /** Revoke the active user's presence lease on this key. */
    suspend fun clearPresence(name: String, key: String) {
        val frame = FrickMsgPack.encodeFrame(
            FrameKindCodes.PRESENCE_CLEAR,
            mapOf(
                "requestId" to UUID.randomUUID().toString(),
                "name" to name,
                "key" to key,
            ),
        )
        sendOrQueue(FrameKindCodes.PRESENCE_CLEAR, frame)
    }

    /**
     * Subscribe to all objects of a given `type`. The server replies with
     * a Snapshot frame of the current row set (delivered as
     * [FrickInboundEvent.Delta] with populated `objects`) and then
     * streams subsequent upserts as Delta frames. Object subscriptions
     * are type-scoped on the wire today; per-id filtering happens at
     * the consumer (see `FrickDraftStore`).
     */
    suspend fun subscribeObject(type: String) {
        val subId = UUID.randomUUID().toString()
        val frame = FrickMsgPack.encodeFrame(
            FrameKindCodes.SUBSCRIBE,
            mapOf(
                "subscriptionId" to subId,
                "kind" to "object",
                "name" to type,
            ),
        )
        sendOrQueue(FrameKindCodes.SUBSCRIBE, frame)
        // FR-256 (client half): resolve only once the server has REGISTERED the
        // subscription — the gateway sends the Snapshot AFTER registering — so a
        // write issued right after this returns can't race ahead of it.
        awaitRegistration(subId)
    }

    /** Subscribe to a projection by name. */
    suspend fun subscribeProjection(name: String) {
        val subId = UUID.randomUUID().toString()
        val frame = FrickMsgPack.encodeFrame(
            FrameKindCodes.SUBSCRIBE,
            mapOf(
                "subscriptionId" to subId,
                "kind" to "projection",
                "name" to name,
            ),
        )
        sendOrQueue(FrameKindCodes.SUBSCRIBE, frame)
        // Projections correlate by name (the ProjectionDelta carries the name,
        // not the subscriptionId) — see resolveRegistration in the dispatch.
        awaitRegistration(name)
    }

    /**
     * Park the caller until the server confirms registration of [token] — the
     * `subscriptionId` echoed in the initial Snapshot (objects) / StreamPage
     * (streams), or the projection name in the initial ProjectionDelta. Resumed
     * by [resolveRegistration]; drained by [resolveAllRegistrations] when the
     * connection resets (the subscribe replays on reconnect). FR-256 client half.
     */
    private suspend fun awaitRegistration(token: String) {
        val deferred = CompletableDeferred<Unit>()
        pendingRegistrations.compute(token) { _, list ->
            (list ?: mutableListOf()).also { it.add(deferred) }
        }
        deferred.await()
    }

    /** Resume every waiter parked on [token]: its initial snapshot arrived. */
    private fun resolveRegistration(token: String) {
        pendingRegistrations.remove(token)?.forEach { it.complete(Unit) }
    }

    /** Resume every parked registration waiter — connection reset/closed, so a
     *  subscribe...() caller must not hang; the subscription replays on reconnect. */
    private fun resolveAllRegistrations() {
        for (token in pendingRegistrations.keys.toList()) {
            pendingRegistrations.remove(token)?.forEach { it.complete(Unit) }
        }
    }

    /**
     * Send an ObjectUpsert frame and suspend until the server replies with an
     * Ack (returning the new version) or a Nack (thrown as [FrickHttpException]
     * carrying the server-supplied envelope).
     */
    suspend fun upsertObject(
        type: String,
        id: String,
        value: Map<String, Any?>,
        expectedVersion: Int? = null,
    ): Int {
        val requestId = UUID.randomUUID().toString()
        val payload = buildMap<String, Any?> {
            put("requestId", requestId)
            put("objectType", type)
            put("objectId", id)
            put("value", value)
            expectedVersion?.let { put("expectedVersion", it) }
        }
        val frame = FrickMsgPack.encodeFrame(FrameKindCodes.OBJECT_UPSERT, payload)
        val deferred = CompletableDeferred<ObjectWriteResult>()
        pendingObjectWrites[requestId] = deferred
        // Evict the map entry whenever the deferred settles — including when the
        // caller's coroutine is cancelled (the await() below unwinds but the
        // requestId would otherwise linger forever, an unbounded leak under
        // churny screens/reconnects).
        deferred.invokeOnCompletion { pendingObjectWrites.remove(requestId) }
        sendOrQueue(FrameKindCodes.OBJECT_UPSERT, frame)
        val result = deferred.await()
        return when (result) {
            is ObjectWriteResult.Ok -> result.version
            is ObjectWriteResult.Failed -> throw FrickHttpException(
                statusCode = 0,
                envelope = result.envelope,
                responseBody = "",
                message = result.envelope.message,
            )
        }
    }

    /**
     * FR-15 — issue a call control-plane command (`CallCommand`, kind 21) and
     * suspend until the server replies with a `CallCommandResult` (kind 22,
     * returning [op] + the raw `result` map) or a `Nack` (thrown as
     * [FrickHttpException] carrying the server envelope, keyed by the same
     * requestId). Mirrors [upsertObject]'s request/response correlation exactly.
     *
     * [command] is the discriminated command body — `{ op, ... }` — packed
     * verbatim under the frame's `command` field (the wire contract from
     * `packages/protocol/src/calls.ts`). The higher-level verbs on
     * [FrickCallManager] build these maps and decode the result records.
     */
    internal suspend fun callCommand(command: Map<String, Any?>): CallCommandResult {
        val requestId = UUID.randomUUID().toString()
        val payload = mapOf(
            "requestId" to requestId,
            "command" to command,
        )
        val frame = FrickMsgPack.encodeFrame(FrameKindCodes.CALL_COMMAND, payload)
        val deferred = CompletableDeferred<CallCommandResult>()
        pendingCallCommands[requestId] = deferred
        // Evict on settle/cancel so a cancelled caller doesn't leak the entry.
        deferred.invokeOnCompletion { pendingCallCommands.remove(requestId) }
        sendOrQueue(FrameKindCodes.CALL_COMMAND, frame)
        return deferred.await()
    }

    private fun sendOrQueue(kind: Int, frame: ByteArray) {
        val ws = webSocket
        val ready = _status.value is FrickSyncStatus.Ready
        if (ws != null && ready) {
            if (ws.send(frame.toByteString())) {
                recordFrameTelemetry("sent", kind)
            }
        } else {
            pendingFrames.add(kind to frame)
        }
    }

    private fun flushPending() {
        val ws = webSocket ?: return
        synchronized(pendingFrames) {
            val iter = pendingFrames.iterator()
            while (iter.hasNext()) {
                val (kind, frame) = iter.next()
                if (ws.send(frame.toByteString())) {
                    iter.remove()
                    recordFrameTelemetry("sent", kind)
                } else {
                    break
                }
            }
        }
    }

    override fun close() {
        if (closed) return
        closed = true
        reconnectEnabled = false
        webSocket?.close(NORMAL_CLOSURE, "client.close")
        // OkHttp delivers onClosed asynchronously after a client-initiated
        // close, and the scope is cancelled below — finish the span here so the
        // client-close path is recorded deterministically (normal/ok). Idempotent
        // with onClosed: whichever runs first claims the span.
        finishConnectionTelemetrySpan(NORMAL_CLOSURE)
        webSocket = null
        _status.value = FrickSyncStatus.Disconnected
        // Resume any caller awaiting an in-flight write/call before the scope is
        // cancelled, so close() never strands a suspended awaiter.
        failPendingRequests("Sync connection closed")
        signalDisconnected()
        scope.cancel()
    }

    private fun handleFrame(kind: Int, payload: Map<String, Any?>) {
        when (kind) {
            FrameKindCodes.HELLO_ACK -> {
                val schemaHash = payload.stringField("schemaHash") ?: FRICK_SCHEMA_HASH
                val schemaId = payload.stringField("schemaId") ?: FRICK_SCHEMA_ID
                val schemaRev = payload.intField("schemaRevision") ?: FRICK_SCHEMA_REVISION
                _status.value = FrickSyncStatus.Ready(schemaHash, schemaId, schemaRev)
                backoffState.set(config.initialBackoffMs)
                if (!helloAcked.isCompleted) helloAcked.complete(Unit)
                flushPending()
            }
            FrameKindCodes.SCHEMA -> {
                _events.tryEmit(FrickInboundEvent.Schema(payload))
            }
            FrameKindCodes.ACK -> {
                val requestId = payload.stringField("requestId") ?: return
                val cursor = payload.intField("cursor")
                val version = payload.intField("version")
                pendingObjectWrites.remove(requestId)?.complete(
                    ObjectWriteResult.Ok(version ?: 0),
                )
                if (version != null) {
                    _events.tryEmit(FrickInboundEvent.ObjectUpsertResult(requestId, version))
                }
                _events.tryEmit(FrickInboundEvent.Ack(requestId, cursor, version))
            }
            FrameKindCodes.NACK -> {
                val requestId = payload.stringField("requestId") ?: return
                val envelope = decodeErrorEnvelope(payload.mapField("error"), payload)
                pendingObjectWrites.remove(requestId)?.complete(ObjectWriteResult.Failed(envelope))
                // FR-15: a CallCommand failure reuses Nack keyed by the same
                // requestId — route it to the awaiting callCommand() if any.
                pendingCallCommands.remove(requestId)?.complete(CallCommandResult.Failed(envelope))
                _events.tryEmit(FrickInboundEvent.Nack(requestId, envelope))
            }
            FrameKindCodes.DELTA -> {
                // Delta `objects` and `events` arrive on the wire as packed
                // positional tuples — `PackedObjectRecord` and
                // `PackedStreamEvent`. The previous implementation cast each
                // entry as `Map<String, Any?>` and silently dropped every one,
                // because the wire form is `List<Any?>`. Resolve type/field
                // names via the generated `FRICK_*` descriptor tables and emit
                // named-field maps for consumers.
                val objects = (payload.listField("objects") ?: emptyList())
                    .mapNotNull(::decodePackedObjectRecord)
                val events = (payload.listField("events") ?: emptyList())
                    .mapNotNull(::decodePackedStreamEvent)
                // Object removals (FR-142/FR-144): the gateway carries a
                // `removed` list of `{ type, id }` maps alongside the
                // back-compat tombstone records in `objects`. Surface them so
                // consumers drop the deleted rows directly without a refetch.
                val removed = (payload.listField("removed") ?: emptyList())
                    .mapNotNull(::decodeObjectRemoval)
                val cursor = payload.intField("cursor") ?: 0
                _events.tryEmit(FrickInboundEvent.Delta(objects, events, cursor, removed))
            }
            FrameKindCodes.SNAPSHOT -> {
                // Snapshot is the server's response to a `subscribe { kind:
                // "object" }` and carries the current row set in `objects`.
                // Surfaced as a Delta with an empty `events` list so existing
                // consumers (and the typed Compose helpers) don't need a new
                // case for the initial-state path vs. live updates.
                val objects = (payload.listField("objects") ?: emptyList())
                    .mapNotNull(::decodePackedObjectRecord)
                val cursor = payload.intField("cursor") ?: 0
                _events.tryEmit(FrickInboundEvent.Delta(objects, emptyList(), cursor))
                // FR-256: the object Snapshot is the server's post-registration
                // reply, so a subscribeObject waiter on this subscriptionId can
                // resolve.
                resolveRegistration(payload.stringField("subscriptionId") ?: "")
            }
            FrameKindCodes.STREAM_PAGE -> {
                // FR-256: the StreamPage is the server's reply to a stream
                // subscribe (re-sent on reconnect). The Android client does not
                // yet surface stream pages as events, but the frame confirms
                // registration, so resolve a subscribe(stream, key) waiter.
                resolveRegistration(payload.stringField("subscriptionId") ?: "")
            }
            FrameKindCodes.CALL_COMMAND_RESULT -> {
                // FR-15: the server's reply to a CallCommand (kind 21). Resolve
                // the awaiting callCommand() by requestId with the raw result
                // map (room/invites/participant/mediaGrant/invite), and fan the
                // typed event out for any observer. Failures arrive as a Nack.
                val requestId = payload.stringField("requestId") ?: return
                val op = payload.stringField("op") ?: ""
                pendingCallCommands.remove(requestId)?.complete(
                    CallCommandResult.Ok(op, payload),
                )
                _events.tryEmit(FrickInboundEvent.CallCommandResult(requestId, op, payload))
            }
            FrameKindCodes.PRESENCE_DELTA -> {
                val name = payload.stringField("name") ?: payload.stringField("presence") ?: ""
                val records = (payload.listField("records") ?: emptyList())
                    .mapNotNull(::decodePackedPresenceRecord)
                val cleared = (payload.listField("cleared") ?: emptyList())
                    .mapNotNull { it as? String }
                _events.tryEmit(FrickInboundEvent.PresenceDelta(name, records, cleared))
            }
            FrameKindCodes.PROJECTION_DELTA -> {
                val name = payload.stringField("projection") ?: ""
                val changes = (payload.listField("changes") ?: emptyList()).mapNotNull { item ->
                    @Suppress("UNCHECKED_CAST")
                    val row = item as? Map<String, Any?> ?: return@mapNotNull null
                    val key = row.stringField("key") ?: return@mapNotNull null
                    val value = row.mapField("value")
                    ProjectionChange(key, value)
                }
                _events.tryEmit(FrickInboundEvent.ProjectionDelta(name, changes))
                // FR-256: the initial ProjectionDelta is the post-registration
                // reply; resolve a subscribeProjection waiter (projections
                // correlate by name, which is what the frame carries).
                resolveRegistration(name)
            }
            FrameKindCodes.SYNC_STATUS -> {
                val connected = (payload["connected"] as? Boolean) ?: false
                val cursorsRaw = payload.mapField("cursors") ?: emptyMap()
                val cursors = cursorsRaw.mapValues { (_, v) ->
                    (v as? Number)?.toInt() ?: 0
                }
                val inFlight = payload.intField("inFlight") ?: 0
                _events.tryEmit(FrickInboundEvent.SyncStatus(connected, cursors, inFlight))
            }
            FrameKindCodes.PING -> {
                val sentAt = payload.intField("sentAt")?.toLong() ?: System.currentTimeMillis()
                val pong = FrickMsgPack.encodeFrame(
                    FrameKindCodes.PONG,
                    mapOf("sentAt" to sentAt, "receivedAt" to System.currentTimeMillis()),
                )
                if (webSocket?.send(pong.toByteString()) == true) {
                    recordFrameTelemetry("sent", FrameKindCodes.PONG)
                }
            }
            // Other kinds handled in follow-up commits.
        }
    }

    /**
     * Decode a `PackedObjectRecord` tuple `[objectTypeId, recordId, packedFields]`
     * into a named-field map: `{ type, id, value }`. `value` is itself a
     * `Map<String, Any?>` keyed by field name. Returns null when the tuple is
     * malformed or the object type id is not in [FRICK_OBJECT_NAMES].
     */
    private fun decodePackedObjectRecord(raw: Any?): Map<String, Any?>? {
        val tuple = raw as? List<*> ?: return null
        if (tuple.size < 3) return null
        val typeId = (tuple[0] as? Number)?.toInt() ?: return null
        val id = tuple[1] as? String ?: return null
        val typeName = FRICK_OBJECT_NAMES[typeId] ?: return null
        val fieldTable = FRICK_OBJECT_FIELDS[typeId] ?: emptyMap()
        val packedFields = tuple[2] as? List<*> ?: emptyList<Any?>()
        val value = unpackFields(packedFields, fieldTable).toMutableMap()
        value["id"] = id
        return mapOf("type" to typeName, "id" to id, "value" to value)
    }

    /**
     * Decode a Delta `removed` entry — a `{ type, id }` map — into an
     * [ObjectRemoval] (FR-142/FR-144). Returns null when either field is
     * missing so a malformed entry is skipped rather than surfaced.
     */
    private fun decodeObjectRemoval(raw: Any?): ObjectRemoval? {
        @Suppress("UNCHECKED_CAST")
        val map = raw as? Map<String, Any?> ?: return null
        val type = map.stringField("type") ?: return null
        val id = map.stringField("id") ?: return null
        return ObjectRemoval(type, id)
    }

    /**
     * Decode a `PackedPresenceRecord` tuple `[presenceTypeId, key,
     * packedFields]` into a named-field map matching the Swift/TS
     * `FrickPresenceRecord` shape `{ type, key, value }`. The generated
     * descriptor today shares the object-id table for presence rows; we'll
     * switch to a dedicated `FRICK_PRESENCE_*` table when the generator
     * grows one.
     */
    private fun decodePackedPresenceRecord(raw: Any?): Map<String, Any?>? {
        val tuple = raw as? List<*> ?: return null
        if (tuple.size < 3) return null
        val typeId = (tuple[0] as? Number)?.toInt() ?: return null
        val key = tuple[1] as? String ?: return null
        val typeName = FRICK_OBJECT_NAMES[typeId] ?: "#$typeId"
        val packedFields = tuple[2] as? List<*> ?: emptyList<Any?>()
        val value = unpackFields(packedFields, FRICK_OBJECT_FIELDS[typeId] ?: emptyMap())
        return mapOf("type" to typeName, "key" to key, "value" to value)
    }

    /**
     * Decode a `PackedStreamEvent` tuple
     * `[streamTypeId, streamKey, sequence, eventId, eventTypeId, packedFields]`
     * into a named-field map: `{ stream, streamId, sequence, eventId, event, payload }`.
     * Returns null when the tuple is malformed or the stream/event type id is
     * not in [FRICK_STREAM_NAMES] / [FRICK_EVENT_NAMES].
     */
    private fun decodePackedStreamEvent(raw: Any?): Map<String, Any?>? {
        val tuple = raw as? List<*> ?: return null
        if (tuple.size < 6) return null
        val streamTypeId = (tuple[0] as? Number)?.toInt() ?: return null
        val streamKey = tuple[1] as? String ?: return null
        val sequence = (tuple[2] as? Number)?.toInt() ?: return null
        val eventId = tuple[3] as? String ?: return null
        val eventTypeId = (tuple[4] as? Number)?.toInt() ?: return null
        val streamName = FRICK_STREAM_NAMES[streamTypeId] ?: return null
        val eventName = FRICK_EVENT_NAMES[eventTypeId] ?: return null
        val fieldTable = FRICK_EVENT_FIELDS[eventTypeId] ?: emptyMap()
        val packedFields = tuple[5] as? List<*> ?: emptyList<Any?>()
        val payload = unpackFields(packedFields, fieldTable)
        return mapOf(
            "stream" to streamName,
            "streamId" to streamKey,
            "sequence" to sequence,
            "eventId" to eventId,
            "event" to eventName,
            "payload" to payload,
        )
    }

    /**
     * Translate a packed field list `[[fieldId, value], ...]` into a named
     * map using the provided fieldId → fieldName table. Unknown field ids are
     * preserved under a stringified-id key so callers can still observe them
     * after a schema bump (forward compatibility).
     */
    private fun unpackFields(packed: List<*>, fieldTable: Map<Int, String>): Map<String, Any?> {
        val result = LinkedHashMap<String, Any?>(packed.size)
        for (entry in packed) {
            val pair = entry as? List<*> ?: continue
            if (pair.size < 2) continue
            val fieldId = (pair[0] as? Number)?.toInt() ?: continue
            val name = fieldTable[fieldId] ?: "#$fieldId"
            result[name] = pair[1]
        }
        return result
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            sendHello()
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            val decoded = try {
                FrickMsgPack.decodeFrame(bytes.toByteArray())
            } catch (e: Throwable) {
                _status.value = FrickSyncStatus.Failed("decode: ${e.message}")
                return
            } ?: return
            recordFrameTelemetry("received", decoded.first)
            handleFrame(decoded.first, decoded.second)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            // Sync uses binary msgpack — ignore text payloads.
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            finishConnectionTelemetrySpan(code)
            _events.tryEmit(FrickInboundEvent.Disconnected)
            _status.value = FrickSyncStatus.Disconnected
            // The Ack/Nack/CallCommandResult that would settle an in-flight
            // write/call can no longer arrive on this dropped connection — fail
            // its awaiter rather than leave the caller coroutine hung.
            failPendingRequests("Sync connection closed (code $code)")
            signalDisconnected()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            // No close code is available on a transport failure; pass the
            // abnormal-closure code so the span/histogram are labelled
            // "abnormal" with error status, matching the TS/Swift parity.
            finishConnectionTelemetrySpan(ABNORMAL_CLOSURE)
            _events.tryEmit(FrickInboundEvent.Disconnected)
            _status.value = FrickSyncStatus.Failed(t.message ?: "socket failure")
            // Fail in-flight writes/calls so their awaiters resume with an error
            // instead of hanging until the process dies.
            failPendingRequests(t.message ?: "Sync connection failed")
            signalDisconnected()
        }
    }

    companion object {
        internal const val NORMAL_CLOSURE = 1000
        internal const val ABNORMAL_CLOSURE = 1006

        fun defaultOkHttpClient(): OkHttpClient =
            OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS) // long-lived
                .writeTimeout(10, TimeUnit.SECONDS)
                .pingInterval(15, TimeUnit.SECONDS)
                .build()
    }
}

/** Thrown when the socket cannot be opened or the negotiation fails. */
class FrickSyncSocketException(message: String, cause: Throwable? = null) : IOException(message, cause)

/**
 * Project a decoded Nack payload into [FrickErrorEnvelope]. The Nack body
 * carries the envelope under "error" plus duplicate "code"/"message" hints.
 */
internal fun decodeErrorEnvelope(error: Map<String, Any?>?, outer: Map<String, Any?>): FrickErrorEnvelope {
    val source = error ?: outer
    val details = (source.mapField("details") ?: outer.mapField("details"))
        ?.mapValues { (_, value) -> value.toJsonElement() }
    return FrickErrorEnvelope(
        code = source.stringField("code") ?: outer.stringField("code") ?: "sync.protocolError",
        message = source.stringField("message") ?: outer.stringField("message") ?: "Sync nack",
        requestId = source.stringField("requestId") ?: outer.stringField("requestId") ?: "",
        retryable = (source["retryable"] as? Boolean) ?: false,
        details = details,
        schemaHash = source.stringField("schemaHash"),
        schemaRevision = source.intField("schemaRevision"),
    )
}

private fun Any?.toJsonElement(): JsonElement =
    when (this) {
        null -> JsonNull
        is JsonElement -> this
        is Boolean -> JsonPrimitive(this)
        is Number -> JsonPrimitive(this)
        is String -> JsonPrimitive(this)
        is Map<*, *> -> JsonObject(
            entries.associate { (key, value) ->
                key.toString() to value.toJsonElement()
            },
        )
        is Iterable<*> -> JsonArray(map { value -> value.toJsonElement() })
        is Array<*> -> JsonArray(map { value -> value.toJsonElement() })
        else -> JsonPrimitive(toString())
    }
