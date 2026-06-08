#if canImport(Observation)
import XCTest
import Observation
@testable import FrickSwift

/// FR-140. Drives the observable `FrickSharingService` against a `FrickClient`
/// wired to a stub HTTP transport, asserting that it:
///   - composes the raw sharing verbs (`createInvitation` / `acceptInvitation` /
///     `listGrants` / `revokeGrant`) into stateful, observable orchestration,
///   - holds an observable grants cache that refreshes after each mutating verb,
///   - builds/parses accept deep-link URLs off the *injected* URL scheme,
///   - stashes/consumes a pending accept token across sign-in,
///   - surfaces failures via `lastError` / `FrickShareAcceptResult.failed`,
///   - answers the synchronous read helpers off the cache + signed-in user id.
@MainActor
final class FrickSharingServiceTests: XCTestCase {

    override func setUp() {
        super.setUp()
        StubShareURLProtocol.reset()
    }

    private let deepLink = FrickSharingDeepLinkConfig(scheme: "myapp")

    // MARK: - Deep-link config (injected scheme)

    func testAcceptURLRoundTripsTokenUsingInjectedScheme() {
        let url = deepLink.acceptURL(for: "tok-abc")
        XCTAssertEqual(url?.scheme, "myapp")
        XCTAssertEqual(url?.host, "share")
        XCTAssertEqual(url?.path, "/accept")
        XCTAssertEqual(deepLink.token(from: url!), "tok-abc")
    }

    func testTokenParsingRejectsForeignScheme() {
        let other = URL(string: "otherapp://share/accept?token=tok-abc")!
        XCTAssertNil(deepLink.token(from: other))
        // Wrong host/path also reject.
        XCTAssertNil(deepLink.token(from: URL(string: "myapp://share/other?token=t")!))
    }

    func testCustomHostPathAndQueryItemAreHonored() {
        let custom = FrickSharingDeepLinkConfig(
            scheme: "acme", host: "invites", acceptPath: "/redeem", tokenQueryItem: "t"
        )
        let url = custom.acceptURL(for: "tok-xyz")!
        XCTAssertEqual(url.absoluteString, "acme://invites/redeem?t=tok-xyz")
        XCTAssertEqual(custom.token(from: url), "tok-xyz")
    }

    // MARK: - refreshGrants

    func testRefreshGrantsPopulatesObservableCacheWhenSignedIn() async {
        let sharing = makeSharing(signedInAs: "user-ada")
        StubShareURLProtocol.enqueueGrants(
            [makeGrant(id: "g1", owner: "user-ada", grantee: "user-bob")],
            for: "/share/grants"
        )

        await sharing.refreshGrants()

        XCTAssertEqual(sharing.grants.map(\.id), ["g1"])
        XCTAssertTrue(sharing.hasLoaded)
        XCTAssertFalse(sharing.isWorking)
        XCTAssertNil(sharing.lastError)
    }

    func testRefreshGrantsIsNoOpWhenSignedOut() async {
        let sharing = makeSharing(signedInAs: nil)

        await sharing.refreshGrants()

        XCTAssertTrue(sharing.grants.isEmpty)
        XCTAssertFalse(sharing.hasLoaded)
    }

    func testRefreshGrantsRecordsLastErrorOnFailure() async {
        let sharing = makeSharing(signedInAs: "user-ada")
        StubShareURLProtocol.enqueueStatus(500, body: "{}", for: "/share/grants")

        await sharing.refreshGrants()

        XCTAssertTrue(sharing.grants.isEmpty)
        XCTAssertNotNil(sharing.lastError)
        XCTAssertFalse(sharing.isWorking)
    }

    // MARK: - invite (owner)

    func testInviteBuildsURLFromInjectedSchemeAndRefreshesCache() async throws {
        let sharing = makeSharing(signedInAs: "user-ada")
        StubShareURLProtocol.enqueueInvitation(
            makeInvitation(token: "tok-new", owner: "user-ada"),
            for: "/share/invite"
        )
        // invite() refreshes the cache afterward → stub a grants response too.
        StubShareURLProtocol.enqueueGrants(
            [makeGrant(id: "g1", owner: "user-ada", grantee: "user-bob")],
            for: "/share/grants"
        )

        let url = try await sharing.invite(recordType: "Account", recordId: "rec-1", permission: .write)

        XCTAssertEqual(url.scheme, "myapp")
        XCTAssertEqual(sharing.deepLink.token(from: url), "tok-new")
        XCTAssertEqual(sharing.grants.map(\.id), ["g1"], "invite should refresh the cache")
        XCTAssertFalse(sharing.isWorking)
    }

    func testInvitePropagatesClientError() async {
        let sharing = makeSharing(signedInAs: "user-ada")
        StubShareURLProtocol.enqueueStatus(403, body: "{}", for: "/share/invite")

        do {
            _ = try await sharing.invite(recordType: "Account", recordId: "rec-1", permission: .read)
            XCTFail("expected invite to throw on 403")
        } catch {
            XCTAssertNotNil(sharing.lastError)
            XCTAssertFalse(sharing.isWorking)
        }
    }

    // MARK: - accept (recipient)

    func testAcceptRedeemsTokenAndReturnsGrantDetails() async {
        let sharing = makeSharing(signedInAs: "user-bob")
        StubShareURLProtocol.enqueueGrant(
            makeGrant(id: "g7", owner: "user-ada", grantee: "user-bob", recordType: "Account", recordId: "rec-9"),
            for: "/share/accept"
        )
        StubShareURLProtocol.enqueueGrants([], for: "/share/grants")

        let result = await sharing.accept(token: "tok-x")

        XCTAssertEqual(result, .accepted(grantId: "g7", recordType: "Account", recordId: "rec-9"))
        XCTAssertNil(sharing.lastError)
    }

    func testAcceptViaURLParsesTokenWithInjectedScheme() async {
        let sharing = makeSharing(signedInAs: "user-bob")
        StubShareURLProtocol.enqueueGrant(
            makeGrant(id: "g7", owner: "user-ada", grantee: "user-bob"),
            for: "/share/accept"
        )
        StubShareURLProtocol.enqueueGrants([], for: "/share/grants")

        let url = deepLink.acceptURL(for: "tok-x")!
        let result = await sharing.accept(url: url)

        guard case .accepted(let id, _, _)? = result else {
            return XCTFail("expected accepted, got \(String(describing: result))")
        }
        XCTAssertEqual(id, "g7")
    }

    func testAcceptViaForeignURLReturnsNil() async {
        let sharing = makeSharing(signedInAs: "user-bob")
        let result = await sharing.accept(url: URL(string: "otherapp://share/accept?token=t")!)
        XCTAssertNil(result, "a non-matching URL should fall through (nil), not attempt accept")
    }

    func testAcceptWhenSignedOutStashesPendingTokenAndFails() async {
        let sharing = makeSharing(signedInAs: nil)

        let result = await sharing.accept(token: "tok-later")

        XCTAssertEqual(sharing.pendingAcceptToken, "tok-later")
        guard case .failed = result else {
            return XCTFail("expected failed when signed out")
        }
    }

    func testAcceptSurfacesFailureWithoutThrowing() async {
        let sharing = makeSharing(signedInAs: "user-bob")
        StubShareURLProtocol.enqueueStatus(410, body: "{}", for: "/share/accept")

        let result = await sharing.accept(token: "tok-expired")

        guard case .failed = result else {
            return XCTFail("expected failed on 410")
        }
        XCTAssertNotNil(sharing.lastError)
    }

    func testConsumePendingAcceptRedeemsStashedToken() async {
        let sharing = makeSharing(signedInAs: "user-bob")
        // First attempt while signed out stashes the token.
        let signedOut = makeSharing(signedInAs: nil)
        _ = await signedOut.accept(token: "tok-pending")
        sharing.pendingAcceptToken = signedOut.pendingAcceptToken

        StubShareURLProtocol.enqueueGrant(
            makeGrant(id: "g9", owner: "user-ada", grantee: "user-bob"),
            for: "/share/accept"
        )
        StubShareURLProtocol.enqueueGrants([], for: "/share/grants")

        let result = await sharing.consumePendingAcceptIfAny()

        guard case .accepted(let id, _, _)? = result else {
            return XCTFail("expected accepted after consuming pending token")
        }
        XCTAssertEqual(id, "g9")
        XCTAssertNil(sharing.pendingAcceptToken, "pending token cleared after consume")
        let secondConsume = await sharing.consumePendingAcceptIfAny()
        XCTAssertNil(secondConsume, "second consume is a no-op")
    }

    // MARK: - revoke (owner)

    func testRevokeCallsClientAndRefreshes() async throws {
        let sharing = makeSharing(signedInAs: "user-ada")
        StubShareURLProtocol.enqueueGrant(
            makeGrant(id: "g1", owner: "user-ada", grantee: "user-bob", revokedAt: "2026-01-01T00:00:00.000Z"),
            for: "/share/grants/g1"
        )
        // refreshGrants after revoke returns the now-empty active set.
        StubShareURLProtocol.enqueueGrants([], for: "/share/grants")

        try await sharing.revoke(grantId: "g1")

        XCTAssertTrue(sharing.grants.isEmpty)
        XCTAssertNil(sharing.lastError)
    }

    // MARK: - reset

    func testResetClearsAllState() async {
        let sharing = makeSharing(signedInAs: "user-ada")
        StubShareURLProtocol.enqueueGrants(
            [makeGrant(id: "g1", owner: "user-ada", grantee: "user-bob")],
            for: "/share/grants"
        )
        await sharing.refreshGrants()
        sharing.pendingAcceptToken = "x"

        sharing.reset()

        XCTAssertTrue(sharing.grants.isEmpty)
        XCTAssertFalse(sharing.hasLoaded)
        XCTAssertNil(sharing.lastError)
        XCTAssertNil(sharing.pendingAcceptToken)
    }

    // MARK: - Read helpers

    func testReadHelpersGateOffCacheAndSignedInUser() async {
        let sharing = makeSharing(signedInAs: "user-ada")
        StubShareURLProtocol.enqueueGrants(
            [
                makeGrant(id: "g1", owner: "user-ada", grantee: "user-bob", recordType: "Account", recordId: "rec-1"),
                makeGrant(id: "g2", owner: "user-zoe", grantee: "user-ada", recordType: "Account", recordId: "rec-2"),
                makeGrant(id: "g3", owner: "user-zoe", grantee: "user-ada", recordType: "Account", recordId: "rec-3", revokedAt: "2026-01-01T00:00:00.000Z"),
            ],
            for: "/share/grants"
        )
        await sharing.refreshGrants()

        // Owner-side: ada owns g1 on rec-1.
        XCTAssertTrue(sharing.userOwnsGrants(forRecordType: "Account", recordId: "rec-1"))
        XCTAssertEqual(sharing.grants(forRecordType: "Account", recordId: "rec-1").map(\.id), ["g1"])
        // ada is not the grantee of her own grant.
        XCTAssertNil(sharing.granteeAccess(forRecordType: "Account", recordId: "rec-1"))
        // Grantee-side: ada is granted access to rec-2 by zoe.
        XCTAssertEqual(sharing.granteeAccess(forRecordType: "Account", recordId: "rec-2")?.id, "g2")
        XCTAssertFalse(sharing.userOwnsGrants(forRecordType: "Account", recordId: "rec-2"))
        // Revoked g3 excluded from shared-with-me expansion; zoe appears once.
        XCTAssertEqual(sharing.ownersWithGrantsToMe(recordType: "Account"), ["user-zoe"])
    }

    // MARK: - Observation

    func testGrantsMutationIsObservable() async {
        let sharing = makeSharing(signedInAs: "user-ada")
        StubShareURLProtocol.enqueueGrants(
            [makeGrant(id: "g1", owner: "user-ada", grantee: "user-bob")],
            for: "/share/grants"
        )

        let changed = expectation(description: "grants change observed")
        withObservationTracking {
            _ = sharing.grants
        } onChange: {
            changed.fulfill()
        }

        await sharing.refreshGrants()
        await fulfillment(of: [changed], timeout: 1.0)
    }
}

// MARK: - Helpers

@MainActor
private func makeSharing(signedInAs userId: String?) -> FrickSharingService {
    let store: FrickInMemorySessionStore
    if let userId {
        store = FrickInMemorySessionStore(initial: makeShareSession(userId: userId))
    } else {
        store = FrickInMemorySessionStore()
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubShareURLProtocol.self]
    let urlSession = URLSession(configuration: configuration)
    let client = try! FrickClient(
        baseURL: URL(string: "http://frick.test")!,
        session: urlSession,
        storage: FrickSQLiteStorage(path: ":memory:"),
        sessionPersistence: store
    )
    let manager = FrickSessionManager(client: client)
    return FrickSharingService(
        session: manager,
        deepLink: FrickSharingDeepLinkConfig(scheme: "myapp")
    )
}

private func makeShareSession(userId: String) -> FrickSession {
    FrickSession(
        schemaHash: FrickSchema.schemaHash,
        sessionToken: "tok-\(userId)",
        userId: userId,
        deviceId: "device-\(userId)",
        replicaId: "replica-\(userId)",
        expiresAt: "2099-01-01T00:00:00.000Z"
    )
}

private func makeGrant(
    id: String,
    owner: String,
    grantee: String,
    recordType: String = "Account",
    recordId: String = "rec-1",
    revokedAt: String? = nil
) -> FrickGrant {
    FrickGrant(
        id: id,
        tenantId: "t1",
        ownerUserId: owner,
        recordType: recordType,
        recordId: recordId,
        granteeUserId: grantee,
        permission: .write,
        createdAt: "2026-01-01T00:00:00.000Z",
        revokedAt: revokedAt
    )
}

private func makeInvitation(token: String, owner: String) -> FrickInvitation {
    FrickInvitation(
        id: "inv-1",
        tenantId: "t1",
        ownerUserId: owner,
        recordType: "Account",
        recordId: "rec-1",
        permission: .write,
        token: token,
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-15T00:00:00.000Z"
    )
}

/// Minimal `URLProtocol` stub serving queued JSON bodies keyed by request path.
/// Self-contained so this suite doesn't depend on other suites' mocks.
private final class StubShareURLProtocol: URLProtocol {
    nonisolated(unsafe) private static var lock = NSLock()
    nonisolated(unsafe) private static var responses: [String: [(status: Int, body: Data)]] = [:]

    static func reset() {
        lock.lock(); responses = [:]; lock.unlock()
    }

    static func enqueueStatus(_ status: Int, body: String, for path: String) {
        lock.lock(); responses[path, default: []].append((status, Data(body.utf8))); lock.unlock()
    }

    private static func enqueueJSON<T: Encodable>(_ value: T, for path: String) {
        let data = try! JSONEncoder().encode(value)
        lock.lock(); responses[path, default: []].append((200, data)); lock.unlock()
    }

    static func enqueueGrants(_ grants: [FrickGrant], for path: String) {
        enqueueJSON(ListGrantsEnvelope(grants: grants), for: path)
    }

    static func enqueueGrant(_ grant: FrickGrant, for path: String) {
        // Both /share/accept and /share/grants/:id decode a `{ grant }` envelope.
        enqueueJSON(GrantEnvelope(grant: grant), for: path)
    }

    static func enqueueInvitation(_ invitation: FrickInvitation, for path: String) {
        enqueueJSON(InvitationEnvelope(invitation: invitation), for: path)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL)); return
        }
        let path = url.path
        Self.lock.lock()
        var queued = Self.responses[path] ?? []
        let response = queued.isEmpty ? (status: 200, body: Data("{}".utf8)) : queued.removeFirst()
        Self.responses[path] = queued
        Self.lock.unlock()

        let httpResponse = HTTPURLResponse(
            url: url, statusCode: response.status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: httpResponse, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: response.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    // Mirrors of the server envelope shapes the client decodes.
    private struct GrantEnvelope: Encodable { let grant: FrickGrant }
    private struct InvitationEnvelope: Encodable { let invitation: FrickInvitation }
    private struct ListGrantsEnvelope: Encodable { let grants: [FrickGrant] }
}
#endif
