package dev.frick.client

import org.junit.Assert.assertEquals
import org.junit.Test

class FrickDraftStoreTest {

    @Test
    fun draftIdMatchesCrossSDKConvention() {
        // The React `useDraft({ sync: true })` and Swift
        // `FrickDraftStore` both key MessageDraft rows by
        // `"${userId}:${conversationId}"` — keep parity so a draft
        // typed on web shows up under the same id on iOS and Android.
        assertEquals("user-ada:convo-1", FrickDraftStore.draftId("user-ada", "convo-1"))
        // No collapsing of separators in odd user ids.
        assertEquals("a:b:c", FrickDraftStore.draftId("a:b", "c"))
    }
}
