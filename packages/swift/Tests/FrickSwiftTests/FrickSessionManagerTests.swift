#if canImport(Observation)
import XCTest
import Observation
@testable import FrickSwift

/// FR-139. Drives the observable `FrickSessionManager` against a `FrickClient`
/// wired to a stub HTTP transport + in-memory session store, asserting that:
///   - it seeds its observable `session` from a Keychain-restored client,
///   - sign-in / sign-up flip `session` / `isAuthenticated` and ride the
///     client's persistence (the in-memory store stands in for the Keychain),
///   - sign-out clears both the observable state and the persisted session,
///   - the password-reset verbs delegate without disturbing the session.
@MainActor
final class FrickSessionManagerTests: XCTestCase {

    override func setUp() {
        super.setUp()
        StubAuthURLProtocol.reset()
    }

    // MARK: - Seeding from restored session

    func testSeedsObservableSessionFromRestoredClient() {
        let store = FrickInMemorySessionStore(initial: makeSession(userId: "user-ada", token: "tok-ada"))
        let client = makeClient(persistence: store)
        // FrickClient auto-restores from the store on construction.
        XCTAssertEqual(client.currentSession?.userId, "user-ada")

        let manager = FrickSessionManager(client: client)

        XCTAssertEqual(manager.session?.userId, "user-ada")
        XCTAssertTrue(manager.isAuthenticated)
        XCTAssertFalse(manager.isAuthenticating)
    }

    func testStartsSignedOutWhenNoPersistedSession() {
        let store = FrickInMemorySessionStore()
        let manager = FrickSessionManager(client: makeClient(persistence: store))

        XCTAssertNil(manager.session)
        XCTAssertFalse(manager.isAuthenticated)
    }

    // MARK: - Sign in

    func testSignInUpdatesObservableStateAndPersists() async throws {
        let store = FrickInMemorySessionStore()
        let manager = FrickSessionManager(client: makeClient(persistence: store))
        StubAuthURLProtocol.enqueueSession(
            makeSession(userId: "user-grace", token: "tok-grace"),
            for: "/auth/email/login"
        )

        XCTAssertNil(manager.session)
        try await manager.signIn(email: "grace@example.com", password: "pw")

        XCTAssertEqual(manager.session?.userId, "user-grace")
        XCTAssertTrue(manager.isAuthenticated)
        XCTAssertFalse(manager.isAuthenticating)
        // Rode the client's persistence — the in-memory store (Keychain stand-in)
        // now holds the session, so a fresh client would auto-restore it.
        XCTAssertEqual(try store.load()?.userId, "user-grace")
    }

    func testIsAuthenticatingResetsAfterSignInFailure() async {
        let store = FrickInMemorySessionStore()
        let manager = FrickSessionManager(client: makeClient(persistence: store))
        StubAuthURLProtocol.enqueueStatus(401, body: "{}", for: "/auth/email/login")

        do {
            try await manager.signIn(email: "x@example.com", password: "bad")
            XCTFail("expected sign-in to throw on 401")
        } catch {
            // expected
        }

        XCTAssertNil(manager.session)
        XCTAssertFalse(manager.isAuthenticated)
        XCTAssertFalse(manager.isAuthenticating, "isAuthenticating must reset even on failure")
        XCTAssertNil(try? store.load())
    }

    // MARK: - Sign up

    func testSignUpUpdatesObservableStateAndPersists() async throws {
        let store = FrickInMemorySessionStore()
        let manager = FrickSessionManager(client: makeClient(persistence: store))
        StubAuthURLProtocol.enqueueSession(
            makeSession(userId: "user-new", token: "tok-new"),
            for: "/auth/email/signup"
        )

        try await manager.signUp(email: "new@example.com", password: "pw", displayName: "New")

        XCTAssertEqual(manager.session?.userId, "user-new")
        XCTAssertTrue(manager.isAuthenticated)
        XCTAssertEqual(try store.load()?.userId, "user-new")
    }

    // MARK: - Sign out

    func testSignOutClearsObservableStateAndPersistence() async throws {
        let store = FrickInMemorySessionStore(initial: makeSession(userId: "user-ada", token: "tok-ada"))
        let manager = FrickSessionManager(client: makeClient(persistence: store))
        XCTAssertTrue(manager.isAuthenticated)
        // logout() POSTs to /auth/logout; stub a success so it doesn't error out.
        StubAuthURLProtocol.enqueueStatus(200, body: "{}", for: "/auth/logout")

        await manager.signOut()

        XCTAssertNil(manager.session)
        XCTAssertFalse(manager.isAuthenticated)
        XCTAssertFalse(manager.isAuthenticating)
        // Persisted session is purged — a fresh client would start signed out.
        XCTAssertNil(try store.load())
    }

    // MARK: - Password reset (stateless)

    func testRequestPasswordResetDoesNotDisturbSession() async throws {
        let store = FrickInMemorySessionStore(initial: makeSession(userId: "user-ada", token: "tok-ada"))
        let manager = FrickSessionManager(client: makeClient(persistence: store))
        StubAuthURLProtocol.enqueueStatus(200, body: "{}", for: "/auth/email/forgot-password")

        try await manager.requestPasswordReset(email: "ada@example.com")

        XCTAssertEqual(manager.session?.userId, "user-ada", "password reset must not clear the session")
        XCTAssertEqual(StubAuthURLProtocol.requestedPaths.last, "/auth/email/forgot-password")
    }

    func testResetPasswordDelegatesToClient() async throws {
        let store = FrickInMemorySessionStore()
        let manager = FrickSessionManager(client: makeClient(persistence: store))
        StubAuthURLProtocol.enqueueStatus(200, body: "{}", for: "/auth/email/reset-password")

        try await manager.resetPassword(token: "one-time", newPassword: "new-pw")

        XCTAssertEqual(StubAuthURLProtocol.requestedPaths.last, "/auth/email/reset-password")
        XCTAssertNil(manager.session)
    }

    // MARK: - Observation

    func testSessionMutationIsObservable() async throws {
        let store = FrickInMemorySessionStore()
        let manager = FrickSessionManager(client: makeClient(persistence: store))
        StubAuthURLProtocol.enqueueSession(
            makeSession(userId: "user-obs", token: "tok-obs"),
            for: "/auth/email/login"
        )

        // withObservationTracking fires its change handler the first time an
        // accessed property mutates — proves `session` participates in
        // Observation so SwiftUI re-renders.
        let changed = expectation(description: "session change observed")
        withObservationTracking {
            _ = manager.session
        } onChange: {
            changed.fulfill()
        }

        try await manager.signIn(email: "obs@example.com", password: "pw")
        await fulfillment(of: [changed], timeout: 1.0)
    }
}

// MARK: - Helpers

@MainActor
private func makeClient(persistence: FrickSessionPersisting) -> FrickClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubAuthURLProtocol.self]
    let session = URLSession(configuration: configuration)
    return try! FrickClient(
        baseURL: URL(string: "http://frick.test")!,
        session: session,
        storage: FrickSQLiteStorage(path: ":memory:"),
        sessionPersistence: persistence
    )
}

private func makeSession(userId: String, token: String) -> FrickSession {
    FrickSession(
        schemaHash: FrickSchema.schemaHash,
        sessionToken: token,
        userId: userId,
        deviceId: "device-\(userId)",
        replicaId: "replica-\(userId)",
        expiresAt: "2099-01-01T00:00:00.000Z"
    )
}

/// Minimal `URLProtocol` stub: serves queued JSON bodies keyed by request path
/// and records requested paths. Self-contained so this suite doesn't depend on
/// the parser-tests' file-private mock.
private final class StubAuthURLProtocol: URLProtocol {
    nonisolated(unsafe) private static var lock = NSLock()
    nonisolated(unsafe) private static var responses: [String: [(status: Int, body: Data)]] = [:]
    nonisolated(unsafe) private static var paths: [String] = []

    static var requestedPaths: [String] {
        lock.lock(); defer { lock.unlock() }
        return paths
    }

    static func reset() {
        lock.lock()
        responses = [:]
        paths = []
        lock.unlock()
    }

    static func enqueueStatus(_ status: Int, body: String, for path: String) {
        lock.lock()
        responses[path, default: []].append((status, Data(body.utf8)))
        lock.unlock()
    }

    static func enqueueSession(_ session: FrickSession, for path: String) {
        let data = try! JSONEncoder().encode(EmailEnvelope(session: session, user: [:], isNewUser: false))
        lock.lock()
        responses[path, default: []].append((200, data))
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let path = url.path
        Self.lock.lock()
        Self.paths.append(path)
        var queued = Self.responses[path] ?? []
        let response = queued.isEmpty ? (status: 200, body: Data("{}".utf8)) : queued.removeFirst()
        Self.responses[path] = queued
        Self.lock.unlock()

        let httpResponse = HTTPURLResponse(
            url: url,
            statusCode: response.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: httpResponse, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: response.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    /// Mirror of the server's `/auth/email/*` envelope shape the client decodes
    /// (`SignInWithEmailEnvelope`). Only `session` is load-bearing here.
    private struct EmailEnvelope: Encodable {
        let session: FrickSession
        let user: [String: String]
        let isNewUser: Bool
    }
}
#endif
