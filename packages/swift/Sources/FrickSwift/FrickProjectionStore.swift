import Foundation
import Observation

// MARK: - FrickProjectionEventSource

/// The slice of ``FrickSyncSocket`` a ``FrickProjectionStore`` depends on.
/// Abstracted so tests can drive a store with hand-fed events and assert the
/// observable row map updates, without standing up a real socket or server.
///
/// Mirrors ``FrickStoreEventSource`` but targets projection subscriptions:
/// `subscribeProjection(name:)` registers the subscription (the socket replays
/// it on reconnect) and the server streams ``FrickInboundEvent/projectionDelta(projection:changes:)``
/// frames the store folds into its keyed cache.
public protocol FrickProjectionEventSource: Sendable {
    /// The inbound event stream the store folds into its row map.
    var events: AsyncThrowingStream<FrickInboundEvent, Error> { get async }

    /// Subscribe to a projection by name. The server streams `ProjectionDelta`
    /// frames carrying keyed row upserts (and deletions via `nil` values).
    func subscribeProjection(name: String) async throws
}

extension FrickSyncSocket: FrickProjectionEventSource {}

// MARK: - FrickProjectionStore

/// A generic, reusable observable projection cache + sync loop.
///
/// `FrickProjectionStore` subscribes to a single projection over the sync
/// socket and maintains an in-memory map keyed by the projection-defined row
/// key, exposing it as observable state for SwiftUI. It mirrors the
/// TypeScript runtime's `client.projection(name)` abstraction, which returns a
/// Signal of `Map<rowKey, row>` fed by `ProjectionDelta` frames.
///
/// It applies, in order, every ``FrickInboundEvent/projectionDelta(projection:changes:)``
/// for its projection name:
///
/// - a change with a non-`nil` value **upserts** the row at `key`,
/// - a change with a `nil` value **deletes** the row at `key`.
///
/// On reconnect the underlying socket replays its registered subscriptions, so
/// a dropped connection self-heals: a fresh snapshot re-arrives and reconciles
/// the map without app intervention. (Identical semantics to the TS runtime,
/// which re-issues projection subscribes after reconnect.)
///
/// ```swift
/// @MainActor
/// final class InboxProjection {
///     let store: FrickProjectionStore
///     init(socket: FrickSyncSocket) {
///         store = FrickProjectionStore(source: socket, name: "conversation-inbox")
///         store.start()
///     }
/// }
/// ```
@MainActor
@Observable
public final class FrickProjectionStore {
    /// The current projection rows, keyed by the projection-defined row key.
    /// Observable: SwiftUI views reading this re-render on every applied delta.
    /// Values are carried as ``FrickMsgPackValue``; use `.anyValue` for a
    /// JSON-friendly Swift tree (mirrors ``FrickProjectionChange``).
    public private(set) var rows: [String: FrickMsgPackValue] = [:]

    /// `true` once at least one ``FrickInboundEvent/projectionDelta(projection:changes:)``
    /// has been applied. Use it to gate a loading spinner vs. an empty-state
    /// view (empty + bootstrapped ≠ loading).
    public private(set) var hasBootstrapped: Bool = false

    /// The last error surfaced by the sync loop, if any. The loop keeps running
    /// (it self-heals on reconnect); this is for diagnostics/UI.
    public private(set) var lastError: String?

    /// The projection name this store subscribes to.
    public let name: String

    @ObservationIgnored private let source: FrickProjectionEventSource
    @ObservationIgnored private var listenerTask: Task<Void, Never>?

    public init(source: FrickProjectionEventSource, name: String) {
        self.source = source
        self.name = name
    }

    deinit {
        listenerTask?.cancel()
    }

    // MARK: Lifecycle

    /// Subscribe to the projection and begin folding inbound deltas into the
    /// row map. Idempotent — a second call while already running is a no-op, so
    /// it's safe to call from `task {}`/`onAppear`.
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
        rows = [:]
        hasBootstrapped = false
        lastError = nil
    }

    // MARK: Sync loop

    private func run() async {
        do {
            try await source.subscribeProjection(name: name)
            for try await event in await source.events {
                switch event {
                case let .projectionDelta(projection, changes) where projection == name:
                    apply(changes: changes)
                case let .status(status):
                    if let err = status.lastError { lastError = err }
                    // On a fresh (re)connect the socket replays the projection
                    // subscription itself; the snapshot re-arrives and
                    // reconciles the map — nothing to do here.
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

    /// Fold a batch of projection changes into the keyed map. A `nil` value
    /// deletes the row at `key`; a non-`nil` value upserts it. Mirrors the TS
    /// runtime's ProjectionDelta apply (null → delete). Sets
    /// ``hasBootstrapped`` once any delta lands.
    private func apply(changes: [FrickProjectionChange]) {
        for change in changes {
            if let value = change.value {
                rows[change.key] = value
            } else {
                rows.removeValue(forKey: change.key)
            }
        }
        hasBootstrapped = true
    }
}
