#if canImport(SwiftUI) && canImport(Combine)
import XCTest
@testable import FrickSwift

// Reuses `WidgetModel` from FrickStoreTests.swift (same test target).
// WidgetModel exposes `id: String` and `name: String`, enough to exercise
// the sort/filter pipeline and the FrickSort key-path overloads.

private func queryWidget(_ id: String, name: String) -> FrickObjectRecord {
    FrickObjectRecord(type: "Widget", id: id, value: ["id": id, "name": name])
}

@MainActor
final class FrickQueryTests: XCTestCase {

    private func makeResults(
        _ models: [WidgetModel],
        sort: [FrickSort<WidgetModel>] = [],
        filter: ((WidgetModel) -> Bool)? = nil
    ) -> FrickQueryResults<WidgetModel> {
        FrickQueryResults(
            items: models,
            sortDescriptors: sort,
            filter: filter,
            updateSort: { _ in },
            updateFilter: { _ in }
        )
    }

    private func model(_ id: String, _ name: String) -> WidgetModel {
        WidgetModel(record: queryWidget(id, name: name))!
    }

    func testIsRandomAccessCollectionOverItems() {
        let results = makeResults([model("1", "Apple"), model("2", "Banana")])
        XCTAssertEqual(results.count, 2)
        XCTAssertEqual(results[0].name, "Apple")
        XCTAssertEqual(results.map(\.id), ["1", "2"])
    }

    func testFilterIsApplied() {
        let results = makeResults(
            [model("1", "Apple"), model("2", "Banana"), model("3", "Avocado")],
            filter: { $0.name.hasPrefix("A") }
        )
        XCTAssertEqual(results.map(\.name).sorted(), ["Apple", "Avocado"])
        XCTAssertEqual(results.count, 2)
    }

    func testSortDescriptorAscendingByStringKeyPath() {
        let results = makeResults(
            [model("1", "Cherry"), model("2", "Apple"), model("3", "Banana")],
            sort: [FrickSort(keyPath: \.name, ascending: true)]
        )
        XCTAssertEqual(results.map(\.name), ["Apple", "Banana", "Cherry"])
    }

    func testSortDescriptorDescending() {
        let results = makeResults(
            [model("1", "Apple"), model("2", "Cherry"), model("3", "Banana")],
            sort: [FrickSort(keyPath: \.name, ascending: false)]
        )
        XCTAssertEqual(results.map(\.name), ["Cherry", "Banana", "Apple"])
    }

    func testMultipleDescriptorsPrimaryThenSecondary() {
        // Primary: name ascending; secondary: id descending (tie-break).
        let results = makeResults(
            [model("1", "Apple"), model("3", "Apple"), model("2", "Banana")],
            sort: [
                FrickSort(keyPath: \.name, ascending: true),
                FrickSort(keyPath: \.id, ascending: false),
            ]
        )
        // Both "Apple"s first (primary), tie broken by id desc → 3 before 1.
        XCTAssertEqual(results.map(\.id), ["3", "1", "2"])
    }

    func testClosureDescriptor() {
        let results = makeResults(
            [model("1", "bb"), model("2", "a"), model("3", "ccc")],
            sort: [FrickSort({ $0.name.count < $1.name.count })]
        )
        XCTAssertEqual(results.map(\.name), ["a", "bb", "ccc"])
    }

    func testWriteThroughSortInvokesUpdateClosure() {
        var captured: [FrickSort<WidgetModel>]?
        let results = FrickQueryResults<WidgetModel>(
            items: [],
            sortDescriptors: [],
            filter: nil,
            updateSort: { captured = $0 },
            updateFilter: { _ in }
        )
        results.sortDescriptors = [FrickSort(keyPath: \.name)]
        XCTAssertEqual(captured?.count, 1)
    }

    func testWriteThroughFilterInvokesUpdateClosure() {
        var didUpdate = false
        let results = FrickQueryResults<WidgetModel>(
            items: [],
            sortDescriptors: [],
            filter: nil,
            updateSort: { _ in },
            updateFilter: { _ in didUpdate = true }
        )
        results.filter = { _ in true }
        XCTAssertTrue(didUpdate)
    }
}
#endif
