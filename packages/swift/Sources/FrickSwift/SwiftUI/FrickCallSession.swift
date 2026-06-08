#if canImport(Observation)
import Foundation
import Observation

/// FR-82 — the per-participant presence surface a call UI renders: identity
/// plus mic/camera/screen-share, the live `speaking` flag, and a coarse
/// `networkQuality` bucket. `mic`/`camera`/`screenSharing` come straight off
/// the server-authoritative participant record; `speaking`/`networkQuality`
/// ride the same record when a media adapter reports them (defaulting to
/// `false`/`.unknown`). Mirrors TS `CallParticipantPresence`.
public struct FrickCallParticipantPresence: Sendable, Equatable, Identifiable {
    public let userId: String
    public let deviceId: String
    public let state: FrickCallParticipantState
    public let micEnabled: Bool
    public let cameraEnabled: Bool
    public let screenSharing: Bool
    public let speaking: Bool
    public let networkQuality: FrickCallNetworkQuality

    /// Stable identity for `ForEach` — a participant is unique per (user, device).
    public var id: String { "\(userId):\(deviceId)" }

    init(record: FrickCallParticipantRecord) {
        self.userId = record.userId
        self.deviceId = record.deviceId
        self.state = record.state
        self.micEnabled = record.micEnabled
        self.cameraEnabled = record.cameraEnabled
        self.screenSharing = record.screenSharing
        self.speaking = record.speaking ?? false
        self.networkQuality = record.networkQuality ?? .unknown
    }
}

/// The reactive view of a single call: the room record, every participant's
/// presence, and the convenience `isActive`/`isEnded` flags. A `nil` `room`
/// means the call isn't known to this client yet (not synced, or wrong id).
/// Mirrors TS `CallState`.
public struct FrickCallState: Sendable, Equatable {
    public let callId: String
    public let room: FrickCallRoomRecord?
    public let participants: [FrickCallParticipantPresence]
    public var isActive: Bool { room?.state == .active }
    public var isEnded: Bool { room?.state == .ended }

    public init(
        callId: String,
        room: FrickCallRoomRecord? = nil,
        participants: [FrickCallParticipantPresence] = []
    ) {
        self.callId = callId
        self.room = room
        self.participants = participants
    }
}

/// Observable call-state object — the SwiftUI analogue of the TS
/// `callState(client, callId)` Signal / `useCallState` hook (FR-80/FR-82).
///
/// It subscribes to the `CallRoom` + `CallParticipant` object types over the
/// sync socket, folds the inbound deltas into an in-memory cache keyed by the
/// `callId` it tracks, and exposes the composed ``FrickCallState`` as
/// observable state SwiftUI re-renders on. It also exposes the call *actions*
/// (`create`/`join`/`accept`/`leave`/`end`/`setMediaState`) so a call screen
/// can drive both the live state and the commands off one object — the union
/// of TS `useCallState` + `useCallActions`.
///
/// Mirrors the ``FrickStore`` / ``FrickSessionManager`` idioms: `@MainActor`-
/// confined so views read synchronously, `start()`/`reset()` lifecycle, a
/// detached listener that self-heals on reconnect (the socket replays its
/// subscriptions, the snapshot re-arrives and reconciles the cache), and a
/// `FrickStoreEventSource`-shaped seam so tests drive it with hand-fed events.
@MainActor
@Observable
public final class FrickCallSession {

    /// The call id this session tracks. Immutable for the object's lifetime.
    public let callId: String

    /// The composed reactive call state. Observable — SwiftUI re-renders on
    /// every room/participant delta touching this call.
    public private(set) var state: FrickCallState

    /// `true` once the initial snapshot of either object type has applied. Gate
    /// a loading spinner vs. an empty/ringing state on this.
    public private(set) var hasBootstrapped: Bool = false

    /// Last error surfaced by the sync loop or an action, for diagnostics/UI.
    public private(set) var lastError: String?

    /// Convenience pass-throughs onto the latest composed state.
    public var room: FrickCallRoomRecord? { state.room }
    public var participants: [FrickCallParticipantPresence] { state.participants }
    public var isActive: Bool { state.isActive }
    public var isEnded: Bool { state.isEnded }

    @ObservationIgnored private var roomsById: [String: FrickCallRoomRecord] = [:]
    @ObservationIgnored private var participantsById: [String: FrickCallParticipantRecord] = [:]

    @ObservationIgnored private let source: FrickStoreEventSource
    @ObservationIgnored private let actor: FrickSyncSocket?
    @ObservationIgnored private var listenerTask: Task<Void, Never>?

    /// Build a session bound to a live socket — the common production path. The
    /// same socket backs both the observable state (its event stream) and the
    /// call actions (its `callCommand`).
    public convenience init(socket: FrickSyncSocket, callId: String) {
        self.init(callId: callId, source: socket, actor: socket)
    }

    /// Designated initializer. `source` feeds the observable state; `actor`
    /// (optional) issues call commands. Tests pass a stub `source` and a `nil`
    /// `actor` to exercise the reconciliation without a socket.
    public init(callId: String, source: FrickStoreEventSource, actor: FrickSyncSocket? = nil) {
        self.callId = callId
        self.source = source
        self.actor = actor
        self.state = FrickCallState(callId: callId)
    }

    deinit {
        listenerTask?.cancel()
    }

    // MARK: Lifecycle

    /// Subscribe to the `CallRoom` + `CallParticipant` object types and begin
    /// folding inbound events into the cache. Idempotent — a second call while
    /// already running is a no-op, so it's safe to call from `task {}`.
    public func start() {
        guard listenerTask == nil else { return }
        listenerTask = Task { [weak self] in
            await self?.run()
        }
    }

    /// Tear down: cancel the listener and clear the cache. After `reset()` the
    /// session can be `start()`ed again.
    public func reset() {
        listenerTask?.cancel()
        listenerTask = nil
        roomsById = [:]
        participantsById = [:]
        hasBootstrapped = false
        lastError = nil
        state = FrickCallState(callId: callId)
    }

    // MARK: Sync loop

    private func run() async {
        do {
            try await source.subscribeObject(type: FrickCallObjectType.room)
            try await source.subscribeObject(type: FrickCallObjectType.participant)
            for try await event in await source.events {
                switch event {
                case let .objectsDelta(records, _):
                    apply(records: records)
                case let .objectsRemoved(removals, _):
                    apply(removals: removals)
                case let .status(status):
                    if let err = status.lastError { lastError = err }
                default:
                    continue
                }
            }
        } catch is CancellationError {
            // Expected on reset()/deinit.
        } catch {
            lastError = "\(error)"
        }
    }

    // MARK: Apply

    private func apply(records: [FrickObjectRecord]) {
        var touched = false
        for record in records {
            switch record.type {
            case FrickCallObjectType.room:
                if let room = FrickCallRoomRecord(record: record) {
                    roomsById[room.id] = room
                    touched = true
                }
            case FrickCallObjectType.participant:
                if let participant = FrickCallParticipantRecord(record: record) {
                    participantsById[participant.id] = participant
                    touched = true
                }
            default:
                continue
            }
        }
        if touched {
            hasBootstrapped = true
            recompose()
        }
    }

    private func apply(removals: [FrickObjectRemoval]) {
        var touched = false
        for removal in removals {
            switch removal.type {
            case FrickCallObjectType.room:
                if roomsById.removeValue(forKey: removal.id) != nil { touched = true }
            case FrickCallObjectType.participant:
                if participantsById.removeValue(forKey: removal.id) != nil { touched = true }
            default:
                continue
            }
        }
        if touched { recompose() }
    }

    /// Recompose the observable state from the cache: resolve the room by id,
    /// filter participants to this call, and sort them stably (by user then
    /// device) so the UI doesn't reshuffle tiles on every delta — mirrors the
    /// TS `composeCallState` ordering.
    private func recompose() {
        let forCall: [FrickCallParticipantRecord] = participantsById.values.filter { $0.callId == callId }
        var presence: [FrickCallParticipantPresence] = forCall.map { FrickCallParticipantPresence(record: $0) }
        presence.sort { lhs, rhs in
            lhs.userId == rhs.userId ? lhs.deviceId < rhs.deviceId : lhs.userId < rhs.userId
        }
        state = FrickCallState(callId: callId, room: roomsById[callId], participants: presence)
    }

    // MARK: Actions (FR-80)

    /// Join this call. See ``FrickSyncSocket/joinCall(callId:)``. Records the
    /// error on `lastError` and rethrows.
    @discardableResult
    public func join() async throws -> FrickJoinCallResult {
        try await runAction("join") { try await $0.joinCall(callId: self.callId) }
    }

    /// Accept this call's ringing invite. See
    /// ``FrickSyncSocket/acceptCall(callId:)``.
    @discardableResult
    public func accept() async throws -> FrickCallInviteRecord {
        try await runAction("accept") { try await $0.acceptCall(callId: self.callId) }
    }

    /// Leave this call. See ``FrickSyncSocket/leaveCall(callId:)``.
    @discardableResult
    public func leave() async throws -> FrickCallRoomRecord {
        try await runAction("leave") { try await $0.leaveCall(callId: self.callId) }
    }

    /// End this call. See ``FrickSyncSocket/endCall(callId:)``.
    @discardableResult
    public func end() async throws -> FrickCallRoomRecord {
        try await runAction("end") { try await $0.endCall(callId: self.callId) }
    }

    /// Update local media state on this call (mic/camera/screen-share, FR-82).
    /// See ``FrickSyncSocket/setCallMediaState(callId:media:)``.
    @discardableResult
    public func setMediaState(_ media: FrickCallMediaStatePatch) async throws -> FrickCallParticipantRecord {
        try await runAction("setMediaState") { try await $0.setCallMediaState(callId: self.callId, media: media) }
    }

    /// Toggle mic on/off relative to the signed-in device's current participant
    /// presence (the first participant whose `userId` matches the room creator's
    /// own device is not known here, so callers usually pass the desired state
    /// explicitly via ``setMediaState(_:)``). Convenience over `setMediaState`.
    @discardableResult
    public func setMicEnabled(_ enabled: Bool) async throws -> FrickCallParticipantRecord {
        try await setMediaState(FrickCallMediaStatePatch(micEnabled: enabled))
    }

    @discardableResult
    public func setCameraEnabled(_ enabled: Bool) async throws -> FrickCallParticipantRecord {
        try await setMediaState(FrickCallMediaStatePatch(cameraEnabled: enabled))
    }

    @discardableResult
    public func setScreenSharing(_ enabled: Bool) async throws -> FrickCallParticipantRecord {
        try await setMediaState(FrickCallMediaStatePatch(screenSharing: enabled))
    }

    private func runAction<T>(_ op: String, _ body: (FrickSyncSocket) async throws -> T) async throws -> T {
        guard let actor else {
            let error = FrickCallError.missingResultField(op: op, field: "socket")
            lastError = "\(op): no socket"
            throw error
        }
        do {
            let result = try await body(actor)
            lastError = nil
            return result
        } catch {
            lastError = "\(op): \(error)"
            throw error
        }
    }
}
#endif
