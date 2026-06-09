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
 *    re-subscribes automatically so the server replays a fresh snapshot. The
 *    first delta after each (re)subscribe is treated as a **snapshot boundary**:
 *    the cache is reconciled against the snapshot's id set so rows the server
 *    DELETED while the client was offline (absent from the snapshot rather than
 *    present as a `removed` entry) are pruned instead of lingering as stale
 *    "ghost" rows. Live deltas after the boundary keep folding in as upserts.
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

    // Set when a (re)subscribe is issued; the next delta is the authoritative
    // snapshot and the cache is reconciled against it (stale rows pruned) before
    // its upserts fold in. Guarded by `lock`.
    private var pendingSnapshotReset = false

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
                    // Arm the snapshot-boundary reconcile: the snapshot the server
                    // replays for this (re)subscribe is the authoritative row set,
                    // so the next delta prunes rows deleted while we were offline.
                    synchronized(lock) { pendingSnapshotReset = true }
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
            // Snapshot-boundary reconcile: on the first delta after a
            // (re)subscribe, the snapshot is the authoritative current row set.
            // Prune any cached id that the snapshot does NOT carry — those are
            // rows the server deleted while we were disconnected (absent from the
            // snapshot rather than present as a `removed` entry). Live deltas
            // after the boundary skip this and keep folding in as upserts.
            if (pendingSnapshotReset) {
                pendingSnapshotReset = false
                val present = HashSet<String>()
                for (record in delta.objects) {
                    if (record.stringField("type") != type) continue
                    val id = record.stringField("id") ?: continue
                    // Only ids that decode to a live row count as "present"; a
                    // tombstone record in the snapshot still means the row is gone.
                    if (decoder.decode(record) != null) present.add(id)
                }
                val staleIterator = cache.keys.iterator()
                while (staleIterator.hasNext()) {
                    if (staleIterator.next() !in present) {
                        staleIterator.remove()
                        changed = true
                    }
                }
            }
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
     * Test/integration seam: arm the snapshot-boundary reconcile so the next
     * delta is treated as an authoritative snapshot (stale rows pruned). The live
     * path arms this automatically on every (re)subscribe; tests that drive
     * [onEvent] directly without a socket use this to exercise the reconnect
     * reconcile.
     */
    internal fun markResubscribed() {
        synchronized(lock) { pendingSnapshotReset = true }
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
