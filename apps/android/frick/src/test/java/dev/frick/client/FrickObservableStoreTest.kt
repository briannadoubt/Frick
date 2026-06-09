package dev.frick.client

import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Drives [FrickObservableStore] with injected [FrickInboundEvent.Delta]s and
 * asserts the exposed [FrickObservableStore.items] StateFlow tracks the cache
 * across the initial snapshot, live upserts, and removals — without standing up
 * a WebSocket. The decode path mirrors the named-field record shape produced by
 * [FrickSyncSocket] (`{ type, id, value }`).
 */
class FrickObservableStoreTest {

    data class Todo(val id: String, val title: String, val done: Boolean)

    private fun newSocket(): FrickSyncSocket =
        FrickSyncSocket(
            baseUrl = "http://example.invalid",
            sessionTokenProvider = { null },
            config = FrickSyncSocketConfig(),
            httpClient = OkHttpClient(),
        )

    /** Decoder over the `{ type, id, value }` record. Returns null for tombstones. */
    private val decoder = FrickObjectDecoder<Todo> { record ->
        @Suppress("UNCHECKED_CAST")
        val value = record["value"] as? Map<String, Any?> ?: return@FrickObjectDecoder null
        if (value["deleted"] == true) return@FrickObjectDecoder null
        val id = value["id"]?.toString() ?: record["id"]?.toString() ?: return@FrickObjectDecoder null
        Todo(
            id = id,
            title = value["title"]?.toString() ?: "",
            done = value["done"] == true,
        )
    }

    private fun newStore(socket: FrickSyncSocket): FrickObservableStore<Todo> =
        FrickObservableStore(
            socket = socket,
            type = "Todo",
            decoder = decoder,
            idOf = { it.id },
        )

    private fun objectRecord(id: String, fields: Map<String, Any?>): Map<String, Any?> =
        mapOf("type" to "Todo", "id" to id, "value" to (fields + ("id" to id)))

    private fun delta(
        objects: List<Map<String, Any?>>,
        cursor: Int = 0,
        removed: List<ObjectRemoval> = emptyList(),
    ): FrickInboundEvent.Delta =
        FrickInboundEvent.Delta(objects = objects, events = emptyList(), cursor = cursor, removed = removed)

    @Test
    fun snapshotPopulatesItems() {
        val socket = newSocket()
        val store = newStore(socket)
        try {
            assertTrue(store.items.value.isEmpty())

            store.onEvent(
                delta(
                    listOf(
                        objectRecord("a", mapOf("title" to "Buy milk")),
                        objectRecord("b", mapOf("title" to "Walk dog", "done" to true)),
                    ),
                ),
            )

            val items = store.items.value
            assertEquals(2, items.size)
            assertEquals(listOf("a", "b"), items.map { it.id })
            assertEquals("Buy milk", store.get("a")?.title)
            assertEquals(true, store.get("b")?.done)
        } finally {
            store.close()
            socket.close()
        }
    }

    @Test
    fun liveUpsertUpdatesExistingRow() {
        val socket = newSocket()
        val store = newStore(socket)
        try {
            store.onEvent(delta(listOf(objectRecord("a", mapOf("title" to "old")))))
            assertEquals("old", store.get("a")?.title)

            // Live delta upserts a new field value for the same id.
            store.onEvent(delta(listOf(objectRecord("a", mapOf("title" to "new", "done" to true)))))

            assertEquals(1, store.items.value.size)
            assertEquals("new", store.get("a")?.title)
            assertEquals(true, store.get("a")?.done)
        } finally {
            store.close()
            socket.close()
        }
    }

    @Test
    fun liveUpsertAppendsNewRow() {
        val socket = newSocket()
        val store = newStore(socket)
        try {
            store.onEvent(delta(listOf(objectRecord("a", mapOf("title" to "first")))))
            store.onEvent(delta(listOf(objectRecord("b", mapOf("title" to "second")))))

            assertEquals(listOf("a", "b"), store.items.value.map { it.id })
        } finally {
            store.close()
            socket.close()
        }
    }

    @Test
    fun tombstoneDecodeDropsRow() {
        val socket = newSocket()
        val store = newStore(socket)
        try {
            store.onEvent(
                delta(
                    listOf(
                        objectRecord("a", mapOf("title" to "keep")),
                        objectRecord("b", mapOf("title" to "remove me")),
                    ),
                ),
            )
            assertEquals(2, store.items.value.size)

            // A delta whose value marks the row deleted -> decoder returns null -> drop.
            store.onEvent(delta(listOf(objectRecord("b", mapOf("deleted" to true)))))

            assertEquals(listOf("a"), store.items.value.map { it.id })
            assertNull(store.get("b"))
        } finally {
            store.close()
            socket.close()
        }
    }

    @Test
    fun deltaRemovedDropsRowWithoutRefetch() {
        val socket = newSocket()
        val store = newStore(socket)
        try {
            store.onEvent(
                delta(
                    listOf(
                        objectRecord("a", mapOf("title" to "keep")),
                        objectRecord("b", mapOf("title" to "delete me")),
                    ),
                ),
            )
            assertEquals(2, store.items.value.size)

            // FR-144: a Delta carrying a typed `removed` entry drops the row.
            store.onEvent(delta(objects = emptyList(), removed = listOf(ObjectRemoval("Todo", "b"))))

            assertEquals(listOf("a"), store.items.value.map { it.id })
            assertNull(store.get("b"))
        } finally {
            store.close()
            socket.close()
        }
    }

    @Test
    fun deltaRemovedIgnoresOtherTypes() {
        val socket = newSocket()
        val store = newStore(socket)
        try {
            store.onEvent(delta(listOf(objectRecord("a", mapOf("title" to "a")))))
            // A removal for a different type must not touch this store's rows.
            store.onEvent(delta(objects = emptyList(), removed = listOf(ObjectRemoval("Note", "a"))))
            assertEquals(listOf("a"), store.items.value.map { it.id })
        } finally {
            store.close()
            socket.close()
        }
    }

    @Test
    fun explicitRemoveDropsRow() {
        val socket = newSocket()
        val store = newStore(socket)
        try {
            store.onEvent(
                delta(
                    listOf(
                        objectRecord("a", mapOf("title" to "a")),
                        objectRecord("b", mapOf("title" to "b")),
                    ),
                ),
            )
            assertEquals(2, store.items.value.size)

            store.remove("a")

            assertEquals(listOf("b"), store.items.value.map { it.id })
        } finally {
            store.close()
            socket.close()
        }
    }

    @Test
    fun reSnapshotAfterReconnectReplacesNothingStale() {
        val socket = newSocket()
        val store = newStore(socket)
        try {
            // Initial snapshot.
            store.onEvent(delta(listOf(objectRecord("a", mapOf("title" to "a")))))
            assertEquals(listOf("a"), store.items.value.map { it.id })

            // A fresh snapshot after reconnect carries an updated row + a new one.
            // The store upserts both; existing ids are updated in place.
            store.onEvent(
                delta(
                    listOf(
                        objectRecord("a", mapOf("title" to "a-updated")),
                        objectRecord("c", mapOf("title" to "c")),
                    ),
                ),
            )

            assertEquals(listOf("a", "c"), store.items.value.map { it.id })
            assertEquals("a-updated", store.get("a")?.title)
        } finally {
            store.close()
            socket.close()
        }
    }

    @Test
    fun reconnectSnapshotPrunesRowsDeletedWhileOffline() {
        // native-android-5: a server-side deletion that happened while the client
        // was disconnected is absent from the reconnect snapshot (not present as a
        // `removed` entry). The store must prune it instead of leaving a ghost row.
        val socket = newSocket()
        val store = newStore(socket)
        try {
            // Online: two rows are cached.
            store.onEvent(
                delta(
                    listOf(
                        objectRecord("a", mapOf("title" to "keep")),
                        objectRecord("b", mapOf("title" to "deleted-while-offline")),
                    ),
                ),
            )
            assertEquals(listOf("a", "b"), store.items.value.map { it.id })

            // Reconnect: the store re-subscribes (armed here) and the server
            // replays an authoritative snapshot that NO LONGER contains "b".
            store.markResubscribed()
            store.onEvent(
                delta(
                    listOf(
                        objectRecord("a", mapOf("title" to "keep-updated")),
                        objectRecord("c", mapOf("title" to "new-since-reconnect")),
                    ),
                ),
            )

            // "b" is pruned; "a" updated; "c" added.
            assertEquals(listOf("a", "c"), store.items.value.map { it.id })
            assertEquals("keep-updated", store.get("a")?.title)
            assertNull(store.get("b"))
        } finally {
            store.close()
            socket.close()
        }
    }

    @Test
    fun snapshotBoundaryAppliesOnlyToTheFirstDeltaAfterResubscribe() {
        // Only the FIRST delta after a (re)subscribe is a snapshot boundary; a
        // subsequent live delta must NOT prune rows it simply doesn't mention.
        val socket = newSocket()
        val store = newStore(socket)
        try {
            store.markResubscribed()
            store.onEvent(
                delta(
                    listOf(
                        objectRecord("a", mapOf("title" to "a")),
                        objectRecord("b", mapOf("title" to "b")),
                    ),
                ),
            )
            assertEquals(listOf("a", "b"), store.items.value.map { it.id })

            // A later live delta touches only "a" — "b" must survive.
            store.onEvent(delta(listOf(objectRecord("a", mapOf("title" to "a2")))))

            assertEquals(listOf("a", "b"), store.items.value.map { it.id })
            assertEquals("a2", store.get("a")?.title)
            assertEquals("b", store.get("b")?.title)
        } finally {
            store.close()
            socket.close()
        }
    }

    @Test
    fun ignoresDeltaObjectsOfOtherTypes() {
        val socket = newSocket()
        val store = newStore(socket)
        try {
            val foreign = mapOf(
                "type" to "Note",
                "id" to "n1",
                "value" to mapOf("id" to "n1", "title" to "not a todo"),
            )
            store.onEvent(delta(listOf(foreign, objectRecord("a", mapOf("title" to "a")))))

            assertEquals(listOf("a"), store.items.value.map { it.id })
        } finally {
            store.close()
            socket.close()
        }
    }
}
