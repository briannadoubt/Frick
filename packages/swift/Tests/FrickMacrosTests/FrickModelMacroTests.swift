import SwiftSyntaxMacros
import SwiftSyntaxMacrosTestSupport
import XCTest

@testable import FrickMacros

private let testMacros: [String: Macro.Type] = [
    "FrickModel": FrickModelMacro.self
]

final class FrickModelMacroTests: XCTestCase {
    func testGeneratesScaffolding() {
        assertMacroExpansion(
            """
            @FrickModel(AccountDTO.self)
            final class AccountFrickModel {
                var accountName: String { dto.accountName }
            }
            """,
            expandedSource: """
            final class AccountFrickModel {
                var accountName: String { dto.accountName }

                /// Stable identifier, seeded from the wrapped DTO's `id`.
                public let objectId: String

                /// The wrapped wire DTO, replaced wholesale by `apply(_:)`.
                ///
                /// Not observation-tracked: a member macro cannot participate in
                /// `@Observable`'s expansion, so in-place edits do NOT re-render
                /// observing views. Replace the model instance to drive updates.
                public private(set) var dto: AccountDTO

                public init(dto: AccountDTO) {
                    self.objectId = dto.id
                    self.dto = dto
                }

                /// Replace the wrapped DTO in place when a fresh server state lands.
                public func apply(_ newValue: AccountDTO) {
                    self.dto = newValue
                }

                public var id: String {
                    objectId
                }

                public static func == (lhs: AccountFrickModel, rhs: AccountFrickModel) -> Bool {
                    lhs.objectId == rhs.objectId
                }

                public func hash(into hasher: inout Hasher) {
                    hasher.combine(objectId)
                }
            }

            extension AccountFrickModel: Identifiable, Hashable {
            }
            """,
            macros: testMacros
        )
    }

    func testWorksWithQualifiedDTOType() {
        assertMacroExpansion(
            """
            @FrickModel(Wire.NoteDTO.self)
            final class NoteFrickModel {
            }
            """,
            expandedSource: """
            final class NoteFrickModel {

                /// Stable identifier, seeded from the wrapped DTO's `id`.
                public let objectId: String

                /// The wrapped wire DTO, replaced wholesale by `apply(_:)`.
                ///
                /// Not observation-tracked: a member macro cannot participate in
                /// `@Observable`'s expansion, so in-place edits do NOT re-render
                /// observing views. Replace the model instance to drive updates.
                public private(set) var dto: Wire.NoteDTO

                public init(dto: Wire.NoteDTO) {
                    self.objectId = dto.id
                    self.dto = dto
                }

                /// Replace the wrapped DTO in place when a fresh server state lands.
                public func apply(_ newValue: Wire.NoteDTO) {
                    self.dto = newValue
                }

                public var id: String {
                    objectId
                }

                public static func == (lhs: NoteFrickModel, rhs: NoteFrickModel) -> Bool {
                    lhs.objectId == rhs.objectId
                }

                public func hash(into hasher: inout Hasher) {
                    hasher.combine(objectId)
                }
            }

            extension NoteFrickModel: Identifiable, Hashable {
            }
            """,
            macros: testMacros
        )
    }

    func testDiagnosesMissingDTOArgument() {
        assertMacroExpansion(
            """
            @FrickModel
            final class Bad {
            }
            """,
            expandedSource: """
            final class Bad {
            }

            extension Bad: Identifiable, Hashable {
            }
            """,
            diagnostics: [
                DiagnosticSpec(
                    message: "@FrickModel requires the wrapped DTO type, e.g. @FrickModel(AccountDTO.self).",
                    line: 1,
                    column: 1
                )
            ],
            macros: testMacros
        )
    }

    func testDiagnosesNonClass() {
        assertMacroExpansion(
            """
            @FrickModel(FooDTO.self)
            struct Foo {
            }
            """,
            expandedSource: """
            struct Foo {
            }

            extension Foo: Identifiable, Hashable {
            }
            """,
            diagnostics: [
                DiagnosticSpec(
                    message: "@FrickModel can only be attached to a class (use `final class`).",
                    line: 1,
                    column: 1
                )
            ],
            macros: testMacros
        )
    }
}
