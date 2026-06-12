package dev.frick.client

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * FR-301: the transport's JSON `PUT` verb. The interface default throws (so
 * existing fakes stay source-compatible); a real transport overrides it.
 */
class FrickTransportPutTest {
    private open class StubTransport : FrickTransport {
        override suspend fun get(path: String): String = ""
        override suspend fun getBytes(path: String): ByteArray = ByteArray(0)
        override fun stream(path: String): Flow<String> = emptyFlow()
        override suspend fun post(path: String, body: String): String = ""
        override suspend fun putBytes(path: String, mimeType: String, bytes: ByteArray): String = ""
    }

    @Test
    fun jsonPutDeliversPathBodyAndHeaders() = runBlocking {
        var seenPath: String? = null
        var seenBody: String? = null
        var seenHeaders: Map<String, String>? = null
        val transport =
            object : StubTransport() {
                override suspend fun put(
                    path: String,
                    body: String,
                    headers: Map<String, String>,
                ): String {
                    seenPath = path
                    seenBody = body
                    seenHeaders = headers
                    return """{"ok":true}"""
                }
            }

        val result =
            transport.put("/api/square/locations", """{"id":"loc-1"}""", mapOf("X-Test" to "1"))

        assertEquals("""{"ok":true}""", result)
        assertEquals("/api/square/locations", seenPath)
        assertEquals("""{"id":"loc-1"}""", seenBody)
        assertEquals(mapOf("X-Test" to "1"), seenHeaders)
    }

    @Test(expected = UnsupportedOperationException::class)
    fun jsonPutDefaultIsUnsupported() =
        runBlocking {
            // A transport that does not override `put` falls through to the
            // throwing default — existing fakes keep compiling, but a real PUT
            // requires an implementation (KtorFrickTransport provides one).
            StubTransport().put("/x", "{}")
            Unit
        }
}
