#if canImport(SwiftUI) && canImport(Combine)
import SwiftUI
import Combine
import Foundation

/// SwiftUI property wrapper that subscribes to a Frick stream via the
/// surrounding `FrickSyncSocket` and exposes the live tail as
/// `[FrickStreamEvent]`. The wrapper bridges the socket's
/// `AsyncThrowingStream<FrickInboundEvent, Error>` into an
/// `@Observable`-style state property so SwiftUI views re-render on every
/// Delta automatically — no manual `Task { for try await … }` boilerplate.
///
///     struct ConvoView: View {
///         @FrickStream("ActivityStream", key: "item-1") var events
///         var body: some View { List(events, id: \.eventId) { … } }
///     }
///
/// The wrapper picks the socket up from `@Environment(\.frickSyncSocket)`.
/// Inject it once in your scene root:
///
///     ContentView()
///         .environment(\.frickSyncSocket, socket)
///
/// Falls back to an empty list when no socket is in the environment so
/// previews render without crashing.
@MainActor
@propertyWrapper
public struct FrickStream: DynamicProperty {
    @Environment(\.frickSyncSocket) private var socket
    @StateObject private var store: StreamStore
    private let streamName: String
    private let key: String

    public init(_ stream: String, key: String) {
        self.streamName = stream
        self.key = key
        _store = StateObject(wrappedValue: StreamStore())
    }

    public var wrappedValue: [FrickStreamEvent] { store.events }

    // DynamicProperty's `update()` requirement is `nonisolated`; SwiftUI
    // guarantees it runs during the view-update phase on the main thread,
    // so `MainActor.assumeIsolated` bridges into our @MainActor store
    // without an async hop.
    nonisolated public func update() {
        MainActor.assumeIsolated {
            store.attach(socket: socket, stream: streamName, key: key)
        }
    }
}

@MainActor
private final class StreamStore: ObservableObject {
    @Published private(set) var events: [FrickStreamEvent] = []
    private var listenerTask: Task<Void, Never>?
    private var currentSocket: FrickSyncSocket?
    private var currentKey: String?

    func attach(socket: FrickSyncSocket?, stream: String, key: String) {
        let scope = "\(stream)\u{0}\(key)"
        if currentSocket === socket, currentKey == scope { return }
        listenerTask?.cancel()
        currentSocket = socket
        currentKey = scope
        events = []
        guard let socket else { return }
        listenerTask = Task { [weak self] in
            do {
                try await socket.subscribe(stream: stream, key: key)
                for try await event in await socket.events {
                    guard case let .delta(_, evs, _) = event else { continue }
                    let filtered = evs.filter { $0.stream == stream && $0.streamId == key }
                    if filtered.isEmpty { continue }
                    await MainActor.run {
                        self?.events.append(contentsOf: filtered)
                    }
                }
            } catch {
                // Swallow — the socket emits its own status updates that
                // SwiftUI consumers can render alongside via `useSyncStatus`
                // (or the Swift equivalent: `socket.statusUpdates()`).
            }
        }
    }

    deinit {
        listenerTask?.cancel()
    }
}

/// SwiftUI property wrapper for a presence row.
@MainActor
@propertyWrapper
public struct FrickPresence: DynamicProperty {
    @Environment(\.frickSyncSocket) private var socket
    @StateObject private var store: PresenceStore
    private let presenceName: String
    private let key: String

    public init(_ name: String, key: String) {
        self.presenceName = name
        self.key = key
        _store = StateObject(wrappedValue: PresenceStore())
    }

    public var wrappedValue: [FrickPresenceRecord] { store.records }

    // See FrickStream.update() above — same DynamicProperty/@MainActor bridge.
    nonisolated public func update() {
        MainActor.assumeIsolated {
            store.attach(socket: socket, name: presenceName, key: key)
        }
    }
}

@MainActor
private final class PresenceStore: ObservableObject {
    @Published private(set) var records: [FrickPresenceRecord] = []
    private var listenerTask: Task<Void, Never>?
    private var currentSocket: FrickSyncSocket?
    private var currentKey: String?

    func attach(socket: FrickSyncSocket?, name: String, key: String) {
        let scope = "\(name)\u{0}\(key)"
        if currentSocket === socket, currentKey == scope { return }
        listenerTask?.cancel()
        currentSocket = socket
        currentKey = scope
        records = []
        guard let socket else { return }
        listenerTask = Task { [weak self] in
            do {
                try await socket.subscribePresence(name: name, key: key)
                for try await event in await socket.events {
                    guard case let .presenceDelta(deltaName, deltaRecords, cleared) = event,
                          deltaName == name
                    else { continue }
                    await MainActor.run {
                        guard let self else { return }
                        var next = self.records
                        next.removeAll { record in cleared.contains(record.key) }
                        for record in deltaRecords {
                            if let idx = next.firstIndex(where: { $0.key == record.key }) {
                                next[idx] = record
                            } else {
                                next.append(record)
                            }
                        }
                        self.records = next
                    }
                }
            } catch {
                // See comment in StreamStore — surface errors via the
                // status stream instead of throwing through SwiftUI.
            }
        }
    }

    deinit {
        listenerTask?.cancel()
    }
}

// MARK: - Environment plumbing

private struct FrickSyncSocketKey: EnvironmentKey {
    static let defaultValue: FrickSyncSocket? = nil
}

public extension EnvironmentValues {
    /// The `FrickSyncSocket` to use for `@FrickStream` / `@FrickPresence`
    /// property wrappers. Inject once in the scene root.
    var frickSyncSocket: FrickSyncSocket? {
        get { self[FrickSyncSocketKey.self] }
        set { self[FrickSyncSocketKey.self] = newValue }
    }
}

#endif
