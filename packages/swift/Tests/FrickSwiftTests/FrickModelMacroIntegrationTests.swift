import XCTest

@testable import FrickSwift

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
}
