package dev.frick.client

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * FR-151. Drives the observable [FrickSessionManager] against a [FrickClient]
 * wired to a fake transport + in-memory session store (the encrypted SQLite
 * store's stand-in), asserting that:
 *   - it seeds [SessionState.session] from a restored client,
 *   - sign-in / sign-up flip `session` / `isAuthenticated` and ride the client's
 *     persistence,
 *   - `isAuthenticating` resets on both success and failure,
 *   - a failed verb records `lastError` and rethrows without disturbing session,
 *   - sign-out clears both the observable state and the persisted session,
 *   - the stateless password-reset verbs hit the right routes without touching
 *     the session.
 */
class FrickSessionManagerTest {

    private fun sessionJson(userId: String, token: String): String =
        """
        {
          "schemaHash": "$FRICK_SCHEMA_HASH",
          "sessionToken": "$token",
          "userId": "$userId",
          "deviceId": "android-device",
          "replicaId": "android-replica",
          "expiresAt": "2026-05-09T22:00:00.000Z"
        }
        """.trimIndent()

    private fun client(
        storage: FrickStorage,
        postResponses: Map<String, String> = emptyMap(),
        failingPosts: Int = 0,
    ): Pair<FrickClient, RecordingTransport> {
        val transport = RecordingTransport(postResponses = postResponses, failingPosts = failingPosts)
        return FrickClient(transport = transport, storage = storage) to transport
    }

    @Test
    fun seedsSessionFromRestoredClient() {
        val storage = InMemoryStorage()
        storage.saveSession(frickJsonTest.decodeFromString(sessionJson("user-ada", "tok-ada")))
        val (frick, _) = client(storage)

        val manager = FrickSessionManager(client = frick)

        assertEquals("user-ada", manager.state.value.session?.userId)
        assertTrue(manager.state.value.isAuthenticated)
        assertFalse(manager.state.value.isAuthenticating)
        assertNull(manager.state.value.lastError)
    }

    @Test
    fun startsSignedOutWhenNoPersistedSession() {
        val (frick, _) = client(InMemoryStorage())
        val manager = FrickSessionManager(client = frick)

        assertNull(manager.state.value.session)
        assertFalse(manager.state.value.isAuthenticated)
    }

    @Test
    fun signInInstallsSessionAndRidesPersistence() = runBlocking {
        val storage = InMemoryStorage()
        val (frick, transport) = client(
            storage,
            postResponses = mapOf("/auth/login" to sessionJson("user-grace", "tok-grace")),
        )
        val manager = FrickSessionManager(client = frick)

        val returned = manager.signIn(identity = "grace", password = "pw")

        assertEquals("user-grace", returned.userId)
        assertEquals("user-grace", manager.state.value.session?.userId)
        assertTrue(manager.state.value.isAuthenticated)
        assertFalse(manager.state.value.isAuthenticating)
        // Rode the client's encrypted persistence — no ad-hoc store.
        assertEquals("user-grace", storage.loadSession()?.userId)
        assertEquals("/auth/login", transport.posts.single().first)
    }

    @Test
    fun signUpInstallsSession() = runBlocking {
        val storage = InMemoryStorage()
        val (frick, transport) = client(
            storage,
            postResponses = mapOf("/auth/signup" to sessionJson("user-new", "tok-new")),
        )
        val manager = FrickSessionManager(client = frick)

        manager.signUp(displayName = "New Person", handle = "newbie", password = "pw")

        assertEquals("user-new", manager.state.value.session?.userId)
        assertEquals("user-new", storage.loadSession()?.userId)
        assertEquals("/auth/signup", transport.posts.single().first)
    }

    @Test
    fun signInFailureRecordsErrorAndResetsAuthenticating() = runBlocking {
        val (frick, _) = client(InMemoryStorage(), failingPosts = 1)
        val manager = FrickSessionManager(client = frick)

        try {
            manager.signIn(identity = "grace", password = "pw")
            fail("expected the failing transport to propagate")
        } catch (_: Exception) {
            // expected
        }

        assertNull(manager.state.value.session)
        assertFalse(manager.state.value.isAuthenticated)
        assertFalse(manager.state.value.isAuthenticating)
        assertTrue(manager.state.value.lastError != null)
    }

    @Test
    fun signOutClearsObservableStateAndPersistedSession() = runBlocking {
        val storage = InMemoryStorage()
        storage.saveSession(frickJsonTest.decodeFromString(sessionJson("user-ada", "tok-ada")))
        // Leave a queued append so we can confirm sign-out drains it too.
        storage.appendPendingAppend(PendingAppend(requestId = "req-1", body = "{}"))
        val (frick, _) = client(storage)
        val manager = FrickSessionManager(client = frick)
        assertTrue(manager.state.value.isAuthenticated)

        manager.signOut()

        assertNull(manager.state.value.session)
        assertFalse(manager.state.value.isAuthenticated)
        assertFalse(manager.state.value.isAuthenticating)
        assertNull(storage.loadSession())
        assertTrue(storage.loadPendingAppends().isEmpty())
    }

    @Test
    fun requestPasswordResetHitsRouteWithoutTouchingSession() = runBlocking {
        val storage = InMemoryStorage()
        storage.saveSession(frickJsonTest.decodeFromString(sessionJson("user-ada", "tok-ada")))
        val (frick, transport) = client(storage)
        val manager = FrickSessionManager(client = frick)

        manager.requestPasswordReset(email = "ada@example.com")

        assertEquals("/auth/email/forgot-password", transport.posts.single().first)
        // Session untouched.
        assertEquals("user-ada", manager.state.value.session?.userId)
        assertEquals("user-ada", storage.loadSession()?.userId)
    }

    @Test
    fun resetPasswordHitsRouteWithoutTouchingSession() = runBlocking {
        val storage = InMemoryStorage()
        storage.saveSession(frickJsonTest.decodeFromString(sessionJson("user-ada", "tok-ada")))
        val (frick, transport) = client(storage)
        val manager = FrickSessionManager(client = frick)

        manager.resetPassword(token = "one-time", newPassword = "newpw")

        assertEquals("/auth/email/reset-password", transport.posts.single().first)
        assertEquals("user-ada", manager.state.value.session?.userId)
    }

    @Test
    fun exposesUnderlyingClient() {
        val (frick, _) = client(InMemoryStorage())
        val manager = FrickSessionManager(client = frick)
        assertSame(frick, manager.client)
    }
}

private val frickJsonTest = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }

private class RecordingTransport(
    private val postResponses: Map<String, String> = emptyMap(),
    private var failingPosts: Int = 0,
) : FrickTransport {
    val posts = mutableListOf<Pair<String, String>>()

    override suspend fun get(path: String): String = """{"schemaHash":"$FRICK_SCHEMA_HASH","data":[]}"""
    override suspend fun getBytes(path: String): ByteArray = ByteArray(0)
    override fun stream(path: String): Flow<String> = emptyFlow()
    override suspend fun post(path: String, body: String): String = post(path, body, emptyMap())
    override suspend fun post(path: String, body: String, headers: Map<String, String>): String {
        if (failingPosts > 0) {
            failingPosts -= 1
            throw IllegalStateException("offline")
        }
        posts += path to body
        return postResponses[path].orEmpty()
    }
    override suspend fun putBytes(path: String, mimeType: String, bytes: ByteArray): String = ""
}

private class InMemoryStorage : FrickStorage {
    private var session: FrickSession? = null
    private val pending = mutableListOf<PendingAppend>()

    override fun loadObjectJson(type: String, id: String): String? = null
    override fun saveObjectJson(type: String, id: String, json: String, version: Int) = Unit
    override fun loadStreamEvents(stream: String, key: String): List<FrickStreamEvent> = emptyList()
    override fun saveStreamEvent(event: FrickStreamEvent) = Unit
    override fun loadPendingAppends(): List<PendingAppend> = pending.toList()
    override fun appendPendingAppend(append: PendingAppend) { pending += append }
    override fun removePendingAppend(requestId: String) { pending.removeAll { it.requestId == requestId } }
    override fun loadSession(): FrickSession? = session
    override fun saveSession(session: FrickSession) { this.session = session }
    override fun clearSession() { session = null }
    override fun loadCacheMetadata(): FrickCacheMetadata? = null
    override fun saveCacheMetadata(metadata: FrickCacheMetadata) = Unit
    override fun clearCache() = Unit
}
