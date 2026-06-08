#if canImport(Observation)
import XCTest
@testable import FrickSwift

/// FR-80/FR-82 (Swift) — observable call-state object.
///
/// Drives a `FrickCallSession` with a hand-fed `FrickStoreEventSource` (no
/// socket) and asserts the composed `FrickCallState` transitions as
/// `CallRoom`/`CallParticipant` deltas and removals arrive — the SwiftUI
/// analogue of the TS `callState` observable.
@MainActor
final class FrickCallSessionTests: XCTestCase {

    /// Hand-feeds inbound events into a session. Mirrors `StubEventSource` in
    /// `FrickStoreTests` but kept local to avoid cross-file coupling.
    final class CallStubSource: FrickStoreEventSource, @unchecked Sendable {
        private let continuation: AsyncThrowingStream<FrickInboundEvent, Error>.Continuation
        private let stream: AsyncThrowingStream<FrickInboundEvent, Error>
        private let lock = NSLock()
        private var _subscribed: [String] = []

        init() {
            var cont: AsyncThrowingStream<FrickInboundEvent, Error>.Continuation!
            self.stream = AsyncThrowingStream(bufferingPolicy: .unbounded) { c in cont = c }
            self.continuation = cont
        }

        var events: AsyncThrowingStream<FrickInboundEvent, Error> { get async { stream } }

        func subscribeObject(type: String) async throws {
            lock.withLock { _subscribed.append(type) }
        }

        var subscribedTypes: [String] { lock.withLock { _subscribed } }

        func emit(_ event: FrickInboundEvent) { continuation.yield(event) }
    }

    private func waitUntil(_ condition: @MainActor () -> Bool, timeout: TimeInterval = 2.0) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    private func roomRecord(id: String, state: String) -> FrickObjectRecord {
        FrickObjectRecord(type: "CallRoom", id: id, value: [
            "id": id,
            "conversationId": "conv-1",
            "state": state,
            "createdBy": "u1",
            "kind": "video",
            "createdAt": "t0",
        ])
    }

    private func participantRecord(
        id: String, callId: String, userId: String, deviceId: String,
        mic: String = "true", camera: String = "false", screen: String = "false"
    ) -> FrickObjectRecord {
        FrickObjectRecord(type: "CallParticipant", id: id, value: [
            "id": id,
            "callId": callId,
            "userId": userId,
            "deviceId": deviceId,
            "state": "joined",
            "joinedAt": "t1",
            "micEnabled": mic,
            "cameraEnabled": camera,
            "screenSharing": screen,
        ])
    }

    func testSubscribesToBothCallObjectTypes() async {
        let source = CallStubSource()
        let session = FrickCallSession(callId: "call-1", source: source)
        session.start()
        await waitUntil { source.subscribedTypes.contains("CallRoom") && source.subscribedTypes.contains("CallParticipant") }
        XCTAssertEqual(Set(source.subscribedTypes), ["CallRoom", "CallParticipant"])
    }

    func testComposesRoomAndParticipantsForTrackedCall() async {
        let source = CallStubSource()
        let session = FrickCallSession(callId: "call-1", source: source)
        session.start()

        source.emit(.objectsDelta(records: [roomRecord(id: "call-1", state: "active")], cursor: 1))
        source.emit(.objectsDelta(records: [
            participantRecord(id: "p-2", callId: "call-1", userId: "u2", deviceId: "d-2", mic: "false"),
            participantRecord(id: "p-1", callId: "call-1", userId: "u1", deviceId: "d-1"),
            // a participant on a different call must be filtered out
            participantRecord(id: "p-9", callId: "other", userId: "u9", deviceId: "d-9"),
        ], cursor: 2))

        await waitUntil { session.participants.count == 2 && session.isActive }

        XCTAssertEqual(session.room?.id, "call-1")
        XCTAssertTrue(session.isActive)
        XCTAssertFalse(session.isEnded)
        // Stable sort by userId then deviceId.
        XCTAssertEqual(session.participants.map(\.userId), ["u1", "u2"])
        XCTAssertEqual(session.participants.first?.micEnabled, true)
        XCTAssertEqual(session.participants.last?.micEnabled, false)
        XCTAssertTrue(session.hasBootstrapped)
    }

    func testMediaStateUpdateReflectsOnParticipant() async {
        let source = CallStubSource()
        let session = FrickCallSession(callId: "call-1", source: source)
        session.start()

        source.emit(.objectsDelta(records: [participantRecord(id: "p-1", callId: "call-1", userId: "u1", deviceId: "d-1", mic: "true")], cursor: 1))
        await waitUntil { session.participants.first?.micEnabled == true }

        // Upsert the same participant id with mic off — should merge in place.
        source.emit(.objectsDelta(records: [participantRecord(id: "p-1", callId: "call-1", userId: "u1", deviceId: "d-1", mic: "false", screen: "true")], cursor: 2))
        await waitUntil { session.participants.first?.micEnabled == false }

        XCTAssertEqual(session.participants.count, 1)
        XCTAssertEqual(session.participants.first?.micEnabled, false)
        XCTAssertEqual(session.participants.first?.screenSharing, true)
    }

    func testParticipantRemovalDropsFromState() async {
        let source = CallStubSource()
        let session = FrickCallSession(callId: "call-1", source: source)
        session.start()

        source.emit(.objectsDelta(records: [
            participantRecord(id: "p-1", callId: "call-1", userId: "u1", deviceId: "d-1"),
            participantRecord(id: "p-2", callId: "call-1", userId: "u2", deviceId: "d-2"),
        ], cursor: 1))
        await waitUntil { session.participants.count == 2 }

        source.emit(.objectsRemoved(removed: [FrickObjectRemoval(type: "CallParticipant", id: "p-2")], cursor: 2))
        await waitUntil { session.participants.count == 1 }

        XCTAssertEqual(session.participants.map(\.userId), ["u1"])
    }

    func testEndedRoomFlipsIsEnded() async {
        let source = CallStubSource()
        let session = FrickCallSession(callId: "call-1", source: source)
        session.start()

        source.emit(.objectsDelta(records: [roomRecord(id: "call-1", state: "ringing")], cursor: 1))
        await waitUntil { session.room != nil }
        XCTAssertFalse(session.isEnded)

        source.emit(.objectsDelta(records: [roomRecord(id: "call-1", state: "ended")], cursor: 2))
        await waitUntil { session.isEnded }
        XCTAssertTrue(session.isEnded)
        XCTAssertFalse(session.isActive)
    }

    func testResetClearsState() async {
        let source = CallStubSource()
        let session = FrickCallSession(callId: "call-1", source: source)
        session.start()
        source.emit(.objectsDelta(records: [roomRecord(id: "call-1", state: "active")], cursor: 1))
        await waitUntil { session.room != nil }

        session.reset()
        XCTAssertNil(session.room)
        XCTAssertTrue(session.participants.isEmpty)
        XCTAssertFalse(session.hasBootstrapped)
    }

    func testActionWithoutSocketRecordsError() async {
        let source = CallStubSource()
        let session = FrickCallSession(callId: "call-1", source: source)
        do {
            _ = try await session.leave()
            XCTFail("Expected error when no socket is wired")
        } catch {
            XCTAssertNotNil(session.lastError)
        }
    }
}
#endif
