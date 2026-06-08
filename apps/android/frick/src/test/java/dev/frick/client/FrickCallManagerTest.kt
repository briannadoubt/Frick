package dev.frick.client

import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * FR-15 (FR-80 / FR-82) call client coverage.
 *
 * Two halves:
 *  - The socket-level request/response: a fake WebSocket server captures the
 *    encoded `CallCommand` (kind 21) frame and replies with a
 *    `CallCommandResult` (kind 22) or a `Nack`, asserting [FrickSyncSocket.callCommand]
 *    encodes the command and correlates the reply by requestId.
 *  - The observable [FrickCallManager.state]: injected [FrickInboundEvent.Delta]s
 *    drive the StateFlow across room + participant snapshots, media-state
 *    mutations (FR-82), and removals — without standing up a socket.
 */
class FrickCallManagerTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private val received = LinkedBlockingDeque<Pair<Int, Map<String, Any?>>>()
    private var serverSocket: WebSocket? = null

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build()
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
        onMessage: (WebSocket, Pair<Int, Map<String, Any?>>) -> Unit = { _, _ -> },
    ) {
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                serverSocket = webSocket
            }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                val decoded = FrickMsgPack.decodeFrame(bytes.toByteArray()) ?: return
                received.add(decoded)
                onMessage(webSocket, decoded)
            }
        }
        server.enqueue(MockResponse.Builder().webSocketUpgrade(listener).build())
    }

    private fun sendHelloAck(webSocket: WebSocket) {
        webSocket.send(
            FrickMsgPack.encodeFrame(
                FrameKindCodes.HELLO_ACK,
                mapOf(
                    "schemaHash" to FRICK_SCHEMA_HASH,
                    "schemaId" to FRICK_SCHEMA_ID,
                    "schemaRevision" to FRICK_SCHEMA_REVISION,
                ),
            ).toByteString(),
        )
    }

    private fun newSocket(): FrickSyncSocket =
        FrickSyncSocket(
            baseUrl = "http://${server.hostName}:${server.port}",
            sessionTokenProvider = { "test-token" },
            config = FrickSyncSocketConfig(
                replicaId = "test-replica",
                initialBackoffMs = 25,
                maxBackoffMs = 50,
                helloAckTimeoutMs = 2_000,
            ),
            httpClient = client,
        ).also { it.connect() }

    private fun frameOfKind(kind: Int): Pair<Int, Map<String, Any?>>? =
        received.firstOrNull { it.first == kind }

    // ----- socket-level CallCommand encode + result correlation -----

    @Test
    fun callCommandEncodesCommandAndResolvesOnResult() = runBlocking {
        // Server replies HelloAck on HELLO, then echoes a CallCommandResult keyed
        // by the requestId of the inbound CallCommand frame.
        enqueueWebSocketHandler(
            onMessage = { ws, frame ->
                when (frame.first) {
                    FrameKindCodes.HELLO -> sendHelloAck(ws)
                    FrameKindCodes.CALL_COMMAND -> {
                        val requestId = frame.second["requestId"] as String
                        ws.send(
                            FrickMsgPack.encodeFrame(
                                FrameKindCodes.CALL_COMMAND_RESULT,
                                mapOf(
                                    "requestId" to requestId,
                                    "op" to "join",
                                    "room" to mapOf(
                                        "id" to "call-1",
                                        "conversationId" to "conv-1",
                                        "state" to "active",
                                        "createdBy" to "u1",
                                        "kind" to "video",
                                        "createdAt" to "t0",
                                    ),
                                ),
                            ).toByteString(),
                        )
                    }
                }
            },
        )
        val socket = newSocket()
        try {
            socket.awaitReady()
            val result = withTimeout(3_000) {
                socket.callCommand(mapOf("op" to "join", "callId" to "call-1"))
            }

            // The CallCommand frame was encoded with the command body intact.
            val sent = frameOfKind(FrameKindCodes.CALL_COMMAND)
                ?: error("no CallCommand frame captured")
            @Suppress("UNCHECKED_CAST")
            val command = sent.second["command"] as Map<String, Any?>
            assertEquals("join", command["op"])
            assertEquals("call-1", command["callId"])

            assertTrue(result is CallCommandResult.Ok)
            assertEquals("join", (result as CallCommandResult.Ok).op)
            assertEquals("call-1", result.result.mapField("room")?.get("id"))
        } finally {
            socket.close()
        }
    }

    @Test
    fun callCommandNackResolvesAsFailureByRequestId() = runBlocking {
        enqueueWebSocketHandler(
            onMessage = { ws, frame ->
                when (frame.first) {
                    FrameKindCodes.HELLO -> sendHelloAck(ws)
                    FrameKindCodes.CALL_COMMAND -> {
                        val requestId = frame.second["requestId"] as String
                        ws.send(
                            FrickMsgPack.encodeFrame(
                                FrameKindCodes.NACK,
                                mapOf(
                                    "requestId" to requestId,
                                    "error" to mapOf(
                                        "code" to "auth.forbidden",
                                        "message" to "only the creator may end the call",
                                        "requestId" to requestId,
                                        "retryable" to false,
                                    ),
                                ),
                            ).toByteString(),
                        )
                    }
                }
            },
        )
        val socket = newSocket()
        try {
            socket.awaitReady()
            val result = withTimeout(3_000) {
                socket.callCommand(mapOf("op" to "end", "callId" to "call-x"))
            }
            assertTrue(result is CallCommandResult.Failed)
            assertEquals("auth.forbidden", (result as CallCommandResult.Failed).envelope.code)
        } finally {
            socket.close()
        }
    }

    // ----- FrickCallManager observable state (FR-82) -----

    private fun newManager(socket: FrickSyncSocket): FrickCallManager =
        FrickCallManager(socket = socket, callId = "call-1")

    private fun roomRecord(state: String): Map<String, Any?> =
        mapOf(
            "type" to CALL_ROOM_TYPE,
            "id" to "call-1",
            "value" to mapOf(
                "id" to "call-1",
                "conversationId" to "conv-1",
                "state" to state,
                "createdBy" to "u1",
                "kind" to "video",
                "createdAt" to "t0",
            ),
        )

    private fun participantRecord(
        id: String,
        userId: String,
        deviceId: String = "d1",
        mic: Boolean = true,
        camera: Boolean = false,
        screen: Boolean = false,
        speaking: Boolean? = null,
        networkQuality: String? = null,
        callId: String = "call-1",
        state: String = "joined",
    ): Map<String, Any?> =
        mapOf(
            "type" to CALL_PARTICIPANT_TYPE,
            "id" to id,
            "value" to buildMap {
                put("id", id)
                put("callId", callId)
                put("userId", userId)
                put("deviceId", deviceId)
                put("state", state)
                put("joinedAt", "t0")
                put("micEnabled", mic)
                put("cameraEnabled", camera)
                put("screenSharing", screen)
                speaking?.let { put("speaking", it) }
                networkQuality?.let { put("networkQuality", it) }
            },
        )

    private fun delta(
        objects: List<Map<String, Any?>>,
        removed: List<ObjectRemoval> = emptyList(),
    ): FrickInboundEvent.Delta =
        FrickInboundEvent.Delta(objects = objects, events = emptyList(), cursor = 0, removed = removed)

    private fun newSocketStub(): FrickSyncSocket =
        FrickSyncSocket(
            baseUrl = "http://example.invalid",
            sessionTokenProvider = { null },
            config = FrickSyncSocketConfig(),
            httpClient = OkHttpClient(),
        )

    @Test
    fun stateComposesRoomAndParticipants() {
        val socket = newSocketStub()
        val manager = newManager(socket)
        try {
            assertNull(manager.state.value.room)
            assertTrue(manager.state.value.participants.isEmpty())

            manager.onEvent(
                delta(
                    listOf(
                        roomRecord("active"),
                        participantRecord("p2", userId = "u2", mic = true, camera = true),
                        participantRecord("p1", userId = "u1", mic = false),
                    ),
                ),
            )

            val s = manager.state.value
            assertEquals(CallRoomState.Active, s.room?.state)
            assertEquals(CallKind.Video, s.room?.kind)
            assertTrue(s.isActive)
            // Stable sort by userId then deviceId.
            assertEquals(listOf("u1", "u2"), s.participants.map { it.userId })
            assertEquals(false, s.participants[0].micEnabled)
            assertEquals(true, s.participants[1].cameraEnabled)
        } finally {
            manager.close()
            socket.close()
        }
    }

    @Test
    fun mediaStateMutationUpdatesParticipantPresence() {
        val socket = newSocketStub()
        val manager = newManager(socket)
        try {
            manager.onEvent(delta(listOf(participantRecord("p1", userId = "u1", mic = true))))
            assertEquals(true, manager.state.value.participants.single().micEnabled)

            // FR-82: a live delta flips mic off and reports speaking + quality.
            manager.onEvent(
                delta(
                    listOf(
                        participantRecord(
                            "p1", userId = "u1", mic = false,
                            speaking = true, networkQuality = "good",
                        ),
                    ),
                ),
            )

            val p = manager.state.value.participants.single()
            assertEquals(false, p.micEnabled)
            assertEquals(true, p.speaking)
            assertEquals(CallNetworkQuality.Good, p.networkQuality)
        } finally {
            manager.close()
            socket.close()
        }
    }

    @Test
    fun presenceDefaultsWhenAdapterReportsNothing() {
        val socket = newSocketStub()
        val manager = newManager(socket)
        try {
            manager.onEvent(delta(listOf(participantRecord("p1", userId = "u1"))))
            val p = manager.state.value.participants.single()
            // speaking/networkQuality default to false/unknown when absent.
            assertEquals(false, p.speaking)
            assertEquals(CallNetworkQuality.Unknown, p.networkQuality)
        } finally {
            manager.close()
            socket.close()
        }
    }

    @Test
    fun ignoresRecordsForOtherCalls() {
        val socket = newSocketStub()
        val manager = newManager(socket)
        try {
            manager.onEvent(
                delta(
                    listOf(
                        participantRecord("p1", userId = "u1"),
                        participantRecord("pX", userId = "uX", callId = "other-call"),
                    ),
                ),
            )
            assertEquals(listOf("u1"), manager.state.value.participants.map { it.userId })
        } finally {
            manager.close()
            socket.close()
        }
    }

    @Test
    fun removedParticipantLeavesState() {
        val socket = newSocketStub()
        val manager = newManager(socket)
        try {
            manager.onEvent(
                delta(
                    listOf(
                        participantRecord("p1", userId = "u1"),
                        participantRecord("p2", userId = "u2"),
                    ),
                ),
            )
            assertEquals(2, manager.state.value.participants.size)

            manager.onEvent(delta(objects = emptyList(), removed = listOf(ObjectRemoval(CALL_PARTICIPANT_TYPE, "p2"))))

            assertEquals(listOf("u1"), manager.state.value.participants.map { it.userId })
        } finally {
            manager.close()
            socket.close()
        }
    }

    @Test
    fun endedRoomFlagsState() {
        val socket = newSocketStub()
        val manager = newManager(socket)
        try {
            manager.onEvent(delta(listOf(roomRecord("ringing"))))
            assertEquals(false, manager.state.value.isActive)

            manager.onEvent(delta(listOf(roomRecord("ended"))))
            assertTrue(manager.state.value.isEnded)
        } finally {
            manager.close()
            socket.close()
        }
    }
}
