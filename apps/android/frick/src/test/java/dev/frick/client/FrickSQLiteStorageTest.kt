package dev.frick.client

import java.util.UUID
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FrickSQLiteStorageTest {
    private val databaseNames = mutableListOf<String>()

    @After
    fun deleteDatabases() {
        val context = RuntimeEnvironment.getApplication()
        databaseNames.forEach(context::deleteDatabase)
    }

    @Test
    fun persistsFoundationObjectsStreamEventsAndPendingAppendsAcrossInstances() {
        val context = RuntimeEnvironment.getApplication()
        val databaseName = "frick-test-${UUID.randomUUID()}.sqlite"
        databaseNames += databaseName

        val userJson = """{"id":"user-ada","displayName":"Ada Lovelace","avatarBlobId":null}"""
        val event = FrickStreamEvent(
            stream = "MessageStream",
            streamId = "conversation-general",
            sequence = 42,
            eventId = "event-42",
            event = "MessageSent",
            payload = mapOf(
                "messageId" to "message-42",
                "senderId" to "user-ada",
                "body" to "SQL backed",
                "createdAt" to "2026-05-09T12:00:00.000Z",
            ),
        )
        val append = PendingAppend(
            requestId = "request-1",
            body = """{"requestId":"request-1","stream":"MessageStream"}""",
        )

        SQLiteFrickStorage(context, name = databaseName).use { storage ->
            storage.saveObjectJson(type = "User", id = "user-ada", json = userJson, version = 1)
            storage.saveStreamEvent(event)
            storage.appendPendingAppend(append)
        }

        SQLiteFrickStorage(context, name = databaseName).use { storage ->
            assertEquals(userJson, storage.loadObjectJson(type = "User", id = "user-ada"))
            assertEquals(listOf(event), storage.loadStreamEvents(stream = "MessageStream", key = "conversation-general"))
            assertEquals(listOf(append), storage.loadPendingAppends())

            storage.removePendingAppend("request-1")
            assertEquals(emptyList<PendingAppend>(), storage.loadPendingAppends())
        }
    }
}
