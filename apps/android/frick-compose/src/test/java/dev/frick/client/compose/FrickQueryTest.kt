package dev.frick.client.compose

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit-tests the pure filter+sort projection backing [rememberFrickQuery]
 * (FR-150). The Compose plumbing (`collectAsState`/`derivedStateOf`) is thin;
 * the query semantics live in [applyQuery], exercised here without a Compose
 * runtime.
 */
class FrickQueryTest {

    data class Todo(val id: String, val title: String, val done: Boolean)

    private val rows = listOf(
        Todo("c", "Charlie", done = false),
        Todo("a", "Alpha", done = true),
        Todo("b", "Bravo", done = false),
    )

    @Test
    fun noFilterNoSortPreservesOrder() {
        assertEquals(listOf("c", "a", "b"), applyQuery(rows, null, null).map { it.id })
    }

    @Test
    fun filterDropsNonMatchingRows() {
        val open = applyQuery(rows, { !it.done }, null)
        assertEquals(listOf("c", "b"), open.map { it.id })
    }

    @Test
    fun sortOrdersRows() {
        val sorted = applyQuery(rows, null, compareBy { it.title })
        assertEquals(listOf("Alpha", "Bravo", "Charlie"), sorted.map { it.title })
    }

    @Test
    fun filterThenSortAppliesBoth() {
        val result = applyQuery(rows, { !it.done }, compareBy { it.title })
        // Alpha is filtered out (done == true); remaining sorted by title.
        assertEquals(listOf("Bravo", "Charlie"), result.map { it.title })
    }

    @Test
    fun emptyInputYieldsEmpty() {
        assertEquals(emptyList<Todo>(), applyQuery(emptyList<Todo>(), { true }, compareBy { it.title }))
    }
}
