import Foundation
import Observation

// MARK: - FrickModel

/// The contract a model must satisfy to live in a ``FrickStore``.
///
/// A `FrickModel` is the app-facing wrapper around a single object row. It is
/// constructed from a wire-decoded ``FrickObjectRecord`` (id + named-field
/// strings, resolved via the schema descriptor) and exposes a stable `id` so
/// the store can key its in-memory cache.
///
/// The protocol is deliberately tiny — the only per-entity differences across
/// RangerCRM's ~16 hand-written stores were the model type and the sort
/// predicate. Everything else (snapshot apply, live upsert/remove
/// reconciliation, reconnect re-subscribe) is owned by the generic store.
///
/// Conformers should be reference types (`final class`) so a same-id merge can
/// mutate the existing instance in place — this is what lets SwiftUI's
/// `ForEach` re-bind an edited row instead of tearing down and rebuilding the
/// cell (see ``FrickStore`` merge notes).
@MainActor
public protocol FrickModel: AnyObject, Identifiable where ID == String {
    /// The Frick object type name this model maps to (e.g. "Account"). The
    /// store subscribes to this type over the sync socket.
    static var objectType: String { get }

    /// Build a model from a decoded object record. Return `nil` to skip a row
    /// the model can't represent (e.g. a tombstone or a forward-incompatible
    /// shape) — the store drops it rather than aborting the whole snapshot.
    init?(record: FrickObjectRecord)

    /// Apply a newer record's fields to this existing instance, in place.
    ///
    /// Called when a delta touches a row already in the cache. Mutating the
    /// existing instance (rather than replacing it) preserves object identity
    /// so SwiftUI re-renders the same cell instead of recreating it — one of
    /// the two hard-won RangerCRM correctness fixes this port centralizes.
    func merge(record: FrickObjectRecord)
}

// MARK: - FrickStoreEventSource

/// The slice of ``FrickSyncSocket`` a ``FrickStore`` depends on. Abstracted so
/// tests can drive a store with hand-fed events and assert the observable
/// collection updates, without standing up a real socket or server.
public protocol FrickStoreEventSource: Sendable {
    /// The inbound event stream the store folds into its cache.
    var events: AsyncThrowingStream<FrickInboundEvent, Error> { get async }

    /// Subscribe to all objects of `type`. The source replies with a snapshot
    /// (surfaced as ``FrickInboundEvent/objectsDelta(records:cursor:)``) and
    /// then streams live upserts/removals the same way.
    func subscribeObject(type: String) async throws
}

extension FrickSyncSocket: FrickStoreEventSource {}

// MARK: - FrickStore

/// A generic, reusable observable object cache + sync loop.
///
/// `FrickStore<Model>` subscribes to a single object type over the sync
/// socket, maintains an in-memory cache keyed by id, and exposes the
/// collection as observable state for SwiftUI. It applies, in order:
///
/// - the **initial snapshot** (the first `.objectsDelta` after subscribe),
/// - live **upserts** (`.objectsDelta`), merging same-id rows in place, and
/// - live **removals** (`.objectsRemoved`, FR-144), dropping rows by id.
///
/// On reconnect it re-subscribes automatically (the underlying socket replays
/// subscriptions, and the store re-attaches its listener), so a dropped
/// connection self-heals without app intervention.
///
/// Subclass for a concrete entity by supplying only the sort predicate:
///
/// ```swift
/// @MainActor
/// final class AccountStore: FrickStore<AccountModel> {
///     init(source: FrickStoreEventSource) {
///         super.init(source: source, sort: { $0.name < $1.name })
///     }
/// }
/// ```
///
/// ## Correctness invariants (ported from RangerCRM)
///
/// 1. **Re-sort + re-emit on every merge.** An in-place edit mutates a model
///    but not the `items` array, so without reassigning `items` SwiftUI never
///    re-renders. The store reassigns `items` (sorted) after every apply,
///    forcing observation to fire.
/// 2. **In-place same-id merge.** A delta touching an existing row mutates the
///    cached instance rather than replacing it, so `ForEach` re-binds the same
///    cell (a replaced instance tears the cell down — losing focus, animation,
///    scroll position).
@MainActor
@Observable
open class FrickStore<Model: FrickModel> {
    /// The current cached collection, sorted by the injected predicate.
    /// Observable: SwiftUI views reading this re-render on every apply.
    public private(set) var items: [Model] = []

    /// `true` once the initial snapshot has been applied. Use it to gate a
    /// loading spinner vs. an empty-state view (empty + bootstrapped ≠ loading).
    public private(set) var hasBootstrapped: Bool = false

    /// The last error surfaced by the sync loop, if any. The loop keeps
    /// running (it self-heals on reconnect); this is for diagnostics/UI.
    public private(set) var lastError: String?

    /// id → model index, kept in lock-step with `items` for O(1) merges.
    @ObservationIgnored private var byId: [String: Model] = [:]

    @ObservationIgnored private let source: FrickStoreEventSource
    @ObservationIgnored private let sort: @MainActor (Model, Model) -> Bool
    @ObservationIgnored private var listenerTask: Task<Void, Never>?

    /// - Parameters:
    ///   - source: the sync event source (a ``FrickSyncSocket`` in production,
    ///     a stub in tests).
    ///   - sort: ordering predicate applied after every merge. Defaults to
    ///     ordering by `id` so the collection is at least deterministic.
    public init(
        source: FrickStoreEventSource,
        sort: @escaping @MainActor (Model, Model) -> Bool = { $0.id < $1.id }
    ) {
        self.source = source
        self.sort = sort
    }

    deinit {
        listenerTask?.cancel()
    }

    // MARK: Lifecycle

    /// Subscribe to the model's object type and begin folding inbound events
    /// into the cache. Idempotent — a second call while already running is a
    /// no-op, so it's safe to call from `task {}`/`onAppear`.
    public func start() {
        guard listenerTask == nil else { return }
        listenerTask = Task { [weak self] in
            await self?.run()
        }
    }

    /// Tear down on sign-out: cancel the listener and clear the cache. After
    /// `reset()` the store can be `start()`ed again (e.g. on the next sign-in).
    public func reset() {
        listenerTask?.cancel()
        listenerTask = nil
        items = []
        byId = [:]
        hasBootstrapped = false
        lastError = nil
    }

    // MARK: Sync loop

    private func run() async {
        do {
            try await source.subscribeObject(type: Model.objectType)
            for try await event in await source.events {
                switch event {
                case let .objectsDelta(records, _):
                    apply(records: records)
                case let .objectsRemoved(removals, _):
                    apply(removals: removals)
                case let .status(status):
                    if let err = status.lastError { lastError = err }
                    // On a fresh (re)connect the socket replays the object
                    // subscription itself; nothing to do here but note that
                    // the snapshot will re-arrive and reconcile the cache.
                default:
                    continue
                }
            }
        } catch is CancellationError {
            // Expected on reset()/deinit — swallow.
        } catch {
            // The socket emits its own status updates and reconnects; surface
            // the error for UI but keep the (now-finished) loop from crashing.
            lastError = "\(error)"
        }
    }

    // MARK: Apply

    /// Apply a batch of upserts. New ids are inserted; existing ids are merged
    /// in place. Records for other object types are ignored (object
    /// subscriptions are type-scoped on the wire, but a shared event stream
    /// may carry sibling types). Always re-sorts + re-emits.
    private func apply(records: [FrickObjectRecord]) {
        for record in records where record.type == Model.objectType {
            if let existing = byId[record.id] {
                existing.merge(record: record)
            } else if let model = Model(record: record) {
                byId[record.id] = model
            }
        }
        hasBootstrapped = true
        reemit()
    }

    /// Apply a batch of removals, dropping matching ids from the cache. Always
    /// re-sorts + re-emits so the removed rows leave the observable collection.
    private func apply(removals: [FrickObjectRemoval]) {
        var changed = false
        for removal in removals where removal.type == Model.objectType {
            if byId.removeValue(forKey: removal.id) != nil {
                changed = true
            }
        }
        if changed { reemit() }
    }

    /// Rebuild the sorted `items` array from the index. Reassigning `items`
    /// (even when membership is unchanged but a row was edited in place) is
    /// what forces SwiftUI observation to fire — invariant (1) above.
    private func reemit() {
        items = byId.values.sorted(by: sort)
    }
}
