package dev.frick.client

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Cross-device draft sync over the `MessageDraft` foundation object.
 * Mirrors the React `useDraft({ sync: true })` hook and the Swift
 * `FrickDraftStore`. Per-conversation rows are addressed by the
 * cross-SDK id convention `"${userId}:${conversationId}"`, so
 * per-user isolation comes for free without a policy hook.
 *
 * The schema's `versionPrecondition` merge policy means concurrent
 * typing on two devices races; this store surfaces the conflict via
 * the returned [Result] from [setDraft] and refreshes its tracked
 * version off the inbound `objectsDelta` so the next write picks the
 * server's view (last-write-wins by default).
 */
class FrickDraftStore(
    private val socket: FrickSyncSocket,
    private val userId: String,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    private val bodies = mutableMapOf<String, String>()
    private val versions = mutableMapOf<String, Int>()
    private val mutex = Mutex()
    private val emissions = MutableSharedFlow<Pair<String, String>>(extraBufferCapacity = 64)
    private var listenerJob: Job? = null
    private val subscribed = MutableStateFlow(false)

    companion object {
        fun draftId(userId: String, conversationId: String): String = "$userId:$conversationId"
    }

    /**
     * Returns a flow of the draft body for `(userId, conversationId)`,
     * starting with the current known body (or empty string if none
     * yet) and updating on every server-confirmed delta. The first
     * call also lazily kicks off the underlying object subscription.
     */
    fun flowDraft(conversationId: String): Flow<String> {
        ensureSubscribed()
        val id = draftId(userId, conversationId)
        return emissions.asSharedFlow()
            .filter { it.first == id }
            .map { it.second }
            .onStart {
                val initial: String = mutex.withLock { bodies[id].orEmpty() }
                emit(initial)
            }
    }

    /**
     * Upsert the draft body. Returns `Result.success(version)` on a
     * normal ack, `Result.failure(FrickHttpException)` on the
     * versionPrecondition conflict (the caller can decide to re-try
     * with the server's version, which the next call here will pick
     * up automatically once the inbound delta refreshes our cache).
     */
    suspend fun setDraft(conversationId: String, body: String): Result<Int> {
        val id = draftId(userId, conversationId)
        val expected = mutex.withLock { versions[id] }
        val payload = mapOf(
            "userId" to userId,
            "conversationId" to conversationId,
            "body" to body,
            "updatedAt" to System.currentTimeMillis(),
        )
        return try {
            val version = socket.upsertObject(
                type = "MessageDraft",
                id = id,
                value = payload,
                expectedVersion = expected,
            )
            mutex.withLock {
                versions[id] = version
                bodies[id] = body
            }
            emissions.tryEmit(id to body)
            Result.success(version)
        } catch (error: FrickHttpException) {
            Result.failure(error)
        }
    }

    /**
     * Clear the draft for a conversation. Emits an empty-body upsert
     * since the schema doesn't expose a delete primitive today.
     */
    suspend fun clearDraft(conversationId: String): Result<Int> = setDraft(conversationId, "")

    private fun ensureSubscribed() {
        if (subscribed.value) return
        subscribed.value = true
        listenerJob = scope.launch {
            try {
                socket.subscribeObject(type = "MessageDraft")
            } catch (_: Exception) {
                subscribed.value = false
                return@launch
            }
            socket.events.collect { event ->
                if (event !is FrickInboundEvent.Delta) return@collect
                for (record in event.objects) {
                    val type = record["type"] as? String ?: continue
                    if (type != "MessageDraft") continue
                    val id = record["id"] as? String ?: continue
                    @Suppress("UNCHECKED_CAST")
                    val value = record["value"] as? Map<String, Any?> ?: continue
                    val body = value["body"]?.toString().orEmpty()
                    mutex.withLock { bodies[id] = body }
                    emissions.tryEmit(id to body)
                }
            }
        }
    }
}
