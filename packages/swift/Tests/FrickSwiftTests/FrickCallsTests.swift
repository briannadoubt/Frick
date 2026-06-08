import XCTest
import os
@testable import FrickSwift

/// FR-15 Phase 2 (Swift) — call client wire + helpers.
///
/// Reuses the `MockWebSocketTask`/`MockWebSocketFactory` harness from
/// `FrickSyncSocketTests` (same test target) to drive a real `FrickSyncSocket`
/// with hand-fed frames: asserts the `CallCommand` (kind 21) encode, that a
/// matching `CallCommandResult` (kind 22) resolves the awaiting helper, and
/// that a `Nack` keyed by the same `requestId` fails it.
final class FrickCallsTests: XCTestCase {

    // MARK: Helpers

    private func makeSocket(factory: MockWebSocketFactory) -> FrickSyncSocket {
        FrickSyncSocket(
            baseURL: URL(string: "http://127.0.0.1:4099")!,
            sessionToken: "token-1",
            clientCapabilities: .defaultIOS(sdkVersion: "0.1.0-test"),
            replicaId: "test-replica",
            deviceId: "test-device",
            factory: factory,
            sleepFor: { _ in }
        )
    }

    private func helloAckFrame() -> Data {
        FrickMsgPackCodec.encodeFrame(FrickFrame(kind: .helloAck, payload: .map([
            (.string("schemaHash"), .string(FrickSchema.schemaHash)),
            (.string("schemaCompatibility"), .map([(.string("status"), .string("ok"))])),
            (.string("serverCapabilities"), .map([
                (.string("schema"), .map([
                    (.string("schemaId"), .string(FrickSchema.schemaId)),
                    (.string("schemaRevision"), .int(Int64(FrickSchema.schemaRevision))),
                    (.string("schemaHash"), .string(FrickSchema.schemaHash)),
                ])),
                (.string("transports"), .array([.string("websocket")])),
                (.string("encodings"), .array([.string("msgpack")])),
                (.string("primitives"), .array([.string("objects")])),
                (.string("blobUploads"), .array([])),
                (.string("push"), .array([])),
                (.string("experimental"), .array([])),
            ])),
        ])))
    }

    private func waitForCondition(_ check: @escaping () async -> Bool, timeout: TimeInterval = 2) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await check() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return false
    }

    private func connect(_ socket: FrickSyncSocket, _ task: MockWebSocketTask) async {
        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        task.deliver(.data(helloAckFrame()))
        _ = await waitForCondition {
            let s = await socket.status
            return s.state == .connected && s.serverCapabilities != nil
        }
    }

    // MARK: Frame kinds

    func testCallFrameKindsMirrorProtocol() {
        XCTAssertEqual(FrickFrameKind.callCommand.rawValue, 21)
        XCTAssertEqual(FrickFrameKind.callCommandResult.rawValue, 22)
        XCTAssertEqual(FrickFrameKind.callCommand.telemetryLabel, "CallCommand")
        XCTAssertEqual(FrickFrameKind.callCommandResult.telemetryLabel, "CallCommandResult")
    }

    // MARK: Command encode

    func testCreateCommandEncodesWireBody() throws {
        let command: FrickCallCommand = .create(
            conversationId: "conv-1",
            inviteeUserIds: ["u2", "u3"],
            kind: .video,
            regionHint: "us-east"
        )
        let frame = FrickFrame(kind: .callCommand, payload: .map([
            (.string("requestId"), .string("req-x")),
            (.string("command"), command.asMsgPack()),
        ]))
        let encoded = FrickMsgPackCodec.encodeFrame(frame)
        let decoded = try FrickMsgPackCodec.decodeFrame(encoded)
        XCTAssertEqual(decoded.kind, .callCommand)
        let body = try XCTUnwrap(decoded.payload.mapValue?["command"]?.mapValue)
        XCTAssertEqual(body["op"]?.stringValue, "create")
        XCTAssertEqual(body["conversationId"]?.stringValue, "conv-1")
        XCTAssertEqual(body["inviteeUserIds"]?.arrayValue?.compactMap { $0.stringValue }, ["u2", "u3"])
        XCTAssertEqual(body["kind"]?.stringValue, "video")
        XCTAssertEqual(body["regionHint"]?.stringValue, "us-east")
    }

    func testSetMediaStateCommandEncodesOnlyPresentFields() throws {
        let command: FrickCallCommand = .setMediaState(
            callId: "call-1",
            media: FrickCallMediaStatePatch(micEnabled: false, screenSharing: true)
        )
        let body = try XCTUnwrap(command.asMsgPack().mapValue)
        XCTAssertEqual(body["op"]?.stringValue, "setMediaState")
        XCTAssertEqual(body["callId"]?.stringValue, "call-1")
        let media = try XCTUnwrap(body["media"]?.mapValue)
        XCTAssertEqual(media["micEnabled"]?.boolValue, false)
        XCTAssertEqual(media["screenSharing"]?.boolValue, true)
        XCTAssertNil(media["cameraEnabled"], "absent patch fields are omitted (mirrors TS spread)")
    }

    // MARK: callCommand round-trip

    func testCreateCallResolvesOnCallCommandResult() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)
        await connect(socket, task)

        async let created = socket.createCall(conversationId: "conv-1", inviteeUserIds: ["u2"], kind: .audio)

        _ = await waitForCondition { task.sentFrameCount >= 2 }
        let sent = try FrickMsgPackCodec.decodeFrame(task.sentFrame(at: 1))
        XCTAssertEqual(sent.kind, .callCommand)
        let requestId = try XCTUnwrap(sent.payload.mapValue?["requestId"]?.stringValue)
        XCTAssertEqual(sent.payload.mapValue?["command"]?.mapValue?["op"]?.stringValue, "create")

        let resultFrame = FrickMsgPackCodec.encodeFrame(FrickFrame(kind: .callCommandResult, payload: .map([
            (.string("requestId"), .string(requestId)),
            (.string("op"), .string("create")),
            (.string("room"), .map([
                (.string("id"), .string("call-1")),
                (.string("conversationId"), .string("conv-1")),
                (.string("state"), .string("ringing")),
                (.string("createdBy"), .string("u1")),
                (.string("kind"), .string("audio")),
                (.string("createdAt"), .string("2026-06-07T00:00:00Z")),
            ])),
            (.string("invites"), .array([.map([
                (.string("id"), .string("inv-1")),
                (.string("callId"), .string("call-1")),
                (.string("inviteeUserId"), .string("u2")),
                (.string("status"), .string("ringing")),
                (.string("invitedBy"), .string("u1")),
                (.string("invitedAt"), .string("2026-06-07T00:00:00Z")),
            ])])),
        ])))
        task.deliver(.data(resultFrame))

        let result = try await created
        XCTAssertEqual(result.room.id, "call-1")
        XCTAssertEqual(result.room.state, .ringing)
        XCTAssertEqual(result.invites.count, 1)
        XCTAssertEqual(result.invites.first?.inviteeUserId, "u2")

        await socket.close()
    }

    func testJoinCallDecodesParticipantAndMediaGrant() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)
        await connect(socket, task)

        async let joined = socket.joinCall(callId: "call-1")

        _ = await waitForCondition { task.sentFrameCount >= 2 }
        let sent = try FrickMsgPackCodec.decodeFrame(task.sentFrame(at: 1))
        let requestId = try XCTUnwrap(sent.payload.mapValue?["requestId"]?.stringValue)

        let resultFrame = FrickMsgPackCodec.encodeFrame(FrickFrame(kind: .callCommandResult, payload: .map([
            (.string("requestId"), .string(requestId)),
            (.string("op"), .string("join")),
            (.string("room"), .map([
                (.string("id"), .string("call-1")),
                (.string("conversationId"), .string("conv-1")),
                (.string("state"), .string("active")),
                (.string("createdBy"), .string("u1")),
                (.string("kind"), .string("video")),
                (.string("createdAt"), .string("t0")),
            ])),
            (.string("participant"), .map([
                (.string("id"), .string("p-1")),
                (.string("callId"), .string("call-1")),
                (.string("userId"), .string("u2")),
                (.string("deviceId"), .string("d-2")),
                (.string("state"), .string("joined")),
                (.string("joinedAt"), .string("t1")),
                (.string("micEnabled"), .bool(true)),
                (.string("cameraEnabled"), .bool(false)),
                (.string("screenSharing"), .bool(false)),
                (.string("speaking"), .bool(true)),
                (.string("networkQuality"), .string("good")),
            ])),
            (.string("mediaGrant"), .map([
                (.string("callId"), .string("call-1")),
                (.string("mediaSessionId"), .string("ms-1")),
                (.string("userId"), .string("u2")),
                (.string("deviceId"), .string("d-2")),
                (.string("token"), .string("grant-token")),
                (.string("expiresAt"), .string("t9")),
                (.string("connection"), .map([(.string("url"), .string("wss://sfu"))])),
            ])),
        ])))
        task.deliver(.data(resultFrame))

        let result = try await joined
        XCTAssertEqual(result.room.state, .active)
        XCTAssertEqual(result.participant.userId, "u2")
        XCTAssertEqual(result.participant.speaking, true)
        XCTAssertEqual(result.participant.networkQuality, .good)
        XCTAssertEqual(result.mediaGrant.token, "grant-token")
        XCTAssertEqual(result.mediaGrant.connection?["url"], "wss://sfu")

        await socket.close()
    }

    func testCallCommandFailsOnNackByRequestId() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)
        await connect(socket, task)

        async let joined = socket.joinCall(callId: "call-1")

        _ = await waitForCondition { task.sentFrameCount >= 2 }
        let sent = try FrickMsgPackCodec.decodeFrame(task.sentFrame(at: 1))
        let requestId = try XCTUnwrap(sent.payload.mapValue?["requestId"]?.stringValue)

        let nackFrame = FrickMsgPackCodec.encodeFrame(FrickFrame(kind: .nack, payload: .map([
            (.string("requestId"), .string(requestId)),
            (.string("error"), .map([
                (.string("code"), .string("calls.notInvitee")),
                (.string("message"), .string("not invited")),
                (.string("requestId"), .string(requestId)),
                (.string("retryable"), .bool(false)),
            ])),
        ])))
        task.deliver(.data(nackFrame))

        do {
            _ = try await joined
            XCTFail("Expected Nack to throw")
        } catch is FrickServerError {
            // expected — call failures reuse the Nack channel
        }

        await socket.close()
    }

    // MARK: Record decode from synced object rows

    func testParticipantRecordParsesStringPackedBooleans() {
        let record = FrickObjectRecord(type: "CallParticipant", id: "p-1", value: [
            "id": "p-1",
            "callId": "call-1",
            "userId": "u2",
            "deviceId": "d-2",
            "state": "joined",
            "joinedAt": "t1",
            "micEnabled": "true",
            "cameraEnabled": "false",
            "screenSharing": "1",
            "networkQuality": "fair",
        ])
        let parsed = FrickCallParticipantRecord(record: record)
        XCTAssertEqual(parsed?.micEnabled, true)
        XCTAssertEqual(parsed?.cameraEnabled, false)
        XCTAssertEqual(parsed?.screenSharing, true)
        XCTAssertEqual(parsed?.networkQuality, .fair)
    }
}
