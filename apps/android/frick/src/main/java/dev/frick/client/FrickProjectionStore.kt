package dev.frick.client

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * A generic, reusable observable projection store + sync loop for the Android
 * SDK.
 *
 * Subscribes to a single projection `name` over an existing [FrickSyncSocket],
 * maintains an in-memory map keyed by the projection-defined row key, and
 * exposes the rows as a [StateFlow] for Compose `collectAsState`. It mirrors
 * the TypeScript runtime's `client.projection(name)` abstraction (a Signal of
 * `Map<rowKey, row>` fed by `ProjectionDelta` frames) and the Swift
 * `FrickProjectionStore`.
 *
 * Lifecycle:
 *  - [start] subscribes to the projection and begins collecting
 *    [FrickSyncSocket.events].
 *  - Each [FrickInboundEvent.ProjectionDelta] for [name] is folded into the
 *    map: a change with a non-null [ProjectionChange.value] upserts the row at
 *    its key; a null value deletes it (matching the TS null-deletes semantics).
 *  - On reconnect (the socket transitions back to Ready after a drop) the store
 *    re-subscribes automatically so the server replays a fresh snapshot.
 *
 * Row values are surfaced as the decoded `Map<String, Any?>` payload exactly as
 * delivered on the wire, so callers project them into their own model types.
 */
class FrickProjectionStore(
    private val socket: FrickSyncSocket,
    /** The projection name to subscribe to (matches `subscribeProjection(name)`). */
    private val name: String,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) : AutoCloseable {

    // Insertion-ordered cache keyed by row key. Guarded by `lock` so the event
    // collector and any external apply* calls don't race.
    private val cache = LinkedHashMap<String, Map<String, Any?>>()
    private val lock = Any()

    private val _rows = MutableStateFlow<Map<String, Map<String, Any?>>>(emptyMap())

    /** The live projection rows. Collect with Compose `collectAsState()`. */
    val rows: StateFlow<Map<String, Map<String, Any?>>> = _rows.asStateFlow()

    @Volatile private var collectJob: Job? = null
    @Volatile private var statusJob: Job? = null
    @Volatile private var started = false
    @Volatile private var lastReady = false
    @Volatile private var closed = false

    /**
     * Begin syncing: subscribe to [name] and start applying deltas. Idempotent —
     * a second call while already running is a no-op.
     */
    fun start() {
        if (closed) return
        synchronized(lock) {
            if (started) return
            started = true
        }
        collectJob = scope.launch {
            socket.events.collect { event -> onEvent(event) }
        }
        // Drive (re)subscription off the socket's Ready transitions so a
        // reconnect replays the snapshot for this projection.
        statusJob = scope.launch {
            socket.status.collect { status ->
                val ready = status is FrickSyncStatus.Ready
                if (ready && !lastReady) {
                    socket.subscribeProjection(name)
                }
                lastReady = ready
            }
        }
        // Ensure the socket is connecting; harmless if already in flight.
        socket.connect()
    }

    /**
     * Apply a single inbound event to the cache. Public-but-internal seam used
     * by the live collector ([start]) and exercised directly by unit tests that
     * inject [FrickInboundEvent.ProjectionDelta]s without standing up a socket.
     */
    internal fun onEvent(event: FrickInboundEvent) {
        when (event) {
            is FrickInboundEvent.ProjectionDelta -> applyDelta(event)
            else -> Unit
        }
    }

    private fun applyDelta(delta: FrickInboundEvent.ProjectionDelta) {
        if (delta.projection != name) return
        var changed = false
        synchronized(lock) {
            for (change in delta.changes) {
                val value = change.value
                if (value == null) {
                    if (cache.remove(change.key) != null) changed = true
                } else {
                    cache[change.key] = value
                    changed = true
                }
            }
        }
        if (changed) publish()
    }

    /** Current row payload for [key], or null if absent. */
    fun get(key: String): Map<String, Any?>? = synchronized(lock) { cache[key] }

    private fun publish() {
        val snapshot = synchronized(lock) { LinkedHashMap(cache) }
        _rows.value = snapshot
    }

    override fun close() {
        if (closed) return
        closed = true
        collectJob?.cancel()
        statusJob?.cancel()
        scope.cancel()
    }
}
