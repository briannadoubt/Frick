import Foundation
import Observation

// MARK: - FrickStoreRegistry

/// A generic, type-keyed registry of live ``FrickStore`` instances.
///
/// This is the FR-137 replacement for RangerCRM's
/// `DataController+FrickStoresBridge`: instead of an app-owned
/// `DataController` exposing a hand-written typed array per entity (and a
/// `KeyPath<DataController, [Item]>` anchor on every `@FrickQuery`), a store
/// registers *itself* under its `Model` type and any consumer resolves the
/// live store — or its `items` — generically by that type.
///
/// The registry owns no models and no sync logic; it is a thin, observable
/// indirection so SwiftUI views (via `@FrickQuery`, FR-138) can reach a
/// `FrickStore<Model>` without compile-time coupling to a concrete app object
/// graph. It folds in the old `bridge` weak-pointer pattern: entries are held
/// **weakly**, so a store dropped by its owner (e.g. on sign-out teardown)
/// silently falls out of the registry rather than being kept alive by it.
///
/// ## Idiom
///
/// `@MainActor @Observable`, matching ``FrickStore`` and the SwiftUI property
/// wrappers. Resolution reads observable state, so a view that resolves a
/// store before it has registered re-renders once the store registers.
///
/// ## Usage
///
/// Register each store once, where it's created and held alive (the scene
/// root or a `DataController`-equivalent), then inject the registry into the
/// environment for `@FrickQuery`:
///
/// ```swift
/// let registry = FrickStoreRegistry()
/// registry.register(accountStore)   // FrickStore<AccountModel>
/// registry.register(contactStore)   // FrickStore<ContactModel>
///
/// ContentView()
///     .environment(\.frickStoreRegistry, registry)
/// ```
///
/// then resolve generically:
///
/// ```swift
/// let store = registry.store(for: AccountModel.self)   // FrickStore<AccountModel>?
/// let rows  = registry.items(for: AccountModel.self)   // [AccountModel]
/// ```
@MainActor
@Observable
public final class FrickStoreRegistry {

    /// Boxed weak reference to a registered store, type-erased to `AnyObject`.
    ///
    /// Held weakly so the registry never extends a store's lifetime — the
    /// store's owner (scene root / app object) remains the single source of
    /// truth for liveness, exactly as the old `bridge` weak static did.
    private final class WeakBox {
        weak var store: AnyObject?
        init(_ store: AnyObject) { self.store = store }
    }

    /// `objectType` → boxed live store. Keyed by ``FrickModel/objectType`` (a
    /// stable wire name) rather than the Swift metatype so resolution is
    /// unambiguous across module boundaries and matches the type the store
    /// actually subscribes to.
    private var stores: [String: WeakBox] = [:]

    public init() {}

    // MARK: Registration

    /// Register a live store under its `Model` type. The registry holds the
    /// store **weakly**; the caller must keep its own strong reference for as
    /// long as the store should live. Re-registering the same type replaces
    /// the previous entry (e.g. a store recreated across sign-in).
    public func register<Model: FrickModel>(_ store: FrickStore<Model>) {
        stores[Model.objectType] = WeakBox(store)
    }

    /// Remove a store from the registry. Idempotent. (Weak entries also clear
    /// themselves once the owner drops the store; this is for eager teardown.)
    public func unregister<Model: FrickModel>(_ modelType: Model.Type) {
        stores[Model.objectType] = nil
    }

    // MARK: Resolution

    /// The live ``FrickStore`` registered for `modelType`, or `nil` if none has
    /// registered yet (or its owner has released it). Observable: a view that
    /// reads this re-renders when the matching store registers.
    public func store<Model: FrickModel>(for modelType: Model.Type) -> FrickStore<Model>? {
        guard let box = stores[Model.objectType] else { return nil }
        guard let store = box.store as? FrickStore<Model> else {
            // The store was released; drop the stale box so the dictionary
            // doesn't accumulate tombstones.
            stores[Model.objectType] = nil
            return nil
        }
        return store
    }

    /// The live `items` of the store registered for `modelType`, or an empty
    /// array when no store has registered. Mirrors the old bridge's
    /// `?? []` pass-through so views render an empty collection instead of
    /// trapping. Observable through the resolved store's `items`.
    public func items<Model: FrickModel>(for modelType: Model.Type) -> [Model] {
        store(for: modelType)?.items ?? []
    }
}
