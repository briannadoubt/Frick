package dev.frick.client

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * FR-152. Drives the observable [FrickSharingService] against a [FrickClient]
 * wired to a fake transport + in-memory session store, asserting that:
 *   - it partitions the grants cache into outgoing / shared-with-me by user,
 *   - refresh drops revoked grants and flips isLoading/hasLoaded,
 *   - invite returns the injected-scheme deep-link URL and refreshes,
 *   - accept/revoke orchestrate the raw verbs and refresh the cache,
 *   - accept while signed out captures a pending token (PendingSignIn),
 *   - deep-link parsing honors the INJECTED scheme/host/path,
 *   - read helpers (grants/userOwnsGrants/granteeAccess/ownersWithGrantsToMe).
 *
 * Robolectric is required only because the deep-link config uses android.net.Uri.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FrickSharingServiceTest {

    private val linkConfig = FrickSharingLinkConfig(scheme = "myapp")

    private fun sessionJson(userId: String): String =
        """
        {
          "schemaHash": "$FRICK_SCHEMA_HASH",
          "sessionToken": "tok-$userId",
          "userId": "$userId",
          "deviceId": "android-device",
          "replicaId": "android-replica",
          "expiresAt": "2026-05-09T22:00:00.000Z"
        }
        """.trimIndent()

    private fun grantJson(
        id: String,
        ownerUserId: String,
        granteeUserId: String,
        recordType: String = "Company",
        recordId: String = "co-1",
        revokedAt: String? = null,
    ): String =
        buildString {
            append("{")
            append(""""id":"$id","tenantId":"t1","ownerUserId":"$ownerUserId",""")
            append(""""recordType":"$recordType","recordId":"$recordId",""")
            append(""""granteeUserId":"$granteeUserId","permission":"read","createdAt":"2026-01-01T00:00:00Z"""")
            if (revokedAt != null) append(""","revokedAt":"$revokedAt"""")
            append("}")
        }

    private fun grantsEnvelope(vararg grants: String): String =
        """{"schemaHash":"$FRICK_SCHEMA_HASH","grants":[${grants.joinToString(",")}]}"""

    private fun signedInService(
        userId: String,
        transport: SharingRecordingTransport,
    ): FrickSharingService {
        val storage = SharingInMemoryStorage()
        storage.saveSession(sharingFrickJsonTest.decodeFromString(sessionJson(userId)))
        val client = FrickClient(transport = transport, storage = storage)
        val session = FrickSessionManager(client = client)
        return FrickSharingService(session = session, linkConfig = linkConfig)
    }

    // MARK: - Deep-link config (injected scheme)

    @Test
    fun acceptUrlUsesInjectedScheme() {
        val url = linkConfig.acceptUrl("opaque-token")
        assertEquals("myapp://share/accept?token=opaque-token", url)
    }

    @Test
    fun tokenFromParsesMatchingLink() {
        assertEquals("abc123", linkConfig.tokenFrom("myapp://share/accept?token=abc123"))
    }

    @Test
    fun tokenFromRejectsWrongScheme() {
        assertNull(linkConfig.tokenFrom("otherapp://share/accept?token=abc123"))
    }

    @Test
    fun tokenFromRejectsWrongHostOrPath() {
        assertNull(linkConfig.tokenFrom("myapp://other/accept?token=abc"))
        assertNull(linkConfig.tokenFrom("myapp://share/reject?token=abc"))
    }

    @Test
    fun roundTripsTokenThroughUrl() {
        val url = linkConfig.acceptUrl("round trip+token")
        assertEquals("round trip+token", linkConfig.tokenFrom(url))
    }

    // MARK: - Refresh + partitioning

    @Test
    fun refreshPartitionsGrantsByUser() = runBlocking {
        val transport = SharingRecordingTransport(
            getResponse = grantsEnvelope(
                grantJson("g1", ownerUserId = "me", granteeUserId = "other"),
                grantJson("g2", ownerUserId = "owner2", granteeUserId = "me"),
                grantJson("g3", ownerUserId = "me", granteeUserId = "x", revokedAt = "2026-02-01T00:00:00Z"),
            ),
        )
        val service = signedInService("me", transport)

        service.refresh()

        val s = service.state.value
        assertEquals(listOf("g1"), s.outgoingShares.map { it.id })
        assertEquals(listOf("g2"), s.sharedWithMe.map { it.id })
        assertTrue(s.hasLoaded)
        assertFalse(s.isLoading)
        assertNull(s.lastError)
        assertEquals("/share/grants", transport.gets.single())
    }

    @Test
    fun refreshSignedOutResetsState() = runBlocking {
        val transport = SharingRecordingTransport()
        val storage = SharingInMemoryStorage()
        val client = FrickClient(transport = transport, storage = storage)
        val service = FrickSharingService(FrickSessionManager(client), linkConfig)

        service.refresh()

        assertTrue(service.state.value.outgoingShares.isEmpty())
        assertFalse(service.state.value.hasLoaded)
        assertTrue(transport.gets.isEmpty())
    }

    // MARK: - Sender verbs

    @Test
    fun inviteReturnsDeepLinkAndRefreshes() = runBlocking {
        val invitationEnvelope =
            """{"schemaHash":"$FRICK_SCHEMA_HASH","invitation":{"id":"inv1","tenantId":"t1","ownerUserId":"me","recordType":"Company","recordId":"co-1","permission":"write","token":"the-token","createdAt":"2026-01-01T00:00:00Z","expiresAt":"2026-01-15T00:00:00Z"}}"""
        val transport = SharingRecordingTransport(
            postResponses = mapOf("/share/invite" to invitationEnvelope),
            getResponse = grantsEnvelope(grantJson("g1", "me", "other")),
        )
        val service = signedInService("me", transport)

        val url = service.invite("Company", "co-1", FrickSharingPermission.WRITE)

        assertEquals("myapp://share/accept?token=the-token", url)
        assertEquals("/share/invite", transport.posts.single().first)
        // Refreshed after the mutation.
        assertEquals(listOf("g1"), service.state.value.outgoingShares.map { it.id })
    }

    @Test
    fun revokeCallsDeleteAndRefreshes() = runBlocking {
        val transport = SharingRecordingTransport(
            deleteResponse = """{"schemaHash":"$FRICK_SCHEMA_HASH","grant":${grantJson("g1", "me", "other", revokedAt = "2026-03-01T00:00:00Z")}}""",
            getResponse = grantsEnvelope(),
        )
        val service = signedInService("me", transport)

        service.revoke("g1")

        assertEquals("/share/grants/g1", transport.deletes.single())
        assertTrue(service.state.value.outgoingShares.isEmpty())
    }

    // MARK: - Receiver verbs

    @Test
    fun acceptRedeemsTokenAndRefreshes() = runBlocking {
        val acceptEnvelope =
            """{"schemaHash":"$FRICK_SCHEMA_HASH","grant":${grantJson("g2", "owner2", "me")}}"""
        val transport = SharingRecordingTransport(
            postResponses = mapOf("/share/accept" to acceptEnvelope),
            getResponse = grantsEnvelope(grantJson("g2", "owner2", "me")),
        )
        val service = signedInService("me", transport)

        val result = service.accept("a-token")

        assertTrue(result is FrickShareAcceptResult.Accepted)
        assertEquals("g2", (result as FrickShareAcceptResult.Accepted).grant.id)
        assertEquals("/share/accept", transport.posts.single().first)
        assertEquals(listOf("g2"), service.state.value.sharedWithMe.map { it.id })
    }

    @Test
    fun acceptWhileSignedOutCapturesPendingToken() = runBlocking {
        val transport = SharingRecordingTransport()
        val client = FrickClient(transport = transport, storage = SharingInMemoryStorage())
        val service = FrickSharingService(FrickSessionManager(client), linkConfig)

        val result = service.accept("pending-token")

        assertSame(FrickShareAcceptResult.PendingSignIn, result)
        assertEquals("pending-token", service.state.value.pendingAcceptToken)
        assertTrue(transport.posts.isEmpty())
    }

    @Test
    fun handleDeepLinkReturnsNullForUnrelatedUrl() = runBlocking {
        val transport = SharingRecordingTransport()
        val service = signedInService("me", transport)

        assertNull(service.handleDeepLink("https://example.com/other"))
        assertTrue(transport.posts.isEmpty())
    }

    @Test
    fun handleDeepLinkAcceptsTokenFromLink() = runBlocking {
        val acceptEnvelope =
            """{"schemaHash":"$FRICK_SCHEMA_HASH","grant":${grantJson("g2", "owner2", "me")}}"""
        val transport = SharingRecordingTransport(
            postResponses = mapOf("/share/accept" to acceptEnvelope),
            getResponse = grantsEnvelope(grantJson("g2", "owner2", "me")),
        )
        val service = signedInService("me", transport)

        val result = service.handleDeepLink("myapp://share/accept?token=a-token")

        assertTrue(result is FrickShareAcceptResult.Accepted)
        // The token parsed from the link is what got posted to /share/accept.
        val postedToken = sharingFrickJsonTest.parseToJsonElement(transport.posts.single().second)
            .jsonObject["token"]?.jsonPrimitive?.content
        assertEquals("a-token", postedToken)
    }

    @Test
    fun consumePendingAcceptReturnsNullWhenNothingPending() = runBlocking {
        val transport = SharingRecordingTransport()
        val service = signedInService("me", transport)

        assertNull(service.consumePendingAccept())
        assertTrue(transport.posts.isEmpty())
    }

    @Test
    fun consumePendingAcceptRedeemsCapturedTokenAfterSignIn() = runBlocking {
        val acceptEnvelope =
            """{"schemaHash":"$FRICK_SCHEMA_HASH","grant":${grantJson("g2", "owner2", "me")}}"""
        val storage = SharingInMemoryStorage()
        val transport = SharingRecordingTransport(
            postResponses = mapOf(
                "/auth/login" to sessionJson("me"),
                "/share/accept" to acceptEnvelope,
            ),
            getResponse = grantsEnvelope(grantJson("g2", "owner2", "me")),
        )
        val client = FrickClient(transport = transport, storage = storage)
        val session = FrickSessionManager(client)
        val service = FrickSharingService(session, linkConfig)

        // Capture a deep-link token before sign-in.
        assertSame(FrickShareAcceptResult.PendingSignIn, service.accept("captured"))
        assertEquals("captured", service.state.value.pendingAcceptToken)

        // Sign in through the same session manager, then consume.
        session.signIn(identity = "me", password = "pw")
        val result = service.consumePendingAccept()

        assertTrue(result is FrickShareAcceptResult.Accepted)
        assertNull(service.state.value.pendingAcceptToken)
        assertEquals(listOf("g2"), service.state.value.sharedWithMe.map { it.id })
    }

    // MARK: - Read helpers

    @Test
    fun readHelpersGateOnCache() = runBlocking {
        val transport = SharingRecordingTransport(
            getResponse = grantsEnvelope(
                grantJson("g1", ownerUserId = "me", granteeUserId = "other", recordId = "co-1"),
                grantJson("g2", ownerUserId = "owner2", granteeUserId = "me", recordId = "co-2"),
            ),
        )
        val service = signedInService("me", transport)
        service.refresh()

        assertTrue(service.userOwnsGrants("Company", "co-1"))
        assertFalse(service.userOwnsGrants("Company", "co-2"))
        assertEquals("g2", service.granteeAccess("Company", "co-2")?.id)
        assertNull(service.granteeAccess("Company", "co-1"))
        assertEquals(listOf("owner2"), service.ownersWithGrantsToMe("Company"))
        assertEquals(2, service.grants("Company", "co-1").size + service.grants("Company", "co-2").size)
    }
}

private val sharingFrickJsonTest = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }

private class SharingRecordingTransport(
    private val postResponses: Map<String, String> = emptyMap(),
    private val getResponse: String = """{"schemaHash":"$FRICK_SCHEMA_HASH","data":[]}""",
    private val deleteResponse: String = "",
) : FrickTransport {
    val posts = mutableListOf<Pair<String, String>>()
    val gets = mutableListOf<String>()
    val deletes = mutableListOf<String>()

    override suspend fun get(path: String): String {
        gets += path
        return getResponse
    }
    override suspend fun getBytes(path: String): ByteArray = ByteArray(0)
    override fun stream(path: String): Flow<String> = emptyFlow()
    override suspend fun post(path: String, body: String): String = post(path, body, emptyMap())
    override suspend fun post(path: String, body: String, headers: Map<String, String>): String {
        posts += path to body
        return postResponses[path].orEmpty()
    }
    override suspend fun putBytes(path: String, mimeType: String, bytes: ByteArray): String = ""
    override suspend fun delete(path: String): String {
        deletes += path
        return deleteResponse
    }
}

private class SharingInMemoryStorage : FrickStorage {
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
