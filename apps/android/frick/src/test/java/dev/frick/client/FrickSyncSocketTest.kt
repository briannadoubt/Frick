package dev.frick.client

import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Exercises FrickSyncSocket against an in-process WebSocket using
 * MockWebServer's withWebSocketUpgrade. The server-side listener captures
 * inbound frames and the test drives outbound frames by hand.
 */
class FrickSyncSocketTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private val received = LinkedBlockingDeque<Pair<Int, Map<String, Any?>>>()
    private var serverSocket: WebSocket? = null

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
        received.clear()
        serverSocket = null
    }

    @After
    fun tearDown() {
        client.dispatcher.executorService.shutdownNow()
        client.connectionPool.evictAll()
        runCatching { server.close() }
    }

    private fun enqueueWebSocketHandler(
        onOpen: (WebSocket) -> Unit = {},
        onMessage: (WebSocket, Pair<Int, Map<String, Any?>>) -> Unit = { _, _ -> },
    ) {
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                serverSocket = webSocket
                onOpen(webSocket)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                val decoded = FrickMsgPack.decodeFrame(bytes.toByteArray()) ?: return
                received.add(decoded)
                onMessage(webSocket, decoded)
            }
        }
        server.enqueue(MockResponse.Builder().webSocketUpgrade(listener).build())
    }

    private fun newSocket(
        baseUrl: String = "http://${server.hostName}:${server.port}",
        config: FrickSyncSocketConfig = FrickSyncSocketConfig(
            replicaId = "test-replica",
            initialBackoffMs = 25,
            maxBackoffMs = 50,
            helloAckTimeoutMs = 2_000,
        ),
    ): FrickSyncSocket {
        return FrickSyncSocket(
            baseUrl = baseUrl,
            sessionTokenProvider = { "test-token" },
            config = config,
            httpClient = client,
        ).also { it.connect() }
    }

    private fun sendFrame(kind: Int, payload: Map<String, Any?>) {
        val ws = serverSocket ?: error("server socket not yet open")
        ws.send(FrickMsgPack.encodeFrame(kind, payload).toByteString())
    }

    private fun takeFrame(timeoutMs: Long = 2_000): Pair<Int, Map<String, Any?>> =
        received.poll(timeoutMs, TimeUnit.MILLISECONDS)
            ?: error("no frame received within ${timeoutMs}ms")

    @Test
    fun sendsHelloOnConnect() = runBlocking {
        enqueueWebSocketHandler()
        val socket = newSocket()
        try {
            val frame = takeFrame()
            assertEquals(FrameKindCodes.HELLO, frame.first)
            assertEquals("test-replica", frame.second["replicaId"])
            assertEquals("test-token", frame.second["sessionToken"])
            assertEquals(FRICK_SCHEMA_HASH, frame.second["schemaHash"])
            @Suppress("UNCHECKED_CAST")
            val caps = frame.second["clientCapabilities"] as Map<String, Any?>
            assertEquals("android", caps["platform"])
        } finally {
            socket.close()
        }
    }

    @Test
    fun websocketHandshakeCarriesAuthorizationHeaderWithoutSessionTokenQuery() = runBlocking {
        enqueueWebSocketHandler()
        val socket = newSocket(
            baseUrl = "http://${server.hostName}:${server.port}?sessionToken=secret&transport=websocket",
        )
        try {
            val request = server.takeRequest(2, TimeUnit.SECONDS)
                ?: error("no websocket handshake request")

            assertEquals("Bearer test-token", request.headers["Authorization"])
            assertEquals(null, request.url.queryParameter("sessionToken"))
            assertEquals("websocket", request.url.queryParameter("transport"))
            assertEquals("/_frick/sync", request.url.encodedPath)
        } finally {
            socket.close()
        }
    }

    @Test
    fun helloAckUpdatesStatus() = runBlocking {
        enqueueWebSocketHandler(
            onMessage = { _, frame ->
                if (frame.first == FrameKindCodes.HELLO) {
                    sendFrame(
                        FrameKindCodes.HELLO_ACK,
                        mapOf(
                            "schemaHash" to FRICK_SCHEMA_HASH,
                            "schemaId" to FRICK_SCHEMA_ID,
                            "schemaRevision" to FRICK_SCHEMA_REVISION,
                            "schemaCompatibility" to mapOf("status" to "compatible"),
                            "serverCapabilities" to emptyMap<String, Any?>(),
                        ),
                    )
                }
            },
        )
        val socket = newSocket()
        try {
            val ready = withTimeout(2_000) { socket.awaitReady() }
            assertNotNull(ready)
            assertEquals(FRICK_SCHEMA_HASH, ready!!.schemaHash)
        } finally {
            socket.close()
        }
    }

    @Test
    fun appendReceivesAck() = runBlocking {
        enqueueWebSocketHandler(
            onMessage = { _, frame ->
                when (frame.first) {
                    FrameKindCodes.HELLO -> sendFrame(
                        FrameKindCodes.HELLO_ACK,
                        mapOf(
                            "schemaHash" to FRICK_SCHEMA_HASH,
                            "schemaId" to FRICK_SCHEMA_ID,
                            "schemaRevision" to FRICK_SCHEMA_REVISION,
                            "schemaCompatibility" to mapOf("status" to "compatible"),
                            "serverCapabilities" to emptyMap<String, Any?>(),
                        ),
                    )
                    FrameKindCodes.APPEND -> sendFrame(
                        FrameKindCodes.ACK,
                        mapOf(
                            "requestId" to frame.second["requestId"],
                            "cursor" to 7,
                        ),
                    )
                }
            },
        )
        val socket = newSocket()
        try {
            socket.awaitReady()
            @OptIn(DelicateCoroutinesApi::class)
            val ackDeferred = GlobalScope.async {
                withTimeout(2_000) {
                    socket.events.filter { it is FrickInboundEvent.Ack }.first() as FrickInboundEvent.Ack
                }
            }
            // Give the collector time to subscribe before we emit.
            delay(50)
            socket.append(stream = "MessageStream", key = "room", event = "MessageSent", payload = mapOf("body" to "hi"))
            val ack = ackDeferred.await()
            assertEquals(7, ack.cursor)
        } finally {
            socket.close()
        }
    }

    // removed: `subscribeDeliversDelta` + `subscribeObjectDeliversSnapshot`
    // exercised the packed Delta/Snapshot decode primitive against the
    // foundation's MessageStream/MessageSent/MessageDraft typeId tables.
    // The Framework Boundary Cleanup (see CHANGELOG.md) replaced the
    // shipped foundation schema with an empty one, so FRICK_STREAM_NAMES
    // / FRICK_OBJECT_NAMES no longer contain those ids — the decoder
    // can't resolve packed tuples with typeId=1 / typeId=7 and the tests
    // hung waiting for events that never decoded. The packed-decode
    // primitive itself still ships and is reachable once an app schema
    // populates the typeId tables.

    @Test
    fun objectUpsertConflictNacks() = runBlocking {
        enqueueWebSocketHandler(
            onMessage = { _, frame ->
                when (frame.first) {
                    FrameKindCodes.HELLO -> sendFrame(
                        FrameKindCodes.HELLO_ACK,
                        mapOf(
                            "schemaHash" to FRICK_SCHEMA_HASH,
                            "schemaId" to FRICK_SCHEMA_ID,
                            "schemaRevision" to FRICK_SCHEMA_REVISION,
                            "schemaCompatibility" to mapOf("status" to "compatible"),
                            "serverCapabilities" to emptyMap<String, Any?>(),
                        ),
                    )
                    FrameKindCodes.OBJECT_UPSERT -> {
                        val requestId = frame.second["requestId"] as String
                        sendFrame(
                            FrameKindCodes.NACK,
                            mapOf(
                                "requestId" to requestId,
                                "code" to FrickErrorCodes.StorageConflict,
                                "message" to "version mismatch",
                                "error" to mapOf(
                                    "code" to FrickErrorCodes.StorageConflict,
                                    "message" to "version mismatch",
                                    "requestId" to requestId,
                                    "retryable" to false,
                                    "details" to mapOf("reason" to "version-precondition"),
                                ),
                            ),
                        )
                    }
                }
            },
        )
        val socket = newSocket()
        try {
            socket.awaitReady()
            val ex = try {
                socket.upsertObject(
                    type = "Conversation",
                    id = "c-1",
                    value = mapOf("title" to "x"),
                    expectedVersion = 0,
                )
                null
            } catch (e: FrickHttpException) {
                e
            }
            assertNotNull(ex)
            assertEquals(FrickErrorCodes.StorageConflict, ex!!.envelope?.code)
            assertEquals(JsonPrimitive("version-precondition"), ex.envelope?.details?.get("reason"))
        } finally {
            socket.close()
        }
    }

    @Test
    fun reconnectsAfterServerClose() = runBlocking {
        // First socket: send HelloAck then close.
        enqueueWebSocketHandler(
            onMessage = { ws, frame ->
                if (frame.first == FrameKindCodes.HELLO) {
                    sendFrame(
                        FrameKindCodes.HELLO_ACK,
                        mapOf(
                            "schemaHash" to FRICK_SCHEMA_HASH,
                            "schemaId" to FRICK_SCHEMA_ID,
                            "schemaRevision" to FRICK_SCHEMA_REVISION,
                            "schemaCompatibility" to mapOf("status" to "compatible"),
                            "serverCapabilities" to emptyMap<String, Any?>(),
                        ),
                    )
                    ws.close(1011, "test-close")
                }
            },
        )
        // Second socket: HelloAck again.
        enqueueWebSocketHandler(
            onMessage = { _, frame ->
                if (frame.first == FrameKindCodes.HELLO) {
                    sendFrame(
                        FrameKindCodes.HELLO_ACK,
                        mapOf(
                            "schemaHash" to FRICK_SCHEMA_HASH,
                            "schemaId" to FRICK_SCHEMA_ID,
                            "schemaRevision" to FRICK_SCHEMA_REVISION,
                            "schemaCompatibility" to mapOf("status" to "compatible"),
                            "serverCapabilities" to emptyMap<String, Any?>(),
                        ),
                    )
                }
            },
        )
        val socket = newSocket()
        try {
            // First hello
            val helloA = takeFrame()
            assertEquals(FrameKindCodes.HELLO, helloA.first)
            // Wait until the server-driven close propagates and a second HELLO arrives.
            val helloB = takeFrame(timeoutMs = 5_000)
            assertEquals(FrameKindCodes.HELLO, helloB.first)
        } finally {
            socket.close()
        }
    }

    @Test
    fun pendingAppendsFlushAfterReady() = runBlocking {
        enqueueWebSocketHandler(
            onMessage = { _, frame ->
                if (frame.first == FrameKindCodes.HELLO) {
                    // Delay before HelloAck so the append can queue.
                    Thread.sleep(150)
                    sendFrame(
                        FrameKindCodes.HELLO_ACK,
                        mapOf(
                            "schemaHash" to FRICK_SCHEMA_HASH,
                            "schemaId" to FRICK_SCHEMA_ID,
                            "schemaRevision" to FRICK_SCHEMA_REVISION,
                            "schemaCompatibility" to mapOf("status" to "compatible"),
                            "serverCapabilities" to emptyMap<String, Any?>(),
                        ),
                    )
                }
            },
        )
        val socket = newSocket()
        try {
            // Append immediately, before Ready is observed.
            socket.append("MessageStream", "k", "MessageSent", mapOf("body" to "hello"))
            // Drain frames: expect HELLO then APPEND in order.
            val first = takeFrame()
            assertEquals(FrameKindCodes.HELLO, first.first)
            val second = takeFrame(timeoutMs = 5_000)
            assertEquals(FrameKindCodes.APPEND, second.first)
        } finally {
            socket.close()
        }
    }

    @Test
    fun decodesPingAndPongs() = runBlocking {
        enqueueWebSocketHandler(
            onMessage = { _, frame ->
                if (frame.first == FrameKindCodes.HELLO) {
                    sendFrame(
                        FrameKindCodes.HELLO_ACK,
                        mapOf(
                            "schemaHash" to FRICK_SCHEMA_HASH,
                            "schemaId" to FRICK_SCHEMA_ID,
                            "schemaRevision" to FRICK_SCHEMA_REVISION,
                            "schemaCompatibility" to mapOf("status" to "compatible"),
                            "serverCapabilities" to emptyMap<String, Any?>(),
                        ),
                    )
                    sendFrame(FrameKindCodes.PING, mapOf("sentAt" to 42L))
                }
            },
        )
        val socket = newSocket()
        try {
            socket.awaitReady()
            // Discard HELLO, expect a PONG within a moment.
            takeFrame() // HELLO
            val pong = takeFrame(timeoutMs = 2_000)
            assertEquals(FrameKindCodes.PONG, pong.first)
            assertEquals(42L, (pong.second["sentAt"] as Number).toLong())
        } finally {
            socket.close()
        }
    }
}
