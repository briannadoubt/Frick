import XCTest
@testable import FrickSwift

// Reuses `WidgetModel` / `StubEventSource` from FrickStoreTests.swift (same
// test target). `widget(_:name:)` there is file-private, so we define a local
// record builder.

private func registryWidget(_ id: String, name: String) -> FrickObjectRecord {
    FrickObjectRecord(type: "Widget", id: id, value: ["id": id, "name": name])
}

@MainActor
final class FrickStoreRegistryTests: XCTestCase {

    func testResolvesRegisteredStore() {
        let source = StubEventSource()
        let store = FrickStore<WidgetModel>(source: source)
        let registry = FrickStoreRegistry()

        XCTAssertNil(registry.store(for: WidgetModel.self), "empty registry resolves nil")

        registry.register(store)
        XCTAssertTrue(registry.store(for: WidgetModel.self) === store)
    }

    func testItemsForUnregisteredTypeIsEmpty() {
        let registry = FrickStoreRegistry()
        XCTAssertEqual(registry.items(for: WidgetModel.self).count, 0)
    }

    func testItemsPassThroughLiveStoreItems() async {
        let source = StubEventSource()
        let store = FrickStore<WidgetModel>(source: source, sort: { $0.name < $1.name })
        let registry = FrickStoreRegistry()
        registry.register(store)

        store.start()
        await waitUntilRegistry { !source.subscribedTypes.isEmpty }
        source.emit(.objectsDelta(records: [
            registryWidget("2", name: "Banana"),
            registryWidget("1", name: "Apple"),
        ], cursor: 1))
        await waitUntilRegistry { store.items.count == 2 }

        XCTAssertEqual(registry.items(for: WidgetModel.self).map(\.name), ["Apple", "Banana"])
    }

    func testReRegisterReplacesEntry() {
        let registry = FrickStoreRegistry()
        let first = FrickStore<WidgetModel>(source: StubEventSource())
        let second = FrickStore<WidgetModel>(source: StubEventSource())

        registry.register(first)
        registry.register(second)
        XCTAssertTrue(registry.store(for: WidgetModel.self) === second)
    }

    func testUnregisterRemovesEntry() {
        let registry = FrickStoreRegistry()
        let store = FrickStore<WidgetModel>(source: StubEventSource())
        registry.register(store)
        XCTAssertNotNil(registry.store(for: WidgetModel.self))

        registry.unregister(WidgetModel.self)
        XCTAssertNil(registry.store(for: WidgetModel.self))
    }

    func testEntryIsWeak_StoreReleaseClearsResolution() {
        let registry = FrickStoreRegistry()
        do {
            let store = FrickStore<WidgetModel>(source: StubEventSource())
            registry.register(store)
            XCTAssertNotNil(registry.store(for: WidgetModel.self))
        }
        // The only strong reference (`store`) has gone out of scope; the
        // registry held it weakly, so resolution now returns nil.
        XCTAssertNil(registry.store(for: WidgetModel.self))
        XCTAssertEqual(registry.items(for: WidgetModel.self).count, 0)
    }
}

@MainActor
private func waitUntilRegistry(
    _ condition: @MainActor () -> Bool,
    timeout: TimeInterval = 2.0
) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition(), Date() < deadline {
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
}
