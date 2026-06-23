#if canImport(SwiftUI)
import SwiftUI
import Foundation

// MARK: - FrickQuery

/// SwiftUI property wrapper that resolves a typed, live object collection from
/// the surrounding ``FrickStoreRegistry`` and exposes it as a
/// ``FrickQueryResults`` — a near-drop-in replacement for `@FetchRequest` /
/// `FetchedResults`.
///
/// This completes the trio alongside `@FrickStream` / `@FrickPresence`: where
/// those bridge a socket *stream*, `@FrickQuery` bridges an *object
/// collection*. It resolves the live `FrickStore<Item>.items` through the
/// FR-137 registry — there is no app-owned `DataController` and no
/// `KeyPath<DataController, [Item]>` coupling. You declare only the element
/// type:
///
/// ```swift
/// struct AccountList: View {
///     @FrickQuery(sortDescriptors: [FrickSort(keyPath: \.name)])
///     var accounts: FrickQueryResults<AccountModel>
///
///     var body: some View {
///         List(accounts) { account in Text(account.name) }
///     }
/// }
/// ```
///
/// The registry is picked up from `@Environment(\.frickStoreRegistry)`; inject
/// it once in the scene root (the same place you inject `\.frickSyncSocket`):
///
/// ```swift
/// ContentView()
///     .environment(\.frickStoreRegistry, registry)
/// ```
///
/// Falls back to an empty collection when no registry is in the environment
/// (or no store has registered for `Item` yet), so previews render without
/// crashing — mirroring the old bridge's `?? []` pass-through.
///
/// `sortDescriptors` and `filter` are write-through (`results.sortDescriptors
/// = …` keeps working), and `projectedValue` is a `Binding` into the sort
/// descriptors so sort-picker UIs can drive them through `$accounts`.
@MainActor
@propertyWrapper
public struct FrickQuery<Item: FrickModel>: DynamicProperty {

    @Environment(\.frickStoreRegistry) private var registry

    private let animation: Animation?

    @State private var sortDescriptors: [FrickSort<Item>]
    @State private var filter: ((Item) -> Bool)?

    public init(
        sortDescriptors: [FrickSort<Item>] = [],
        filter: ((Item) -> Bool)? = nil,
        animation: Animation? = nil
    ) {
        self.animation = animation
        _sortDescriptors = State(initialValue: sortDescriptors)
        _filter = State(initialValue: filter)
    }

    /// Convenience mirroring a common `@FetchRequest` shape: ascending by a
    /// single `String` key path.
    public init(
        ascending sortKey: KeyPath<Item, String>,
        animation: Animation? = nil
    ) {
        self.init(
            sortDescriptors: [FrickSort(keyPath: sortKey, ascending: true)],
            animation: animation
        )
    }

    public var wrappedValue: FrickQueryResults<Item> {
        let snapshot = registry?.items(for: Item.self) ?? []
        let currentSort = sortDescriptors
        let currentFilter = filter
        let animation = animation
        return FrickQueryResults(
            items: snapshot,
            sortDescriptors: currentSort,
            filter: currentFilter,
            updateSort: { newValue in
                if let animation {
                    withAnimation(animation) { _sortDescriptors.wrappedValue = newValue }
                } else {
                    _sortDescriptors.wrappedValue = newValue
                }
            },
            updateFilter: { newValue in
                if let animation {
                    withAnimation(animation) { _filter.wrappedValue = newValue }
                } else {
                    _filter.wrappedValue = newValue
                }
            }
        )
    }

    /// Mirrors `@FetchRequest`'s `projectedValue` — a binding into the sort
    /// descriptors so sort-picker UIs can mutate them through `$`.
    public var projectedValue: Binding<[FrickSort<Item>]> {
        Binding(
            get: { _sortDescriptors.wrappedValue },
            set: { newValue in
                if let animation {
                    withAnimation(animation) { _sortDescriptors.wrappedValue = newValue }
                } else {
                    _sortDescriptors.wrappedValue = newValue
                }
            }
        )
    }
}

// MARK: - FrickQueryResults

/// Mirrors `FetchedResults<T>`. Conforms to `RandomAccessCollection` so
/// `ForEach` and subscript access work out of the box. Mutable
/// `sortDescriptors` and `filter` are write-through so views that do
/// `results.sortDescriptors = …` keep compiling.
///
/// `RandomAccessCollection` (and its `BidirectionalCollection` / `Collection`
/// refinements) are adopted via `@preconcurrency` — the stdlib protocols
/// predate `Sendable` and every consumer here is already `@MainActor` (the
/// same pattern RangerCRM's RCRM-134 settled on).
@MainActor
public struct FrickQueryResults<Item: FrickModel>: @preconcurrency RandomAccessCollection {

    private let items: [Item]
    private let _sortDescriptors: [FrickSort<Item>]
    private let _filter: ((Item) -> Bool)?
    private let updateSort: ([FrickSort<Item>]) -> Void
    private let updateFilter: (((Item) -> Bool)?) -> Void

    init(
        items: [Item],
        sortDescriptors: [FrickSort<Item>],
        filter: ((Item) -> Bool)?,
        updateSort: @escaping ([FrickSort<Item>]) -> Void,
        updateFilter: @escaping (((Item) -> Bool)?) -> Void
    ) {
        let filtered = filter.map { items.filter($0) } ?? items
        var sorted = filtered
        // Apply descriptors in reverse so the first descriptor is the primary
        // key (stable sort makes earlier passes the tie-breakers).
        for descriptor in sortDescriptors.reversed() {
            sorted = descriptor.apply(to: sorted)
        }
        self.items = sorted
        self._sortDescriptors = sortDescriptors
        self._filter = filter
        self.updateSort = updateSort
        self.updateFilter = updateFilter
    }

    public var sortDescriptors: [FrickSort<Item>] {
        get { _sortDescriptors }
        nonmutating set { updateSort(newValue) }
    }

    public var filter: ((Item) -> Bool)? {
        get { _filter }
        nonmutating set { updateFilter(newValue) }
    }

    public var startIndex: Int { items.startIndex }
    public var endIndex: Int { items.endIndex }

    public subscript(position: Int) -> Item { items[position] }
}

// MARK: - FrickSort

/// Lightweight value-type sort descriptor — orders any ``FrickModel`` via a
/// typed `KeyPath`. Replaces `SortDescriptor<NSManagedObject>` at call sites
/// migrating off CoreData. String / Date / Double / Int key-path overloads
/// cover the common column types; the closure initializer handles the rest.
public struct FrickSort<Item: FrickModel> {

    public let ascending: Bool
    private let compare: @MainActor (Item, Item) -> Bool

    public init(_ compare: @escaping @MainActor (Item, Item) -> Bool, ascending: Bool = true) {
        self.ascending = ascending
        self.compare = compare
    }

    @MainActor
    public init<V: Comparable>(keyPath: KeyPath<Item, V>, ascending: Bool = true) {
        self.ascending = ascending
        self.compare = { lhs, rhs in
            ascending
                ? lhs[keyPath: keyPath] < rhs[keyPath: keyPath]
                : lhs[keyPath: keyPath] > rhs[keyPath: keyPath]
        }
    }

    @MainActor
    public init(keyPath: KeyPath<Item, String>, ascending: Bool = true) {
        self.ascending = ascending
        self.compare = { lhs, rhs in
            ascending
                ? lhs[keyPath: keyPath] < rhs[keyPath: keyPath]
                : lhs[keyPath: keyPath] > rhs[keyPath: keyPath]
        }
    }

    @MainActor
    public init(keyPath: KeyPath<Item, Date>, ascending: Bool = true) {
        self.ascending = ascending
        self.compare = { lhs, rhs in
            ascending
                ? lhs[keyPath: keyPath] < rhs[keyPath: keyPath]
                : lhs[keyPath: keyPath] > rhs[keyPath: keyPath]
        }
    }

    @MainActor
    public init(keyPath: KeyPath<Item, Double>, ascending: Bool = true) {
        self.ascending = ascending
        self.compare = { lhs, rhs in
            ascending
                ? lhs[keyPath: keyPath] < rhs[keyPath: keyPath]
                : lhs[keyPath: keyPath] > rhs[keyPath: keyPath]
        }
    }

    @MainActor
    public init(keyPath: KeyPath<Item, Int>, ascending: Bool = true) {
        self.ascending = ascending
        self.compare = { lhs, rhs in
            ascending
                ? lhs[keyPath: keyPath] < rhs[keyPath: keyPath]
                : lhs[keyPath: keyPath] > rhs[keyPath: keyPath]
        }
    }

    @MainActor
    func apply(to items: [Item]) -> [Item] {
        items.sorted(by: compare)
    }
}

// MARK: - Environment plumbing

private struct FrickStoreRegistryKey: EnvironmentKey {
    static let defaultValue: FrickStoreRegistry? = nil
}

public extension EnvironmentValues {
    /// The ``FrickStoreRegistry`` `@FrickQuery` resolves its collection from.
    /// Inject once in the scene root, alongside `\.frickSyncSocket`.
    var frickStoreRegistry: FrickStoreRegistry? {
        get { self[FrickStoreRegistryKey.self] }
        set { self[FrickStoreRegistryKey.self] = newValue }
    }
}

#endif
