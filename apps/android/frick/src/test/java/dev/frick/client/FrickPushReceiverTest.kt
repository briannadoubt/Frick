package dev.frick.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

// Kotlin 2.x disallows `sealed` local classes and `object` declarations
// inside function bodies, so the deep-link router fixture types live at
// file scope here.
private sealed class TestRoute {
    data class Conversation(val id: String) : TestRoute()
    data class Call(val id: String) : TestRoute()
    data object Unknown : TestRoute()
}

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
        val router = FrickDeepLinkRouter<TestRoute>()
            .on("message.new") { payload -> TestRoute.Conversation(payload.threadId ?: "general") }
            .on("call.ringing") { payload -> TestRoute.Call(payload.data["callId"].orEmpty()) }
            .fallback { TestRoute.Unknown }

        val message = FrickPushPayload(
            intent = "message.new",
            title = null,
            body = null,
            threadId = "c1",
            deepLink = null,
            data = emptyMap(),
        )
        assertEquals(TestRoute.Conversation("c1"), router.resolve(message))

        val call = FrickPushPayload(
            intent = "call.ringing",
            title = null,
            body = null,
            threadId = null,
            deepLink = null,
            data = mapOf("callId" to "call-7"),
        )
        assertEquals(TestRoute.Call("call-7"), router.resolve(call))

        val unknown = FrickPushPayload(
            intent = "unrelated.intent",
            title = null,
            body = null,
            threadId = null,
            deepLink = null,
            data = emptyMap(),
        )
        assertEquals(TestRoute.Unknown, router.resolve(unknown))
    }
}
