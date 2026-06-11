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

    // FR-256 client half (FR-291): the opt-in `…Registered` subscribe methods
    // resolve only once the server's post-registration reply arrives. withTimeout
    // makes a broken await fail the test instead of hanging it.

    @Test
    fun subscribeObjectRegisteredResolvesAfterSnapshot() = runBlocking {
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
                    FrameKindCodes.SUBSCRIBE -> if (frame.second["kind"] == "object") {
                        sendFrame(
                            FrameKindCodes.SNAPSHOT,
                            mapOf(
                                "subscriptionId" to frame.second["subscriptionId"],
                                "objects" to emptyList<Any?>(),
                                "cursor" to 0,
                            ),
                        )
                    }
                }
            },
        )
        val socket = newSocket()
        try {
            assertNotNull(withTimeout(2_000) { socket.awaitReady() })
            // Resolves when the server's Snapshot for this subscription arrives.
            withTimeout(10_000) { socket.subscribeObjectRegistered("Account") }
        } finally {
            socket.close()
        }
    }

    @Test
    fun subscribeStreamRegisteredResolvesAfterStreamPage() = runBlocking {
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
                    FrameKindCodes.SUBSCRIBE -> if (frame.second["kind"] == "stream") {
                        sendFrame(
                            FrameKindCodes.STREAM_PAGE,
                            mapOf(
                                "subscriptionId" to frame.second["subscriptionId"],
                                "events" to emptyList<Any?>(),
                                "cursor" to 0,
                                "hasMore" to false,
                            ),
                        )
                    }
                }
            },
        )
        val socket = newSocket()
        try {
            assertNotNull(withTimeout(2_000) { socket.awaitReady() })
            withTimeout(10_000) { socket.subscribeStreamRegistered("MessageStream", "c1") }
        } finally {
            socket.close()
        }
    }

    @Test
    fun subscribeProjectionRegisteredResolvesAfterProjectionDelta() = runBlocking {
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
                    FrameKindCodes.SUBSCRIBE -> if (frame.second["kind"] == "projection") {
                        // Projections correlate by name (the frame carries it).
                        sendFrame(
                            FrameKindCodes.PROJECTION_DELTA,
                            mapOf("projection" to frame.second["name"], "changes" to emptyList<Any?>()),
                        )
                    }
                }
            },
        )
        val socket = newSocket()
        try {
            assertNotNull(withTimeout(2_000) { socket.awaitReady() })
            withTimeout(10_000) { socket.subscribeProjectionRegistered("Inbox") }
        } finally {
            socket.close()
        }
    }

    @Test
    fun subscribeObjectRegisteredResolvesOnServerCloseWithoutSnapshot() = runBlocking {
        // Server acks Hello, then closes the connection on the Subscribe WITHOUT
        // ever sending the snapshot — the drain (failPendingRequests →
        // resolveAllSubscriptionRegistrations) must unblock the awaiter instead
        // of stranding it, mirroring the Swift close-drain test (FR-256).
        enqueueWebSocketHandler(
            onMessage = { ws, frame ->
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
                    FrameKindCodes.SUBSCRIBE -> ws.close(1011, "server-gone")
                }
            },
        )
        val socket = newSocket()
        try {
            assertNotNull(withTimeout(2_000) { socket.awaitReady() })
            // Resolves (does not hang) because the close drains the waiter.
            withTimeout(10_000) { socket.subscribeObjectRegistered("Account") }
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
    fun deltaRemovedSurfacesObjectRemovals() = runBlocking {
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
            socket.awaitReady()
            @OptIn(DelicateCoroutinesApi::class)
            val deltaDeferred = GlobalScope.async {
                withTimeout(2_000) {
                    socket.events.filter { it is FrickInboundEvent.Delta }.first() as FrickInboundEvent.Delta
                }
            }
            // Give the collector time to subscribe before we emit.
            delay(50)
            sendFrame(
                FrameKindCodes.DELTA,
                mapOf(
                    "cursor" to 9,
                    "objects" to emptyList<Any?>(),
                    "events" to emptyList<Any?>(),
                    "removed" to listOf(
                        mapOf("type" to "Message", "id" to "msg-1"),
                    ),
                ),
            )
            val delta = deltaDeferred.await()
            assertEquals(9, delta.cursor)
            assertEquals(1, delta.removed.size)
            assertEquals(ObjectRemoval("Message", "msg-1"), delta.removed[0])
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
    fun upsertObjectFailsAwaiterWhenSocketClosesWithoutAck() = runBlocking {
        // Server acks the Hello but never replies to the ObjectUpsert.
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
            socket.awaitReady()
            @OptIn(DelicateCoroutinesApi::class)
            val upsertDeferred = GlobalScope.async {
                withTimeout(2_000) {
                    try {
                        socket.upsertObject(type = "Conversation", id = "c-1", value = mapOf("title" to "x"))
                        null
                    } catch (e: FrickHttpException) {
                        e
                    }
                }
            }
            delay(100) // let the upsert frame go out and register its deferred
            // Drop the connection mid-flight: the awaiter must resume with an
            // error rather than hang forever.
            socket.close()
            val error = upsertDeferred.await()
            assertNotNull(error)
            assertEquals(FrickErrorCodes.SyncReconnectExhausted, error!!.envelope?.code)
        } finally {
            socket.close()
        }
    }

    @Test
    fun upsertObjectFailsAwaiterOnServerInitiatedClose() = runBlocking {
        // Server acks Hello, then closes the connection abnormally without ever
        // acking the upsert — exercises the onClosed drain path.
        enqueueWebSocketHandler(
            onMessage = { ws, frame ->
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
                    FrameKindCodes.OBJECT_UPSERT -> ws.close(1011, "server-gone")
                }
            },
        )
        val socket = newSocket()
        try {
            socket.awaitReady()
            val error = withTimeout(3_000) {
                try {
                    socket.upsertObject(type = "Conversation", id = "c-1", value = mapOf("title" to "x"))
                    null
                } catch (e: FrickHttpException) {
                    e
                }
            }
            assertNotNull(error)
            assertEquals(FrickErrorCodes.SyncReconnectExhausted, error!!.envelope?.code)
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

    // -- native-android-4: decode-path DoS bounds -----------------------------

    @Test
    fun decodeRejectsArrayHeaderClaimingAbsurdLengthWithoutOom() {
        // A tiny frame whose inner payload position declares a ~2.1e9-element
        // array. Pre-sizing or even looping that would OOM/spin; the decoder must
        // reject it as a bounds violation instead.
        val out = java.io.ByteArrayOutputStream()
        org.msgpack.core.MessagePack.newDefaultPacker(out).use { packer ->
            packer.packArrayHeader(2) // [kind, payload]
            packer.packInt(FrameKindCodes.DELTA)
            packer.packArrayHeader(Int.MAX_VALUE) // payload position: bogus huge array
            // No elements follow — the header alone is the attack.
        }
        val ex = try {
            FrickMsgPack.decodeFrame(out.toByteArray())
            null
        } catch (e: Throwable) {
            e
        }
        assertNotNull(ex)
        assertTrue(ex is FrickMsgPack.DecodeBoundsException)
    }

    @Test
    fun decodeRejectsMapHeaderClaimingAbsurdLength() {
        val out = java.io.ByteArrayOutputStream()
        org.msgpack.core.MessagePack.newDefaultPacker(out).use { packer ->
            packer.packArrayHeader(2)
            packer.packInt(FrameKindCodes.DELTA)
            packer.packMapHeader(Int.MAX_VALUE) // bogus huge map
        }
        val ex = try {
            FrickMsgPack.decodeFrame(out.toByteArray())
            null
        } catch (e: Throwable) {
            e
        }
        assertNotNull(ex)
        assertTrue(ex is FrickMsgPack.DecodeBoundsException)
    }

    @Test
    fun decodeRejectsDeeplyNestedFrameInsteadOfStackOverflow() {
        // Nest arrays far past MAX_DEPTH. Unbounded recursion would StackOverflow;
        // the decoder must throw a bounded DecodeBoundsException.
        val out = java.io.ByteArrayOutputStream()
        org.msgpack.core.MessagePack.newDefaultPacker(out).use { packer ->
            packer.packArrayHeader(2)
            packer.packInt(FrameKindCodes.DELTA)
            // payload position: a chain of single-element arrays, deeper than the cap.
            repeat(FrickMsgPack.MAX_DEPTH + 50) { packer.packArrayHeader(1) }
            packer.packNil()
        }
        val ex = try {
            FrickMsgPack.decodeFrame(out.toByteArray())
            null
        } catch (e: Throwable) {
            e
        }
        assertNotNull(ex)
        assertTrue(ex is FrickMsgPack.DecodeBoundsException)
    }

    @Test
    fun onMessageSurfacesDecodeBoundsAsFailedStatusWithoutCrashing() = runBlocking {
        // The malicious frame arrives over the live socket: onMessage must catch
        // the bounds error and flip status to Failed rather than crash the process.
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
                    // Then a hostile frame with a bogus huge array header.
                    val out = java.io.ByteArrayOutputStream()
                    org.msgpack.core.MessagePack.newDefaultPacker(out).use { packer ->
                        packer.packArrayHeader(2)
                        packer.packInt(FrameKindCodes.DELTA)
                        packer.packArrayHeader(Int.MAX_VALUE)
                    }
                    serverSocket?.send(out.toByteArray().toByteString())
                }
            },
        )
        val socket = newSocket()
        try {
            socket.awaitReady()
            val failed = withTimeout(2_000) {
                socket.status.filter { it is FrickSyncStatus.Failed }.first() as FrickSyncStatus.Failed
            }
            assertTrue(failed.reason.startsWith("decode:"))
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
