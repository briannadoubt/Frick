import SwiftSyntax
import SwiftSyntaxBuilder
import SwiftSyntaxMacros

/// Implements `@FrickModel(SomeDTO.self)`.
///
/// Attached to a `final class`, it generates the DTO-wrapper scaffolding that
/// was hand-written ~16 times across RangerCRM's `*FrickModel` classes:
///
/// - `let objectId: String`
/// - `private(set) var dto: <DTO>`
/// - `init(dto: <DTO>)` (seeds `objectId` from `dto.id`)
/// - `func apply(_ newValue: <DTO>)` (replaces the wrapped DTO in place)
/// - `var id: String { objectId }` (Identifiable)
/// - `static func == ` + `hash(into:)` keyed on `objectId` (Hashable)
///
/// plus an extension adding `Identifiable, Hashable` conformance. Domain field
/// accessors and relationship resolvers are NOT generated — they stay app-side.
public enum FrickModelMacro {}

// MARK: - Diagnostics

private enum FrickModelMacroError: Error, CustomStringConvertible {
    case notAClass
    case missingDTOArgument

    var description: String {
        switch self {
        case .notAClass:
            return "@FrickModel can only be attached to a class (use `final class`)."
        case .missingDTOArgument:
            return "@FrickModel requires the wrapped DTO type, e.g. @FrickModel(AccountDTO.self)."
        }
    }
}

// MARK: - Argument extraction

extension FrickModelMacro {
    /// Pull the DTO type out of `@FrickModel(SomeDTO.self)`.
    fileprivate static func dtoTypeName(
        from node: AttributeSyntax
    ) throws -> String {
        guard
            let arguments = node.arguments?.as(LabeledExprListSyntax.self),
            let first = arguments.first,
            let memberAccess = first.expression.as(MemberAccessExprSyntax.self),
            memberAccess.declName.baseName.text == "self",
            let base = memberAccess.base
        else {
            throw FrickModelMacroError.missingDTOArgument
        }
        // `base` is the type expression, e.g. `AccountDTO` or `Foo.BarDTO`.
        return base.trimmedDescription
    }
}

// MARK: - MemberMacro

extension FrickModelMacro: MemberMacro {
    public static func expansion(
        of node: AttributeSyntax,
        providingMembersOf declaration: some DeclGroupSyntax,
        conformingTo protocols: [TypeSyntax],
        in context: some MacroExpansionContext
    ) throws -> [DeclSyntax] {
        guard let classDecl = declaration.as(ClassDeclSyntax.self) else {
            throw FrickModelMacroError.notAClass
        }

        let dto = try dtoTypeName(from: node)
        let typeName = classDecl.name.trimmedDescription

        let objectId: DeclSyntax = """
            /// Stable identifier, seeded from the wrapped DTO's `id`.
            public let objectId: String
            """

        let dtoProperty: DeclSyntax = """
            /// The wrapped wire DTO. Observed so in-place edits re-render cells.
            public private(set) var dto: \(raw: dto)
            """

        let initializer: DeclSyntax = """
            public init(dto: \(raw: dto)) {
                self.objectId = dto.id
                self.dto = dto
            }
            """

        let apply: DeclSyntax = """
            /// Replace the wrapped DTO in place when a fresh server state lands.
            public func apply(_ newValue: \(raw: dto)) {
                self.dto = newValue
            }
            """

        let id: DeclSyntax = """
            public var id: String { objectId }
            """

        let equatable: DeclSyntax = """
            public static func == (lhs: \(raw: typeName), rhs: \(raw: typeName)) -> Bool {
                lhs.objectId == rhs.objectId
            }
            """

        let hashable: DeclSyntax = """
            public func hash(into hasher: inout Hasher) {
                hasher.combine(objectId)
            }
            """

        return [objectId, dtoProperty, initializer, apply, id, equatable, hashable]
    }
}

// MARK: - ExtensionMacro

extension FrickModelMacro: ExtensionMacro {
    public static func expansion(
        of node: AttributeSyntax,
        attachedTo declaration: some DeclGroupSyntax,
        providingExtensionsOf type: some TypeSyntaxProtocol,
        conformingTo protocols: [TypeSyntax],
        in context: some MacroExpansionContext
    ) throws -> [ExtensionDeclSyntax] {
        // Add `Identifiable, Hashable` conformance. The members are supplied by
        // the MemberMacro expansion above.
        let ext: DeclSyntax = """
            extension \(type.trimmed): Identifiable, Hashable {}
            """
        guard let extensionDecl = ext.as(ExtensionDeclSyntax.self) else {
            return []
        }
        return [extensionDecl]
    }
}
