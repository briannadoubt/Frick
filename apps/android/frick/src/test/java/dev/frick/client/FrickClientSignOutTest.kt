package dev.frick.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * native-android-3 regression: `FrickClient.signOut()` must wipe ALL persisted
 * state — the session secret, queued appends, AND the local cache (synced object
 * rows / stream events / cache metadata). Previously it cleared only the session
 * + pending appends, leaving a prior account's records (including records shared
 * with them by other users) on disk as data remanence.
 */
class FrickClientSignOutTest {

    private fun session(userId: String): FrickSession =
        FrickSession(
            schemaHash = FRICK_SCHEMA_HASH,
            sessionToken = "tok-$userId",
            userId = userId,
            deviceId = "android-device",
            replicaId = "android-replica",
            expiresAt = "2026-05-09T22:00:00.000Z",
        )

    @Test
    fun signOutClearsSessionPendingAppendsAndCache() {
        val storage = TrackingStorage()
        storage.saveSession(session("user-ada"))
        storage.appendPendingAppend(PendingAppend(requestId = "req-1", body = "{}"))
        storage.saveObjectJson(type = "User", id = "user-ada", json = """{"id":"user-ada"}""", version = 1)
        storage.saveStreamEvent(
            FrickStreamEvent(
                stream = "MessageStream",
                streamId = "c1",
                sequence = 1,
                eventId = "e1",
                event = "MessageSent",
                payload = mapOf("body" to "secret"),
            ),
        )
        storage.saveCacheMetadata(FrickCacheMetadata.currentSchema)

        val client = FrickClient(storage = storage, transport = NoopTransport)
        client.signOut()

        assertNull(storage.loadSession())
        assertEquals(emptyList<PendingAppend>(), storage.loadPendingAppends())
        // The data-remanence fix: cached records and stream events are gone too.
        assertNull(storage.loadObjectJson(type = "User", id = "user-ada"))
        assertEquals(emptyList<FrickStreamEvent>(), storage.loadStreamEvents(stream = "MessageStream", key = "c1"))
        assertNull(storage.loadCacheMetadata())
        assertEquals(true, storage.clearCacheCalled)
    }
}

/** Records which clear* paths run and holds state in memory for assertions. */
private class TrackingStorage : FrickStorage {
    private val objects = mutableMapOf<Pair<String, String>, String>()
    private val streams = mutableMapOf<Pair<String, String>, MutableList<FrickStreamEvent>>()
    private val pending = mutableListOf<PendingAppend>()
    private var session: FrickSession? = null
    private var metadata: FrickCacheMetadata? = null
    var clearCacheCalled = false
        private set

    override fun loadObjectJson(type: String, id: String): String? = objects[type to id]
    override fun saveObjectJson(type: String, id: String, json: String, version: Int) {
        objects[type to id] = json
    }

    override fun loadStreamEvents(stream: String, key: String): List<FrickStreamEvent> =
        streams[stream to key]?.toList() ?: emptyList()

    override fun saveStreamEvent(event: FrickStreamEvent) {
        streams.getOrPut(event.stream to event.streamId) { mutableListOf() }.add(event)
    }

    override fun loadPendingAppends(): List<PendingAppend> = pending.toList()
    override fun appendPendingAppend(append: PendingAppend) { pending += append }
    override fun removePendingAppend(requestId: String) { pending.removeAll { it.requestId == requestId } }
    override fun loadSession(): FrickSession? = session
    override fun saveSession(session: FrickSession) { this.session = session }
    override fun clearSession() { session = null }
    override fun loadCacheMetadata(): FrickCacheMetadata? = metadata
    override fun saveCacheMetadata(metadata: FrickCacheMetadata) { this.metadata = metadata }

    override fun clearCache() {
        clearCacheCalled = true
        objects.clear()
        streams.clear()
        pending.clear()
        metadata = null
    }
}

/** Transport that never makes a network call — signOut() is purely local. */
private object NoopTransport : FrickTransport {
    override suspend fun get(path: String): String = ""
    override suspend fun getBytes(path: String): ByteArray = ByteArray(0)
    override fun stream(path: String): kotlinx.coroutines.flow.Flow<String> = kotlinx.coroutines.flow.emptyFlow()
    override suspend fun post(path: String, body: String): String = ""
    override suspend fun putBytes(path: String, mimeType: String, bytes: ByteArray): String = ""
}
