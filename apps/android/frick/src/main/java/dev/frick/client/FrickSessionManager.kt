package dev.frick.client

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Immutable snapshot of the app's Frick authentication state.
 *
 * Collected by Compose (`collectAsState`) off [FrickSessionManager.state] to
 * gate the UI between a sign-in screen and the signed-in app. Kotlin analogue
 * of the observable properties on Swift's `@Observable FrickSessionManager`.
 */
data class SessionState(
    /**
     * The active Frick session, or `null` when signed out. Views gate on this
     * (or on [isAuthenticated]). Seeded from the client's persisted session at
     * construction and updated by every auth verb.
     */
    val session: FrickSession? = null,
    /**
     * `true` while an auth network call ([FrickSessionManager.signIn] /
     * [FrickSessionManager.signUp] / [FrickSessionManager.signOut]) is in
     * flight. Sign-in UIs disable their submit button while this is `true` to
     * avoid duplicate submissions.
     */
    val isAuthenticating: Boolean = false,
    /**
     * The error thrown by the most recent auth verb, or `null` after a success.
     * Cleared at the start of each verb. Sign-in UIs surface this as the form's
     * error message.
     */
    val lastError: Throwable? = null,
) {
    /** Convenience flag — `true` exactly when a session is held. */
    val isAuthenticated: Boolean get() = session != null
}

/**
 * Observable holder for the app's Frick authentication state — Kotlin parity
 * with Swift's `FrickSessionManager` (FR-139), idiomatic as a
 * [StateFlow]<[SessionState]> + suspend verbs.
 *
 * [FrickClient] already owns *durable* session persistence: it saves the active
 * [FrickSession] to its injected [FrickStorage] (the encrypted SQLite store by
 * default — the Android analogue of the iOS Keychain path) on every install via
 * the auth verbs, and exposes the restored session through
 * [FrickClient.currentSession]. What it does NOT provide is an *observable*
 * auth-STATE surface for Compose to gate on. This type fills that gap: it wraps
 * a [FrickClient], mirrors the client's session into an observable
 * [SessionState], and exposes the auth verbs a sign-in UI calls.
 *
 * Apps drop their own ad-hoc session persistence (a `SharedPreferences` session
 * blob and the like) and instead:
 *
 *   1. collect [state] (or [SessionState.isAuthenticated]) to gate their UI, and
 *   2. call [signIn] / [signUp] / [signOut] / [requestPasswordReset] /
 *      [resetPassword], which delegate to the underlying [FrickClient] and ride
 *      its existing encrypted persistence — strictly more secure than a
 *      `SharedPreferences` reimplementation, and less code.
 *
 * The manager seeds [SessionState.session] from [FrickClient.currentSession] at
 * construction, so a session the client restored from the encrypted store is
 * reflected immediately — the UI starts at the right gate on a warm launch
 * without any app-side restore code.
 *
 * The wrapped [client] is exposed read-only so screens that need the client
 * directly (a per-entity store, sync-socket setup) don't have to route through
 * a wrapper method here. Persistence is the client's responsibility — this type
 * never touches the store directly.
 */
class FrickSessionManager(
    val client: FrickClient,
) {
    // Seeded from the client's persisted session so a restored session is
    // reflected immediately on a warm launch.
    private val _state = MutableStateFlow(SessionState(session = client.currentSession))

    /** The live auth state. Collect with Compose `collectAsState()`. */
    val state: StateFlow<SessionState> = _state.asStateFlow()

    // MARK: - Auth verbs

    /**
     * Handle/password sign-in. Delegates to [FrickClient.login], which installs
     * (and persists) the returned session. On failure leaves the session
     * untouched, records the error in [SessionState.lastError], and rethrows so
     * callers can react; [SessionState.isAuthenticating] resets either way.
     */
    suspend fun signIn(
        identity: String,
        password: String,
        deviceId: String? = null,
        replicaId: String? = null,
        platform: String? = "android",
    ): FrickSession =
        runAuthVerb {
            client.login(
                identity = identity,
                password = password,
                deviceId = deviceId,
                replicaId = replicaId ?: client.replicaId,
                platform = platform,
            )
        }

    /**
     * Handle/password sign-up. Delegates to [FrickClient.signUp], which installs
     * (and persists) the returned session.
     */
    suspend fun signUp(
        displayName: String,
        handle: String,
        password: String,
        deviceId: String? = null,
        replicaId: String? = null,
        platform: String? = "android",
    ): FrickSession =
        runAuthVerb {
            client.signUp(
                displayName = displayName,
                handle = handle,
                password = password,
                deviceId = deviceId,
                replicaId = replicaId ?: client.replicaId,
                platform = platform,
            )
        }

    /**
     * Local logout — clears the persisted session (and queued appends) on the
     * client, then clears the observable session. [FrickClient.signOut] is local
     * and does not throw: the user pressed Sign Out, they're getting signed out
     * either way.
     */
    suspend fun signOut() {
        _state.update { it.copy(isAuthenticating = true, lastError = null) }
        try {
            client.signOut()
            _state.update { it.copy(session = null, isAuthenticating = false) }
        } catch (error: Throwable) {
            // signOut() is local + non-throwing today; defensively still clear
            // the observable session so the UI gates to the sign-in screen.
            _state.update { it.copy(session = null, isAuthenticating = false, lastError = error) }
        }
    }

    /**
     * Kick off the email password-reset flow. Stateless — does not touch the
     * active session. Delegates to [FrickClient.requestPasswordReset].
     */
    suspend fun requestPasswordReset(email: String) {
        client.requestPasswordReset(email = email)
    }

    /**
     * Complete the email password-reset flow with the one-time token and a new
     * password. Delegates to [FrickClient.resetPassword]. The server invalidates
     * the user's sessions on success, so call [signIn] afterwards to
     * re-establish one.
     */
    suspend fun resetPassword(token: String, newPassword: String) {
        client.resetPassword(token = token, newPassword = newPassword)
    }

    private suspend fun runAuthVerb(verb: suspend () -> FrickSession): FrickSession {
        _state.update { it.copy(isAuthenticating = true, lastError = null) }
        return try {
            val session = verb()
            _state.update { it.copy(session = session, isAuthenticating = false, lastError = null) }
            session
        } catch (error: Throwable) {
            _state.update { it.copy(isAuthenticating = false, lastError = error) }
            throw error
        }
    }
}
