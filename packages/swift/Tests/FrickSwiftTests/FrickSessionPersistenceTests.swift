import XCTest
@testable import FrickSwift

/// Covers the Keychain-backed session persistence wiring: the client
/// auto-restores a saved session on construction, drops an expired one,
/// and writes through to the store on install / sign-out. The contract is
/// exercised through `FrickInMemorySessionStore` so the suite never touches
/// the real Keychain (which needs an entitled host app).
final class FrickSessionPersistenceTests: XCTestCase {

    func testInMemoryStoreRoundTrip() throws {
        let store = FrickInMemorySessionStore()
        XCTAssertNil(try store.load())

        let session = makeSession(userId: "user-ada", token: "token-ada")
        try store.save(session)
        XCTAssertEqual(try store.load(), session)

        try store.clear()
        XCTAssertNil(try store.load())
    }

    func testClientAutoRestoresValidSessionOnInit() throws {
        let session = makeSession(userId: "user-ada", token: "token-ada")
        let store = FrickInMemorySessionStore(initial: session)

        let client = makeClient(sessionPersistence: store)

        XCTAssertEqual(client.currentSession, session, "a live persisted session must be restored on init")
    }

    func testClientDropsExpiredSessionOnInit() throws {
        let expired = makeSession(
            userId: "user-ada",
            token: "token-ada",
            expiresAt: "2000-01-01T00:00:00.000Z"
        )
        let store = FrickInMemorySessionStore(initial: expired)

        let client = makeClient(sessionPersistence: store)

        XCTAssertNil(client.currentSession, "an expired persisted session must not be installed")
        XCTAssertNil(try store.load(), "an expired session must be purged from the store")
    }

    func testInstallSessionPersistsToStore() throws {
        let store = FrickInMemorySessionStore()
        let client = makeClient(sessionPersistence: store)

        let session = makeSession(userId: "user-grace", token: "token-grace")
        client.restoreSession(session)

        XCTAssertEqual(try store.load(), session, "installing a session must write it through to the store")
    }

    func testSignOutClearsPersistedSession() throws {
        let session = makeSession(userId: "user-ada", token: "token-ada")
        let store = FrickInMemorySessionStore(initial: session)
        let client = makeClient(sessionPersistence: store)
        XCTAssertNotNil(client.currentSession)

        client.signOut()

        XCTAssertNil(client.currentSession)
        XCTAssertNil(try store.load(), "signOut must purge the persisted session")
    }

    func testIsExpired() {
        let live = makeSession(userId: "u", token: "t", expiresAt: "2099-01-01T00:00:00.000Z")
        XCTAssertFalse(live.isExpired(), "a far-future expiry must not be expired")

        let dead = makeSession(userId: "u", token: "t", expiresAt: "2000-01-01T00:00:00.000Z")
        XCTAssertTrue(dead.isExpired(), "a past expiry must be expired")

        // No fractional seconds — must still parse.
        let plain = makeSession(userId: "u", token: "t", expiresAt: "2099-01-01T00:00:00Z")
        XCTAssertFalse(plain.isExpired(), "a non-fractional ISO8601 expiry must parse")

        // Unparseable expiry is treated as live so a bad format never locks a user out.
        let garbage = makeSession(userId: "u", token: "t", expiresAt: "not-a-date")
        XCTAssertFalse(garbage.isExpired(), "an unparseable expiry must be treated as live")
    }
}

// MARK: - Helpers

private func makeClient(sessionPersistence: FrickSessionPersisting) -> FrickClient {
    FrickClient(
        baseURL: URL(string: "http://frick.test")!,
        storage: try! FrickSQLiteStorage(path: ":memory:"),
        sessionPersistence: sessionPersistence
    )
}

private func makeSession(
    userId: String,
    token: String,
    expiresAt: String = "2099-01-01T00:00:00.000Z"
) -> FrickSession {
    FrickSession(
        schemaHash: FrickSchema.schemaHash,
        sessionToken: token,
        userId: userId,
        deviceId: "device-\(userId)",
        replicaId: "replica-\(userId)",
        expiresAt: expiresAt
    )
}
