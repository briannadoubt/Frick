#if canImport(Observation)
import Foundation
import Observation

/// Deep-link configuration for the sharing receiver flow.
///
/// The raw sharing verbs (`createInvitation` / `acceptInvitation`) traffic in
/// opaque tokens; Frick deliberately doesn't dictate how an owner ships a token
/// to a recipient. Most apps wrap the token in a custom-scheme URL
/// (`myapp://share/accept?token=<opaque>`) so the OS can route an inbound link
/// straight back into the app. This value type owns the scheme/host/path the
/// app registers (in `Info.plist` under `CFBundleURLTypes`) and the round-trip
/// between a token and its URL.
///
/// The scheme is **injected**, not hardcoded: it's the one app-specific bit of
/// the otherwise generic sharing layer. Construct one with your app's scheme
/// and hand it to ``FrickSharingService``:
///
/// ```swift
/// let config = FrickSharingDeepLinkConfig(scheme: "myapp")
/// let sharing = FrickSharingService(session: auth, deepLink: config)
/// ```
public struct FrickSharingDeepLinkConfig: Sendable, Equatable {

    /// The custom URL scheme the app registers (e.g. `"myapp"`). The only
    /// app-specific value in the sharing layer.
    public let scheme: String

    /// The URL host that distinguishes share links from other deep links.
    /// Defaults to `"share"`.
    public let host: String

    /// The URL path that distinguishes an accept link from future share-related
    /// deep links. Defaults to `"/accept"`.
    public let acceptPath: String

    /// The query-item name carrying the opaque invitation token. Defaults to
    /// `"token"`.
    public let tokenQueryItem: String

    public init(
        scheme: String,
        host: String = "share",
        acceptPath: String = "/accept",
        tokenQueryItem: String = "token"
    ) {
        self.scheme = scheme
        self.host = host
        self.acceptPath = acceptPath
        self.tokenQueryItem = tokenQueryItem
    }

    /// Build the URL an owner ships to a recipient out-of-band (Messages,
    /// email, AirDrop, QR code — Frick doesn't dictate the channel). The token
    /// is percent-encoded as a query parameter. Returns `nil` only if the
    /// configured components can't form a valid URL.
    public func acceptURL(for token: String) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.path = acceptPath
        components.queryItems = [URLQueryItem(name: tokenQueryItem, value: token)]
        return components.url
    }

    /// Parse an inbound `scheme://host/accept?token=...` URL. Returns the token
    /// if the URL matches the configured scheme/host/path; `nil` otherwise (so a
    /// caller can fall through to its other deep-link handlers).
    public func token(from url: URL) -> String? {
        guard url.scheme == scheme,
              url.host == host,
              url.path == acceptPath else {
            return nil
        }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        return components?.queryItems?.first(where: { $0.name == tokenQueryItem })?.value
    }
}

/// Errors thrown by ``FrickSharingService`` itself (as opposed to errors
/// surfaced from the underlying ``FrickClient`` verbs, which propagate
/// unchanged).
public enum FrickSharingError: Error, Equatable, Sendable {

    /// `createInvitation` succeeded but the injected
    /// ``FrickSharingDeepLinkConfig`` could not form a valid accept URL from
    /// the returned token (e.g. an empty/invalid scheme). Carries the token so
    /// the caller can still surface it manually.
    case couldNotBuildAcceptURL(token: String)
}

/// The outcome of a single accept attempt. The receiver flow surfaces either
/// path through the same UI, so the accept verb returns this instead of
/// throwing.
public enum FrickShareAcceptResult: Equatable, Sendable {

    /// The token was redeemed; a durable grant now authorises access. Carries
    /// the grant id and the record type the share targets so the UI can route
    /// the user to the now-shared record.
    case accepted(grantId: String, recordType: String, recordId: String)

    /// The accept failed (expired/replayed token, network error, or signed
    /// out). Carries a human-readable message for a toast.
    case failed(message: String)
}

/// Stateful, observable sharing layer over the raw sharing verbs.
///
/// ``FrickClient`` already owns the *raw* sharing verbs — `createInvitation` /
/// `acceptInvitation` / `listGrants` / `revokeGrant` — but they're stateless:
/// each is a one-shot network call returning a value, with nothing holding the
/// result or re-rendering SwiftUI. This type is the stateful analogue
/// (mirroring how ``FrickStore`` is the stateful analogue of the raw object
/// reads and ``FrickSessionManager`` of the raw auth verbs): it wraps a
/// ``FrickSessionManager`` (for the authed client + signed-in user id), holds
/// an observable cache of the grants the user owns or was granted, and exposes
/// the orchestrating verbs the share UI calls.
///
/// It deliberately **composes** the existing verbs and value types — there is
/// no parallel abstraction. `invite` calls `createInvitation` then wraps the
/// returned token in a deep-link URL via the injected
/// ``FrickSharingDeepLinkConfig``; `accept` calls `acceptInvitation`; both
/// refresh the cache off `listGrants` so any UI driving off `grants`
/// reconciles. The one app-specific value — the URL scheme — is injected, not
/// hardcoded.
///
/// ```swift
/// @State private var sharing = FrickSharingService(
///     session: auth,
///     deepLink: FrickSharingDeepLinkConfig(scheme: "myapp")
/// )
/// // owner shares a record:
/// let url = try await sharing.invite(recordType: "Account", recordId: id, permission: .write)
/// // recipient taps the link → app routes it here:
/// await sharing.accept(url: incomingURL)
/// ```
///
/// Thread-confined to the main actor so views read the cache synchronously.
/// Gated behind `#if canImport(Observation)`.
@MainActor
@Observable
public final class FrickSharingService {

    /// Active (non-revoked) grants visible to the signed-in user: any grant
    /// they own *or* are the grantee of. Populated by ``refreshGrants()``;
    /// reset to empty on ``reset()``. Observable — SwiftUI re-renders on change.
    public private(set) var grants: [FrickGrant] = []

    /// `true` once ``refreshGrants()`` has completed at least once for the
    /// current session. Gate a loading spinner vs. empty-state on this.
    public private(set) var hasLoaded: Bool = false

    /// `true` while a sharing network call (`invite` / `accept` / `revoke` /
    /// `refreshGrants`) is in flight. Share UIs disable their submit button on
    /// this to avoid duplicate submissions.
    public private(set) var isWorking: Bool = false

    /// Last error surfaced by any verb. UI may show this as a toast; cleared on
    /// the next successful call.
    public private(set) var lastError: String?

    /// Invitation token captured from a deep link before the user signed in.
    /// Consumed by ``consumePendingAcceptIfAny()`` after the next sign-in.
    public var pendingAcceptToken: String?

    /// The deep-link configuration (URL scheme etc.) used to build/parse accept
    /// URLs. Exposed read-only so callers can parse inbound URLs the same way.
    @ObservationIgnored public let deepLink: FrickSharingDeepLinkConfig

    @ObservationIgnored private let session: FrickSessionManager

    /// - Parameters:
    ///   - session: the observable session manager whose `client` the raw verbs
    ///     route through and whose `session.userId` the read helpers gate on.
    ///   - deepLink: the deep-link configuration. Its `scheme` is the one
    ///     app-specific value in the sharing layer.
    public init(session: FrickSessionManager, deepLink: FrickSharingDeepLinkConfig) {
        self.session = session
        self.deepLink = deepLink
    }

    // MARK: - Lifecycle

    /// Hydrate `grants` from the server via `listGrants`. Idempotent; safe to
    /// call on every session change. A no-op (clearing the cache) when signed
    /// out.
    public func refreshGrants() async {
        guard session.session != nil else {
            grants = []
            hasLoaded = false
            return
        }
        isWorking = true
        defer { isWorking = false }
        do {
            grants = try await session.client.listGrants()
            hasLoaded = true
            lastError = nil
        } catch {
            lastError = "refreshGrants: \(error)"
        }
    }

    /// Clear all in-memory state. Call on sign-out.
    public func reset() {
        grants = []
        hasLoaded = false
        lastError = nil
        pendingAcceptToken = nil
    }

    // MARK: - Owner verbs

    /// Create an invitation for the given record and return the deep-link URL
    /// the owner ships to the recipient. Composes `createInvitation` + the
    /// injected ``FrickSharingDeepLinkConfig``, then refreshes the cache.
    @discardableResult
    public func invite(
        recordType: String,
        recordId: String,
        permission: FrickSharingPermission,
        expiresIn: TimeInterval? = nil
    ) async throws -> URL {
        isWorking = true
        defer { isWorking = false }
        do {
            let invitation = try await session.client.createInvitation(
                recordType: recordType,
                recordId: recordId,
                permission: permission,
                expiresIn: expiresIn
            )
            guard let url = deepLink.acceptURL(for: invitation.token) else {
                throw FrickSharingError.couldNotBuildAcceptURL(token: invitation.token)
            }
            lastError = nil
            await refreshGrants()
            return url
        } catch {
            lastError = "invite: \(error)"
            throw error
        }
    }

    /// Revoke a grant by id, then refresh the cache so the revoked row leaves
    /// `grants`. Composes `revokeGrant`.
    public func revoke(grantId: String) async throws {
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await session.client.revokeGrant(grantId: grantId)
            lastError = nil
            await refreshGrants()
        } catch {
            lastError = "revoke: \(error)"
            throw error
        }
    }

    // MARK: - Recipient verbs

    /// Accept a raw invitation token. Returns a ``FrickShareAcceptResult``
    /// describing the outcome — never throws, because the deep-link handler
    /// surfaces both success and failure through the same UI. When signed out,
    /// the token is stashed in ``pendingAcceptToken`` for
    /// ``consumePendingAcceptIfAny()`` to redeem after sign-in.
    @discardableResult
    public func accept(token: String) async -> FrickShareAcceptResult {
        guard session.session != nil else {
            pendingAcceptToken = token
            return .failed(message: "Sign in to accept this share.")
        }
        isWorking = true
        defer { isWorking = false }
        do {
            let grant = try await session.client.acceptInvitation(token: token)
            lastError = nil
            await refreshGrants()
            return .accepted(
                grantId: grant.id,
                recordType: grant.recordType,
                recordId: grant.recordId
            )
        } catch {
            lastError = "accept: \(error)"
            return .failed(message: "\(error)")
        }
    }

    /// Accept the token carried by an inbound deep-link URL. Returns `nil` if
    /// the URL doesn't match the configured scheme/host/path (so the caller can
    /// fall through to its other deep-link handlers); otherwise behaves like
    /// ``accept(token:)``.
    @discardableResult
    public func accept(url: URL) async -> FrickShareAcceptResult? {
        guard let token = deepLink.token(from: url) else { return nil }
        return await accept(token: token)
    }

    /// Redeem any token captured before sign-in. Call after each successful
    /// session change. Returns `nil` when nothing was pending.
    @discardableResult
    public func consumePendingAcceptIfAny() async -> FrickShareAcceptResult? {
        guard let token = pendingAcceptToken else { return nil }
        pendingAcceptToken = nil
        return await accept(token: token)
    }

    // MARK: - Read helpers (synchronous, for gating share UI)

    /// Active grants on a specific record — the owner-side "who has access"
    /// view.
    public func grants(forRecordType recordType: String, recordId: String) -> [FrickGrant] {
        grants.filter {
            $0.recordType == recordType && $0.recordId == recordId && $0.revokedAt == nil
        }
    }

    /// `true` if the signed-in user owns any active grant on the given record
    /// (i.e. they issued the invitation).
    public func userOwnsGrants(forRecordType recordType: String, recordId: String) -> Bool {
        guard let myUserId = session.session?.userId else { return false }
        return grants.contains {
            $0.recordType == recordType
                && $0.recordId == recordId
                && $0.ownerUserId == myUserId
                && $0.revokedAt == nil
        }
    }

    /// The active grant (if any) giving the signed-in user access to the given
    /// record. Returns `nil` when the user is the owner — owners hold no grants
    /// on their own records.
    public func granteeAccess(forRecordType recordType: String, recordId: String) -> FrickGrant? {
        guard let myUserId = session.session?.userId else { return nil }
        return grants.first {
            $0.recordType == recordType
                && $0.recordId == recordId
                && $0.granteeUserId == myUserId
                && $0.revokedAt == nil
        }
    }

    /// The distinct owner user ids that have shared a record of `recordType`
    /// with the signed-in user. Used to expand "shared with me" reads.
    public func ownersWithGrantsToMe(recordType: String) -> [String] {
        guard let myUserId = session.session?.userId else { return [] }
        let owners = grants
            .filter {
                $0.recordType == recordType
                    && $0.granteeUserId == myUserId
                    && $0.revokedAt == nil
            }
            .map(\.ownerUserId)
        return Array(Set(owners))
    }
}
#endif
