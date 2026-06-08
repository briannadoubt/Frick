import XCTest
@testable import FrickSwift

// MARK: - Stub projection event source

/// Hand-feeds `FrickInboundEvent`s into a `FrickProjectionStore` so tests
/// exercise the real delta-apply logic without a socket or server.
final class StubProjectionSource: FrickProjectionEventSource, @unchecked Sendable {
    private let continuation: AsyncThrowingStream<FrickInboundEvent, Error>.Continuation
    private let stream: AsyncThrowingStream<FrickInboundEvent, Error>

    private let lock = NSLock()
    private var _subscribed: [String] = []

    init() {
        var cont: AsyncThrowingStream<FrickInboundEvent, Error>.Continuation!
        self.stream = AsyncThrowingStream(bufferingPolicy: .unbounded) { c in cont = c }
        self.continuation = cont
    }

    var events: AsyncThrowingStream<FrickInboundEvent, Error> {
        get async { stream }
    }

    func subscribeProjection(name: String) async throws {
        lock.withLock { _subscribed.append(name) }
    }

    var subscribed: [String] {
        lock.withLock { _subscribed }
    }

    func emit(_ event: FrickInboundEvent) {
        continuation.yield(event)
    }

    func finish() {
        continuation.finish()
    }
}

// MARK: - Helpers

private func row(_ pairs: [String: String]) -> FrickMsgPackValue {
    .map(pairs.map { (FrickMsgPackValue.string($0.key), FrickMsgPackValue.string($0.value)) })
}

private func change(_ key: String, _ value: FrickMsgPackValue?) -> FrickProjectionChange {
    FrickProjectionChange(key: key, value: value)
}

@MainActor
private func waitUntil(
    _ condition: @MainActor () -> Bool,
    timeout: TimeInterval = 2.0
) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition(), Date() < deadline {
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
}

// MARK: - Tests

@MainActor
final class FrickProjectionStoreTests: XCTestCase {

    func testSubscribesToProjectionByName() async {
        let source = StubProjectionSource()
        let store = FrickProjectionStore(source: source, name: "conversation-inbox")
        store.start()
        await waitUntil { source.subscribed == ["conversation-inbox"] }
        XCTAssertEqual(source.subscribed, ["conversation-inbox"])
        XCTAssertFalse(store.hasBootstrapped)
        XCTAssertTrue(store.rows.isEmpty)
    }

    func testInitialDeltaPopulatesRows() async {
        let source = StubProjectionSource()
        let store = FrickProjectionStore(source: source, name: "inbox")
        store.start()
        await waitUntil { !source.subscribed.isEmpty }

        source.emit(.projectionDelta(projection: "inbox", changes: [
            change("a", row(["title": "Alpha"])),
            change("b", row(["title": "Bravo"])),
        ]))

        await waitUntil { store.rows.count == 2 }
        XCTAssertTrue(store.hasBootstrapped)
        XCTAssertEqual(store.rows["a"]?.mapValue?["title"]?.stringValue, "Alpha")
        XCTAssertEqual(store.rows["b"]?.mapValue?["title"]?.stringValue, "Bravo")
    }

    func testUpsertReplacesExistingRow() async {
        let source = StubProjectionSource()
        let store = FrickProjectionStore(source: source, name: "inbox")
        store.start()
        await waitUntil { !source.subscribed.isEmpty }

        source.emit(.projectionDelta(projection: "inbox", changes: [change("a", row(["title": "Old"]))]))
        await waitUntil { store.rows["a"] != nil }

        source.emit(.projectionDelta(projection: "inbox", changes: [change("a", row(["title": "New"]))]))
        await waitUntil { store.rows["a"]?.mapValue?["title"]?.stringValue == "New" }
        XCTAssertEqual(store.rows.count, 1)
        XCTAssertEqual(store.rows["a"]?.mapValue?["title"]?.stringValue, "New")
    }

    func testNilValueDeletesRow() async {
        let source = StubProjectionSource()
        let store = FrickProjectionStore(source: source, name: "inbox")
        store.start()
        await waitUntil { !source.subscribed.isEmpty }

        source.emit(.projectionDelta(projection: "inbox", changes: [
            change("a", row(["title": "Alpha"])),
            change("b", row(["title": "Bravo"])),
        ]))
        await waitUntil { store.rows.count == 2 }

        source.emit(.projectionDelta(projection: "inbox", changes: [change("a", nil)]))
        await waitUntil { store.rows["a"] == nil }
        XCTAssertEqual(store.rows.count, 1)
        XCTAssertNil(store.rows["a"])
        XCTAssertNotNil(store.rows["b"])
    }

    func testIgnoresDeltaForOtherProjection() async {
        let source = StubProjectionSource()
        let store = FrickProjectionStore(source: source, name: "inbox")
        store.start()
        await waitUntil { !source.subscribed.isEmpty }

        source.emit(.projectionDelta(projection: "other", changes: [change("x", row(["title": "Nope"]))]))
        // Followed by a delta for our projection so we have something to wait on.
        source.emit(.projectionDelta(projection: "inbox", changes: [change("a", row(["title": "Yes"]))]))

        await waitUntil { store.rows["a"] != nil }
        XCTAssertNil(store.rows["x"])
        XCTAssertEqual(store.rows.count, 1)
    }

    func testResetClearsRowsAndAllowsRestart() async {
        let source = StubProjectionSource()
        let store = FrickProjectionStore(source: source, name: "inbox")
        store.start()
        await waitUntil { !source.subscribed.isEmpty }
        source.emit(.projectionDelta(projection: "inbox", changes: [change("a", row(["title": "Alpha"]))]))
        await waitUntil { store.rows.count == 1 }

        store.reset()
        XCTAssertTrue(store.rows.isEmpty)
        XCTAssertFalse(store.hasBootstrapped)

        store.start()
        await waitUntil { source.subscribed.count == 2 }
        XCTAssertEqual(source.subscribed, ["inbox", "inbox"])
    }
}
