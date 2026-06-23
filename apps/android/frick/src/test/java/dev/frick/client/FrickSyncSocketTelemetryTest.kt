package dev.frick.client

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
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
 * Generous upper bound for the connect/handshake waits. These tests drive a
 * real in-process socket on shared CI runners; a tight bound (the old 1–2s)
 * flakes under load. No wait here asserts the timeout fires, so the ceiling
 * only needs to be high enough to never trip spuriously.
 */
private const val TEST_TIMEOUT_MS = 15_000L

/**
 * Verifies FrickSyncSocket emits the OpenTelemetry-style span + metrics that
 * mirror the TS client (packages/core/src/runtime.ts) and Swift FR-74:
 *  - one client span `"WebSocket /_frick/sync"` at connect with the shared
 *    attributes, finished on close with status + close-code/category;
 *  - per-frame counters `frick.client.ws.frames.{sent,received}.total`;
 *  - a `frick.client.ws.connection.duration_ms` histogram on close.
 */
class FrickSyncSocketTelemetryTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private var serverSocket: WebSocket? = null

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
        serverSocket = null
    }

    @After
    fun tearDown() {
        client.dispatcher.executorService.shutdownNow()
        client.connectionPool.evictAll()
        runCatching { server.close() }
    }

    /** Records every span lifecycle event + metric for assertions. */
    private class RecordingSpan(
        val name: String,
        val kind: FrickClientTelemetrySpanKind,
        val startAttributes: Map<String, JsonPrimitive>,
    ) : FrickClientTelemetrySpan {
        @Volatile var ended: Boolean = false
        @Volatile var endStatus: FrickClientTelemetrySpanStatus? = null
        @Volatile var endAttributes: Map<String, JsonPrimitive> = emptyMap()

        override fun end(result: FrickClientTelemetrySpanResult?) {
            ended = true
            endStatus = result?.status
            endAttributes = result?.attributes ?: emptyMap()
        }
    }

    private class CounterRecord(val name: String, val value: Double, val attributes: Map<String, JsonPrimitive>)
    private class HistogramRecord(val name: String, val value: Double, val attributes: Map<String, JsonPrimitive>)

    private class RecordingTelemetry : FrickClientTelemetryRuntime {
        val spans = CopyOnWriteArrayList<RecordingSpan>()
        val counters = CopyOnWriteArrayList<CounterRecord>()
        val histograms = CopyOnWriteArrayList<HistogramRecord>()

        override fun startSpan(input: FrickClientTelemetrySpanStart): FrickClientTelemetrySpan {
            val span = RecordingSpan(input.name, input.kind, input.attributes)
            spans.add(span)
            return span
        }

        override fun recordCounter(name: String, value: Double, attributes: Map<String, JsonPrimitive>) {
            counters.add(CounterRecord(name, value, attributes))
        }

        override fun recordHistogram(name: String, value: Double, attributes: Map<String, JsonPrimitive>) {
            histograms.add(HistogramRecord(name, value, attributes))
        }

        fun counterKinds(name: String): List<String> =
            counters.filter { it.name == name }.mapNotNull { it.attributes["kind"]?.content }
    }

    private fun enqueueHandler(onMessage: (WebSocket, Pair<Int, Map<String, Any?>>) -> Unit) {
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                serverSocket = webSocket
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                val decoded = FrickMsgPack.decodeFrame(bytes.toByteArray()) ?: return
                onMessage(webSocket, decoded)
            }
        }
        server.enqueue(MockResponse.Builder().webSocketUpgrade(listener).build())
    }

    private fun helloAckPayload(): Map<String, Any?> = mapOf(
        "schemaHash" to FRICK_SCHEMA_HASH,
        "schemaId" to FRICK_SCHEMA_ID,
        "schemaRevision" to FRICK_SCHEMA_REVISION,
        "schemaCompatibility" to mapOf("status" to "compatible"),
        "serverCapabilities" to emptyMap<String, Any?>(),
    )

    private fun newSocket(telemetry: FrickClientTelemetryRuntime): FrickSyncSocket =
        FrickSyncSocket(
            baseUrl = "http://${server.hostName}:${server.port}",
            sessionTokenProvider = { "test-token" },
            config = FrickSyncSocketConfig(
                replicaId = "test-replica",
                initialBackoffMs = 25,
                maxBackoffMs = 50,
                helloAckTimeoutMs = TEST_TIMEOUT_MS,
            ),
            httpClient = client,
            telemetry = telemetry,
        ).also { it.connect() }

    @Test
    fun emitsSpanFramesAndHistogramAcrossConnectAndClose() = runBlocking {
        val telemetry = RecordingTelemetry()
        enqueueHandler { _, frame ->
            if (frame.first == FrameKindCodes.HELLO) {
                serverSocket?.send(FrickMsgPack.encodeFrame(FrameKindCodes.HELLO_ACK, helloAckPayload()).toByteString())
            }
        }
        val socket = newSocket(telemetry)
        withTimeout(TEST_TIMEOUT_MS) { socket.awaitReady() }
        // Wait for the inbound HelloAck counter to record (poll, not a fixed
        // sleep, so the assertions don't flake under CI load).
        awaitUntil { "HelloAck" in telemetry.counterKinds("frick.client.ws.frames.received.total") }

        // Exactly one connection span, with the mirrored attributes.
        assertEquals(1, telemetry.spans.size)
        val span = telemetry.spans.first()
        assertEquals("WebSocket /_frick/sync", span.name)
        assertEquals(FrickClientTelemetrySpanKind.CLIENT, span.kind)
        assertEquals(JsonPrimitive("websocket"), span.startAttributes["network.protocol.name"])
        assertEquals(JsonPrimitive("/_frick/sync"), span.startAttributes["url.path"])
        assertEquals(JsonPrimitive(FRICK_SCHEMA_ID), span.startAttributes["frick.schema_id"])
        assertEquals(JsonPrimitive(FRICK_SCHEMA_REVISION), span.startAttributes["frick.schema_revision"])
        assertEquals(JsonPrimitive(true), span.startAttributes["frick.authenticated"])
        assertTrue("span should be live before close", !span.ended)

        // Sent Hello + received HelloAck counters, labelled by kind.
        assertTrue("Hello" in telemetry.counterKinds("frick.client.ws.frames.sent.total"))
        assertTrue("HelloAck" in telemetry.counterKinds("frick.client.ws.frames.received.total"))

        socket.close()
        // Wait for the close to finish the span (poll, not a fixed sleep).
        awaitUntil { span.ended }

        // Span finished exactly once: normal close → ok status + category.
        assertTrue("span should be ended after close", span.ended)
        assertEquals(FrickClientTelemetrySpanStatus.OK, span.endStatus)
        assertEquals(JsonPrimitive(1000), span.endAttributes["frick.ws.close_code"])
        assertEquals(JsonPrimitive("normal"), span.endAttributes["frick.ws.close_category"])

        // Connection-duration histogram recorded once, labelled by close category.
        val durations = telemetry.histograms.filter { it.name == "frick.client.ws.connection.duration_ms" }
        assertEquals(1, durations.size)
        assertEquals(JsonPrimitive("normal"), durations.first().attributes["closeCategory"])
        assertTrue("duration should be non-negative", durations.first().value >= 0.0)
    }

    @Test
    fun authenticatedAttributeFalseWhenNoSessionToken() = runBlocking {
        val telemetry = RecordingTelemetry()
        enqueueHandler { _, _ -> }
        val socket = FrickSyncSocket(
            baseUrl = "http://${server.hostName}:${server.port}",
            sessionTokenProvider = { null },
            config = FrickSyncSocketConfig(replicaId = "test-replica", helloAckTimeoutMs = TEST_TIMEOUT_MS),
            httpClient = client,
            telemetry = telemetry,
        ).also { it.connect() }
        try {
            // Wait for the span to open.
            withTimeout(TEST_TIMEOUT_MS) {
                while (telemetry.spans.isEmpty()) Thread.sleep(20)
            }
            assertEquals(JsonPrimitive(false), telemetry.spans.first().startAttributes["frick.authenticated"])
        } finally {
            socket.close()
        }
    }

    /** Poll until [condition] holds or the timeout elapses — avoids fixed-sleep flakiness under CI load. */
    private fun awaitUntil(timeoutMs: Long = TEST_TIMEOUT_MS, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!condition() && System.currentTimeMillis() < deadline) Thread.sleep(10)
    }

    @Test
    fun defaultsToNoopTelemetryWithNoCrash() = runBlocking {
        // No telemetry argument → NoopFrickClientTelemetryRuntime; behavior unchanged.
        enqueueHandler { _, frame ->
            if (frame.first == FrameKindCodes.HELLO) {
                serverSocket?.send(FrickMsgPack.encodeFrame(FrameKindCodes.HELLO_ACK, helloAckPayload()).toByteString())
            }
        }
        val socket = FrickSyncSocket(
            baseUrl = "http://${server.hostName}:${server.port}",
            sessionTokenProvider = { "test-token" },
            config = FrickSyncSocketConfig(replicaId = "test-replica", helloAckTimeoutMs = TEST_TIMEOUT_MS),
            httpClient = client,
        ).also { it.connect() }
        try {
            val ready = withTimeout(TEST_TIMEOUT_MS) { socket.awaitReady() }
            assertNotNull(ready)
        } finally {
            socket.close()
        }
    }

    @Test
    fun frameKindLabelMirrorsProtocolEnumNames() {
        assertEquals("Hello", frickFrameKindLabel(FrameKindCodes.HELLO))
        assertEquals("HelloAck", frickFrameKindLabel(FrameKindCodes.HELLO_ACK))
        assertEquals("ObjectUpsert", frickFrameKindLabel(FrameKindCodes.OBJECT_UPSERT))
        assertEquals("Pong", frickFrameKindLabel(FrameKindCodes.PONG))
        assertEquals("unknown", frickFrameKindLabel(9999))
    }

    @Test
    fun closeCategoryMirrorsTsSwitch() {
        assertEquals("normal", frickWebSocketCloseCategory(1000))
        assertEquals("internal_error", frickWebSocketCloseCategory(1011))
        assertEquals("abnormal", frickWebSocketCloseCategory(1006))
        assertEquals("private", frickWebSocketCloseCategory(4001))
        assertEquals("unknown", frickWebSocketCloseCategory(null))
        assertEquals("unknown", frickWebSocketCloseCategory(3001))
    }

    @Test
    fun urlPathMirrorsTsHelper() {
        assertEquals("/_frick/sync", frickWebSocketUrlPath("wss://host:443/_frick/sync"))
        assertEquals("/", frickWebSocketUrlPath("not a url"))
    }
}
