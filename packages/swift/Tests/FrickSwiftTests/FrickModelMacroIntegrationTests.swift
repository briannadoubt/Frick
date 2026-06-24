import Observation
import XCTest

@testable import FrickSwift
import FrickSwift

// MARK: - Fixture DTO

private struct WidgetDTO {
    let id: String
    let name: String
}

// MARK: - Macro-generated model

/// Exercises the `@FrickModel` macro end-to-end: applying it must compile and
/// produce a working DTO-wrapper (objectId/dto/init/apply/id/Identifiable/
/// Hashable). The hand-written domain accessor below stays app-side.
@FrickModel(WidgetDTO.self)
private final class WidgetFrickModel {
    var name: String { dto.name }
}

/// FR-233 fixture: `@Observable` combined with `@FrickModel`. This compiles,
/// but the macro-emitted `dto` is invisible to `@Observable`'s expansion, so it
/// is NOT observation-tracked. The test below pins that documented contract.
@Observable
@FrickModel(WidgetDTO.self)
private final class ObservableWidgetModel {
    var name: String { dto.name }
}

/// Reference box so the `@Sendable` `onChange` closure can record whether it
/// fired without tripping strict-concurrency capture rules.
private final class ChangeFlag: @unchecked Sendable {
    var fired = false
}

// MARK: - Tests

final class FrickModelMacroIntegrationTests: XCTestCase {
    func testGeneratedScaffolding() {
        let model = WidgetFrickModel(dto: WidgetDTO(id: "w1", name: "Sprocket"))

        XCTAssertEqual(model.objectId, "w1")
        XCTAssertEqual(model.id, "w1")
        XCTAssertEqual(model.name, "Sprocket")

        model.apply(WidgetDTO(id: "w1", name: "Cog"))
        XCTAssertEqual(model.name, "Cog")
        XCTAssertEqual(model.objectId, "w1")
    }

    func testHashableAndEquatableKeyedOnObjectId() {
        let a = WidgetFrickModel(dto: WidgetDTO(id: "same", name: "A"))
        let b = WidgetFrickModel(dto: WidgetDTO(id: "same", name: "B"))
        let c = WidgetFrickModel(dto: WidgetDTO(id: "other", name: "C"))

        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, c)

        let set: Set<WidgetFrickModel> = [a, b, c]
        XCTAssertEqual(set.count, 2)
    }

    /// FR-233 contract: the macro-emitted `dto` is NOT observation-tracked, even
    /// when the class is `@Observable`. An in-place `apply(_:)` must therefore
    /// fire no `withObservationTracking` change. If this ever starts failing,
    /// the macro began emitting observation plumbing — update the documented
    /// `@Observable` incompatibility (and this assertion) deliberately.
    func testDtoIsNotObservationTrackedUnderObservable() {
        let model = ObservableWidgetModel(dto: WidgetDTO(id: "w1", name: "Sprocket"))
        let flag = ChangeFlag()
        withObservationTracking {
            _ = model.dto.name
        } onChange: {
            flag.fired = true
        }
        model.apply(WidgetDTO(id: "w1", name: "Cog"))
        XCTAssertFalse(
            flag.fired,
            "Regression: @FrickModel's dto became observation-tracked; the documented @Observable incompatibility (FR-233) no longer holds."
        )
        // The wrapped state still updates — observation is the only thing absent.
        XCTAssertEqual(model.name, "Cog")
    }
}
