package dev.frick.client

import kotlin.reflect.KClass

/**
 * A generic, type-keyed registry that owns and resolves per-type
 * [FrickObservableStore] instances (FR-149, Kotlin parity with the Swift
 * FrickStore registry tier).
 *
 * Instead of wiring one `FrickObservableStore<Model>` by hand for every object
 * type and threading it through the UI, a Compose app registers each type once
 * and then resolves the live store by its [KClass]:
 *
 * ```kotlin
 * val registry = FrickStoreRegistry()
 * registry.register(Todo::class, type = "Todo", decoder = todoDecoder, idOf = { it.id })
 * // …later, anywhere with the registry in hand:
 * val store = registry.store(Todo::class)   // started on first resolve
 * ```
 *
 * The registry is the single owner of the stores it creates: it lazily
 * [FrickObservableStore.start]s a store the first time it is resolved and
 * [FrickObservableStore.close]s every store it owns on [close]. Resolution is
 * idempotent — repeated [store] calls for the same model class return the same
 * live instance, so multiple Compose subscribers share one cache + sync loop.
 *
 * Idiomatic Kotlin: keyed by `KClass<Model>`, immutable registration records,
 * and thread-safe via a single lock so registration and resolution can race
 * across the main thread and background sync scopes.
 */
class FrickStoreRegistry(
    private val socket: FrickSyncSocket,
) : AutoCloseable {

    /**
     * A type's registration: everything needed to lazily build its
     * [FrickObservableStore]. Immutable — held until first resolution, then the
     * built store is cached alongside it.
     */
    private class Registration<Model : Any>(
        val type: String,
        val decoder: FrickObjectDecoder<Model>,
        val idOf: (Model) -> String,
    ) {
        @Volatile var store: FrickObservableStore<Model>? = null
    }

    private val lock = Any()
    private val registrations = LinkedHashMap<KClass<*>, Registration<*>>()

    @Volatile private var closed = false

    /**
     * Register the [modelClass] so its store can later be resolved by [store].
     * No store is built or started here — construction is deferred to the first
     * [store] call so registration is cheap and a never-resolved type costs
     * nothing.
     *
     * Registering the same [modelClass] twice replaces the prior registration;
     * any store already built for it is closed so the next [store] call rebuilds
     * with the new wiring. Idempotent re-registration of an unchanged type is a
     * no-op cost-wise but still drops the live store, so prefer registering each
     * type exactly once at app start.
     *
     * @param type the object type name to subscribe to (matches the wire `type`).
     * @param decoder decodes a `{ type, id, value }` record into [Model].
     * @param idOf extracts the stable cache key from a decoded model.
     */
    fun <Model : Any> register(
        modelClass: KClass<Model>,
        type: String,
        decoder: FrickObjectDecoder<Model>,
        idOf: (Model) -> String,
    ) {
        check(!closed) { "FrickStoreRegistry is closed" }
        val registration = Registration(type, decoder, idOf)
        synchronized(lock) {
            registrations.put(modelClass, registration)?.let { prior ->
                prior.store?.close()
            }
        }
    }

    /**
     * Resolve the live [FrickObservableStore] for [modelClass], building and
     * [FrickObservableStore.start]ing it on first call and returning the same
     * instance thereafter. Multiple callers share one cache + sync loop.
     *
     * @throws IllegalStateException if the registry is closed or [modelClass]
     *   was never [register]ed.
     */
    fun <Model : Any> store(modelClass: KClass<Model>): FrickObservableStore<Model> {
        check(!closed) { "FrickStoreRegistry is closed" }
        synchronized(lock) {
            @Suppress("UNCHECKED_CAST")
            val registration = registrations[modelClass] as? Registration<Model>
                ?: error("No FrickObservableStore registered for ${modelClass.simpleName ?: modelClass}")
            registration.store?.let { return it }
            val built = FrickObservableStore(
                socket = socket,
                type = registration.type,
                decoder = registration.decoder,
                idOf = registration.idOf,
            )
            registration.store = built
            built.start()
            return built
        }
    }

    /** True if [modelClass] has been [register]ed (whether or not yet resolved). */
    fun isRegistered(modelClass: KClass<*>): Boolean =
        synchronized(lock) { registrations.containsKey(modelClass) }

    /**
     * Close the registry and every store it owns. Idempotent. After close the
     * registry rejects further [register]/[store] calls.
     */
    override fun close() {
        val toClose: List<FrickObservableStore<*>>
        synchronized(lock) {
            if (closed) return
            closed = true
            toClose = registrations.values.mapNotNull { it.store }
            registrations.clear()
        }
        toClose.forEach { it.close() }
    }
}

/** Reified convenience: `registry.store<Todo>()`. */
inline fun <reified Model : Any> FrickStoreRegistry.store(): FrickObservableStore<Model> =
    store(Model::class)

/** Reified convenience: `registry.register<Todo>("Todo", decoder) { it.id }`. */
inline fun <reified Model : Any> FrickStoreRegistry.register(
    type: String,
    decoder: FrickObjectDecoder<Model>,
    noinline idOf: (Model) -> String,
) = register(Model::class, type, decoder, idOf)
