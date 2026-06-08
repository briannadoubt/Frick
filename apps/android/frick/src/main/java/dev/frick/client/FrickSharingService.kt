package dev.frick.client

import android.net.Uri
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Config for the deep-link/invitation-URL surface — the URL scheme an app
 * registers for inbound share links. Mirrors the Swift FR-140
 * `FrickSharingDeepLink` design, but the scheme is **injected** (not hardcoded
 * to a single app's `rangercrm://`) so the framework SDK stays app-agnostic.
 *
 * The full link an owner ships looks like `<scheme>://<host><acceptPath>?<tokenQueryParam>=<token>`,
 * e.g. `myapp://share/accept?token=<opaque>`. The host/path distinguish the
 * accept action from any other future share-related deep link.
 */
data class FrickSharingLinkConfig(
    /** URL scheme the app registers (e.g. `"myapp"`). No `://`. */
    val scheme: String,
    /** Host segment that identifies a share link. Defaults to `"share"`. */
    val host: String = "share",
    /** Path that identifies the accept action. Defaults to `"/accept"`. */
    val acceptPath: String = "/accept",
    /** Query-parameter name carrying the opaque token. Defaults to `"token"`. */
    val tokenQueryParam: String = "token",
) {
    /**
     * Build the URL an owner ships to a recipient out-of-band (message, email —
     * the channel is the app's choice). The token is URL-encoded.
     */
    fun acceptUrl(token: String): String =
        Uri.Builder()
            .scheme(scheme)
            .authority(host)
            .path(acceptPath)
            .appendQueryParameter(tokenQueryParam, token)
            .build()
            .toString()

    /**
     * Parse an inbound `<scheme>://<host><acceptPath>?<tokenQueryParam>=...`
     * URL, returning the token if the URL matches this config; `null` otherwise.
     */
    fun tokenFrom(url: String): String? {
        val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return null
        if (!uri.scheme.equals(scheme, ignoreCase = true)) return null
        if (!uri.host.equals(host, ignoreCase = true)) return null
        if (uri.path != acceptPath) return null
        return uri.getQueryParameter(tokenQueryParam)?.takeIf { it.isNotBlank() }
    }
}

/**
 * Outcome of a single try-accept, so a deep-link handler can surface success
 * or failure through one UI path. Mirrors Swift `FrickShareAcceptResult`.
 */
sealed interface FrickShareAcceptResult {
    data class Accepted(val grant: FrickGrant) : FrickShareAcceptResult

    /** The token was captured before sign-in; redeem it after authenticating. */
    object PendingSignIn : FrickShareAcceptResult

    data class Failed(val error: Throwable) : FrickShareAcceptResult
}

/**
 * Immutable snapshot of the app's sharing state, collected by Compose
 * (`collectAsState`) off [FrickSharingService.state]. Kotlin analogue of the
 * observable properties on Swift's `@Observable FrickSharingService`.
 *
 * The single grants cache is split into two derived projections the share UI
 * gates on: [outgoingShares] (grants the signed-in user owns — "shared by me")
 * and [sharedWithMe] (grants where they're the grantee — "shared with me").
 */
data class SharingState(
    /** Active grants the signed-in user owns (issued the invitation for). */
    val outgoingShares: List<FrickGrant> = emptyList(),
    /** Active grants where the signed-in user is the grantee. */
    val sharedWithMe: List<FrickGrant> = emptyList(),
    /** `true` while any sharing verb that refreshes the cache is in flight. */
    val isLoading: Boolean = false,
    /** `true` once [FrickSharingService.refresh] has completed for the session. */
    val hasLoaded: Boolean = false,
    /** Error from the most recent verb, or `null` after a success. */
    val lastError: Throwable? = null,
    /**
     * Invitation token captured from a deep link before the user signed in,
     * consumed by [FrickSharingService.consumePendingAccept] after sign-in.
     */
    val pendingAcceptToken: String? = null,
)

/**
 * Observable, stateful sharing layer over the [FrickClient] grant/invitation
 * verbs — Kotlin parity with Swift's FR-140 `FrickSharingService`, idiomatic as
 * a [StateFlow]<[SharingState]> + suspend verbs (matching [FrickSessionManager]
 * / [FrickObservableStore]).
 *
 * [FrickClient] owns the raw two-phase sharing primitives ([FrickClient.createInvitation]
 * / [FrickClient.acceptInvitation] / [FrickClient.listGrants] / [FrickClient.revokeGrant])
 * and the [FrickGrant] / [FrickInvitation] value types. What it does NOT provide
 * is an *observable* sharing-STATE surface for Compose. This type fills that
 * gap: it holds an in-memory grants cache, derives the "shared with me" /
 * "outgoing shares" projections a share UI gates on, orchestrates accept/revoke
 * over the raw verbs (refreshing the cache after each mutation), and parses
 * inbound deep links via the injected [linkConfig].
 *
 * It owns **no** persistence — the grants cache is hydrated from the server via
 * [refresh] and reset on sign-out. The wrapped [session] is read so verbs can
 * check the signed-in user and partition grants by ownership.
 *
 * @param session the observable session holder; verbs gate on its current user.
 * @param linkConfig the app's deep-link scheme — **injected**, not hardcoded.
 */
class FrickSharingService(
    private val session: FrickSessionManager,
    val linkConfig: FrickSharingLinkConfig,
) {
    private val client: FrickClient get() = session.client

    private val _state = MutableStateFlow(SharingState())

    /** The live sharing state. Collect with Compose `collectAsState()`. */
    val state: StateFlow<SharingState> = _state.asStateFlow()

    // MARK: - Lifecycle

    /**
     * Hydrate the grants cache from the server. Idempotent — safe to call on
     * every session change. Partitions the fetched grants into the observable
     * "shared with me" / "outgoing shares" projections by the signed-in user.
     * A `null` session resets the cache (signed out).
     */
    suspend fun refresh() {
        val myUserId = session.state.value.session?.userId
        if (myUserId == null) {
            reset()
            return
        }
        _state.update { it.copy(isLoading = true, lastError = null) }
        try {
            val grants = client.listGrants().filter { it.isActive }
            _state.update {
                it.copy(
                    outgoingShares = grants.filter { grant -> grant.ownerUserId == myUserId },
                    sharedWithMe = grants.filter { grant -> grant.granteeUserId == myUserId },
                    isLoading = false,
                    hasLoaded = true,
                    lastError = null,
                )
            }
        } catch (error: Throwable) {
            _state.update { it.copy(isLoading = false, lastError = error) }
        }
    }

    /** Clear all in-memory state. Called on sign-out. */
    fun reset() {
        _state.value = SharingState()
    }

    // MARK: - Sender verbs

    /**
     * Create an invitation for a record and return the deep-link URL the owner
     * ships to a recipient. Refreshes the cache so any UI driving off [state]
     * reflects the new outgoing state. Records [SharingState.lastError] and
     * rethrows on failure.
     */
    suspend fun invite(
        recordType: String,
        recordId: String,
        permission: FrickSharingPermission,
        expiresInSeconds: Long? = null,
    ): String {
        _state.update { it.copy(lastError = null) }
        try {
            val invitation = client.createInvitation(
                recordType = recordType,
                recordId = recordId,
                permission = permission,
                expiresInSeconds = expiresInSeconds,
            )
            refresh()
            return linkConfig.acceptUrl(invitation.token)
        } catch (error: Throwable) {
            _state.update { it.copy(lastError = error) }
            throw error
        }
    }

    /** Revoke a grant by id (owner-only). Refreshes the cache afterward. */
    suspend fun revoke(grantId: String) {
        _state.update { it.copy(lastError = null) }
        try {
            client.revokeGrant(grantId)
            refresh()
        } catch (error: Throwable) {
            _state.update { it.copy(lastError = error) }
            throw error
        }
    }

    // MARK: - Receiver verbs

    /**
     * Accept an invitation token. Never throws — returns a [FrickShareAcceptResult]
     * so a deep-link handler surfaces success/failure through one path. When
     * signed out, captures the token as [SharingState.pendingAcceptToken] and
     * returns [FrickShareAcceptResult.PendingSignIn] so it can be redeemed after
     * sign-in via [consumePendingAccept].
     */
    suspend fun accept(token: String): FrickShareAcceptResult {
        if (session.state.value.session == null) {
            _state.update { it.copy(pendingAcceptToken = token) }
            return FrickShareAcceptResult.PendingSignIn
        }
        return try {
            val grant = client.acceptInvitation(token)
            refresh()
            FrickShareAcceptResult.Accepted(grant)
        } catch (error: Throwable) {
            _state.update { it.copy(lastError = error) }
            FrickShareAcceptResult.Failed(error)
        }
    }

    /**
     * Parse an inbound deep-link URL and, if it carries a valid token, accept
     * it. Returns `null` when the URL isn't a share-accept link for this app's
     * [linkConfig]. Otherwise delegates to [accept].
     */
    suspend fun handleDeepLink(url: String): FrickShareAcceptResult? {
        val token = linkConfig.tokenFrom(url) ?: return null
        return accept(token)
    }

    /**
     * Consume any token captured before sign-in (see [accept]). Returns `null`
     * when there's nothing pending. Call after each successful session change.
     */
    suspend fun consumePendingAccept(): FrickShareAcceptResult? {
        val token = _state.value.pendingAcceptToken ?: return null
        _state.update { it.copy(pendingAcceptToken = null) }
        return accept(token)
    }

    // MARK: - Read helpers (used by the gating shim + share UI)

    /** Active grants for a specific record (owner-side "who has access"). */
    fun grants(recordType: String, recordId: String): List<FrickGrant> {
        val s = _state.value
        return (s.outgoingShares + s.sharedWithMe)
            .filter { it.recordType == recordType && it.recordId == recordId && it.isActive }
    }

    /**
     * `true` if the signed-in user owns any active grant on the record (i.e.
     * they issued the invitation).
     */
    fun userOwnsGrants(recordType: String, recordId: String): Boolean =
        _state.value.outgoingShares.any {
            it.recordType == recordType && it.recordId == recordId && it.isActive
        }

    /**
     * The active grant (if any) giving the signed-in user access to the record.
     * `null` if the user is the owner — owners hold no grants on their own
     * records.
     */
    fun granteeAccess(recordType: String, recordId: String): FrickGrant? =
        _state.value.sharedWithMe.firstOrNull {
            it.recordType == recordType && it.recordId == recordId && it.isActive
        }

    /**
     * Distinct owner user ids who have shared a record of [recordType] with the
     * signed-in user. Used to expand "shared with me" reads.
     */
    fun ownersWithGrantsToMe(recordType: String): List<String> =
        _state.value.sharedWithMe
            .filter { it.recordType == recordType && it.isActive }
            .map { it.ownerUserId }
            .distinct()
}
