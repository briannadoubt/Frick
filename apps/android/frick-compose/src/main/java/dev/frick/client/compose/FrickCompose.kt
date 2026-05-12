package dev.frick.client.compose

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import dev.frick.client.FrickInboundEvent
import dev.frick.client.FrickStreamEvent
import dev.frick.client.FrickSyncSocket
import dev.frick.client.ProjectionChange
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Compose helpers mirroring the Swift SDK's `@FrickStream` /
 * `@FrickPresence` property wrappers.
 *
 * The Kotlin SDK already exposes `FrickSyncSocket.events` as a
 * `SharedFlow<FrickInboundEvent>` and `status` as a `StateFlow`, which
 * Compose can already `.collectAsState()` directly — these helpers add
 * the small amount of plumbing every consumer would otherwise write
 * by hand: bind to a single `(stream, key)` subscription, accumulate the
 * resulting events into a `State<List<…>>`, and tear the subscription
 * down on disposal.
 *
 * Lives in a separate `:frick-compose` Gradle module so the core
 * `:frick` SDK can stay Compose-agnostic for non-Compose consumers
 * (XML View, server-side JVM, etc.).
 */

/**
 * Subscribe to a stream + collect the live tail of decoded events.
 * Returns a Compose `State<List<Map<String, Any?>>>` keyed by `(stream,
 * key)` so the subscription re-binds when the consumer navigates away.
 */
@Composable
fun rememberFrickStream(
    socket: FrickSyncSocket,
    stream: String,
    key: String,
): State<List<Map<String, Any?>>> {
    val state = remember(stream, key) { mutableStateOf(emptyList<Map<String, Any?>>()) }
    LaunchedEffect(socket, stream, key) {
        socket.subscribe(stream, key)
        socket.events.collect { event ->
            if (event !is FrickInboundEvent.Delta) return@collect
            val matching = event.events.filter { e ->
                (e["stream"] as? String) == stream && (e["streamId"] as? String) == key
            }
            if (matching.isNotEmpty()) {
                state.value = state.value + matching
            }
        }
    }
    return state
}

/**
 * Subscribe to a presence channel + collect the rolling record set
 * (last-write-wins per `key`, with cleared keys removed). Returns a
 * Compose `State<List<Map<String, Any?>>>` of the current roster.
 */
@Composable
fun rememberFrickPresence(
    socket: FrickSyncSocket,
    name: String,
    key: String,
): State<List<Map<String, Any?>>> {
    val state = remember(name, key) { mutableStateOf(emptyList<Map<String, Any?>>()) }
    LaunchedEffect(socket, name, key) {
        socket.subscribePresence(name, key)
        socket.events.collect { event ->
            if (event !is FrickInboundEvent.PresenceDelta) return@collect
            if (event.name != name) return@collect
            var next = state.value
            if (event.cleared.isNotEmpty()) {
                next = next.filterNot { record ->
                    val recordKey = record["key"] as? String
                    recordKey != null && event.cleared.contains(recordKey)
                }
            }
            for (record in event.records) {
                val recordKey = record["key"] as? String ?: continue
                val idx = next.indexOfFirst { (it["key"] as? String) == recordKey }
                next = if (idx == -1) next + record else next.toMutableList().also { it[idx] = record }
            }
            state.value = next
        }
    }
    return state
}

/**
 * Generic Compose helper: subscribes to a `SharedFlow<T>` for the
 * lifetime of the composition and invokes `onValue` for each emission.
 * Tears down on dispose. Pair with `socket.events` to observe every
 * `FrickInboundEvent`.
 *
 * Named with the `Use` prefix per Compose naming convention for
 * `@Composable` functions without a return type.
 */
@Composable
fun <T> UseFrickEvents(flow: SharedFlow<T>, onValue: (T) -> Unit) {
    LaunchedEffect(flow) {
        flow.collect(onValue)
    }
}

/**
 * Generic Compose helper: subscribes to a `StateFlow<T>` for the lifetime
 * of the composition. Useful for `socket.status` so the UI can react to
 * connect / reconnect / failure without writing its own collector.
 */
@Composable
fun <T> UseFrickStatus(flow: StateFlow<T>, onValue: (T) -> Unit) {
    LaunchedEffect(flow) {
        flow.collect(onValue)
    }
}

// Keep the Job import live so `all warnings as errors` doesn't reject
// the unused-import; callers in apps/android/app rely on the public
// surface and import Job themselves.
@Suppress("unused")
private val unusedSentinel: Job? = null

/**
 * Decode a wire-shaped stream-event map (the `events` payload of
 * [FrickInboundEvent.Delta]) into the typed [FrickStreamEvent]
 * domain shape. Returns `null` if the map is missing required keys.
 *
 * Public so the typed Compose helpers below and demo code can share
 * one canonical decoder rather than each rolling their own.
 */
fun decodeFrickStreamEvent(raw: Map<String, Any?>, fallbackStreamId: String? = null): FrickStreamEvent? {
    val stream = raw["stream"]?.toString() ?: return null
    val streamId = raw["streamId"]?.toString() ?: fallbackStreamId ?: return null
    val sequence = (raw["sequence"] as? Number)?.toInt() ?: return null
    val eventId = raw["eventId"]?.toString() ?: return null
    val eventName = raw["event"]?.toString() ?: return null
    @Suppress("UNCHECKED_CAST")
    val payloadRaw = raw["payload"] as? Map<String, Any?> ?: emptyMap()
    val payload = payloadRaw.mapValues { entry -> entry.value?.toString().orEmpty() }
    return FrickStreamEvent(stream, streamId, sequence, eventId, eventName, payload)
}

/**
 * Typed sibling of [rememberFrickStream]: subscribes to `(stream, key)`
 * and returns the accumulated tail decoded into [FrickStreamEvent], the
 * domain type the rest of the Kotlin SDK already consumes. Duplicates
 * are dropped by `eventId` and the list is kept ordered by `sequence`.
 */
@Composable
fun rememberFrickStreamEvents(
    socket: FrickSyncSocket,
    stream: String,
    key: String,
): State<List<FrickStreamEvent>> {
    val state = remember(stream, key) { mutableStateOf(emptyList<FrickStreamEvent>()) }
    LaunchedEffect(socket, stream, key) {
        socket.subscribe(stream, key)
        socket.events.collect { event ->
            if (event !is FrickInboundEvent.Delta) return@collect
            val decoded = event.events
                .filter { e -> (e["stream"] as? String) == stream && (e["streamId"] as? String) == key }
                .mapNotNull { decodeFrickStreamEvent(it, key) }
            if (decoded.isEmpty()) return@collect
            val combined = (state.value + decoded)
                .distinctBy { it.eventId }
                .sortedBy { it.sequence }
            state.value = combined
        }
    }
    return state
}

/**
 * Compose helper for projection subscriptions: subscribes to
 * `projection` and returns a `State<Map<key, value?>>` representing the
 * current live row set. Keys whose latest delta carries `value == null`
 * are removed from the map. Mirrors the projection consumption pattern
 * the demo previously hand-rolled around [FrickInboundEvent.ProjectionDelta].
 */
@Composable
fun rememberFrickProjection(
    socket: FrickSyncSocket,
    projection: String,
): State<Map<String, Map<String, Any?>?>> {
    val state = remember(projection) { mutableStateOf(emptyMap<String, Map<String, Any?>?>()) }
    LaunchedEffect(socket, projection) {
        socket.subscribeProjection(projection)
        socket.events.collect { event ->
            if (event !is FrickInboundEvent.ProjectionDelta) return@collect
            if (event.projection != projection) return@collect
            val next = state.value.toMutableMap()
            for (change: ProjectionChange in event.changes) {
                if (change.value == null) next.remove(change.key) else next[change.key] = change.value
            }
            state.value = next.toMap()
        }
    }
    return state
}
