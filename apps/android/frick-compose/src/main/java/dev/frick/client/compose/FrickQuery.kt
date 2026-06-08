package dev.frick.client.compose

import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.remember
import dev.frick.client.FrickObservableStore
import dev.frick.client.FrickStoreRegistry
import kotlin.reflect.KClass

/**
 * Compose object-collection state — Kotlin/Compose parity with the Swift
 * `@FrickQuery` SwiftUI property wrapper (FR-150).
 *
 * `rememberFrickQuery` resolves a typed [FrickObservableStore] from a
 * [FrickStoreRegistry] (FR-149), subscribes to its `items` [StateFlow] via
 * `collectAsState`, and surfaces the live collection as Compose `State<List<Model>>`
 * with optional filtering and sorting applied — mirroring `@FrickQuery`'s
 * `filter` + `sort` ergonomics:
 *
 * ```kotlin
 * val todos by rememberFrickQuery(
 *     registry,
 *     Todo::class,
 *     filter = { !it.done },
 *     sort = compareBy { it.title },
 * )
 * ```
 *
 * The registry resolves (and starts, on first use) one shared store per type, so
 * several `rememberFrickQuery` call sites for the same `Model` share a single
 * cache + sync loop. Filtering and sorting run in a [derivedStateOf] over the
 * collected snapshot, so they re-run only when the underlying collection — or a
 * supplied predicate/comparator key — actually changes, not on every recompose.
 *
 * This file lives in `:frick-compose` so the core `:frick` SDK stays
 * Compose-agnostic.
 */

/**
 * Resolve the [modelClass] store from [registry] and observe its live collection
 * as Compose state, with optional [filter] and [sort] applied.
 *
 * @param filter optional row predicate; rows for which it returns `false` are
 *   omitted. `null` (default) keeps every row.
 * @param sort optional [Comparator] applied after filtering. `null` (default)
 *   preserves the store's insertion order.
 */
@Composable
fun <Model : Any> rememberFrickQuery(
    registry: FrickStoreRegistry,
    modelClass: KClass<Model>,
    filter: ((Model) -> Boolean)? = null,
    sort: Comparator<Model>? = null,
): State<List<Model>> {
    // Resolve (and start, on first use) the shared store for this type. Keyed by
    // (registry, modelClass) so navigating between registries re-resolves.
    val store = remember(registry, modelClass) { registry.store(modelClass) }
    return rememberFrickQuery(store, filter, sort)
}

/**
 * Lower-level overload over an already-resolved [store] — for callers that hold
 * the [FrickObservableStore] directly rather than going through a registry.
 */
@Composable
fun <Model : Any> rememberFrickQuery(
    store: FrickObservableStore<Model>,
    filter: ((Model) -> Boolean)? = null,
    sort: Comparator<Model>? = null,
): State<List<Model>> {
    val collected: State<List<Model>> = store.items.collectAsState()
    return remember(collected, filter, sort) {
        derivedStateOf {
            applyQuery(collected.value, filter, sort)
        }
    }
}

/**
 * Reified convenience: `rememberFrickQuery<Todo>(registry, sort = …)`.
 */
@Composable
inline fun <reified Model : Any> rememberFrickQuery(
    registry: FrickStoreRegistry,
    noinline filter: ((Model) -> Boolean)? = null,
    sort: Comparator<Model>? = null,
): State<List<Model>> = rememberFrickQuery(registry, Model::class, filter, sort)

/**
 * Pure filter+sort projection over a collection snapshot. Extracted so the
 * query semantics are unit-testable without a Compose runtime.
 */
fun <Model : Any> applyQuery(
    items: List<Model>,
    filter: ((Model) -> Boolean)?,
    sort: Comparator<Model>?,
): List<Model> {
    val filtered = if (filter == null) items else items.filter(filter)
    return if (sort == null) filtered else filtered.sortedWith(sort)
}
