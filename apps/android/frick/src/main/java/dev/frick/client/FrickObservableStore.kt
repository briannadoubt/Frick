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
 * Decodes a single object record from the sync gateway into a typed [Model].
 *
 * The record is the named-field map produced by [FrickSyncSocket]'s packed
 * decoder: `{ "type": String, "id": String, "value": Map<String, Any?> }`,
 * where `value` itself contains the object's fields (including a mirrored
 * `id`). Implementations pull the fields they care about out of `value`.
 *
 * Return `null` to signal the row should be *dropped* from the cache — this is
 * how a consumer can treat a server tombstone record (a delta object whose
 * `value` marks the row deleted) as a removal without a dedicated wire field.
 */
fun interface FrickObjectDecoder<Model : Any> {
    fun decode(record: Map<String, Any?>): Model?
}

/**
 * A generic, reusable observable object store + sync loop for the Android SDK.
 *
 * Subscribes to a single object `type` over an existing [FrickSyncSocket],
 * maintains an in-memory cache keyed by object id, and exposes the collection
 * as a [StateFlow] of decoded models for Compose `collectAsState`.
 *
 * Lifecycle:
 *  - [start] subscribes to the type and begins collecting [FrickSyncSocket.events].
 *  - The first [FrickInboundEvent.Delta] for the type is the initial snapshot;
 *    subsequent deltas carry live upserts. Both flow through the same path.
 *  - Removals are applied from the typed `removed` list on the delta payload
 *    ([FrickInboundEvent.Delta.removed], `ObjectRemoval(type, id)`, FR-144) and
 *    — as a fallback for servers/decoders that signal deletion via a tombstone
 *    record — whenever [decoder] returns `null` for a record. Either way the row
 *    leaves [items] without a refetch.
 *  - On reconnect (the socket transitions back to Ready after a drop) the store
 *    re-subscribes automatically so the server replays a fresh snapshot.
 *
 * The store is generic over `Model` and decodes records via an injected
 * [FrickObjectDecoder]; [idOf] extracts the stable cache key from a decoded
 * model. Nothing here is type-specific — callers supply both lambdas.
 */
class FrickObservableStore<Model : Any>(
    private val socket: FrickSyncSocket,
    /** The object type name to subscribe to (matches `subscribeObject(type)`). */
    private val type: String,
    private val decoder: FrickObjectDecoder<Model>,
    /** Extracts the stable cache key (object id) from a decoded model. */
    private val idOf: (Model) -> String,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) : AutoCloseable {

    // Insertion-ordered cache keyed by object id. Guarded by `lock` so the
    // event collector and any external apply* calls don't race.
    private val cache = LinkedHashMap<String, Model>()
    private val lock = Any()

    private val _items = MutableStateFlow<List<Model>>(emptyList())

    /** The live collection. Collect with Compose `collectAsState()`. */
    val items: StateFlow<List<Model>> = _items.asStateFlow()

    @Volatile private var collectJob: Job? = null
    @Volatile private var statusJob: Job? = null
    @Volatile private var started = false
    @Volatile private var lastReady = false
    @Volatile private var closed = false

    /**
     * Begin syncing: subscribe to [type] and start applying deltas. Idempotent —
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
        // reconnect replays the snapshot for this type.
        statusJob = scope.launch {
            socket.status.collect { status ->
                val ready = status is FrickSyncStatus.Ready
                if (ready && !lastReady) {
                    socket.subscribeObject(type)
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
     * inject [FrickInboundEvent.Delta]s without standing up a socket.
     */
    internal fun onEvent(event: FrickInboundEvent) {
        when (event) {
            is FrickInboundEvent.Delta -> applyDelta(event)
            else -> Unit
        }
    }

    private fun applyDelta(delta: FrickInboundEvent.Delta) {
        var changed = false
        synchronized(lock) {
            for (record in delta.objects) {
                if (record.stringField("type") != type) continue
                val id = record.stringField("id") ?: continue
                val decoded = decoder.decode(record)
                if (decoded == null) {
                    // Tombstone / decoder-signalled removal.
                    if (cache.remove(id) != null) changed = true
                } else {
                    cache[idOf(decoded)] = decoded
                    changed = true
                }
            }
            // FR-144: honor the typed `removed` list directly, dropping rows
            // without a refetch. Applied after the upserts so a delete wins over
            // its own back-compat tombstone record in the same delta.
            for (removal in delta.removed) {
                if (removal.type != type) continue
                if (cache.remove(removal.id) != null) changed = true
            }
        }
        if (changed) publish()
    }

    /**
     * Explicitly drop a row by id (e.g. driven by a higher layer that observes
     * removals out-of-band). Safe to call from any thread.
     */
    fun remove(id: String) {
        val changed = synchronized(lock) { cache.remove(id) != null }
        if (changed) publish()
    }

    /** Current decoded model for [id], or null if absent. */
    fun get(id: String): Model? = synchronized(lock) { cache[id] }

    private fun publish() {
        val snapshot = synchronized(lock) { cache.values.toList() }
        _items.value = snapshot
    }

    override fun close() {
        if (closed) return
        closed = true
        collectJob?.cancel()
        statusJob?.cancel()
        scope.cancel()
    }
}
