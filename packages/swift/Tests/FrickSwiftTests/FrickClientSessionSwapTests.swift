import XCTest
@testable import FrickSwift

/// Covers RCRM-45: installing a session for a *different* user must clear
/// the local cache automatically so the next `verifyCacheCompatibility`
/// doesn't trip the user-scope guard. Installing a session for the *same*
/// user (token refresh, reauth, restoreSession on relaunch) must NOT blow
/// away the warm cache.
///
/// Driven through `restoreSession` because it routes through the same
/// private `installSession` helper as `signInWithEmail`/`signInWithApple`/
/// `signInWithGoogle`/`devLogin`/`signUp`/`login` — exercising that helper
/// covers the auto-reset behavior without needing the in-test URL-protocol
/// mock that's `private` to the parser-tests file.
final class FrickClientSessionSwapTests: XCTestCase {
    func testRestoreSessionForDifferentUserClearsCache() throws {
        let storage = RecordingStorage(inner: try FrickSQLiteStorage(path: ":memory:"))
        let client = makeSwapTestClient(storage: storage)

        client.restoreSession(makeSession(userId: "user-ada", token: "token-ada"))
        storage.clearCacheCount = 0
        storage.clearPendingAppendsCount = 0

        // Drop a sentinel pending append so we can verify it's gone after the swap.
        try storage.appendPendingAppend(
            PendingAppend(requestId: "req-1", body: Data())
        )
        XCTAssertEqual(try storage.loadPendingAppends().count, 1)

        client.restoreSession(makeSession(userId: "user-grace", token: "token-grace"))

        XCTAssertEqual(storage.clearCacheCount, 1, "different userId must trigger resetCache")
        XCTAssertEqual(try storage.loadPendingAppends().count, 0, "pending appends from prior user must be dropped")
        XCTAssertEqual(client.currentSession?.userId, "user-grace")
    }

    func testRestoreSessionForSameUserKeepsCache() throws {
        let storage = RecordingStorage(inner: try FrickSQLiteStorage(path: ":memory:"))
        let client = makeSwapTestClient(storage: storage)

        client.restoreSession(makeSession(userId: "user-ada", token: "token-ada-1"))
        storage.clearCacheCount = 0
        storage.clearPendingAppendsCount = 0

        client.restoreSession(makeSession(userId: "user-ada", token: "token-ada-2"))

        XCTAssertEqual(storage.clearCacheCount, 0, "same userId must NOT trigger resetCache")
        XCTAssertEqual(storage.clearPendingAppendsCount, 0, "same userId must NOT drop pending appends")
        XCTAssertEqual(client.currentSession?.sessionToken, "token-ada-2")
    }

    func testFirstSessionInstallDoesNotClearCache() throws {
        let storage = RecordingStorage(inner: try FrickSQLiteStorage(path: ":memory:"))
        let client = makeSwapTestClient(storage: storage)

        client.restoreSession(makeSession(userId: "user-ada", token: "token-ada"))

        XCTAssertEqual(storage.clearCacheCount, 0, "first install must NOT reset (cache is already empty)")
        XCTAssertEqual(storage.clearPendingAppendsCount, 0)
    }
}

// MARK: - Helpers

private func makeSwapTestClient(storage: FrickStorage) -> FrickClient {
    FrickClient(
        baseURL: URL(string: "http://frick.test")!,
        storage: storage,
        sessionPersistence: FrickInMemorySessionStore()
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

/// Pass-through storage that counts `clearCache`/`clearPendingAppends`
/// invocations. Everything else delegates to the real in-memory SQLite
/// storage.
private final class RecordingStorage: FrickStorage, @unchecked Sendable {
    private let inner: FrickStorage
    var clearCacheCount = 0
    var clearPendingAppendsCount = 0

    init(inner: FrickStorage) { self.inner = inner }

    func loadObjectData(type: String, id: String) throws -> Data? {
        try inner.loadObjectData(type: type, id: id)
    }
    func saveObjectData(type: String, id: String, data: Data, version: Int) throws {
        try inner.saveObjectData(type: type, id: id, data: data, version: version)
    }
    func loadStreamEvents(stream: String, key: String) throws -> [FrickStreamEvent] {
        try inner.loadStreamEvents(stream: stream, key: key)
    }
    func saveStreamEvent(_ event: FrickStreamEvent) throws {
        try inner.saveStreamEvent(event)
    }
    func loadPendingAppends() throws -> [PendingAppend] {
        try inner.loadPendingAppends()
    }
    func appendPendingAppend(_ append: PendingAppend) throws {
        try inner.appendPendingAppend(append)
    }
    func removePendingAppend(requestId: String) throws {
        try inner.removePendingAppend(requestId: requestId)
    }
    func clearPendingAppends() throws {
        clearPendingAppendsCount += 1
        try inner.clearPendingAppends()
    }
    func loadCacheMetadata() throws -> FrickCacheMetadata? {
        try inner.loadCacheMetadata()
    }
    func saveCacheMetadata(_ metadata: FrickCacheMetadata) throws {
        try inner.saveCacheMetadata(metadata)
    }
    func clearCache() throws {
        clearCacheCount += 1
        try inner.clearCache()
    }
}
