package dev.frick.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class FrickPushReceiverTest {

    @Test
    fun decodesFromFcmMessage() {
        val payload = FrickPushPayload.from(
            notification = mapOf("title" to "New message", "body" to "Hello"),
            data = mapOf(
                "intent" to "message.new",
                "threadId" to "convo-1",
                "deepLink" to "frick://conversation/convo-1",
                "messageId" to "msg-7",
            ),
        )
        assertNotNull(payload)
        assertEquals("message.new", payload!!.intent)
        assertEquals("New message", payload.title)
        assertEquals("convo-1", payload.threadId)
        assertEquals("frick://conversation/convo-1", payload.deepLink)
        // Reserved keys are excluded from the catch-all `data` map.
        assertEquals(mapOf("messageId" to "msg-7"), payload.data)
    }

    @Test
    fun returnsNullForThirdPartyMessages() {
        val payload = FrickPushPayload.from(
            notification = mapOf("title" to "Some title"),
            data = mapOf("unrelated" to "value"),
        )
        assertNull(payload)
    }

    @Test
    fun routerResolvesIntentSpecificRoutes() {
        sealed class Route {
            data class Conversation(val id: String) : Route()
            data class Call(val id: String) : Route()
            object Unknown : Route()
        }

        val router = FrickDeepLinkRouter<Route>()
            .on("message.new") { payload -> Route.Conversation(payload.threadId ?: "general") }
            .on("call.ringing") { payload -> Route.Call(payload.data["callId"].orEmpty()) }
            .fallback { Route.Unknown }

        val message = FrickPushPayload(
            intent = "message.new",
            title = null,
            body = null,
            threadId = "c1",
            deepLink = null,
            data = emptyMap(),
        )
        assertEquals(Route.Conversation("c1"), router.resolve(message))

        val call = FrickPushPayload(
            intent = "call.ringing",
            title = null,
            body = null,
            threadId = null,
            deepLink = null,
            data = mapOf("callId" to "call-7"),
        )
        assertEquals(Route.Call("call-7"), router.resolve(call))

        val unknown = FrickPushPayload(
            intent = "unrelated.intent",
            title = null,
            body = null,
            threadId = null,
            deepLink = null,
            data = emptyMap(),
        )
        assertEquals(Route.Unknown, router.resolve(unknown))
    }
}
