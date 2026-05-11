package dev.frick.client

import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

// FrickSyncSocket: WebSocket transport for the Android SDK.
//
// Scaffolding only: connection plumbing, codec choice (org.msgpack:msgpack-core
// direct encode/decode of the [FrameKind, payload] 2-tuple), and public type
// surface. Hello handshake, send paths, inbound handling, reconnect, and tests
// arrive in follow-up commits per the implementation plan.

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

/**
 * The WebSocket sync transport. Public APIs (connect, append, subscribe,
 * subscribeProjection, upsertObject, close, status, events) land in
 * subsequent commits. This scaffolding declares the type so callers compile.
 */
class FrickSyncSocket internal constructor(
    private val baseUrl: String,
    private val sessionTokenProvider: () -> String?,
    private val config: FrickSyncSocketConfig,
    private val httpClient: OkHttpClient,
) : AutoCloseable {
    @Volatile private var closed = false
    @Volatile private var webSocket: WebSocket? = null

    init {
        // URI() validates the base URL early; subsequent commits will open the socket.
        URI(buildSyncUrl(baseUrl, sessionTokenProvider()))
    }

    /** Closes the socket. Subsequent commits flesh out lifecycle. */
    override fun close() {
        closed = true
        webSocket?.close(NORMAL_CLOSURE, "client.close")
        webSocket = null
    }

    /** Marker for tests; subsequent commits replace with a real listener. */
    internal class NoopListener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = Unit
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) = Unit
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = Unit
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
