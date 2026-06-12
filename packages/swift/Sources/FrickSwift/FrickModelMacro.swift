/// Generates the DTO-wrapper scaffolding for a Frick model class.
///
/// A Frick model is a read-only façade around a single wire DTO: it holds a
/// stable `objectId`, the wrapped `dto`, an `apply(_:)` to replace the DTO in
/// place, and `Identifiable` / `Hashable` keyed on `objectId`. This boilerplate
/// was hand-written ~16 times across RangerCRM's `*FrickModel` classes;
/// `@FrickModel` generates the identical scaffolding so apps write only the
/// domain field accessors and relationship resolvers.
///
/// ```swift
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
///
/// ## Not compatible with `@Observable` for `dto` tracking (FR-233)
///
/// `@FrickModel` emits `dto` as a member macro. Swift's `@Observable` macro
/// expands against the *original* class source and never sees members added by
/// another attached macro, so it installs no observation accessors on the
/// generated `dto`. Combining `@Observable` with `@FrickModel` compiles, but
/// **in-place `dto` mutations via `apply(_:)` will NOT re-render** views
/// observing a single model instance (e.g. a detail screen). Two supported
/// patterns:
///
///   - **Replace the instance (recommended).** Frick stores vend a fresh model
///     object per snapshot, so list/collection views keyed by `objectId`
///     re-render naturally — no per-property observation needed.
///   - **Hand-declare `dto`.** If a screen must observe in-place edits to a
///     held model, drop `@FrickModel`'s `dto` and write the property yourself
///     with the manual `@ObservationTracked` accessor pair (or keep the model
///     hand-written, as RangerCRM does for its detail surfaces).
@attached(member, names: named(objectId), named(dto), named(init(dto:)), named(apply), named(id), named(==), named(hash))
@attached(extension, conformances: Identifiable, Hashable)
public macro FrickModel<DTO>(_ dto: DTO.Type) = #externalMacro(module: "FrickMacros", type: "FrickModelMacro")
