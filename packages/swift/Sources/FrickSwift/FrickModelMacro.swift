/// Generates the DTO-wrapper scaffolding for a Frick model class.
///
/// A Frick model is a read-only, observable façade around a single wire DTO:
/// it holds a stable `objectId`, the wrapped `dto`, an `apply(_:)` to replace
/// the DTO in place, and `Identifiable` / `Hashable` keyed on `objectId`. This
/// boilerplate was hand-written ~16 times across RangerCRM's `*FrickModel`
/// classes; `@FrickModel` generates the identical scaffolding so apps write
/// only the domain field accessors and relationship resolvers.
///
/// ```swift
/// @MainActor
/// @Observable
/// @FrickModel(AccountDTO.self)
/// final class AccountFrickModel {
///     // Generated: objectId, dto, init(dto:), apply(_:), id, ==, hash(into:)
///     // plus an `extension AccountFrickModel: Identifiable, Hashable {}`.
///
///     // App-side only — NOT generated:
///     var accountName: String { dto.accountName }
///     var accountToContact: Set<ContactFrickModel> { /* resolver */ [] }
/// }
/// ```
///
/// The wrapped DTO must expose a `String` `id` (the macro seeds `objectId` from
/// `dto.id`). Attach to a `final class`. Strictly additive: hand-written
/// `FrickModel` conformances continue to compile unchanged.
@attached(member, names: named(objectId), named(dto), named(init(dto:)), named(apply), named(id), named(==), named(hash))
@attached(extension, conformances: Identifiable, Hashable)
public macro FrickModel<DTO>(_ dto: DTO.Type) = #externalMacro(module: "FrickMacros", type: "FrickModelMacro")
