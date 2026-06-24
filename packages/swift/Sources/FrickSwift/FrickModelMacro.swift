/// Generates the DTO-wrapper scaffolding for a Frick model class.
///
/// A Frick model is a read-only facade around a single wire DTO: it holds a
/// stable `objectId`, the wrapped `dto`, an `apply(_:)` to replace the DTO in
/// place, and `Identifiable` / `Hashable` keyed on `objectId`.
///
/// ```swift
/// @FrickModel(AccountDTO.self)
/// final class AccountFrickModel {
///     // Generated: objectId, dto, init(dto:), apply(_:), id, ==, hash(into:)
///     // plus an `extension AccountFrickModel: Identifiable, Hashable {}`.
/// }
/// ```
///
/// The wrapped DTO must expose a `String` `id`. Attach to a `final class`.
@attached(member, names: named(objectId), named(dto), named(init(dto:)), named(apply), named(id), named(==), named(hash))
@attached(extension, conformances: Identifiable, Hashable)
public macro FrickModel<DTO>(_ dto: DTO.Type) = #externalMacro(module: "FrickMacros", type: "FrickModelMacro")
