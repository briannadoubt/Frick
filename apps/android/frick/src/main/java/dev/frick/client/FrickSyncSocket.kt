package dev.frick.client

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
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
}

data class ProjectionChange(val key: String, val value: Map<String, Any?>?)

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

internal fun buildSyncUrl(baseUrl: String, sessionToken: String?): String {
    val trimmed = baseUrl.trimEnd('/')
    val withScheme = when {
        trimmed.startsWith("ws://") || trimmed.startsWith("wss://") -> trimmed
        trimmed.startsWith("https://") -> "wss://" + trimmed.removePrefix("https://")
        trimmed.startsWith("http://") -> "ws://" + trimmed.removePrefix("http://")
        else -> "ws://$trimmed"
    }
    val query = sessionToken?.takeIf { it.isNotBlank() }
        ?.let { "?sessionToken=${java.net.URLEncoder.encode(it, "UTF-8")}" }
        ?: ""
    return "$withScheme/_frick/sync$query"
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
    @Volatile private var helloAcked = CompletableDeferred<Unit>()
    @Volatile private var connectJob: Job? = null

    init {
        URI(buildSyncUrl(baseUrl, sessionTokenProvider()))
    }

    /** Begin connecting if not already in flight. Idempotent. */
    fun connect() {
        if (closed) return
        if (connectJob?.isActive == true) return
        connectJob = scope.launch { openSocket() }
    }

    private suspend fun openSocket() {
        if (closed) return
        _status.value = FrickSyncStatus.Connecting
        val url = buildSyncUrl(baseUrl, sessionTokenProvider())
        val request = Request.Builder().url(url.replace("ws://", "http://").replace("wss://", "https://")).build()
        val listener = Listener()
        val ws = httpClient.newWebSocket(request, listener)
        webSocket = ws
    }

    private fun sendHello() {
        val payload = mapOf(
            "replicaId" to config.replicaId,
            "deviceId" to config.deviceId,
            "schemaHash" to FRICK_SCHEMA_HASH,
            "knownCursors" to emptyMap<String, Int>(),
            "clientCapabilities" to defaultAndroidCapabilities(config.sdkVersion),
        )
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

    override fun close() {
        if (closed) return
        closed = true
        webSocket?.close(NORMAL_CLOSURE, "client.close")
        webSocket = null
        _status.value = FrickSyncStatus.Disconnected
        scope.cancel()
    }

    private fun handleFrame(kind: Int, payload: Map<String, Any?>) {
        when (kind) {
            FrameKindCodes.HELLO_ACK -> {
                val schemaHash = payload.stringField("schemaHash") ?: FRICK_SCHEMA_HASH
                val schemaId = payload.stringField("schemaId") ?: FRICK_SCHEMA_ID
                val schemaRev = payload.intField("schemaRevision") ?: FRICK_SCHEMA_REVISION
                _status.value = FrickSyncStatus.Ready(schemaHash, schemaId, schemaRev)
                if (!helloAcked.isCompleted) helloAcked.complete(Unit)
            }
            FrameKindCodes.SCHEMA -> {
                _events.tryEmit(FrickInboundEvent.Schema(payload))
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
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            _events.tryEmit(FrickInboundEvent.Disconnected)
            _status.value = FrickSyncStatus.Failed(t.message ?: "socket failure")
        }
    }

    companion object {
        internal const val NORMAL_CLOSURE = 1000

        internal fun defaultOkHttpClient(): OkHttpClient =
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
