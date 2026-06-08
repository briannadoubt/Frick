package dev.frick.client

import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Exercises [FrickStoreRegistry] (FR-149): type-keyed registration, lazy +
 * idempotent resolution sharing one live store per type, re-registration
 * replacement, and close semantics — without standing up a real socket.
 */
class FrickStoreRegistryTest {

    data class Todo(val id: String, val title: String)
    data class Note(val id: String, val body: String)

    private fun newSocket(): FrickSyncSocket =
        FrickSyncSocket(
            baseUrl = "http://example.invalid",
            sessionTokenProvider = { null },
            config = FrickSyncSocketConfig(),
            httpClient = OkHttpClient(),
        )

    private val todoDecoder = FrickObjectDecoder<Todo> { record ->
        @Suppress("UNCHECKED_CAST")
        val value = record["value"] as? Map<String, Any?> ?: return@FrickObjectDecoder null
        val id = value["id"]?.toString() ?: return@FrickObjectDecoder null
        Todo(id = id, title = value["title"]?.toString() ?: "")
    }

    private val noteDecoder = FrickObjectDecoder<Note> { record ->
        @Suppress("UNCHECKED_CAST")
        val value = record["value"] as? Map<String, Any?> ?: return@FrickObjectDecoder null
        val id = value["id"]?.toString() ?: return@FrickObjectDecoder null
        Note(id = id, body = value["body"]?.toString() ?: "")
    }

    private fun registerTodos(registry: FrickStoreRegistry) =
        registry.register(Todo::class, type = "Todo", decoder = todoDecoder, idOf = { it.id })

    @Test
    fun resolvesRegisteredStore() {
        val socket = newSocket()
        val registry = FrickStoreRegistry(socket)
        try {
            assertFalse(registry.isRegistered(Todo::class))
            registerTodos(registry)
            assertTrue(registry.isRegistered(Todo::class))

            val store = registry.store(Todo::class)
            // The store is live: feeding it a delta surfaces decoded rows.
            store.onEvent(
                FrickInboundEvent.Delta(
                    objects = listOf(mapOf("type" to "Todo", "id" to "a", "value" to mapOf("id" to "a", "title" to "Buy milk"))),
                    events = emptyList(),
                    cursor = 0,
                    removed = emptyList(),
                ),
            )
            assertEquals(listOf("a"), store.items.value.map { it.id })
        } finally {
            registry.close()
            socket.close()
        }
    }

    @Test
    fun resolutionIsIdempotentAndShared() {
        val socket = newSocket()
        val registry = FrickStoreRegistry(socket)
        try {
            registerTodos(registry)
            val first = registry.store(Todo::class)
            val second = registry.store(Todo::class)
            assertSame("repeated resolution returns the same live store", first, second)
        } finally {
            registry.close()
            socket.close()
        }
    }

    @Test
    fun distinctTypesGetDistinctStores() {
        val socket = newSocket()
        val registry = FrickStoreRegistry(socket)
        try {
            registerTodos(registry)
            registry.register(Note::class, type = "Note", decoder = noteDecoder, idOf = { it.id })

            val todos = registry.store(Todo::class)
            val notes = registry.store(Note::class)
            assertNotSame(todos, notes)
        } finally {
            registry.close()
            socket.close()
        }
    }

    @Test
    fun reifiedHelpersResolve() {
        val socket = newSocket()
        val registry = FrickStoreRegistry(socket)
        try {
            registry.register<Todo>(type = "Todo", decoder = todoDecoder, idOf = { it.id })
            val store = registry.store<Todo>()
            assertSame(store, registry.store(Todo::class))
        } finally {
            registry.close()
            socket.close()
        }
    }

    @Test
    fun reRegistrationReplacesAndRebuilds() {
        val socket = newSocket()
        val registry = FrickStoreRegistry(socket)
        try {
            registerTodos(registry)
            val first = registry.store(Todo::class)
            // Re-register the same type: prior store is dropped, next resolve rebuilds.
            registerTodos(registry)
            val rebuilt = registry.store(Todo::class)
            assertNotSame("re-registration rebuilds the store", first, rebuilt)
        } finally {
            registry.close()
            socket.close()
        }
    }

    @Test
    fun resolvingUnregisteredTypeThrows() {
        val socket = newSocket()
        val registry = FrickStoreRegistry(socket)
        try {
            assertThrows(IllegalStateException::class.java) {
                registry.store(Todo::class)
            }
        } finally {
            registry.close()
            socket.close()
        }
    }

    @Test
    fun useAfterCloseThrows() {
        val socket = newSocket()
        val registry = FrickStoreRegistry(socket)
        registerTodos(registry)
        registry.close()
        assertThrows(IllegalStateException::class.java) { registry.store(Todo::class) }
        assertThrows(IllegalStateException::class.java) { registerTodos(registry) }
        socket.close()
    }

    @Test
    fun closeIsIdempotent() {
        val socket = newSocket()
        val registry = FrickStoreRegistry(socket)
        registerTodos(registry)
        registry.store(Todo::class)
        registry.close()
        registry.close() // no throw
        socket.close()
    }
}
