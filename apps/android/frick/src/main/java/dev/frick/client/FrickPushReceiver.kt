package dev.frick.client

/**
 * Push receive surface for the Kotlin SDK.
 *
 * The Frick server's `fcm-adapter.ts` encodes notifications as an FCM
 * message with:
 *   * `notification`: `{ title, body }` for the user-visible alert
 *   * `data`: `{ intent, threadId?, deepLink?, ...customString }` for
 *     the structured payload — every value is a String per FCM v1.
 *
 * `FrickPushPayload` is the typed view of that data shape. Apps wire a
 * `FirebaseMessagingService` (or any other receiver) to call
 * [FrickPushPayload.from] on the incoming message, then hand the result
 * to a [FrickDeepLinkRouter] to resolve the matching screen.
 *
 * The Firebase SDK and the matching credentials are intentionally not
 * pulled into the Frick library — the consumer wires that up in their
 * own app module so credentials, build flavors, and Crashlytics
 * choices stay app-owned.
 */
data class FrickPushPayload(
    val intent: String,
    val title: String?,
    val body: String?,
    val threadId: String?,
    val deepLink: String?,
    /** Everything else the server included under FCM's `data` map. */
    val data: Map<String, String>,
) {
    companion object {
        /**
         * Decode a payload from the `data` + `notification` fields a
         * `FirebaseMessagingService.onMessageReceived` callback exposes.
         * Returns null for shapes that don't carry an `intent` key —
         * caller falls back to its own handling for third-party pushes.
         */
        @JvmStatic
        fun from(notification: Map<String, String?>, data: Map<String, String>): FrickPushPayload? {
            val intent = data["intent"] ?: return null
            val extras = data.filterKeys { it !in RESERVED_KEYS }
            return FrickPushPayload(
                intent = intent,
                title = notification["title"],
                body = notification["body"],
                threadId = data["threadId"],
                deepLink = data["deepLink"],
                data = extras,
            )
        }

        private val RESERVED_KEYS = setOf("intent", "threadId", "deepLink")
    }
}

/**
 * Resolves a [FrickPushPayload] to one of the app's typed routes. The
 * generic [Route] parameter is the app's own destination enum / sealed
 * class. The router runs a small pattern-matching list keyed by the
 * payload's `intent` string.
 *
 *   val router = FrickDeepLinkRouter<AppRoute>()
 *     .on("activity.created") { payload -> AppRoute.Item(payload.resourceId ?: "default") }
 *     .on("call.ringing") { payload -> AppRoute.Call(payload.data["callId"].orEmpty()) }
 *
 *   router.resolve(payload)?.let { navigator.navigate(it) }
 */
class FrickDeepLinkRouter<Route> {
    private val entries: MutableList<Pair<String, (FrickPushPayload) -> Route?>> = mutableListOf()
    private var fallback: ((FrickPushPayload) -> Route?)? = null

    fun on(intent: String, resolve: (FrickPushPayload) -> Route?): FrickDeepLinkRouter<Route> {
        entries.add(intent to resolve)
        return this
    }

    fun fallback(resolve: (FrickPushPayload) -> Route?): FrickDeepLinkRouter<Route> {
        fallback = resolve
        return this
    }

    fun resolve(payload: FrickPushPayload): Route? {
        for ((intent, fn) in entries) {
            if (intent == payload.intent) {
                fn(payload)?.let { return it }
            }
        }
        return fallback?.invoke(payload)
    }
}
