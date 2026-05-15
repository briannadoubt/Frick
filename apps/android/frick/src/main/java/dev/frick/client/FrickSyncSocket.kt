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
    data class Delta(val objects: List<Map<String, Any?>>, val events: List<Map<String, Any?>>, val cursor: Int) : FrickInboundEvent()
    data class ProjectionDelta(val projection: String, val changes: List<ProjectionChange>) : FrickInboundEvent()
    data class ObjectUpsertResult(val requestId: String, val version: Int) : FrickInboundEvent()
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

internal sealed class ObjectWriteResult {
    data class Ok(val version: Int) : ObjectWriteResult()
    data class Failed(val envelope: FrickErrorEnvelope) : ObjectWriteResult()
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
}

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
            val map = (unpackAny(unpacker) as? Map<String, Any?>) ?: emptyMap()
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

    private fun unpackAny(unpacker: MessageUnpacker): Any? {
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
                unpacker.readPayload(len)
            }
            ValueType.ARRAY -> {
                val len = unpacker.unpackArrayHeader()
                buildList(len) { repeat(len) { add(unpackAny(unpacker)) } }
            }
            ValueType.MAP -> {
                val len = unpacker.unpackMapHeader()
                buildMap<String, Any?>(len) {
                    repeat(len) {
                        val key = unpackAny(unpacker)?.toString() ?: ""
                        val value = unpackAny(unpacker)
                        put(key, value)
                    }
                }
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
    private val pendingFrames: MutableList<ByteArray> = java.util.Collections.synchronizedList(mutableListOf())

    // requestId -> awaitable result (Ack or Nack). Used by upsertObject().
    private val pendingObjectWrites = ConcurrentHashMap<String, CompletableDeferred<ObjectWriteResult>>()

    init {
        URI(buildSyncUrl(baseUrl))
    }

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
        sendOrQueue(frame)
    }

    /** Subscribe to a stream by key. */
    suspend fun subscribe(stream: String, key: String) {
        val frame = FrickMsgPack.encodeFrame(
            FrameKindCodes.SUBSCRIBE,
            mapOf(
                "subscriptionId" to UUID.randomUUID().toString(),
                "kind" to "stream",
                "name" to stream,
                "key" to key,
            ),
        )
        sendOrQueue(frame)
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
        sendOrQueue(frame)
    }

    /**
     * Set a presence row (e.g. `setPresence("TypingState", "$convo:$user:$device", mapOf("isTyping" to true))`).
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
        sendOrQueue(frame)
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
        sendOrQueue(frame)
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
        val frame = FrickMsgPack.encodeFrame(
            FrameKindCodes.SUBSCRIBE,
            mapOf(
                "subscriptionId" to UUID.randomUUID().toString(),
                "kind" to "object",
                "name" to type,
            ),
        )
        sendOrQueue(frame)
    }

    /** Subscribe to a projection by name. */
    suspend fun subscribeProjection(name: String) {
        val frame = FrickMsgPack.encodeFrame(
            FrameKindCodes.SUBSCRIBE,
            mapOf(
                "subscriptionId" to UUID.randomUUID().toString(),
                "kind" to "projection",
                "name" to name,
            ),
        )
        sendOrQueue(frame)
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
        sendOrQueue(frame)
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

    private fun sendOrQueue(frame: ByteArray) {
        val ws = webSocket
        val ready = _status.value is FrickSyncStatus.Ready
        if (ws != null && ready) {
            ws.send(frame.toByteString())
        } else {
            pendingFrames.add(frame)
        }
    }

    private fun flushPending() {
        val ws = webSocket ?: return
        synchronized(pendingFrames) {
            val iter = pendingFrames.iterator()
            while (iter.hasNext()) {
                val frame = iter.next()
                if (ws.send(frame.toByteString())) {
                    iter.remove()
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
        webSocket = null
        _status.value = FrickSyncStatus.Disconnected
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
                val cursor = payload.intField("cursor") ?: 0
                _events.tryEmit(FrickInboundEvent.Delta(objects, events, cursor))
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
                webSocket?.send(pong.toByteString())
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
            handleFrame(decoded.first, decoded.second)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            // Sync uses binary msgpack — ignore text payloads.
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            _events.tryEmit(FrickInboundEvent.Disconnected)
            _status.value = FrickSyncStatus.Disconnected
            signalDisconnected()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            _events.tryEmit(FrickInboundEvent.Disconnected)
            _status.value = FrickSyncStatus.Failed(t.message ?: "socket failure")
            signalDisconnected()
        }
    }

    companion object {
        internal const val NORMAL_CLOSURE = 1000

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
