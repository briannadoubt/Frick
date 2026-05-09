package dev.frick.client

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.asFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class FrickEventStreamParserTest {
    @Test
    fun parsesEventsSplitAcrossChunks() {
        val parser = FrickEventStreamParser()

        assertEquals(emptyList<FrickEvent>(), parser.push(": connected\n\n"))
        assertEquals(
            emptyList<FrickEvent>(),
            parser.push("event: delta\ndata: {\"stream\":\"MessageStream\","),
        )

        val events = parser.push("\"sequence\":7}\n\n")

        assertEquals(1, events.size)
        assertEquals("delta", events[0].event)
        assertEquals("{\"stream\":\"MessageStream\",\"sequence\":7}", events[0].data)
    }

    @Test
    fun exposesGeneratedFoundationDtos() {
        assertEquals("frick-foundation-2026-05-09", FRICK_SCHEMA_HASH)
        assertEquals(
            UserDto(id = "user-ada", displayName = "Ada", avatarBlobId = null),
            UserDto(id = "user-ada", displayName = "Ada", avatarBlobId = null),
        )
        assertEquals(
            "Hello from Android",
            MessageSentDto(
                messageId = "message-1",
                senderId = "user-ada",
                body = "Hello from Android",
                createdAt = "2026-05-09T12:00:00.000Z",
            ).body,
        )
    }

    @Test
    fun decodesFoundationObjectsAndStreamEvents() {
        val users = parseUsers(
            """
            {
              "schemaHash": "$FRICK_SCHEMA_HASH",
              "type": "User",
              "data": [
                {"id": "user-ada", "displayName": "Ada Lovelace", "avatarBlobId": null}
              ]
            }
            """.trimIndent(),
        )
        val conversations = parseConversations(
            """
            {
              "schemaHash": "$FRICK_SCHEMA_HASH",
              "type": "Conversation",
              "data": [
                {
                  "id": "conversation-general",
                  "kind": "group",
                  "title": "General",
                  "createdBy": "user-ada",
                  "lastMessageEventId": "event-1"
                }
              ]
            }
            """.trimIndent(),
        )
        val events = parseStreamEvents(messageStreamResponse())

        assertEquals(listOf("Ada Lovelace"), users.map { user -> user.displayName })
        assertEquals(listOf("General"), conversations.map { conversation -> conversation.title })
        assertEquals(listOf("Hello from Android"), events.map { event -> event.payload["body"] })
        assertEquals(1, events.single().sequence)
    }

    @Test
    fun rejectsResponsesWithMismatchedSchemaHash() {
        try {
            parseUsers("""{"schemaHash":"wrong-hash","data":[]}""")
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
            replicaId = "android-test",
            requestIdFactory = { "request-1" },
        )

        client.append(
            stream = "MessageStream",
            key = "conversation-general",
            event = "MessageSent",
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
        assertTrue(transport.posts.single().body.contains("\"stream\":\"MessageStream\""))
        assertTrue(transport.posts.single().body.contains("\"key\":\"conversation-general\""))
        assertTrue(transport.posts.single().body.contains("\"body\":\"Hello from Android\""))
    }

    @Test
    fun fetchMessagesFallsBackToCachedStreamEventsWhenOffline() = runBlocking {
        val cached = FrickStreamEvent(
            stream = "MessageStream",
            streamId = "conversation-general",
            sequence = 7,
            eventId = "event-cached",
            event = "MessageSent",
            payload = mapOf("body" to "Cached"),
        )
        val storage = MemoryFrickStorage(streamEvents = listOf(cached))
        val client = FrickClient(
            transport = FakeFrickTransport(failGets = true),
            storage = storage,
        )

        val events = client.fetchMessages()

        assertEquals(listOf(cached), events)
    }

    @Test
    fun queuesAppendWhenOfflineAndFlushesBeforeFetch() = runBlocking {
        val transport = FakeFrickTransport(failingPosts = 1)
        val storage = MemoryFrickStorage()
        val client = FrickClient(
            transport = transport,
            storage = storage,
            replicaId = "android-test",
            requestIdFactory = { "request-1" },
        )

        client.append(
            stream = "MessageStream",
            key = "conversation-general",
            event = "MessageSent",
            payload = mapOf("body" to "Queued"),
        )
        assertEquals(listOf("request-1"), storage.pendingAppends.map { append -> append.requestId })

        client.fetchMessages()

        assertEquals(emptyList<PendingAppend>(), storage.pendingAppends)
        assertEquals(2, transport.postAttempts.size)
        assertEquals(1, transport.posts.size)
    }

    @Test
    fun streamsMessageSnapshotsAndDeltasFromSseTransport() = runBlocking {
        val transport = FakeFrickTransport(
            streamChunks = listOf(
                "event: stream-page\n" +
                    "data: {\"schemaHash\":\"$FRICK_SCHEMA_HASH\",\"stream\":\"MessageStream\",\"key\":\"conversation-general\",\"data\":[]}\n\n",
                "event: delta\n" +
                    "data: {\"schemaHash\":\"$FRICK_SCHEMA_HASH\",\"stream\":\"MessageStream\",\"key\":\"conversation-general\",\"data\":[{\"stream\":\"MessageStream\",\"streamId\":\"conversation-general\",\"sequence\":2,\"eventId\":\"event-2\",\"event\":\"MessageSent\",\"payload\":{\"body\":\"Live\"}}]}\n\n",
            ),
        )
        val client = FrickClient(transport = transport)

        val snapshots = client.streamMessages().take(2).toList()

        assertEquals(listOf(0, 1), snapshots.map { events -> events.size })
        assertEquals("Live", snapshots.last().single().payload["body"])
        assertEquals(listOf("/streams/MessageStream/conversation-general/events?after=0"), transport.streamedPaths)
    }
}

private class FakeFrickTransport(
    private val responseBody: String = messageStreamResponse(),
    private val streamChunks: List<String> = emptyList(),
    private val failGets: Boolean = false,
    private var failingPosts: Int = 0,
) : FrickTransport {
    val requestedPaths = mutableListOf<String>()
    val streamedPaths = mutableListOf<String>()
    val postAttempts = mutableListOf<Post>()
    val posts = mutableListOf<Post>()

    override suspend fun get(path: String): String {
        if (failGets) {
            throw IllegalStateException("offline")
        }
        requestedPaths += path
        return responseBody
    }

    override fun stream(path: String): Flow<String> {
        if (failGets) {
            throw IllegalStateException("offline")
        }
        streamedPaths += path
        return streamChunks.asFlow()
    }

    override suspend fun post(path: String, body: String) {
        val post = Post(path = path, body = body)
        postAttempts += post
        if (failingPosts > 0) {
            failingPosts -= 1
            throw IllegalStateException("offline")
        }
        posts += post
    }

    data class Post(
        val path: String,
        val body: String,
    )
}

private class MemoryFrickStorage(
    private val objectJson: MutableMap<Pair<String, String>, String> = mutableMapOf(),
    private var streamEvents: List<FrickStreamEvent> = emptyList(),
    var pendingAppends: List<PendingAppend> = emptyList(),
) : FrickStorage {
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
}

private fun messageStreamResponse(): String =
    """
    {
      "schemaHash": "$FRICK_SCHEMA_HASH",
      "stream": "MessageStream",
      "key": "conversation-general",
      "data": [
        {
          "stream": "MessageStream",
          "streamId": "conversation-general",
          "sequence": 1,
          "eventId": "event-1",
          "event": "MessageSent",
          "payload": {
            "messageId": "message-1",
            "senderId": "user-ada",
            "body": "Hello from Android",
            "createdAt": "2026-05-09T12:00:00.000Z"
          }
        }
      ]
    }
    """.trimIndent()
