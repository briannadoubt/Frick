// NOTE: This file previously also tested the foundation chat surface
// (`UserDto`, `MessageSentDto`, `fetchInbox`, `sendMessage`,
// `createConversation`, `parseUsers`, `parseConversations`,
// `isVisibleChatMessage`, `streamMessages`, `fetchMessages`,
// `FrickInboxItem`, ...). Those nouns moved out of the SDK in the
// "Framework Boundary Cleanup" (see CHANGELOG.md) — apps now build them
// in their own schema and client layer — so the matching tests were
// removed. What remains exercises the framework primitives that still
// ship: chunked SSE parsing, auth/session, generic append/queue,
// signals, blobs, analytics, schema/cache compatibility, and the Ktor
// transport's authorization + error-envelope behavior.
package dev.frick.client

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.asFlow
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class FrickEventStreamParserTest {
    private val servers = mutableListOf<HttpServer>()

    @After
    fun stopServers() {
        servers.forEach { server -> server.stop(0) }
    }

    @Test
    fun parsesEventsSplitAcrossChunks() {
        val parser = FrickEventStreamParser()

        assertEquals(emptyList<FrickEvent>(), parser.push(": connected\n\n"))
        assertEquals(
            emptyList<FrickEvent>(),
            parser.push("event: delta\ndata: {\"stream\":\"AppStream\","),
        )

        val events = parser.push("\"sequence\":7}\n\n")

        assertEquals(1, events.size)
        assertEquals("delta", events[0].event)
        assertEquals("{\"stream\":\"AppStream\",\"sequence\":7}", events[0].data)
    }

    @Test
    fun devLoginPostsExpectedJsonAndStoresReturnedSession() = runBlocking {
        val storage = MemoryFrickStorage()
        val transport = FakeFrickTransport(
            postResponses = mapOf(
                "/auth/dev-login" to """
                    {
                      "schemaHash": "$FRICK_SCHEMA_HASH",
                      "sessionToken": "session-token-ada",
                      "tenantId": "tenant-alpha",
                      "userId": "user-ada",
                      "deviceId": "android-device",
                      "replicaId": "android-replica",
                      "expiresAt": "2026-05-09T22:00:00.000Z"
                    }
                """.trimIndent(),
            ),
        )
        val client = FrickClient(transport = transport, storage = storage)

        val session = client.devLogin(
            userId = "user-ada",
            deviceId = "android-device",
            replicaId = "android-replica",
            platform = "android",
        )

        assertEquals(
            FrickSession(
                schemaHash = FRICK_SCHEMA_HASH,
                sessionToken = "session-token-ada",
                tenantId = "tenant-alpha",
                userId = "user-ada",
                deviceId = "android-device",
                replicaId = "android-replica",
                expiresAt = "2026-05-09T22:00:00.000Z",
            ),
            session,
        )
        assertEquals(session, storage.loadSession())
        assertEquals("/auth/dev-login", transport.posts.single().path)
        val body = Json.parseToJsonElement(transport.posts.single().body).jsonObject
        assertEquals("user-ada", body.getValue("userId").jsonPrimitive.content)
        assertEquals("android-device", body.getValue("deviceId").jsonPrimitive.content)
        assertEquals("android-replica", body.getValue("replicaId").jsonPrimitive.content)
        assertEquals("android", body.getValue("platform").jsonPrimitive.content)
    }

    @Test
    fun signUpPostsAccountDetailsAndStoresReturnedSession() = runBlocking {
        val storage = MemoryFrickStorage()
        val transport = FakeFrickTransport(
            postResponses = mapOf(
                "/auth/signup" to """
                    {
                      "schemaHash": "$FRICK_SCHEMA_HASH",
                      "sessionToken": "session-token-dorothy",
                      "userId": "user-dorothy",
                      "displayName": "Dorothy Vaughan",
                      "handle": "dorothy",
                      "deviceId": "android-device",
                      "replicaId": "android-replica",
                      "expiresAt": "2026-05-09T22:00:00.000Z"
                    }
                """.trimIndent(),
            ),
        )
        val client = FrickClient(transport = transport, storage = storage)

        val session = client.signUp(
            displayName = "Dorothy Vaughan",
            handle = "dorothy",
            password = "foundation-secret",
            deviceId = "android-device",
            replicaId = "android-replica",
            platform = "android",
        )

        assertEquals("session-token-dorothy", session.sessionToken)
        assertEquals("user-dorothy", session.userId)
        assertEquals("Dorothy Vaughan", session.displayName)
        assertEquals("dorothy", session.handle)
        assertEquals(session, storage.loadSession())
        assertEquals("/auth/signup", transport.posts.single().path)
        val body = Json.parseToJsonElement(transport.posts.single().body).jsonObject
        assertEquals("Dorothy Vaughan", body.getValue("displayName").jsonPrimitive.content)
        assertEquals("dorothy", body.getValue("handle").jsonPrimitive.content)
        assertEquals("foundation-secret", body.getValue("password").jsonPrimitive.content)
        assertEquals("android-device", body.getValue("deviceId").jsonPrimitive.content)
        assertEquals("android-replica", body.getValue("replicaId").jsonPrimitive.content)
        assertEquals("android", body.getValue("platform").jsonPrimitive.content)
    }

    @Test
    fun loginPostsIdentityAndStoresReturnedSession() = runBlocking {
        val storage = MemoryFrickStorage()
        val transport = FakeFrickTransport(
            postResponses = mapOf(
                "/auth/login" to """
                    {
                      "schemaHash": "$FRICK_SCHEMA_HASH",
                      "sessionToken": "session-token-dorothy",
                      "userId": "user-dorothy",
                      "displayName": "Dorothy Vaughan",
                      "handle": "dorothy",
                      "deviceId": "android-device",
                      "replicaId": "android-replica",
                      "expiresAt": "2026-05-09T22:00:00.000Z"
                    }
                """.trimIndent(),
            ),
        )
        val client = FrickClient(transport = transport, storage = storage)

        val session = client.login(
            identity = "dorothy",
            password = "foundation-secret",
            deviceId = "android-device",
            replicaId = "android-replica",
            platform = "android",
        )

        assertEquals("session-token-dorothy", session.sessionToken)
        assertEquals("Dorothy Vaughan", session.displayName)
        assertEquals("dorothy", session.handle)
        assertEquals(session, storage.loadSession())
        assertEquals("/auth/login", transport.posts.single().path)
        val body = Json.parseToJsonElement(transport.posts.single().body).jsonObject
        assertEquals("dorothy", body.getValue("identity").jsonPrimitive.content)
        assertEquals("foundation-secret", body.getValue("password").jsonPrimitive.content)
        assertEquals("android-device", body.getValue("deviceId").jsonPrimitive.content)
        assertEquals("android-replica", body.getValue("replicaId").jsonPrimitive.content)
        assertEquals("android", body.getValue("platform").jsonPrimitive.content)
    }

    @Test
    fun trackPostsProductAnalyticsWithStoredSession() = runBlocking {
        val storage = MemoryFrickStorage(session = testSession())
        val transport = FakeFrickTransport(
            postResponses = mapOf(
                "/analytics/events" to """
                    {
                      "ok": true,
                      "eventId": "platform-event-android-1",
                      "sequence": 2147483648,
                      "acceptedAt": "2026-05-17T12:00:00.000Z",
                      "duplicate": false
                    }
                """.trimIndent(),
            ),
        )
        val client = FrickClient(transport = transport, storage = storage)

        val receipt = client.track(
            name = "screen.viewed",
            properties = mapOf(
                "path" to JsonPrimitive("/settings"),
                "attempt" to JsonPrimitive(3),
            ),
            context = mapOf("source" to JsonPrimitive("android")),
            attributes = mapOf(
                "coldStart" to JsonPrimitive(true),
                "launchCount" to JsonPrimitive(2),
            ),
            traceId = "trace-android-1",
            idempotencyKey = "screen-android-1",
            occurredAt = "2026-05-17T11:59:00.000Z",
        )

        assertEquals(
            FrickAnalyticsTrackReceipt(
                ok = true,
                eventId = "platform-event-android-1",
                sequence = 2147483648L,
                acceptedAt = "2026-05-17T12:00:00.000Z",
                duplicate = false,
            ),
            receipt,
        )
        assertEquals("/analytics/events", transport.posts.single().path)
        val body = Json.parseToJsonElement(transport.posts.single().body).jsonObject
        assertEquals("screen.viewed", body.getValue("name").jsonPrimitive.content)
        assertEquals("/settings", body.getValue("properties").jsonObject.getValue("path").jsonPrimitive.content)
        assertEquals(3, body.getValue("properties").jsonObject.getValue("attempt").jsonPrimitive.int)
        assertEquals("android", body.getValue("context").jsonObject.getValue("source").jsonPrimitive.content)
        assertEquals(true, body.getValue("attributes").jsonObject.getValue("coldStart").jsonPrimitive.content.toBoolean())
        assertEquals(2, body.getValue("attributes").jsonObject.getValue("launchCount").jsonPrimitive.int)
        assertEquals("trace-android-1", body.getValue("traceId").jsonPrimitive.content)
        assertEquals("screen-android-1", body.getValue("idempotencyKey").jsonPrimitive.content)
        assertEquals("2026-05-17T11:59:00.000Z", body.getValue("occurredAt").jsonPrimitive.content)
    }

    @Test
    fun trackRecordsTelemetryAndCorrelatesSpanTraceId() = runBlocking {
        val telemetry = RecordingFrickClientTelemetryRuntime(traceId = "trace-android-auto")
        val storage = MemoryFrickStorage(session = testSession())
        val transport = FakeFrickTransport(
            postResponses = mapOf(
                "/analytics/events" to """
                    {
                      "ok": true,
                      "eventId": "platform-event-android-telemetry",
                      "sequence": 2147483649,
                      "acceptedAt": "2026-05-17T12:00:01.000Z",
                      "duplicate": false
                    }
                """.trimIndent(),
            ),
        )
        val client = FrickClient(transport = transport, storage = storage, telemetry = telemetry)

        client.track(
            name = "screen.viewed",
            properties = mapOf("path" to JsonPrimitive("/settings")),
        )

        val body = Json.parseToJsonElement(transport.posts.single().body).jsonObject
        assertEquals("trace-android-auto", body.getValue("traceId").jsonPrimitive.content)
        assertEquals("00-trace-android-auto-span-01", transport.posts.single().headers["traceparent"])
        assertEquals(
            listOf(
                FrickClientTelemetrySpanStart(
                    name = "frick.analytics.track",
                    kind = FrickClientTelemetrySpanKind.CLIENT,
                    attributes = mapOf(
                        "frick.analytics.event_name" to JsonPrimitive("screen.viewed"),
                        "url.path" to JsonPrimitive("/analytics/events"),
                    ),
                ),
            ),
            telemetry.startedSpans,
        )
        assertEquals(listOf(FrickClientTelemetrySpanStatus.OK), telemetry.finishedSpans.map { result -> result.status })
        assertEquals(
            JsonPrimitive("accepted"),
            telemetry.finishedSpans.single().attributes.getValue("frick.analytics.status"),
        )
        assertEquals(
            JsonPrimitive(false),
            telemetry.finishedSpans.single().attributes.getValue("frick.analytics.duplicate"),
        )
        assertEquals(
            listOf(
                RecordingFrickClientTelemetryRuntime.Measurement(
                    name = "frick.client.analytics.events.total",
                    value = 1.0,
                    attributes = mapOf("status" to JsonPrimitive("accepted")),
                ),
            ),
            telemetry.counters,
        )
        assertEquals(listOf("frick.client.analytics.duration_ms"), telemetry.histograms.map { measurement -> measurement.name })
        assertEquals(mapOf("status" to JsonPrimitive("accepted")), telemetry.histograms.single().attributes)
    }

    @Test
    fun trackIgnoresTelemetryFailures() = runBlocking {
        val storage = MemoryFrickStorage(session = testSession())
        val transport = FakeFrickTransport(
            postResponses = mapOf(
                "/analytics/events" to """
                    {
                      "ok": true,
                      "eventId": "platform-event-android-resilient",
                      "sequence": 2147483650,
                      "acceptedAt": "2026-05-17T12:00:02.000Z",
                      "duplicate": false
                    }
                """.trimIndent(),
            ),
        )
        val client = FrickClient(
            transport = transport,
            storage = storage,
            telemetry = ThrowingFrickClientTelemetryRuntime,
        )

        val receipt = client.track("button.clicked")

        assertEquals("platform-event-android-resilient", receipt.eventId)
    }

    @Test
    fun trackIgnoresThrowingTelemetrySpanTraceId() = runBlocking {
        val storage = MemoryFrickStorage(session = testSession())
        val transport = FakeFrickTransport(
            postResponses = mapOf(
                "/analytics/events" to """
                    {
                      "ok": true,
                      "eventId": "platform-event-android-trace-safe",
                      "sequence": 2147483651,
                      "acceptedAt": "2026-05-17T12:00:03.000Z",
                      "duplicate": false
                    }
                """.trimIndent(),
            ),
        )
        val client = FrickClient(
            transport = transport,
            storage = storage,
            telemetry = ThrowingTraceIdFrickClientTelemetryRuntime,
        )

        val receipt = client.track("button.clicked")

        assertEquals("platform-event-android-trace-safe", receipt.eventId)
        assertEquals("/analytics/events", transport.posts.single().path)
    }

    @Test
    fun trackPrefersCallerTraceIdOverSpanTraceId() = runBlocking {
        val telemetry = RecordingFrickClientTelemetryRuntime(traceId = "trace-android-span")
        val storage = MemoryFrickStorage(session = testSession())
        val transport = FakeFrickTransport(
            postResponses = mapOf(
                "/analytics/events" to """
                    {
                      "ok": true,
                      "eventId": "platform-event-android-caller-trace",
                      "sequence": 2147483652,
                      "acceptedAt": "2026-05-17T12:00:04.000Z",
                      "duplicate": false
                    }
                """.trimIndent(),
            ),
        )
        val client = FrickClient(transport = transport, storage = storage, telemetry = telemetry)

        client.track(name = "screen.viewed", traceId = "trace-android-caller")

        val body = Json.parseToJsonElement(transport.posts.single().body).jsonObject
        assertEquals("trace-android-caller", body.getValue("traceId").jsonPrimitive.content)
    }

    @Test
    fun trackRecordsDuplicateTelemetryStatus() = runBlocking {
        val telemetry = RecordingFrickClientTelemetryRuntime(traceId = "trace-android-duplicate")
        val storage = MemoryFrickStorage(session = testSession())
        val transport = FakeFrickTransport(
            postResponses = mapOf(
                "/analytics/events" to """
                    {
                      "ok": true,
                      "eventId": "platform-event-android-duplicate",
                      "sequence": 2147483653,
                      "acceptedAt": "2026-05-17T12:00:05.000Z",
                      "duplicate": true
                    }
                """.trimIndent(),
            ),
        )
        val client = FrickClient(transport = transport, storage = storage, telemetry = telemetry)

        val receipt = client.track("button.clicked")

        assertEquals(true, receipt.duplicate)
        assertEquals(
            JsonPrimitive("duplicate"),
            telemetry.finishedSpans.single().attributes.getValue("frick.analytics.status"),
        )
        assertEquals(
            JsonPrimitive(true),
            telemetry.finishedSpans.single().attributes.getValue("frick.analytics.duplicate"),
        )
        assertEquals(mapOf("status" to JsonPrimitive("duplicate")), telemetry.counters.single().attributes)
        assertEquals(mapOf("status" to JsonPrimitive("duplicate")), telemetry.histograms.single().attributes)
    }

    @Test
    fun trackRecordsRejectedTelemetryStatus() = runBlocking {
        val telemetry = RecordingFrickClientTelemetryRuntime(traceId = "trace-android-rejected")
        val storage = MemoryFrickStorage(session = testSession())
        val transport = FakeFrickTransport(
            postResponses = mapOf("/analytics/events" to """{"ok":false}"""),
        )
        val client = FrickClient(transport = transport, storage = storage, telemetry = telemetry)

        try {
            client.track("button.clicked")
            fail("expected rejected analytics decode failure")
        } catch (_: Exception) {
            // expected
        }

        assertEquals(listOf(FrickClientTelemetrySpanStatus.ERROR), telemetry.finishedSpans.map { result -> result.status })
        assertEquals(
            JsonPrimitive("rejected"),
            telemetry.finishedSpans.single().attributes.getValue("frick.analytics.status"),
        )
        assertEquals(mapOf("status" to JsonPrimitive("rejected")), telemetry.counters.single().attributes)
        assertEquals(mapOf("status" to JsonPrimitive("rejected")), telemetry.histograms.single().attributes)
    }

    @Test
    fun trackRecordsNetworkTelemetryStatus() = runBlocking {
        val telemetry = RecordingFrickClientTelemetryRuntime(traceId = "trace-android-network")
        val storage = MemoryFrickStorage(session = testSession())
        val transport = FakeFrickTransport(
            failingPosts = 1,
            postFailure = IOException("offline"),
        )
        val client = FrickClient(transport = transport, storage = storage, telemetry = telemetry)

        try {
            client.track("button.clicked")
            fail("expected network analytics failure")
        } catch (_: IOException) {
            // expected
        }

        assertEquals(emptyList<FakeFrickTransport.Post>(), transport.posts)
        assertEquals(listOf(FrickClientTelemetrySpanStatus.ERROR), telemetry.finishedSpans.map { result -> result.status })
        assertEquals(
            JsonPrimitive("network_error"),
            telemetry.finishedSpans.single().attributes.getValue("frick.analytics.status"),
        )
        assertEquals(mapOf("status" to JsonPrimitive("network_error")), telemetry.counters.single().attributes)
        assertEquals(mapOf("status" to JsonPrimitive("network_error")), telemetry.histograms.single().attributes)
    }

    @Test
    fun trackRequiresStoredSessionBeforePosting() = runBlocking {
        val transport = FakeFrickTransport()
        val client = FrickClient(transport = transport, storage = MemoryFrickStorage())

        try {
            client.track("button.clicked")
            fail("expected auth requirement before posting analytics")
        } catch (_: FrickAuthenticationRequiredException) {
            // expected
        }

        assertEquals(emptyList<FakeFrickTransport.Post>(), transport.postAttempts)
    }

    @Test
    fun signOutClearsStoredSession() {
        val session = FrickSession(
            schemaHash = FRICK_SCHEMA_HASH,
            sessionToken = "session-token-dorothy",
            userId = "user-dorothy",
            displayName = "Dorothy Vaughan",
            handle = "dorothy",
            deviceId = "android-device",
            replicaId = "android-replica",
            expiresAt = "2026-05-09T22:00:00.000Z",
        )
        val storage = MemoryFrickStorage(session = session)
        val client = FrickClient(storage = storage, transport = FakeFrickTransport())
        storage.appendPendingAppend(PendingAppend(requestId = "request-1", body = "{}"))

        client.signOut()

        assertEquals(null, storage.loadSession())
        assertEquals(emptyList<PendingAppend>(), storage.loadPendingAppends())
    }

    @Test
    fun flushPendingAppendsRequiresSessionBeforePosting() = runBlocking {
        val transport = FakeFrickTransport()
        val storage = MemoryFrickStorage(
            pendingAppends = listOf(PendingAppend(requestId = "request-1", body = "{}")),
        )
        val client = FrickClient(transport = transport, storage = storage)

        try {
            client.flushPendingAppends()
            fail("expected auth requirement before flushing pending appends")
        } catch (_: FrickAuthenticationRequiredException) {
            // expected
        }

        assertEquals(emptyList<FakeFrickTransport.Post>(), transport.postAttempts)
        assertEquals(listOf("request-1"), storage.pendingAppends.map { append -> append.requestId })
    }

    @Test
    fun ktorTransportAddsAuthorizationHeaderToAuthenticatedRequests() = runBlocking {
        val observed = mutableListOf<Pair<String, String?>>()
        val server = startHeaderCaptureServer(observed)
        servers += server
        val transport = KtorFrickTransport(
            baseUrl = "http://127.0.0.1:${server.address.port}",
            sessionTokenProvider = { "session-token-ada" },
        )

        try {
            transport.get("/objects?type=User")
            transport.post("/append", """{"ok":true}""")
            transport.putBytes("/blobs/blob-1/content", "text/plain", "hello".encodeToByteArray())
            transport.stream("/streams/AppStream/key-1/events?after=0").take(1).toList()
        } finally {
            transport.close()
        }

        assertEquals(
            listOf(
                "GET /objects?type=User" to "Bearer session-token-ada",
                "POST /append" to "Bearer session-token-ada",
                "PUT /blobs/blob-1/content" to "Bearer session-token-ada",
                "GET /streams/AppStream/key-1/events?after=0" to "Bearer session-token-ada",
            ),
            observed,
        )
    }

    @Test
    fun storagePersistsSessionAcrossFakeInstances() {
        val sharedSession = arrayOf<FrickSession?>(null)
        val first = MemoryFrickStorage(sessionBacking = sharedSession)
        val second = MemoryFrickStorage(sessionBacking = sharedSession)
        val session = FrickSession(
            schemaHash = FRICK_SCHEMA_HASH,
            sessionToken = "session-token-ada",
            userId = "user-ada",
            deviceId = "android-device",
            replicaId = "android-replica",
            expiresAt = "2026-05-09T22:00:00.000Z",
        )

        first.saveSession(session)

        assertEquals(session, second.loadSession())
    }

    @Test
    fun fetchesBlobMetadataThroughFoundationContentEndpoint() = runBlocking {
        val transport = FakeFrickTransport(
            responses = mapOf(
                "/blobs/blob-1" to """
                    {
                      "blobId": "blob-1",
                      "ownerId": "user-ada",
                      "contentHash": "sha256-1",
                      "byteLength": 42,
                      "mimeType": "text/plain",
                      "createdAt": "2026-05-09T00:00:00.000Z"
                    }
                """.trimIndent(),
            ),
        )
        val client = FrickClient(transport = transport)

        val blob = client.fetchBlobMetadata(blobId = "blob-1")

        assertEquals("blob-1", blob?.blobId)
        assertEquals(42, blob?.byteLength)
        assertEquals(listOf("/blobs/blob-1"), transport.requestedPaths)
    }

    @Test
    fun uploadsBlobContentThroughFoundationContentEndpoint() = runBlocking {
        val transport = FakeFrickTransport(
            putResponses = mapOf(
                "/blobs/blob%201/content?ownerId=user+ada" to """
                    {
                      "blobId": "blob 1",
                      "ownerId": "user ada",
                      "contentHash": "sha256-uploaded",
                      "byteLength": 5,
                      "mimeType": "text/plain",
                      "storageKey": "objects/blob-1",
                      "createdAt": "2026-05-09T00:00:00.000Z"
                    }
                """.trimIndent(),
            ),
        )
        val client = FrickClient(transport = transport)

        val metadata = client.uploadBlobContent(
            blobId = "blob 1",
            ownerId = "user ada",
            mimeType = "text/plain",
            bytes = "hello".encodeToByteArray(),
        )

        assertEquals("blob 1", metadata.blobId)
        assertEquals("sha256-uploaded", metadata.contentHash)
        assertEquals(
            listOf(
                FakeFrickTransport.BytePut(
                    path = "/blobs/blob%201/content?ownerId=user+ada",
                    mimeType = "text/plain",
                    bytes = "hello".encodeToByteArray(),
                ),
            ),
            transport.bytePuts,
        )
    }

    @Test
    fun downloadsBlobContentThroughFoundationContentEndpoint() = runBlocking {
        val expected = byteArrayOf(1, 2, 3, 4)
        val transport = FakeFrickTransport(
            byteResponses = mapOf("/blobs/blob-1/content" to expected),
        )
        val client = FrickClient(transport = transport)

        val bytes = client.downloadBlobContent(blobId = "blob-1")

        assertArrayEquals(expected, bytes)
        assertEquals(listOf("/blobs/blob-1/content"), transport.byteRequestedPaths)
    }

    @Test
    fun sendsSignalJsonPayloadThroughFoundationEndpoint() = runBlocking {
        val transport = FakeFrickTransport()
        val client = FrickClient(transport = transport)

        client.sendSignal(
            name = "typing",
            key = "conversation general",
            value = mapOf(
                "userId" to JsonPrimitive("user-ada"),
                "typing" to JsonPrimitive(true),
            ),
        )

        assertEquals(1, transport.posts.size)
        assertEquals("/signals/typing/conversation%20general", transport.posts.single().path)
        val body = Json.parseToJsonElement(transport.posts.single().body).jsonObject
        assertEquals("user-ada", body.getValue("userId").jsonPrimitive.content)
        assertEquals(true, body.getValue("typing").jsonPrimitive.content.toBoolean())
    }

    @Test
    fun drainsSignalPayloadsAsStringMaps() = runBlocking {
        val transport = FakeFrickTransport(
            responses = mapOf(
                "/signals/typing/conversation%20general" to """
                    {
                      "schemaHash": "$FRICK_SCHEMA_HASH",
                      "name": "typing",
                      "key": "conversation general",
                      "data": [
                        {
                          "userId": "user-ada",
                          "typing": true,
                          "meta": {"source":"android"}
                        }
                      ]
                    }
                """.trimIndent(),
            ),
        )
        val client = FrickClient(transport = transport)

        val signals = client.drainSignals(name = "typing", key = "conversation general")

        assertEquals(
            listOf(
                mapOf(
                    "userId" to "user-ada",
                    "typing" to "true",
                    "meta" to """{"source":"android"}""",
                ),
            ),
            signals,
        )
        assertEquals(listOf("/signals/typing/conversation%20general"), transport.requestedPaths)
    }

    @Test
    fun rejectsResponsesWithMismatchedSchemaHash() {
        try {
            parseStreamEvents("""{"schemaHash":"wrong-hash","data":[]}""")
            fail("Expected schema mismatch")
        } catch (error: FrickSchemaMismatchException) {
            assertEquals(FRICK_SCHEMA_HASH, error.expectedSchemaHash)
            assertEquals("wrong-hash", error.actualSchemaHash)
        }
    }

    @Test
    fun sendsAppendThroughFoundationEndpoint() = runBlocking {
        val transport = FakeFrickTransport()
        val client = FrickClient(
            transport = transport,
            storage = MemoryFrickStorage(session = testSession()),
            replicaId = "android-test",
            requestIdFactory = { "request-1" },
        )

        client.append(
            stream = "AppStream",
            key = "app-key-1",
            event = "AppEvent",
            payload = mapOf(
                "messageId" to "message-1",
                "senderId" to "user-ada",
                "body" to "Hello from Android",
                "createdAt" to "2026-05-09T12:00:00.000Z",
            ),
        )

        assertEquals(1, transport.posts.size)
        assertEquals("/append", transport.posts.single().path)
        assertTrue(transport.posts.single().body.contains("\"requestId\":\"request-1\""))
        assertTrue(transport.posts.single().body.contains("\"stream\":\"AppStream\""))
        assertTrue(transport.posts.single().body.contains("\"key\":\"app-key-1\""))
        assertTrue(transport.posts.single().body.contains("\"body\":\"Hello from Android\""))
    }

    @Test
    fun appendQueuesWhenOfflineAndFlushPendingAppendsDrainsTheQueue() = runBlocking {
        // Generic primitive: offline append goes onto the pending queue,
        // and flushPendingAppends() drains it on the next call to a
        // working transport. Previously this was tested indirectly via
        // fetchMessages()'s implicit flush; that helper is gone so we
        // exercise the queue + drain primitives directly.
        val transport = FakeFrickTransport(failingPosts = 1)
        val storage = MemoryFrickStorage(session = testSession())
        val client = FrickClient(
            transport = transport,
            storage = storage,
            replicaId = "android-test",
            requestIdFactory = { "request-1" },
        )

        client.append(
            stream = "AppStream",
            key = "app-key-1",
            event = "AppEvent",
            payload = mapOf("body" to "Queued"),
        )
        assertEquals(listOf("request-1"), storage.pendingAppends.map { append -> append.requestId })

        client.flushPendingAppends()

        assertEquals(emptyList<PendingAppend>(), storage.pendingAppends)
        assertEquals(2, transport.postAttempts.size)
        assertEquals(1, transport.posts.size)
    }

    @Test
    fun queuedAppendStampsCurrentSessionScope() = runBlocking {
        val transport = FakeFrickTransport(failingPosts = 1)
        val storage = MemoryFrickStorage(
            session = testSession(tenantId = "tenant-alpha", userId = "user-ada"),
        )
        val client = FrickClient(
            transport = transport,
            storage = storage,
            replicaId = "android-test",
            requestIdFactory = { "request-1" },
        )

        client.append(
            stream = "AppStream",
            key = "app-key-1",
            event = "AppEvent",
            payload = mapOf("body" to "Queued"),
        )

        assertEquals(
            FrickCacheMetadata.currentSchema.copy(
                tenantId = "tenant-alpha",
                userId = "user-ada",
            ),
            storage.loadCacheMetadata(),
        )
        assertEquals(listOf("request-1"), storage.pendingAppends.map { append -> append.requestId })
    }

    @Test
    fun parseFrickErrorEnvelopeDecodesWrappedAndDirectShapes() {
        val wrapped = """
            {
              "error": {
                "code": "auth.forbidden",
                "message": "Nope",
                "requestId": "req-1",
                "retryable": false
              }
            }
        """.trimIndent()
        val direct = """
            {
              "code": "schema.incompatible",
              "message": "Schema mismatch",
              "requestId": "req-2",
              "retryable": false,
              "schemaHash": "$FRICK_SCHEMA_HASH",
              "schemaRevision": 1
            }
        """.trimIndent()

        val wrappedEnvelope = parseFrickErrorEnvelope(wrapped)
        val directEnvelope = parseFrickErrorEnvelope(direct)

        assertEquals(FrickErrorCodes.AuthForbidden, wrappedEnvelope?.code)
        assertEquals("Nope", wrappedEnvelope?.message)
        assertEquals(FrickErrorCodes.SchemaIncompatible, directEnvelope?.code)
        assertEquals(FRICK_SCHEMA_HASH, directEnvelope?.schemaHash)
        assertEquals(1, directEnvelope?.schemaRevision)
    }

    @Test
    fun parseFrickErrorEnvelopeReturnsNullForBlankOrUnparseableBodies() {
        assertEquals(null, parseFrickErrorEnvelope(""))
        assertEquals(null, parseFrickErrorEnvelope("not json"))
        assertEquals(null, parseFrickErrorEnvelope("{\"unrelated\":42}"))
    }

    @Test
    fun ktorTransportThrowsFrickHttpExceptionCarryingEnvelopeOnAuthFailure() = runBlocking {
        val server = startEnvelopeFailureServer(
            statusCode = 401,
            body = """
                {
                  "error": {
                    "code": "auth.unauthenticated",
                    "message": "Invalid identity or password",
                    "requestId": "login_rejected",
                    "retryable": false,
                    "schemaHash": "$FRICK_SCHEMA_HASH",
                    "schemaRevision": 1
                  },
                  "code": "auth.unauthenticated",
                  "message": "Invalid identity or password",
                  "requestId": "login_rejected",
                  "retryable": false
                }
            """.trimIndent(),
        )
        servers += server
        val transport = KtorFrickTransport(baseUrl = "http://127.0.0.1:${server.address.port}")

        try {
            try {
                transport.post("/auth/login", """{"identity":"x","password":"y"}""")
                fail("expected FrickHttpException")
            } catch (error: FrickHttpException) {
                assertEquals(401, error.statusCode)
                assertEquals(FrickErrorCodes.AuthUnauthenticated, error.code)
                assertEquals("login_rejected", error.requestId)
                assertEquals(false, error.retryable)
                assertEquals(FRICK_SCHEMA_HASH, error.envelope?.schemaHash)
                assertEquals(1, error.envelope?.schemaRevision)
                assertEquals("Invalid identity or password", error.message)
            }
        } finally {
            transport.close()
        }
    }

    @Test
    fun verifyCacheCompatibilityStampsMetadataOnFirstRun() {
        val storage = MemoryFrickStorage(
            session = testSession(tenantId = "tenant-alpha", userId = "user-ada"),
        )
        val client = FrickClient(transport = FakeFrickTransport(), storage = storage)

        val stamped = client.verifyCacheCompatibility()

        val expected = FrickCacheMetadata.currentSchema.copy(
            tenantId = "tenant-alpha",
            userId = "user-ada",
        )
        assertEquals(expected, stamped)
        assertEquals(expected, storage.loadCacheMetadata())
    }

    @Test
    fun verifyCacheCompatibilityThrowsOnSchemaIdMismatch() {
        val storage = MemoryFrickStorage().apply {
            saveCacheMetadata(
                FrickCacheMetadata(
                    schemaId = "legacy-app",
                    schemaVersion = "0.0.1",
                    schemaRevision = 1,
                    schemaHash = "legacy-hash",
                ),
            )
            appendPendingAppend(PendingAppend(requestId = "request-1", body = "{}"))
        }
        val client = FrickClient(transport = FakeFrickTransport(), storage = storage)

        try {
            client.verifyCacheCompatibility()
            fail("expected FrickCacheIncompatibleException")
        } catch (error: FrickCacheIncompatibleException) {
            assertEquals(FrickCacheIncompatibilityReason.SCHEMA_ID_MISMATCH, error.reason)
            assertEquals("legacy-app", error.cachedMetadata.schemaId)
            assertEquals(FRICK_SCHEMA_ID, error.currentMetadata.schemaId)
            assertEquals(1, error.pendingAppendCount)
        }
    }

    @Test
    fun verifyCacheCompatibilityThrowsWhenCacheRevisionTooOld() {
        val storage = MemoryFrickStorage().apply {
            saveCacheMetadata(
                FrickCacheMetadata(
                    schemaId = FRICK_SCHEMA_ID,
                    schemaVersion = "0.0.1",
                    schemaRevision = 1,
                    schemaHash = "old-hash",
                ),
            )
        }
        val client = FrickClient(transport = FakeFrickTransport(), storage = storage)

        try {
            client.verifyCacheCompatibility(minimumClientRevision = 5)
            fail("expected FrickCacheIncompatibleException")
        } catch (error: FrickCacheIncompatibleException) {
            assertEquals(FrickCacheIncompatibilityReason.CACHE_TOO_OLD, error.reason)
            assertEquals(5, error.minimumClientRevision)
        }
    }

    @Test
    fun verifyCacheCompatibilityThrowsOnSessionScopeMismatch() {
        val storage = MemoryFrickStorage(
            session = testSession(tenantId = "tenant-beta", userId = "user-grace"),
        ).apply {
            saveCacheMetadata(
                FrickCacheMetadata.currentSchema.copy(
                    tenantId = "tenant-alpha",
                    userId = "user-ada",
                ),
            )
            appendPendingAppend(PendingAppend(requestId = "request-1", body = "{}"))
        }
        val client = FrickClient(transport = FakeFrickTransport(), storage = storage)

        try {
            client.verifyCacheCompatibility()
            fail("expected FrickCacheIncompatibleException")
        } catch (error: FrickCacheIncompatibleException) {
            assertEquals(FrickCacheIncompatibilityReason.SESSION_SCOPE_MISMATCH, error.reason)
            assertEquals("tenant-alpha", error.cachedMetadata.tenantId)
            assertEquals("user-ada", error.cachedMetadata.userId)
            assertEquals("tenant-beta", error.currentMetadata.tenantId)
            assertEquals("user-grace", error.currentMetadata.userId)
            assertEquals(1, error.pendingAppendCount)
        }
    }

    @Test
    fun resetCacheClearsObjectsStreamsPendingAppendsAndMetadata() {
        val storage = MemoryFrickStorage().apply {
            saveObjectJson(type = "User", id = "user-ada", json = """{"id":"user-ada"}""", version = 1)
            saveStreamEvent(streamEvent(sequence = 1, eventId = "event-1", body = "kept"))
            appendPendingAppend(PendingAppend(requestId = "request-1", body = "{}"))
            saveCacheMetadata(FrickCacheMetadata.currentSchema)
        }
        val client = FrickClient(transport = FakeFrickTransport(), storage = storage)

        client.resetCache()

        assertEquals(null, storage.loadObjectJson(type = "User", id = "user-ada"))
        assertEquals(emptyList<FrickStreamEvent>(), storage.loadStreamEvents(stream = "AppStream", key = "app-key-1"))
        assertEquals(emptyList<PendingAppend>(), storage.loadPendingAppends())
        assertEquals(null, storage.loadCacheMetadata())
    }

    @Test
    fun ktorTransportThrowsFrickHttpExceptionWithoutEnvelopeWhenBodyIsEmpty() = runBlocking {
        val server = startEnvelopeFailureServer(statusCode = 500, body = "")
        servers += server
        val transport = KtorFrickTransport(baseUrl = "http://127.0.0.1:${server.address.port}")

        try {
            try {
                transport.get("/objects?type=User")
                fail("expected FrickHttpException")
            } catch (error: FrickHttpException) {
                assertEquals(500, error.statusCode)
                assertEquals(null, error.envelope)
                assertEquals(null, error.code)
                assertEquals(false, error.retryable)
                assertEquals("Request failed with HTTP 500", error.message)
            }
        } finally {
            transport.close()
        }
    }
}

private class FakeFrickTransport(
    private val responseBody: String = """{"schemaHash":"$FRICK_SCHEMA_HASH","data":[]}""",
    private val responses: Map<String, String> = emptyMap(),
    private val postResponses: Map<String, String> = emptyMap(),
    private val byteResponses: Map<String, ByteArray> = emptyMap(),
    private val putResponses: Map<String, String> = emptyMap(),
    private val streamChunks: List<String> = emptyList(),
    private val failGets: Boolean = false,
    private var failingPosts: Int = 0,
    private val postFailure: Throwable = IllegalStateException("offline"),
) : FrickTransport {
    val requestedPaths = mutableListOf<String>()
    val byteRequestedPaths = mutableListOf<String>()
    val streamedPaths = mutableListOf<String>()
    val postAttempts = mutableListOf<Post>()
    val posts = mutableListOf<Post>()
    val bytePuts = mutableListOf<BytePut>()

    override suspend fun get(path: String): String {
        if (failGets) {
            throw IllegalStateException("offline")
        }
        requestedPaths += path
        return responses[path] ?: responseBody
    }

    override suspend fun getBytes(path: String): ByteArray {
        if (failGets) {
            throw IllegalStateException("offline")
        }
        byteRequestedPaths += path
        return byteResponses[path] ?: throw IllegalArgumentException("No byte response for $path")
    }

    override fun stream(path: String): Flow<String> {
        if (failGets) {
            throw IllegalStateException("offline")
        }
        streamedPaths += path
        return streamChunks.asFlow()
    }

    override suspend fun post(path: String, body: String): String =
        post(path = path, body = body, headers = emptyMap())

    override suspend fun post(path: String, body: String, headers: Map<String, String>): String {
        val post = Post(path = path, body = body, headers = headers)
        postAttempts += post
        if (failingPosts > 0) {
            failingPosts -= 1
            throw postFailure
        }
        posts += post
        return postResponses[path].orEmpty()
    }

    override suspend fun putBytes(path: String, mimeType: String, bytes: ByteArray): String {
        val put = BytePut(path = path, mimeType = mimeType, bytes = bytes)
        bytePuts += put
        return putResponses[path] ?: responseBody
    }

    data class Post(
        val path: String,
        val body: String,
        val headers: Map<String, String> = emptyMap(),
    )

    data class BytePut(
        val path: String,
        val mimeType: String,
        val bytes: ByteArray,
    ) {
        override fun equals(other: Any?): Boolean =
            other is BytePut &&
                path == other.path &&
                mimeType == other.mimeType &&
                bytes.contentEquals(other.bytes)

        override fun hashCode(): Int {
            var result = path.hashCode()
            result = 31 * result + mimeType.hashCode()
            result = 31 * result + bytes.contentHashCode()
            return result
        }
    }
}

private class RecordingFrickClientTelemetryRuntime(
    private val traceId: String,
) : FrickClientTelemetryRuntime {
    data class Measurement(
        val name: String,
        val value: Double,
        val attributes: Map<String, JsonPrimitive>,
    )

    val startedSpans = mutableListOf<FrickClientTelemetrySpanStart>()
    val finishedSpans = mutableListOf<FrickClientTelemetrySpanResult>()
    val counters = mutableListOf<Measurement>()
    val histograms = mutableListOf<Measurement>()

    override fun startSpan(input: FrickClientTelemetrySpanStart): FrickClientTelemetrySpan {
        startedSpans += input
        return RecordingFrickClientTelemetrySpan(traceId = traceId) { result ->
            finishedSpans += result ?: FrickClientTelemetrySpanResult()
        }
    }

    override fun recordCounter(name: String, value: Double, attributes: Map<String, JsonPrimitive>) {
        counters += Measurement(name = name, value = value, attributes = attributes)
    }

    override fun recordHistogram(name: String, value: Double, attributes: Map<String, JsonPrimitive>) {
        histograms += Measurement(name = name, value = value, attributes = attributes)
    }
}

private class RecordingFrickClientTelemetrySpan(
    override val traceId: String?,
    private val onEnd: (FrickClientTelemetrySpanResult?) -> Unit,
) : FrickClientTelemetrySpan {
    override fun injectHeaders(headers: MutableMap<String, String>) {
        headers["traceparent"] = "00-${traceId ?: "missing"}-span-01"
    }

    override fun end(result: FrickClientTelemetrySpanResult?) {
        onEnd(result)
    }
}

private object ThrowingFrickClientTelemetryRuntime : FrickClientTelemetryRuntime {
    override fun startSpan(input: FrickClientTelemetrySpanStart): FrickClientTelemetrySpan {
        throw IllegalStateException("telemetry failed")
    }

    override fun recordCounter(name: String, value: Double, attributes: Map<String, JsonPrimitive>) {
        throw IllegalStateException("telemetry failed")
    }

    override fun recordHistogram(name: String, value: Double, attributes: Map<String, JsonPrimitive>) {
        throw IllegalStateException("telemetry failed")
    }
}

private object ThrowingTraceIdFrickClientTelemetryRuntime : FrickClientTelemetryRuntime {
    override fun startSpan(input: FrickClientTelemetrySpanStart): FrickClientTelemetrySpan =
        ThrowingTraceIdFrickClientTelemetrySpan
}

private object ThrowingTraceIdFrickClientTelemetrySpan : FrickClientTelemetrySpan {
    override val traceId: String?
        get() = throw IllegalStateException("telemetry trace failed")
}

private class MemoryFrickStorage(
    private val objectJson: MutableMap<Pair<String, String>, String> = mutableMapOf(),
    private var streamEvents: List<FrickStreamEvent> = emptyList(),
    var pendingAppends: List<PendingAppend> = emptyList(),
    private val sessionBacking: Array<FrickSession?> = arrayOf(null),
    session: FrickSession? = null,
) : FrickStorage {
    init {
        if (session != null) {
            sessionBacking[0] = session
        }
    }

    override fun loadObjectJson(type: String, id: String): String? = objectJson[type to id]

    override fun saveObjectJson(type: String, id: String, json: String, version: Int) {
        objectJson[type to id] = json
    }

    override fun loadStreamEvents(stream: String, key: String): List<FrickStreamEvent> = streamEvents

    override fun saveStreamEvent(event: FrickStreamEvent) {
        streamEvents = (streamEvents + event).distinctBy { saved -> saved.eventId }
    }

    override fun loadPendingAppends(): List<PendingAppend> = pendingAppends

    override fun appendPendingAppend(append: PendingAppend) {
        pendingAppends += append
    }

    override fun removePendingAppend(requestId: String) {
        pendingAppends = pendingAppends.filterNot { append -> append.requestId == requestId }
    }

    override fun clearPendingAppends() {
        pendingAppends = emptyList()
    }

    override fun loadSession(): FrickSession? = sessionBacking[0]

    override fun saveSession(session: FrickSession) {
        sessionBacking[0] = session
    }

    override fun clearSession() {
        sessionBacking[0] = null
    }

    var cacheMetadata: FrickCacheMetadata? = null
        private set

    override fun loadCacheMetadata(): FrickCacheMetadata? = cacheMetadata

    override fun saveCacheMetadata(metadata: FrickCacheMetadata) {
        cacheMetadata = metadata
    }

    override fun clearCache() {
        objectJson.clear()
        streamEvents = emptyList()
        pendingAppends = emptyList()
        cacheMetadata = null
    }
}

private fun testSession(
    tenantId: String? = null,
    userId: String = "user-ada",
    token: String = "session-token-ada",
): FrickSession =
    FrickSession(
        schemaHash = FRICK_SCHEMA_HASH,
        sessionToken = token,
        tenantId = tenantId,
        userId = userId,
        deviceId = "android-device",
        replicaId = "android-replica",
        expiresAt = "2026-05-09T22:00:00.000Z",
    )

private fun startEnvelopeFailureServer(statusCode: Int, body: String): HttpServer {
    val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
    server.createContext("/") { exchange ->
        exchange.responseHeaders.add("Content-Type", "application/json")
        exchange.responseHeaders.add("x-frick-schema-hash", FRICK_SCHEMA_HASH)
        val bytes = body.encodeToByteArray()
        if (bytes.isEmpty()) {
            exchange.sendResponseHeaders(statusCode, -1)
        } else {
            exchange.sendResponseHeaders(statusCode, bytes.size.toLong())
            exchange.responseBody.use { output -> output.write(bytes) }
        }
    }
    server.start()
    return server
}

private fun startHeaderCaptureServer(observed: MutableList<Pair<String, String?>>): HttpServer {
    val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
    server.createContext("/") { exchange ->
        val request = "${exchange.requestMethod} ${exchange.requestURI}"
        observed += request to exchange.requestHeaders.getFirst("Authorization")
        when (exchange.requestMethod) {
            "GET" -> {
                if (exchange.requestURI.path.endsWith("/events")) {
                    exchange.sendText("event: stream-page\ndata: {\"schemaHash\":\"$FRICK_SCHEMA_HASH\",\"data\":[]}\n\n")
                } else {
                    exchange.sendJson("""{"schemaHash":"$FRICK_SCHEMA_HASH","data":[]}""")
                }
            }
            "POST" -> exchange.sendJson("""{"ok":true}""")
            "PUT" -> exchange.sendJson("""{"ok":true}""")
            else -> exchange.sendResponseHeaders(405, -1)
        }
    }
    server.start()
    return server
}

private fun HttpExchange.sendJson(body: String) {
    responseHeaders.add("Content-Type", "application/json")
    sendText(body)
}

private fun HttpExchange.sendText(body: String) {
    val bytes = body.encodeToByteArray()
    sendResponseHeaders(200, bytes.size.toLong())
    responseBody.use { output -> output.write(bytes) }
}

private fun streamEvent(sequence: Int, eventId: String, body: String): FrickStreamEvent =
    FrickStreamEvent(
        stream = "AppStream",
        streamId = "app-key-1",
        sequence = sequence,
        eventId = eventId,
        event = "AppEvent",
        payload = mapOf(
            "messageId" to "message-$sequence",
            "senderId" to "user-ada",
            "body" to body,
            "createdAt" to "2026-05-09T12:00:00.000Z",
        ),
    )
