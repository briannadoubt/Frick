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
        config: FrickSyncSocketConfig = FrickSyncSocketConfig(
            replicaId = "test-replica",
            initialBackoffMs = 25,
            maxBackoffMs = 50,
            helloAckTimeoutMs = 2_000,
        ),
    ): FrickSyncSocket {
        val baseUrl = "http://${server.hostName}:${server.port}"
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
            assertEquals(FRICK_SCHEMA_HASH, frame.second["schemaHash"])
            @Suppress("UNCHECKED_CAST")
            val caps = frame.second["clientCapabilities"] as Map<String, Any?>
            assertEquals("android", caps["platform"])
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

    @Test
    fun subscribeDeliversDelta() = runBlocking {
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
                    FrameKindCodes.SUBSCRIBE -> sendFrame(
                        FrameKindCodes.DELTA,
                        mapOf(
                            "objects" to emptyList<Any?>(),
                            // PackedStreamEvent tuple:
                            //   [streamTypeId, streamKey, sequence, eventId, eventTypeId, packedFields]
                            // MessageStream = stream id 1, MessageSent = event id 1.
                            // packedFields = [[fieldId, value], ...] — MessageSent.body = field id 3.
                            "events" to listOf(
                                listOf(
                                    1,
                                    "room",
                                    1,
                                    "evt-1",
                                    1,
                                    listOf(listOf(3, "hello")),
                                ),
                            ),
                            "cursor" to 1,
                        ),
                    )
                }
            },
        )
        val socket = newSocket()
        try {
            socket.awaitReady()
            @OptIn(DelicateCoroutinesApi::class)
            val deltaDeferred = GlobalScope.async {
                withTimeout(2_000) {
                    socket.events.filter { it is FrickInboundEvent.Delta }.first() as FrickInboundEvent.Delta
                }
            }
            delay(50)
            socket.subscribe(stream = "MessageStream", key = "room")
            val delta = deltaDeferred.await()
            assertEquals(1, delta.cursor)
            assertEquals(1, delta.events.size)
            val event = delta.events.first()
            assertEquals("MessageStream", event["stream"])
            assertEquals("room", event["streamId"])
            assertEquals(1, event["sequence"])
            assertEquals("evt-1", event["eventId"])
            assertEquals("MessageSent", event["event"])
            @Suppress("UNCHECKED_CAST")
            val payload = event["payload"] as Map<String, Any?>
            assertEquals("hello", payload["body"])
        } finally {
            socket.close()
        }
    }

    @Test
    fun draftStoreObservesSnapshotAndPersistsUpsert() = runBlocking {
        // End-to-end through FrickSyncSocket: the store subscribes to
        // MessageDraft, the server replies with a Snapshot row, the
        // store's `flowDraft` emits the body. Then `setDraft` goes out
        // as an ObjectUpsert frame; the server acks with version 1.
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
                    FrameKindCodes.SUBSCRIBE -> {
                        assertEquals("object", frame.second["kind"])
                        assertEquals("MessageDraft", frame.second["name"])
                        sendFrame(
                            FrameKindCodes.SNAPSHOT,
                            mapOf(
                                "objects" to listOf(
                                    listOf(
                                        7,
                                        "user-ada:convo-1",
                                        listOf(listOf(3, "from another device")),
                                    ),
                                ),
                                "cursor" to 0,
                            ),
                        )
                    }
                    FrameKindCodes.OBJECT_UPSERT -> {
                        // Verify the upsert payload shape and ack so the
                        // store's setDraft call doesn't hang on the await.
                        assertEquals("MessageDraft", frame.second["objectType"])
                        assertEquals("user-ada:convo-1", frame.second["objectId"])
                        val requestId = frame.second["requestId"] as String
                        sendFrame(
                            FrameKindCodes.ACK,
                            mapOf("requestId" to requestId, "version" to 1),
                        )
                    }
                }
            },
        )
        val socket = newSocket()
        try {
            socket.awaitReady()
            val store = FrickDraftStore(socket = socket, userId = "user-ada")
            val flow = store.flowDraft(conversationId = "convo-1")
            @OptIn(DelicateCoroutinesApi::class)
            val firstDeferred = GlobalScope.async {
                withTimeout(2_000) { flow.filter { it.isNotEmpty() }.first() }
            }
            val firstEmission = firstDeferred.await()
            assertEquals("from another device", firstEmission)

            // Now setDraft → upsert frame → ack → returns the new version.
            val writeResult = store.setDraft(conversationId = "convo-1", body = "typing here")
            assertEquals(1, writeResult.getOrNull())
        } finally {
            socket.close()
        }
    }

    @Test
    fun subscribeObjectDeliversSnapshot() = runBlocking {
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
                    FrameKindCodes.SUBSCRIBE -> {
                        // Verify the subscribe payload shape and reply with
                        // a Snapshot frame carrying a single MessageDraft row.
                        assertEquals("object", frame.second["kind"])
                        assertEquals("MessageDraft", frame.second["name"])
                        // PackedObjectRecord tuple = [typeId, id, packedFields].
                        // MessageDraft = object id 7; field 3 is `body`.
                        sendFrame(
                            FrameKindCodes.SNAPSHOT,
                            mapOf(
                                "objects" to listOf(
                                    listOf(
                                        7,
                                        "user-ada:conv-1",
                                        listOf(listOf(3, "draft body")),
                                    ),
                                ),
                                "cursor" to 0,
                            ),
                        )
                    }
                }
            },
        )
        val socket = newSocket()
        try {
            socket.awaitReady()
            @OptIn(DelicateCoroutinesApi::class)
            val deltaDeferred = GlobalScope.async {
                withTimeout(2_000) {
                    socket.events.filter { it is FrickInboundEvent.Delta }.first() as FrickInboundEvent.Delta
                }
            }
            delay(50)
            socket.subscribeObject(type = "MessageDraft")
            val snapshot = deltaDeferred.await()
            assertEquals(0, snapshot.cursor)
            assertEquals(0, snapshot.events.size)
            assertEquals(1, snapshot.objects.size)
            val record = snapshot.objects.first()
            assertEquals("MessageDraft", record["type"])
            assertEquals("user-ada:conv-1", record["id"])
            @Suppress("UNCHECKED_CAST")
            val value = record["value"] as Map<String, Any?>
            assertEquals("draft body", value["body"])
        } finally {
            socket.close()
        }
    }

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
