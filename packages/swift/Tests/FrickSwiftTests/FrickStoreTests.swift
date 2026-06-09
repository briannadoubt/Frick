import XCTest
@testable import FrickSwift

// MARK: - Test model

/// A simple reference-type model conforming to `FrickModel`. Tracks how many
/// times it was merged so tests can assert in-place merges (vs. replacement).
@MainActor
final class WidgetModel: FrickModel {
    static let objectType = "Widget"

    let id: String
    private(set) var name: String
    private(set) var mergeCount = 0

    init?(record: FrickObjectRecord) {
        guard let name = record.value["name"] else { return nil }
        self.id = record.id
        self.name = name
    }

    func merge(record: FrickObjectRecord) {
        if let name = record.value["name"] { self.name = name }
        mergeCount += 1
    }
}

// MARK: - Stub event source

/// Hand-feeds `FrickInboundEvent`s into a store so tests exercise the real
/// reconciliation logic without a socket or server.
final class StubEventSource: FrickStoreEventSource, @unchecked Sendable {
    private let continuation: AsyncThrowingStream<FrickInboundEvent, Error>.Continuation
    private let stream: AsyncThrowingStream<FrickInboundEvent, Error>

    private let lock = NSLock()
    private var _subscribedTypes: [String] = []

    init() {
        var cont: AsyncThrowingStream<FrickInboundEvent, Error>.Continuation!
        self.stream = AsyncThrowingStream(bufferingPolicy: .unbounded) { c in cont = c }
        self.continuation = cont
    }

    var events: AsyncThrowingStream<FrickInboundEvent, Error> {
        get async { stream }
    }

    func subscribeObject(type: String) async throws {
        lock.withLock { _subscribedTypes.append(type) }
    }

    var subscribedTypes: [String] {
        lock.withLock { _subscribedTypes }
    }

    func emit(_ event: FrickInboundEvent) {
        continuation.yield(event)
    }

    func finish() {
        continuation.finish()
    }
}

// MARK: - Helpers

private func widget(_ id: String, name: String) -> FrickObjectRecord {
    FrickObjectRecord(type: "Widget", id: id, value: ["id": id, "name": name])
}

/// Spin the run loop until `condition` holds or we time out. The store's
/// listener consumes events on a detached Task, so tests must yield to let it
/// drain before asserting.
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
final class FrickStoreTests: XCTestCase {

    func testSubscribesToModelObjectType() async {
        let source = StubEventSource()
        let store = FrickStore<WidgetModel>(source: source)
        store.start()
        await waitUntil { source.subscribedTypes == ["Widget"] }
        XCTAssertEqual(source.subscribedTypes, ["Widget"])
        XCTAssertFalse(store.hasBootstrapped)
    }

    func testInitialSnapshotPopulatesSortedCache() async {
        let source = StubEventSource()
        let store = FrickStore<WidgetModel>(source: source, sort: { $0.name < $1.name })
        store.start()
        await waitUntil { !source.subscribedTypes.isEmpty }

        source.emit(.objectsDelta(records: [
            widget("2", name: "Banana"),
            widget("1", name: "Apple"),
        ], cursor: 1))

        await waitUntil { store.items.count == 2 }
        XCTAssertTrue(store.hasBootstrapped)
        XCTAssertEqual(store.items.map(\.id), ["1", "2"])
        XCTAssertEqual(store.items.map(\.name), ["Apple", "Banana"])
    }

    func testLiveUpsertInsertsNewRow() async {
        let source = StubEventSource()
        let store = FrickStore<WidgetModel>(source: source, sort: { $0.name < $1.name })
        store.start()
        await waitUntil { !source.subscribedTypes.isEmpty }

        source.emit(.objectsDelta(records: [widget("1", name: "Apple")], cursor: 1))
        await waitUntil { store.items.count == 1 }

        source.emit(.objectsDelta(records: [widget("2", name: "Cherry")], cursor: 2))
        await waitUntil { store.items.count == 2 }

        XCTAssertEqual(store.items.map(\.name), ["Apple", "Cherry"])
    }

    func testUpsertSameIdMergesInPlace() async {
        let source = StubEventSource()
        let store = FrickStore<WidgetModel>(source: source, sort: { $0.name < $1.name })
        store.start()
        await waitUntil { !source.subscribedTypes.isEmpty }

        source.emit(.objectsDelta(records: [widget("1", name: "Apple")], cursor: 1))
        await waitUntil { store.items.count == 1 }
        let original = store.items[0]

        // Update the same id — name changes, instance identity preserved.
        source.emit(.objectsDelta(records: [widget("1", name: "Apricot")], cursor: 2))
        await waitUntil { store.items.first?.name == "Apricot" }

        XCTAssertEqual(store.items.count, 1)
        XCTAssertTrue(store.items[0] === original, "same-id merge must preserve instance identity")
        XCTAssertEqual(original.mergeCount, 1, "merge() should be called, not a fresh init")
    }

    func testReemitOnInPlaceEditTriggersObservation() async {
        // Invariant (1): an in-place edit reassigns `items` so observation fires.
        let source = StubEventSource()
        let store = FrickStore<WidgetModel>(source: source)
        store.start()
        await waitUntil { !source.subscribedTypes.isEmpty }

        source.emit(.objectsDelta(records: [widget("1", name: "A")], cursor: 1))
        await waitUntil { store.items.count == 1 }
        let arrayBefore = store.items

        source.emit(.objectsDelta(records: [widget("1", name: "B")], cursor: 2))
        await waitUntil { store.items.first?.name == "B" }

        // The array was reassigned (re-emitted) even though membership is the
        // same single id — the edited model is reflected.
        XCTAssertEqual(arrayBefore.count, store.items.count)
        XCTAssertEqual(store.items.first?.name, "B")
    }

    func testRemovalDropsRow() async {
        let source = StubEventSource()
        let store = FrickStore<WidgetModel>(source: source, sort: { $0.name < $1.name })
        store.start()
        await waitUntil { !source.subscribedTypes.isEmpty }

        source.emit(.objectsDelta(records: [
            widget("1", name: "Apple"),
            widget("2", name: "Banana"),
        ], cursor: 1))
        await waitUntil { store.items.count == 2 }

        source.emit(.objectsRemoved(removed: [FrickObjectRemoval(type: "Widget", id: "1")], cursor: 2))
        await waitUntil { store.items.count == 1 }

        XCTAssertEqual(store.items.map(\.id), ["2"])
    }

    func testRemovalOfUnknownIdIsNoOp() async {
        let source = StubEventSource()
        let store = FrickStore<WidgetModel>(source: source)
        store.start()
        await waitUntil { !source.subscribedTypes.isEmpty }

        source.emit(.objectsDelta(records: [widget("1", name: "Apple")], cursor: 1))
        await waitUntil { store.items.count == 1 }

        source.emit(.objectsRemoved(removed: [FrickObjectRemoval(type: "Widget", id: "999")], cursor: 2))
        // Give the loop a beat; nothing should change.
        await waitUntil({ false }, timeout: 0.2)

        XCTAssertEqual(store.items.map(\.id), ["1"])
    }

    func testIgnoresRecordsForOtherTypes() async {
        let source = StubEventSource()
        let store = FrickStore<WidgetModel>(source: source)
        store.start()
        await waitUntil { !source.subscribedTypes.isEmpty }

        source.emit(.objectsDelta(records: [
            FrickObjectRecord(type: "OtherType", id: "x", value: ["name": "nope"]),
            widget("1", name: "Apple"),
        ], cursor: 1))
        await waitUntil { store.items.count == 1 }

        XCTAssertEqual(store.items.map(\.id), ["1"])
    }

    func testResetClearsCacheAndAllowsRestart() async {
        let source = StubEventSource()
        let store = FrickStore<WidgetModel>(source: source)
        store.start()
        await waitUntil { !source.subscribedTypes.isEmpty }

        source.emit(.objectsDelta(records: [widget("1", name: "Apple")], cursor: 1))
        await waitUntil { store.items.count == 1 }

        store.reset()
        XCTAssertTrue(store.items.isEmpty)
        XCTAssertFalse(store.hasBootstrapped)

        // Restartable after reset.
        let source2 = StubEventSource()
        let store2 = FrickStore<WidgetModel>(source: source2)
        store2.start()
        await waitUntil { source2.subscribedTypes == ["Widget"] }
        XCTAssertEqual(source2.subscribedTypes, ["Widget"])
    }

    func testStartIsIdempotent() async {
        let source = StubEventSource()
        let store = FrickStore<WidgetModel>(source: source)
        store.start()
        store.start()
        store.start()
        await waitUntil { !source.subscribedTypes.isEmpty }
        // Only one subscription despite repeated start() calls.
        XCTAssertEqual(source.subscribedTypes, ["Widget"])
    }

    // MARK: native-swift-5 — snapshot reconciliation drops stale rows

    /// A reconnect snapshot that omits a row deleted while the client was
    /// disconnected must drop that row. The deletion generates no
    /// `.objectsRemoved` event (the row is simply absent from the snapshot), so
    /// pre-fix the pure-merge `.objectsDelta` path left it lingering forever.
    /// `.objectsSnapshot` is the authoritative full set and must reconcile.
    func testSnapshotDropsRowDeletedWhileDisconnected() async {
        let source = StubEventSource()
        let store = FrickStore<WidgetModel>(source: source, sort: { $0.id < $1.id })
        store.start()
        await waitUntil { !source.subscribedTypes.isEmpty }

        // Initial snapshot: two rows.
        source.emit(.objectsSnapshot(records: [
            widget("1", name: "Apple"),
            widget("2", name: "Banana"),
        ], cursor: 1))
        await waitUntil { store.items.count == 2 }
        XCTAssertEqual(store.items.map(\.id), ["1", "2"])

        // Reconnect snapshot: row "2" was deleted while offline → omitted.
        source.emit(.objectsSnapshot(records: [
            widget("1", name: "Apple"),
        ], cursor: 2))
        await waitUntil { store.items.count == 1 }
        XCTAssertEqual(store.items.map(\.id), ["1"], "row deleted while offline must be dropped on snapshot reconcile")
    }

    /// Snapshot reconciliation must still merge same-id rows in place (preserve
    /// instance identity) for rows that persist across the snapshot, and insert
    /// genuinely-new rows — i.e. it reconciles, it doesn't blow the cache away.
    func testSnapshotReconcileMergesAndInsertsWithoutLosingIdentity() async {
        let source = StubEventSource()
        let store = FrickStore<WidgetModel>(source: source, sort: { $0.id < $1.id })
        store.start()
        await waitUntil { !source.subscribedTypes.isEmpty }

        source.emit(.objectsSnapshot(records: [widget("1", name: "Apple")], cursor: 1))
        await waitUntil { store.items.count == 1 }
        let original = store.items[0]

        // New snapshot: "1" persists (edited), "2" is new.
        source.emit(.objectsSnapshot(records: [
            widget("1", name: "Apricot"),
            widget("2", name: "Banana"),
        ], cursor: 2))
        await waitUntil { store.items.count == 2 }

        XCTAssertEqual(store.items.map(\.id), ["1", "2"])
        XCTAssertEqual(store.items.first?.name, "Apricot")
        XCTAssertTrue(store.items[0] === original, "persisting row must merge in place, not be replaced")
    }

    /// An empty snapshot is not provably this type's authoritative set (it may
    /// belong to a sibling type's subscription on the shared socket), so it must
    /// NOT clear the cache — only mark bootstrapped.
    func testEmptySnapshotDoesNotClearCache() async {
        let source = StubEventSource()
        let store = FrickStore<WidgetModel>(source: source)
        store.start()
        await waitUntil { !source.subscribedTypes.isEmpty }

        source.emit(.objectsSnapshot(records: [widget("1", name: "Apple")], cursor: 1))
        await waitUntil { store.items.count == 1 }

        // Empty snapshot (could be a different type's) — must leave us intact.
        source.emit(.objectsSnapshot(records: [], cursor: 2))
        await waitUntil({ false }, timeout: 0.2)
        XCTAssertEqual(store.items.map(\.id), ["1"])
    }

    /// A snapshot containing only sibling-type rows must not touch this store
    /// (it isn't authoritative for those types).
    func testSnapshotOfOtherTypesLeavesCacheUntouched() async {
        let source = StubEventSource()
        let store = FrickStore<WidgetModel>(source: source)
        store.start()
        await waitUntil { !source.subscribedTypes.isEmpty }

        source.emit(.objectsSnapshot(records: [widget("1", name: "Apple")], cursor: 1))
        await waitUntil { store.items.count == 1 }

        source.emit(.objectsSnapshot(records: [
            FrickObjectRecord(type: "OtherType", id: "z", value: ["name": "nope"]),
        ], cursor: 2))
        await waitUntil({ false }, timeout: 0.2)
        XCTAssertEqual(store.items.map(\.id), ["1"], "a sibling-type snapshot must not clear this store")
    }

    func testStatusErrorSurfacesAsLastError() async {
        let source = StubEventSource()
        let store = FrickStore<WidgetModel>(source: source)
        store.start()
        await waitUntil { !source.subscribedTypes.isEmpty }

        let status = FrickSyncStatus(
            state: .reconnecting,
            serverCapabilities: nil,
            schemaCompatibility: nil,
            lastError: "boom",
            pendingAppendCount: 0
        )
        source.emit(.status(status))
        await waitUntil { store.lastError == "boom" }
        XCTAssertEqual(store.lastError, "boom")
    }
}
