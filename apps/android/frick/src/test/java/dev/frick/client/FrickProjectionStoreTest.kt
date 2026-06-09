package dev.frick.client

import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Drives [FrickProjectionStore] with injected
 * [FrickInboundEvent.ProjectionDelta]s and asserts the exposed
 * [FrickProjectionStore.rows] StateFlow tracks the keyed map across the initial
 * snapshot, live upserts, and null-value deletions — without standing up a
 * WebSocket. Mirrors the TS `client.projection(name)` semantics.
 */
class FrickProjectionStoreTest {

    private fun newSocket(): FrickSyncSocket =
        FrickSyncSocket(
            baseUrl = "http://example.invalid",
            sessionTokenProvider = { null },
            config = FrickSyncSocketConfig(),
            httpClient = OkHttpClient(),
        )

    private fun newStore(socket: FrickSyncSocket, name: String = "inbox"): FrickProjectionStore =
        FrickProjectionStore(socket = socket, name = name)

    private fun delta(
        projection: String = "inbox",
        vararg changes: ProjectionChange,
    ): FrickInboundEvent.ProjectionDelta =
        FrickInboundEvent.ProjectionDelta(projection = projection, changes = changes.toList())

    private fun row(key: String, value: Map<String, Any?>) = ProjectionChange(key, value)
    private fun delete(key: String) = ProjectionChange(key, null)

    @Test
    fun snapshotPopulatesRows() {
        val socket = newSocket()
        val store = newStore(socket)
        try {
            assertTrue(store.rows.value.isEmpty())

            store.onEvent(
                delta(
                    changes = arrayOf(
                        row("a", mapOf("title" to "Alpha")),
                        row("b", mapOf("title" to "Bravo")),
                    ),
                ),
            )

            val rows = store.rows.value
            assertEquals(2, rows.size)
            assertEquals("Alpha", store.get("a")?.get("title"))
            assertEquals("Bravo", store.get("b")?.get("title"))
        } finally {
            store.close()
            socket.close()
        }
    }

    @Test
    fun liveUpsertReplacesExistingRow() {
        val socket = newSocket()
        val store = newStore(socket)
        try {
            store.onEvent(delta(changes = arrayOf(row("a", mapOf("title" to "Old")))))
            store.onEvent(delta(changes = arrayOf(row("a", mapOf("title" to "New")))))

            assertEquals(1, store.rows.value.size)
            assertEquals("New", store.get("a")?.get("title"))
        } finally {
            store.close()
            socket.close()
        }
    }

    @Test
    fun nullValueDeletesRow() {
        val socket = newSocket()
        val store = newStore(socket)
        try {
            store.onEvent(
                delta(
                    changes = arrayOf(
                        row("a", mapOf("title" to "Alpha")),
                        row("b", mapOf("title" to "Bravo")),
                    ),
                ),
            )
            store.onEvent(delta(changes = arrayOf(delete("a"))))

            assertEquals(1, store.rows.value.size)
            assertNull(store.get("a"))
            assertEquals("Bravo", store.get("b")?.get("title"))
        } finally {
            store.close()
            socket.close()
        }
    }

    @Test
    fun reconnectSnapshotPrunesRowsDroppedWhileOffline() {
        // native-android-5: a row the server dropped while the client was offline
        // is absent from the reconnect snapshot (not an explicit null deletion);
        // the store must prune it rather than keep it as a stale row.
        val socket = newSocket()
        val store = newStore(socket)
        try {
            store.onEvent(
                delta(
                    changes = arrayOf(
                        row("a", mapOf("title" to "Alpha")),
                        row("b", mapOf("title" to "Bravo")),
                    ),
                ),
            )
            assertEquals(2, store.rows.value.size)

            // Reconnect: re-subscribe armed; the snapshot omits "b".
            store.markResubscribed()
            store.onEvent(delta(changes = arrayOf(row("a", mapOf("title" to "Alpha2")))))

            assertEquals(setOf("a"), store.rows.value.keys)
            assertNull(store.get("b"))
            assertEquals("Alpha2", store.get("a")?.get("title"))
        } finally {
            store.close()
            socket.close()
        }
    }

    @Test
    fun snapshotBoundaryAppliesOnlyToFirstDeltaAfterResubscribe() {
        val socket = newSocket()
        val store = newStore(socket)
        try {
            store.markResubscribed()
            store.onEvent(
                delta(
                    changes = arrayOf(
                        row("a", mapOf("title" to "Alpha")),
                        row("b", mapOf("title" to "Bravo")),
                    ),
                ),
            )
            assertEquals(2, store.rows.value.size)

            // A later live delta touches only "a" — "b" must survive.
            store.onEvent(delta(changes = arrayOf(row("a", mapOf("title" to "Alpha2")))))

            assertEquals(setOf("a", "b"), store.rows.value.keys)
            assertEquals("Bravo", store.get("b")?.get("title"))
        } finally {
            store.close()
            socket.close()
        }
    }

    @Test
    fun ignoresDeltaForOtherProjection() {
        val socket = newSocket()
        val store = newStore(socket, name = "inbox")
        try {
            store.onEvent(delta(projection = "other", changes = arrayOf(row("x", mapOf("title" to "Nope")))))
            store.onEvent(delta(projection = "inbox", changes = arrayOf(row("a", mapOf("title" to "Yes")))))

            assertEquals(1, store.rows.value.size)
            assertNull(store.get("x"))
            assertEquals("Yes", store.get("a")?.get("title"))
        } finally {
            store.close()
            socket.close()
        }
    }
}
