import XCTest
import os
@testable import FrickSwift

/// Tiny wrapper used by the mocks to bridge `NSLock`-style critical sections
/// into async-safe scoped form expected by Swift 6 concurrency. We use a raw
/// `os_unfair_lock` so the body closure doesn't need to be `@Sendable`.
private final class TaskLock: @unchecked Sendable {
    private var raw = os_unfair_lock_s()
    func withLock<T>(_ body: () -> T) -> T {
        withUnsafeMutablePointer(to: &raw) { ptr in
            os_unfair_lock_lock(ptr)
            defer { os_unfair_lock_unlock(ptr) }
            return body()
        }
    }
}

/// Lock-protected `Bool` for cross-task signalling in the FR-256 tests.
private final class BoolBox: @unchecked Sendable {
    private let lock = TaskLock()
    private var v = false
    var value: Bool { lock.withLock { v } }
    func set(_ newValue: Bool) { lock.withLock { v = newValue } }
}

// MARK: - Mock WebSocket task

/// Mocks the WebSocket task at the `FrickWebSocketTaskProtocol` boundary.
/// We chose this strategy (mock the protocol, not the network) because:
///   - URLProtocol does not interpose `URLSessionWebSocketTask`
///   - Standing up a real `NWListener` here would be slower, flakier, and
///     wouldn't validate the SDK's contract any more strictly than mocking
///     the task interface.
final class MockWebSocketTask: FrickWebSocketTaskProtocol, @unchecked Sendable {
    private let lock = TaskLock()
    private var sentFrames: [Data] = []
    private var pendingMessages: [Result<URLSessionWebSocketTask.Message, Error>] = []
    private var receiveContinuations: [CheckedContinuation<URLSessionWebSocketTask.Message, Error>] = []
    private(set) var didResume = false
    private(set) var didCancel = false
    var sendShouldThrow: Error?

    func resume() {
        lock.withLock { didResume = true }
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let pending: [CheckedContinuation<URLSessionWebSocketTask.Message, Error>] = lock.withLock {
            didCancel = true
            let p = receiveContinuations
            receiveContinuations.removeAll()
            return p
        }
        for cont in pending {
            cont.resume(throwing: URLError(.cancelled))
        }
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        if let err = sendShouldThrow { throw err }
        let bytes: Data
        switch message {
        case .data(let d): bytes = d
        case .string(let s): bytes = Data(s.utf8)
        @unknown default: return
        }
        lock.withLock { sentFrames.append(bytes) }
    }

    func receiveMessage() async throws -> URLSessionWebSocketTask.Message {
        try await withCheckedThrowingContinuation { cont in
            let toResume: Result<URLSessionWebSocketTask.Message, Error>? = lock.withLock {
                if let next = pendingMessages.first {
                    pendingMessages.removeFirst()
                    return next
                } else {
                    receiveContinuations.append(cont)
                    return nil
                }
            }
            if let r = toResume {
                cont.resume(with: r)
            }
        }
    }

    // Test helpers

    var sentFrameCount: Int {
        lock.withLock { sentFrames.count }
    }

    func sentFrame(at index: Int) -> Data {
        lock.withLock { sentFrames[index] }
    }

    func allSentFrames() -> [Data] {
        lock.withLock { sentFrames }
    }

    func deliver(_ message: URLSessionWebSocketTask.Message) {
        let cont: CheckedContinuation<URLSessionWebSocketTask.Message, Error>? = lock.withLock {
            if let cont = receiveContinuations.first {
                receiveContinuations.removeFirst()
                return cont
            } else {
                pendingMessages.append(.success(message))
                return nil
            }
        }
        cont?.resume(returning: message)
    }

    func deliverError(_ error: Error) {
        let cont: CheckedContinuation<URLSessionWebSocketTask.Message, Error>? = lock.withLock {
            if let cont = receiveContinuations.first {
                receiveContinuations.removeFirst()
                return cont
            } else {
                pendingMessages.append(.failure(error))
                return nil
            }
        }
        cont?.resume(throwing: error)
    }
}

final class MockWebSocketFactory: FrickWebSocketFactory, @unchecked Sendable {
    private let lock = TaskLock()
    private var tasks: [MockWebSocketTask] = []
    private var pendingTasks: [MockWebSocketTask] = []
    private var requests: [URLRequest] = []

    func enqueue(_ task: MockWebSocketTask) {
        lock.withLock { pendingTasks.append(task) }
    }

    var producedTasks: [MockWebSocketTask] {
        lock.withLock { tasks }
    }

    var producedRequests: [URLRequest] {
        lock.withLock { requests }
    }

    func makeTask(url: URL) -> FrickWebSocketTaskProtocol {
        lock.withLock {
            let next: MockWebSocketTask
            if !pendingTasks.isEmpty {
                next = pendingTasks.removeFirst()
            } else {
                next = MockWebSocketTask()
            }
            tasks.append(next)
            return next
        }
    }

    func makeTask(request: URLRequest) -> FrickWebSocketTaskProtocol {
        lock.withLock {
            requests.append(request)
            let next: MockWebSocketTask
            if !pendingTasks.isEmpty {
                next = pendingTasks.removeFirst()
            } else {
                next = MockWebSocketTask()
            }
            tasks.append(next)
            return next
        }
    }
}

// MARK: - Tests

final class FrickSyncSocketTests: XCTestCase {

    // Helpers

    private func makeSocket(
        factory: MockWebSocketFactory,
        sleepFor: @escaping @Sendable (UInt64) async throws -> Void = { _ in },
        telemetry: any FrickClientTelemetryRuntime = FrickNoopClientTelemetryRuntime()
    ) -> FrickSyncSocket {
        FrickSyncSocket(
            baseURL: URL(string: "http://127.0.0.1:4099")!,
            sessionToken: "token-1",
            clientCapabilities: .defaultIOS(sdkVersion: "0.1.0-test"),
            replicaId: "test-replica",
            deviceId: "test-device",
            factory: factory,
            sleepFor: sleepFor,
            telemetry: telemetry
        )
    }

    private func helloAckFrame() -> Data {
        FrickMsgPackCodec.encodeFrame(FrickFrame(kind: .helloAck, payload: .map([
            (.string("schemaHash"), .string(FrickSchema.schemaHash)),
            (.string("schemaId"), .string(FrickSchema.schemaId)),
            (.string("schemaRevision"), .int(Int64(FrickSchema.schemaRevision))),
            (.string("schemaCompatibility"), .map([
                (.string("status"), .string("ok")),
                (.string("clientSchemaHash"), .string(FrickSchema.schemaHash)),
                (.string("serverSchemaHash"), .string(FrickSchema.schemaHash)),
            ])),
            (.string("serverCapabilities"), .map([
                (.string("schema"), .map([
                    (.string("schemaId"), .string(FrickSchema.schemaId)),
                    (.string("schemaRevision"), .int(Int64(FrickSchema.schemaRevision))),
                    (.string("schemaHash"), .string(FrickSchema.schemaHash)),
                ])),
                (.string("transports"), .array([.string("websocket"), .string("http")])),
                (.string("encodings"), .array([.string("msgpack"), .string("json")])),
                (.string("primitives"), .array([.string("objects"), .string("streams")])),
                (.string("blobUploads"), .array([.string("direct")])),
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

    // MARK: MsgPack codec round-trip

    func testMsgPackRoundTripsBasicValues() throws {
        let value: FrickMsgPackValue = .map([
            (.string("a"), .int(42)),
            (.string("b"), .string("hello")),
            (.string("c"), .array([.bool(true), .nilValue, .double(1.5)])),
            (.string("d"), .map([(.string("nested"), .int(-7))])),
        ])
        let encoded = FrickMsgPackCodec.encode(value)
        let decoded = try FrickMsgPackCodec.decode(encoded)
        XCTAssertEqual(decoded, value)
    }

    func testFrameRoundTripsThroughCodec() throws {
        let frame = FrickFrame(kind: .append, payload: .map([
            (.string("requestId"), .string("req-1")),
            (.string("stream"), .string("MessageStream")),
        ]))
        let encoded = FrickMsgPackCodec.encodeFrame(frame)
        let decoded = try FrickMsgPackCodec.decodeFrame(encoded)
        XCTAssertEqual(decoded.kind, .append)
        XCTAssertEqual(decoded.payload.mapValue?["requestId"]?.stringValue, "req-1")
    }

    // MARK: Hello handshake

    func testHelloFrameSentOnConnectWithClientCapabilities() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)

        await socket.connect()

        let ok = await waitForCondition { task.sentFrameCount >= 1 }
        XCTAssertTrue(ok, "Hello frame should be sent on connect")

        let frame = try FrickMsgPackCodec.decodeFrame(task.sentFrame(at: 0))
        XCTAssertEqual(frame.kind, .hello)
        let map = try XCTUnwrap(frame.payload.mapValue)
        XCTAssertEqual(map["replicaId"]?.stringValue, "test-replica")
        XCTAssertEqual(map["deviceId"]?.stringValue, "test-device")
        XCTAssertEqual(map["schemaHash"]?.stringValue, FrickSchema.schemaHash)
        XCTAssertEqual(map["sessionToken"]?.stringValue, "token-1")
        let caps = try XCTUnwrap(map["clientCapabilities"]?.mapValue)
        XCTAssertEqual(caps["platform"]?.stringValue, "ios")
        XCTAssertEqual(caps["sdkVersion"]?.stringValue, "0.1.0-test")

        await socket.close()
    }

    func testHelloFrameUsesCustomSchemaHashWhenOverridden() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let customHash = "my-app-schema-2.0.0"
        let socket = FrickSyncSocket(
            baseURL: URL(string: "http://127.0.0.1:4099")!,
            sessionToken: "token-1",
            clientCapabilities: .defaultIOS(sdkVersion: "0.1.0-test", schemaHash: customHash),
            replicaId: "test-replica",
            deviceId: "test-device",
            factory: factory,
            sleepFor: { _ in },
            schemaHash: customHash
        )

        await socket.connect()
        let ok = await waitForCondition { task.sentFrameCount >= 1 }
        XCTAssertTrue(ok, "Hello frame should be sent on connect")

        let frame = try FrickMsgPackCodec.decodeFrame(task.sentFrame(at: 0))
        XCTAssertEqual(frame.kind, .hello)
        let map = try XCTUnwrap(frame.payload.mapValue)
        XCTAssertEqual(map["schemaHash"]?.stringValue, customHash)
        XCTAssertNotEqual(map["schemaHash"]?.stringValue, FrickSchema.schemaHash)
        let caps = try XCTUnwrap(map["clientCapabilities"]?.mapValue)
        let capsSchema = try XCTUnwrap(caps["schema"]?.mapValue)
        XCTAssertEqual(capsSchema["schemaHash"]?.stringValue, customHash)

        await socket.close()
    }

    func testHelloAckUpdatesStatusWithServerCapabilities() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)

        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        task.deliver(.data(helloAckFrame()))

        let updated = await waitForCondition {
            let s = await socket.status
            return s.serverCapabilities != nil
        }
        XCTAssertTrue(updated)

        let status = await socket.status
        XCTAssertEqual(status.state, .connected)
        XCTAssertEqual(status.serverCapabilities?.schemaHash, FrickSchema.schemaHash)
        XCTAssertEqual(status.schemaCompatibility?.status, "ok")

        await socket.close()
    }

    // MARK: Send paths

    func testAppendQueuesWhenDisconnectedAndFlushesOnConnect() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)

        // Append before connect — should queue.
        try await socket.append(stream: "MessageStream", key: "c1", event: "MessageSent", payload: ["body": "hi"])
        let pendingBefore = await socket.pendingAppendCount
        XCTAssertEqual(pendingBefore, 1)

        await socket.connect()

        // Wait for Hello + flushed append.
        let ok = await waitForCondition { task.sentFrameCount >= 2 }
        XCTAssertTrue(ok)

        let pendingAfter = await socket.pendingAppendCount
        XCTAssertEqual(pendingAfter, 0)

        let secondFrame = try FrickMsgPackCodec.decodeFrame(task.sentFrame(at: 1))
        XCTAssertEqual(secondFrame.kind, .append)
        let map = try XCTUnwrap(secondFrame.payload.mapValue)
        XCTAssertEqual(map["stream"]?.stringValue, "MessageStream")
        XCTAssertEqual(map["event"]?.stringValue, "MessageSent")

        await socket.close()
    }

    func testConnectAddsAuthorizationHeaderWithoutSessionTokenQuery() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)

        await socket.connect()

        let ok = await waitForCondition { factory.producedRequests.count == 1 }
        XCTAssertTrue(ok)
        let request = try XCTUnwrap(factory.producedRequests.first)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-1")
        let queryToken = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?
            .queryItems?
            .first(where: { $0.name == "sessionToken" })?
            .value
        XCTAssertNil(queryToken)

        await socket.close()
    }

    func testSubscribeSendsSubscribeFrame() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)
        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }

        try await socket.subscribe(stream: "MessageStream", key: "c1")

        let ok = await waitForCondition { task.sentFrameCount >= 2 }
        XCTAssertTrue(ok)
        let frame = try FrickMsgPackCodec.decodeFrame(task.sentFrame(at: 1))
        XCTAssertEqual(frame.kind, .subscribe)
        let map = try XCTUnwrap(frame.payload.mapValue)
        XCTAssertEqual(map["kind"]?.stringValue, "stream")
        XCTAssertEqual(map["name"]?.stringValue, "MessageStream")

        await socket.close()
    }

    // FR-256 client half (FR-291): the opt-in `…Registered` subscribe methods
    // resolve only once the server's post-registration reply arrives.

    func testSubscribeObjectRegisteredResolvesOnSnapshot() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)
        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        task.deliver(.data(helloAckFrame()))
        _ = await waitForCondition { await socket.status.serverCapabilities != nil }

        let resolved = BoolBox()
        let subTask = Task {
            try await socket.subscribeObjectRegistered(type: "Account")
            resolved.set(true)
        }

        // The Subscribe frame is sent; capture its subscriptionId.
        let sent = await waitForCondition { task.sentFrameCount >= 2 }
        XCTAssertTrue(sent)
        let subFrame = try FrickMsgPackCodec.decodeFrame(task.sentFrame(at: 1))
        XCTAssertEqual(subFrame.kind, .subscribe)
        XCTAssertEqual(subFrame.payload.mapValue?["kind"]?.stringValue, "object")
        let subId = try XCTUnwrap(subFrame.payload.mapValue?["subscriptionId"]?.stringValue)

        // It must NOT resolve before the snapshot — that is the whole point.
        XCTAssertFalse(resolved.value, "resolved before the Snapshot")

        // Deliver the post-registration Snapshot for this subscription id.
        let snapshot = FrickMsgPackCodec.encodeFrame(FrickFrame(kind: .snapshot, payload: .map([
            (.string("subscriptionId"), .string(subId)),
            (.string("objects"), .array([])),
            (.string("cursor"), .int(0)),
        ])))
        task.deliver(.data(snapshot))

        // Now it resolves (bounded wait — a bug fails the test, never hangs it).
        let didResolve = await waitForCondition { resolved.value }
        XCTAssertTrue(didResolve, "did not resolve after its Snapshot")
        _ = try await subTask.value
        await socket.close()
    }

    func testSubscribeStreamRegisteredResolvesOnStreamPage() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)
        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        task.deliver(.data(helloAckFrame()))
        _ = await waitForCondition { await socket.status.serverCapabilities != nil }

        let resolved = BoolBox()
        let subTask = Task {
            try await socket.subscribeStreamRegistered(stream: "MessageStream", key: "c1")
            resolved.set(true)
        }
        _ = await waitForCondition { task.sentFrameCount >= 2 }
        let subFrame = try FrickMsgPackCodec.decodeFrame(task.sentFrame(at: 1))
        XCTAssertEqual(subFrame.payload.mapValue?["kind"]?.stringValue, "stream")
        let subId = try XCTUnwrap(subFrame.payload.mapValue?["subscriptionId"]?.stringValue)
        XCTAssertFalse(resolved.value, "resolved before the StreamPage")

        // The StreamPage is the post-registration reply for a stream subscribe.
        let streamPage = FrickMsgPackCodec.encodeFrame(FrickFrame(kind: .streamPage, payload: .map([
            (.string("subscriptionId"), .string(subId)),
            (.string("events"), .array([])),
            (.string("cursor"), .int(0)),
            (.string("hasMore"), .bool(false)),
        ])))
        task.deliver(.data(streamPage))

        let didResolve = await waitForCondition { resolved.value }
        XCTAssertTrue(didResolve, "did not resolve after its StreamPage")
        _ = try await subTask.value
        await socket.close()
    }

    func testSubscribeProjectionRegisteredResolvesOnProjectionDelta() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)
        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        task.deliver(.data(helloAckFrame()))
        _ = await waitForCondition { await socket.status.serverCapabilities != nil }

        let resolved = BoolBox()
        let subTask = Task {
            try await socket.subscribeProjectionRegistered(name: "Inbox")
            resolved.set(true)
        }
        _ = await waitForCondition { task.sentFrameCount >= 2 }
        XCTAssertFalse(resolved.value, "resolved before the ProjectionDelta")

        // Projections correlate by name (the frame carries the projection name).
        let delta = FrickMsgPackCodec.encodeFrame(FrickFrame(kind: .projectionDelta, payload: .map([
            (.string("projection"), .string("Inbox")),
            (.string("changes"), .array([])),
        ])))
        task.deliver(.data(delta))

        let didResolve = await waitForCondition { resolved.value }
        XCTAssertTrue(didResolve, "did not resolve after its ProjectionDelta")
        _ = try await subTask.value
        await socket.close()
    }

    func testSubscribeObjectRegisteredResolvesOnClose() async throws {
        // A closed socket must not strand the awaiter (it replays on reconnect).
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)
        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        task.deliver(.data(helloAckFrame()))
        _ = await waitForCondition { await socket.status.serverCapabilities != nil }

        let resolved = BoolBox()
        let subTask = Task {
            try? await socket.subscribeObjectRegistered(type: "Account")
            resolved.set(true)
        }
        _ = await waitForCondition { task.sentFrameCount >= 2 }
        XCTAssertFalse(resolved.value)

        await socket.close()

        let didResolve = await waitForCondition { resolved.value }
        XCTAssertTrue(didResolve, "close() must drain pending registration awaiters")
        _ = await subTask.value
    }

    func testObjectUpsertResolvesOnAck() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)
        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        task.deliver(.data(helloAckFrame()))
        _ = await waitForCondition {
            let s = await socket.status
            return s.state == .connected && s.serverCapabilities != nil
        }

        async let versionResult: Int = socket.upsertObject(type: "User", id: "u1", value: ["displayName": "Ada"], expectedVersion: 0)

        // Wait for upsert frame to land, then respond with Ack.
        _ = await waitForCondition { task.sentFrameCount >= 2 }
        let upsertFrame = try FrickMsgPackCodec.decodeFrame(task.sentFrame(at: 1))
        XCTAssertEqual(upsertFrame.kind, .objectUpsert)
        let requestId = try XCTUnwrap(upsertFrame.payload.mapValue?["requestId"]?.stringValue)

        let ackFrame = FrickMsgPackCodec.encodeFrame(FrickFrame(kind: .ack, payload: .map([
            (.string("requestId"), .string(requestId)),
            (.string("version"), .int(7)),
        ])))
        task.deliver(.data(ackFrame))

        let version = try await versionResult
        XCTAssertEqual(version, 7)

        await socket.close()
    }

    func testObjectUpsertWithStaleVersionThrowsServerError() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)
        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        task.deliver(.data(helloAckFrame()))
        _ = await waitForCondition {
            let s = await socket.status
            return s.serverCapabilities != nil
        }

        async let result: Int = socket.upsertObject(type: "User", id: "u1", value: ["displayName": "Ada"], expectedVersion: 0)

        _ = await waitForCondition { task.sentFrameCount >= 2 }
        let upsertFrame = try FrickMsgPackCodec.decodeFrame(task.sentFrame(at: 1))
        let requestId = try XCTUnwrap(upsertFrame.payload.mapValue?["requestId"]?.stringValue)

        let nackFrame = FrickMsgPackCodec.encodeFrame(FrickFrame(kind: .nack, payload: .map([
            (.string("requestId"), .string(requestId)),
            (.string("error"), .map([
                (.string("code"), .string("storage.conflict")),
                (.string("message"), .string("version mismatch")),
                (.string("requestId"), .string(requestId)),
                (.string("retryable"), .bool(false)),
            ])),
        ])))
        task.deliver(.data(nackFrame))

        do {
            _ = try await result
            XCTFail("Expected nack to throw")
        } catch let error as FrickServerError {
            XCTAssertEqual(error.code, .storageConflict)
        }

        await socket.close()
    }

    // MARK: Pre-connect buffering

    /// Regression test for the RangerCRM cold-start race: callers that issue
    /// `subscribeObject` immediately after `FrickClient.connectSync()`
    /// (which schedules `openSocket()` on a detached Task) used to throw
    /// `FrickSyncSocketError.notConnected` if the WS upgrade hadn't completed
    /// yet. The fix routes pre-connect frames through the same `pending`
    /// buffer that append uses, so they flush in FIFO order after Hello.
    func testSubscribeObjectBeforeConnectIsBufferedAndFlushed() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)

        // Issue the subscribe BEFORE connect — must not throw `notConnected`.
        try await socket.subscribeObject(type: "Account")
        let pendingBefore = await socket.pendingAppendCount
        XCTAssertEqual(pendingBefore, 1, "subscribe issued pre-connect should buffer")

        await socket.connect()

        // Wait for Hello + flushed subscribe.
        let ok = await waitForCondition { task.sentFrameCount >= 2 }
        XCTAssertTrue(ok, "buffered subscribe should flush after hello (sent \(task.sentFrameCount))")

        let helloFrame = try FrickMsgPackCodec.decodeFrame(task.sentFrame(at: 0))
        XCTAssertEqual(helloFrame.kind, .hello)
        let subFrame = try FrickMsgPackCodec.decodeFrame(task.sentFrame(at: 1))
        XCTAssertEqual(subFrame.kind, .subscribe)
        let subMap = try XCTUnwrap(subFrame.payload.mapValue)
        XCTAssertEqual(subMap["kind"]?.stringValue, "object")
        XCTAssertEqual(subMap["name"]?.stringValue, "Account")

        let pendingAfter = await socket.pendingAppendCount
        XCTAssertEqual(pendingAfter, 0)

        await socket.close()
    }

    // MARK: Inbound delta handling

    func testDeltaFrameIsSurfacedAsInboundEvent() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)

        let events = await socket.events
        let receivedDelta = expectation(description: "delta surfaced")

        let listener = Task {
            for try await event in events {
                if case .delta(_, let evs, let cursor) = event {
                    if cursor == 5, evs.count == 1, evs.first?.event == "MessageSent" {
                        receivedDelta.fulfill()
                        return
                    }
                }
            }
        }

        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        task.deliver(.data(helloAckFrame()))

        let delta = FrickMsgPackCodec.encodeFrame(FrickFrame(kind: .delta, payload: .map([
            (.string("cursor"), .int(5)),
            (.string("objects"), .array([])),
            (.string("events"), .array([
                .map([
                    (.string("stream"), .string("MessageStream")),
                    (.string("streamId"), .string("c1")),
                    (.string("sequence"), .int(5)),
                    (.string("eventId"), .string("evt-1")),
                    (.string("event"), .string("MessageSent")),
                    (.string("payload"), .map([(.string("body"), .string("hi"))])),
                ]),
            ])),
        ])))
        task.deliver(.data(delta))

        await fulfillment(of: [receivedDelta], timeout: 2)
        listener.cancel()
        await socket.close()
    }

    func testDeltaRemovedSurfacesObjectsRemovedEvent() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)

        let events = await socket.events
        let receivedRemoval = expectation(description: "objectsRemoved surfaced")

        let listener = Task {
            for try await event in events {
                if case .objectsRemoved(let removed, let cursor) = event {
                    if cursor == 9, removed.count == 1,
                       removed.first?.type == "Message", removed.first?.id == "msg-1" {
                        receivedRemoval.fulfill()
                        return
                    }
                }
            }
        }

        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        task.deliver(.data(helloAckFrame()))

        let delta = FrickMsgPackCodec.encodeFrame(FrickFrame(kind: .delta, payload: .map([
            (.string("cursor"), .int(9)),
            (.string("objects"), .array([])),
            (.string("events"), .array([])),
            (.string("removed"), .array([
                .map([
                    (.string("type"), .string("Message")),
                    (.string("id"), .string("msg-1")),
                ]),
            ])),
        ])))
        task.deliver(.data(delta))

        await fulfillment(of: [receivedRemoval], timeout: 2)
        listener.cancel()
        await socket.close()
    }

    func testProjectionDeltaIsSurfaced() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)

        let receivedProjection = expectation(description: "projection delta surfaced")
        let events = await socket.events
        let listener = Task {
            for try await event in events {
                if case .projectionDelta(let projection, let changes) = event, projection == "inbox",
                   changes.count == 1, changes[0].key == "row1" {
                    receivedProjection.fulfill()
                    return
                }
            }
        }

        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        task.deliver(.data(helloAckFrame()))

        let frame = FrickMsgPackCodec.encodeFrame(FrickFrame(kind: .projectionDelta, payload: .map([
            (.string("projection"), .string("inbox")),
            (.string("changes"), .array([
                .map([
                    (.string("key"), .string("row1")),
                    (.string("value"), .map([(.string("count"), .int(3))])),
                ]),
            ])),
        ])))
        task.deliver(.data(frame))

        await fulfillment(of: [receivedProjection], timeout: 2)
        listener.cancel()
        await socket.close()
    }

    // MARK: Reconnect

    func testReconnectsAfterUnexpectedClose() async throws {
        let factory = MockWebSocketFactory()
        let firstTask = MockWebSocketTask()
        let secondTask = MockWebSocketTask()
        factory.enqueue(firstTask)
        factory.enqueue(secondTask)

        let socket = makeSocket(factory: factory) { _ in /* no-op sleep */ }

        await socket.connect()
        _ = await waitForCondition { firstTask.sentFrameCount >= 1 }

        // Simulate server-side close on the first task.
        firstTask.deliverError(URLError(.networkConnectionLost))

        // The socket should reconnect — second task should receive a Hello frame.
        let reconnected = await waitForCondition { secondTask.sentFrameCount >= 1 }
        XCTAssertTrue(reconnected, "Socket should open a second task and send Hello on it")

        let helloFrame = try FrickMsgPackCodec.decodeFrame(secondTask.sentFrame(at: 0))
        XCTAssertEqual(helloFrame.kind, .hello)

        await socket.close()
    }

    func testPendingAppendsFlushOnReconnect() async throws {
        let factory = MockWebSocketFactory()
        let firstTask = MockWebSocketTask()
        let secondTask = MockWebSocketTask()
        factory.enqueue(firstTask)
        factory.enqueue(secondTask)

        // Use a small but real sleep so we can race an append into the
        // disconnected window before the reconnect Task fires.
        let socket = makeSocket(factory: factory) { ns in
            try await Task.sleep(nanoseconds: min(ns, 50_000_000))
        }

        // Queue an append before connecting.
        try await socket.append(stream: "MessageStream", key: "c1", event: "MessageSent", payload: ["body": "queued"])

        await socket.connect()
        _ = await waitForCondition { firstTask.sentFrameCount >= 2 } // Hello + flushed append
        XCTAssertEqual(firstTask.sentFrameCount, 2, "first task should receive Hello + queued append")

        // Drop connection.
        firstTask.deliverError(URLError(.networkConnectionLost))

        // Wait for the socket to observe disconnection before issuing the
        // next append — otherwise we race the receive-loop handler.
        _ = await waitForCondition {
            let s = await socket.status
            return s.state != .connected
        }

        // Queue another append while reconnecting (state != .connected → queued).
        try await socket.append(stream: "MessageStream", key: "c1", event: "MessageSent", payload: ["body": "during"])

        let reconnected = await waitForCondition {
            secondTask.sentFrameCount >= 2
        }
        XCTAssertTrue(reconnected, "Second task should receive Hello + the reconnect-window append (sent \(secondTask.sentFrameCount))")

        // Verify the second frame on the new task is the append, not the Hello.
        let frames = secondTask.allSentFrames()
        let kinds = frames.compactMap { try? FrickMsgPackCodec.decodeFrame($0).kind }
        XCTAssertEqual(kinds.first, .hello)
        XCTAssertTrue(kinds.contains(.append), "Append should have been flushed/sent on the reconnected task")

        await socket.close()
    }

    /// Regression test for RCRM-149: subscriptions must be replayed after a
    /// reconnect. The server scopes subscriptions per-connection, so a
    /// reconnected socket that doesn't re-send its subscribe frames looks
    /// healthy but silently stops receiving deltas — the exact cause of the
    /// observed unreliable cross-device sync. The initial subscribe frame is
    /// consumed once (via `pending`) and is NOT re-sent on later reconnects
    /// without `activeSubscriptions` replay. Pre-fix, the second task received
    /// only a Hello; post-fix it also receives the object subscribe.
    func testSubscriptionsReplayedOnReconnect() async throws {
        let factory = MockWebSocketFactory()
        let firstTask = MockWebSocketTask()
        let secondTask = MockWebSocketTask()
        factory.enqueue(firstTask)
        factory.enqueue(secondTask)

        let socket = makeSocket(factory: factory) { _ in /* no-op sleep */ }

        await socket.connect()
        _ = await waitForCondition { firstTask.sentFrameCount >= 1 } // Hello

        // Subscribe on the live connection (Hello already sent → state connected).
        try await socket.subscribeObject(type: "Account")
        _ = await waitForCondition { firstTask.sentFrameCount >= 2 } // Hello + subscribe

        // Drop the connection — the socket should reconnect on `secondTask`.
        firstTask.deliverError(URLError(.networkConnectionLost))

        // The reconnected task must receive BOTH a Hello and a replayed
        // object subscribe for "Account".
        let replayed = await waitForCondition {
            let kinds = secondTask.allSentFrames()
                .compactMap { try? FrickMsgPackCodec.decodeFrame($0).kind }
            return kinds.contains(.hello) && kinds.contains(.subscribe)
        }
        XCTAssertTrue(replayed, "Reconnected task should receive Hello + replayed subscribe (sent \(secondTask.sentFrameCount))")

        let subFrame = secondTask.allSentFrames()
            .compactMap { try? FrickMsgPackCodec.decodeFrame($0) }
            .first { $0.kind == .subscribe }
        let subMap = try XCTUnwrap(subFrame?.payload.mapValue)
        XCTAssertEqual(subMap["kind"]?.stringValue, "object")
        XCTAssertEqual(subMap["name"]?.stringValue, "Account")

        await socket.close()
    }

    /// Regression: the reconnect backoff must not overflow when the server is
    /// unreachable for many attempts. Previously `Int(pow(2, reconnectAttempt))`
    /// trapped (arithmetic overflow) once the attempt count climbed, crashing
    /// the whole app any time the backend stayed down. Drive far past the old
    /// overflow threshold; a trap would crash this test process.
    func testReconnectBackoffSurvivesManyUnreachableAttempts() async throws {
        let factory = MockWebSocketFactory()
        let socket = makeSocket(factory: factory) { _ in /* no-op sleep */ }

        await socket.connect()

        for i in 1...80 {
            _ = await waitForCondition { factory.producedTasks.count >= i }
            if let task = factory.producedTasks.last {
                _ = await waitForCondition { task.sentFrameCount >= 1 }
                task.deliverError(URLError(.networkConnectionLost))
            }
        }

        let reached = await waitForCondition { factory.producedTasks.count >= 80 }
        XCTAssertTrue(reached, "socket should keep reconnecting without overflow (got \(factory.producedTasks.count) tasks)")

        await socket.close()
    }

    /// RCRM-154: an INJECTED schema descriptor must let the socket decode
    /// packed object Delta frames into named records. With the default empty
    /// foundation descriptor the type id never resolves and the record is
    /// dropped; with the app's descriptor it decodes. This is the mechanism
    /// the realtime-sync fix depends on.
    func testInjectedDescriptorDecodesObjectDelta() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)

        let descriptor = FrickSchemaDescriptorValues(
            objectNames: [7: "Account"],
            objectFields: [7: [1: "name"]],
            streamNames: [:],
            eventNames: [:],
            eventFields: [:]
        )
        let socket = FrickSyncSocket(
            baseURL: URL(string: "http://127.0.0.1:4099")!,
            sessionToken: "token-1",
            clientCapabilities: .defaultIOS(sdkVersion: "0.1.0-test"),
            replicaId: "test-replica",
            deviceId: "test-device",
            factory: factory,
            sleepFor: { _ in },
            descriptor: descriptor
        )

        let received = expectation(description: "object delta decoded with injected descriptor")
        let events = await socket.events
        let listener = Task {
            for try await event in events {
                if case .objectsDelta(let records, _) = event,
                   let first = records.first, first.type == "Account", first.id == "acc-1" {
                    received.fulfill()
                    return
                }
            }
        }

        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        task.deliver(.data(helloAckFrame()))

        // Packed object record tuple: [typeId, recordId, [[fieldId, value]]].
        let delta = FrickMsgPackCodec.encodeFrame(FrickFrame(kind: .delta, payload: .map([
            (.string("cursor"), .int(1)),
            (.string("objects"), .array([
                .array([.int(7), .string("acc-1"), .array([
                    .array([.int(1), .string("Acme")]),
                ])]),
            ])),
            (.string("events"), .array([])),
        ])))
        task.deliver(.data(delta))

        await fulfillment(of: [received], timeout: 2)
        listener.cancel()
        await socket.close()
    }

    /// FR-144 parity: a Delta carrying a `removed` list surfaces as
    /// `.objectsRemoved`, with packed `[typeId, id]` tuples resolved through
    /// the injected descriptor. Caches consume this to drop deleted rows.
    func testDeltaRemovedSurfacesObjectsRemoved() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)

        let descriptor = FrickSchemaDescriptorValues(
            objectNames: [7: "Account"],
            objectFields: [7: [1: "name"]],
            streamNames: [:],
            eventNames: [:],
            eventFields: [:]
        )
        let socket = FrickSyncSocket(
            baseURL: URL(string: "http://127.0.0.1:4099")!,
            sessionToken: "token-1",
            factory: factory,
            sleepFor: { _ in },
            descriptor: descriptor
        )

        let received = expectation(description: "objectsRemoved decoded")
        let events = await socket.events
        let listener = Task {
            for try await event in events {
                if case .objectsRemoved(let removals, _) = event,
                   let first = removals.first, first.type == "Account", first.id == "acc-1" {
                    received.fulfill()
                    return
                }
            }
        }

        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        task.deliver(.data(helloAckFrame()))

        // Delta with a `removed` list — packed [typeId, id] tuple form.
        let delta = FrickMsgPackCodec.encodeFrame(FrickFrame(kind: .delta, payload: .map([
            (.string("cursor"), .int(2)),
            (.string("objects"), .array([])),
            (.string("removed"), .array([
                .array([.int(7), .string("acc-1")]),
            ])),
            (.string("events"), .array([])),
        ])))
        task.deliver(.data(delta))

        await fulfillment(of: [received], timeout: 2)
        listener.cancel()
        await socket.close()
    }

    // MARK: Telemetry (FR-74)

    func testTelemetryStartsConnectionSpanWithMirroredAttributes() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let telemetry = SyncRecordingTelemetry()
        let socket = makeSocket(factory: factory, telemetry: telemetry)

        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        _ = await waitForCondition { await telemetry.startedSpanCount() >= 1 }

        let startedSpans = await telemetry.startedSpans()
        let started = try XCTUnwrap(startedSpans.first)
        XCTAssertEqual(started.name, "WebSocket /_frick/sync")
        XCTAssertEqual(started.kind, .client)
        XCTAssertEqual(started.attributes["network.protocol.name"], .string("websocket"))
        XCTAssertEqual(started.attributes["url.path"], .string("/_frick/sync"))
        XCTAssertEqual(started.attributes["frick.schema_id"], .string(FrickSchema.schemaId))
        XCTAssertEqual(started.attributes["frick.schema_revision"], .int(FrickSchema.schemaRevision))
        XCTAssertEqual(started.attributes["frick.authenticated"], .bool(true))

        await socket.close()
    }

    func testTelemetryRecordsSentAndReceivedFrameCounters() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let telemetry = SyncRecordingTelemetry()
        let socket = makeSocket(factory: factory, telemetry: telemetry)

        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        // Hello sent → counter for the Hello frame.
        _ = await waitForCondition {
            await telemetry.counters().contains {
                $0.name == "frick.client.ws.frames.sent.total"
                    && $0.attributes["kind"] == .string("Hello")
            }
        }
        let sentCounters = await telemetry.counters()
        let sentHello = try XCTUnwrap(sentCounters.first {
            $0.name == "frick.client.ws.frames.sent.total"
        })
        XCTAssertEqual(sentHello.value, 1)
        XCTAssertEqual(sentHello.attributes["kind"], .string("Hello"))

        // Deliver a HelloAck → received counter labeled HelloAck.
        task.deliver(.data(helloAckFrame()))
        let gotReceived = await waitForCondition {
            await telemetry.counters().contains {
                $0.name == "frick.client.ws.frames.received.total"
                    && $0.attributes["kind"] == .string("HelloAck")
            }
        }
        XCTAssertTrue(gotReceived, "received counter should label the HelloAck frame kind")

        await socket.close()
    }

    func testTelemetryFinishesSpanOkAndRecordsDurationOnNormalClose() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let telemetry = SyncRecordingTelemetry()
        let socket = makeSocket(factory: factory, telemetry: telemetry)

        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        await socket.close()

        _ = await waitForCondition { await telemetry.finishedSpanCount() >= 1 }
        let finishedSpans = await telemetry.finishedSpans()
        let finished = try XCTUnwrap(finishedSpans.first)
        XCTAssertEqual(finished.status, .ok)
        XCTAssertEqual(finished.attributes["frick.ws.close_category"], .string("normal"))
        XCTAssertEqual(finished.attributes["frick.ws.close_code"], .int(1000))

        let histograms = await telemetry.histograms()
        let histogram = try XCTUnwrap(histograms.first {
            $0.name == "frick.client.ws.connection.duration_ms"
        })
        XCTAssertEqual(histogram.attributes["closeCategory"], .string("normal"))
        XCTAssertGreaterThanOrEqual(histogram.value, 0)
    }

    func testTelemetryFinishesSpanErrorWithAbnormalCategoryOnDisconnect() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let telemetry = SyncRecordingTelemetry()
        // sleepFor no-op keeps reconnect from delaying; we only assert on the
        // first connection's span being finished with the abnormal category.
        let socket = makeSocket(factory: factory, telemetry: telemetry)

        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        // Force the receive loop to fail → handleDisconnect path.
        task.deliverError(URLError(.networkConnectionLost))

        _ = await waitForCondition { await telemetry.finishedSpanCount() >= 1 }
        let finishedSpans = await telemetry.finishedSpans()
        let finished = try XCTUnwrap(finishedSpans.first)
        XCTAssertEqual(finished.status, .error)
        XCTAssertEqual(finished.attributes["frick.ws.close_category"], .string("abnormal"))
        XCTAssertEqual(finished.attributes["frick.ws.close_code"], .int(1006))

        await socket.close()
    }

    func testWebSocketCloseCategoryMirrorsTS() {
        XCTAssertEqual(frickWebSocketCloseCategory(1000), "normal")
        XCTAssertEqual(frickWebSocketCloseCategory(1001), "going_away")
        XCTAssertEqual(frickWebSocketCloseCategory(1006), "abnormal")
        XCTAssertEqual(frickWebSocketCloseCategory(1011), "internal_error")
        XCTAssertEqual(frickWebSocketCloseCategory(4123), "private")
        XCTAssertEqual(frickWebSocketCloseCategory(9999), "unknown")
        XCTAssertEqual(frickWebSocketCloseCategory(nil), "unknown")
    }

    // MARK: native-swift-1 — events stream must broadcast to every consumer

    /// Two independent `events` iterators on one socket must BOTH receive every
    /// inbound delta. Pre-fix `events` returned the same single-consumer stream,
    /// so each delta reached only one iterator (round-robin) — a delta for one
    /// store was silently swallowed by another store's iterator. The fix fans a
    /// single internal consumer out to per-subscriber child streams.
    func testEventsBroadcastsToMultipleConsumers() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)

        let firstGotBoth = expectation(description: "first consumer sees both deltas")
        let secondGotBoth = expectation(description: "second consumer sees both deltas")

        let firstStream = await socket.events
        let secondStream = await socket.events

        func collectTwoDeltaCursors(_ stream: AsyncThrowingStream<FrickInboundEvent, Error>, _ done: XCTestExpectation) -> Task<Void, Never> {
            Task {
                var seen: Set<Int> = []
                do {
                    for try await event in stream {
                        if case .delta(_, _, let cursor) = event {
                            seen.insert(cursor)
                            if seen.contains(101) && seen.contains(102) {
                                done.fulfill()
                                return
                            }
                        }
                    }
                } catch { /* finished */ }
            }
        }

        let l1 = collectTwoDeltaCursors(firstStream, firstGotBoth)
        let l2 = collectTwoDeltaCursors(secondStream, secondGotBoth)

        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        task.deliver(.data(helloAckFrame()))

        for cursor in [101, 102] {
            let delta = FrickMsgPackCodec.encodeFrame(FrickFrame(kind: .delta, payload: .map([
                (.string("cursor"), .int(Int64(cursor))),
                (.string("objects"), .array([])),
                (.string("events"), .array([
                    .map([
                        (.string("stream"), .string("S")),
                        (.string("streamId"), .string("k")),
                        (.string("sequence"), .int(Int64(cursor))),
                        (.string("eventId"), .string("e-\(cursor)")),
                        (.string("event"), .string("E")),
                        (.string("payload"), .map([])),
                    ]),
                ])),
            ])))
            task.deliver(.data(delta))
        }

        await fulfillment(of: [firstGotBoth, secondGotBoth], timeout: 2)
        l1.cancel(); l2.cancel()
        await socket.close()
    }

    /// A consumer registered before `connect()` must still receive deltas
    /// delivered after connect — the broadcast registry persists across the
    /// connection lifecycle (it isn't tied to a single connection's stream).
    func testEventsConsumerRegisteredBeforeConnectStillReceives() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)

        let got = expectation(description: "pre-connect consumer receives delta")
        let stream = await socket.events
        let listener = Task {
            for try await event in stream {
                if case .delta(_, _, let cursor) = event, cursor == 7 {
                    got.fulfill(); return
                }
            }
        }

        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        task.deliver(.data(helloAckFrame()))

        let delta = FrickMsgPackCodec.encodeFrame(FrickFrame(kind: .delta, payload: .map([
            (.string("cursor"), .int(7)),
            (.string("objects"), .array([])),
            (.string("events"), .array([
                .map([
                    (.string("stream"), .string("S")), (.string("streamId"), .string("k")),
                    (.string("sequence"), .int(7)), (.string("eventId"), .string("e7")),
                    (.string("event"), .string("E")), (.string("payload"), .map([])),
                ]),
            ])),
        ])))
        task.deliver(.data(delta))

        await fulfillment(of: [got], timeout: 2)
        listener.cancel()
        await socket.close()
    }

    /// `close()` must finish every subscriber stream so each `for try await`
    /// loop terminates (no leaked iterators hanging on a dead socket).
    func testCloseFinishesAllEventSubscribers() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)

        let firstFinished = expectation(description: "first subscriber finished")
        let secondFinished = expectation(description: "second subscriber finished")
        let s1 = await socket.events
        let s2 = await socket.events
        let l1 = Task { for try await _ in s1 {}; firstFinished.fulfill() }
        let l2 = Task { for try await _ in s2 {}; secondFinished.fulfill() }

        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        await socket.close()

        await fulfillment(of: [firstFinished, secondFinished], timeout: 2)
        l1.cancel(); l2.cancel()
    }

    // MARK: native-swift-2 — in-flight continuation must not hang on drop

    /// An `upsertObject` awaited across a mid-flight socket drop must resume
    /// (throwing `connectionDropped`) instead of hanging forever. Pre-fix
    /// `handleDisconnect` tore down the task without draining `pendingResponders`,
    /// so the continuation leaked until `close()`.
    func testUpsertObjectInFlightFailsOnDisconnect() async throws {
        let factory = MockWebSocketFactory()
        let firstTask = MockWebSocketTask()
        let secondTask = MockWebSocketTask()
        factory.enqueue(firstTask)
        factory.enqueue(secondTask)
        let socket = makeSocket(factory: factory) { _ in /* no-op sleep */ }

        await socket.connect()
        _ = await waitForCondition { firstTask.sentFrameCount >= 1 }
        firstTask.deliver(.data(helloAckFrame()))
        _ = await waitForCondition {
            let s = await socket.status
            return s.state == .connected && s.serverCapabilities != nil
        }

        async let upsert: Int = socket.upsertObject(type: "User", id: "u1", value: ["displayName": "Ada"])
        // Wait for the upsert frame to be sent, then drop the socket before any Ack.
        _ = await waitForCondition { firstTask.sentFrameCount >= 2 }
        firstTask.deliverError(URLError(.networkConnectionLost))

        do {
            _ = try await upsert
            XCTFail("upsert should not resolve after a mid-flight disconnect")
        } catch let error as FrickSyncSocketError {
            XCTAssertEqual(error, .connectionDropped)
        }

        await socket.close()
    }

    /// Same guarantee for `callCommand` — a `join`/`leave`/`setMediaState`
    /// awaited across a drop must throw, not leave the call UI spinner hung.
    func testCallCommandInFlightFailsOnDisconnect() async throws {
        let factory = MockWebSocketFactory()
        let firstTask = MockWebSocketTask()
        let secondTask = MockWebSocketTask()
        factory.enqueue(firstTask)
        factory.enqueue(secondTask)
        let socket = makeSocket(factory: factory) { _ in /* no-op sleep */ }

        await socket.connect()
        _ = await waitForCondition { firstTask.sentFrameCount >= 1 }
        firstTask.deliver(.data(helloAckFrame()))
        _ = await waitForCondition {
            let s = await socket.status
            return s.state == .connected && s.serverCapabilities != nil
        }

        async let result: FrickCallCommandResult = socket.callCommand(.join(callId: "call-1"))
        _ = await waitForCondition { firstTask.sentFrameCount >= 2 }
        firstTask.deliverError(URLError(.networkConnectionLost))

        do {
            _ = try await result
            XCTFail("callCommand should not resolve after a mid-flight disconnect")
        } catch let error as FrickSyncSocketError {
            XCTAssertEqual(error, .connectionDropped)
        }

        await socket.close()
    }

    // MARK: native-swift-6 — join media token not broadcast over events

    /// `handleCallCommandResult` must deliver the full result (incl.
    /// `mediaGrant.token`) ONLY to the awaiting caller; the copy broadcast on
    /// the shared `events` stream must have `mediaGrant` stripped, so an events
    /// observer (e.g. a logger) can't capture the participant media credential.
    func testJoinMediaGrantNotBroadcastOnEventsStream() async throws {
        let factory = MockWebSocketFactory()
        let task = MockWebSocketTask()
        factory.enqueue(task)
        let socket = makeSocket(factory: factory)

        await socket.connect()
        _ = await waitForCondition { task.sentFrameCount >= 1 }
        task.deliver(.data(helloAckFrame()))
        _ = await waitForCondition {
            let s = await socket.status
            return s.state == .connected && s.serverCapabilities != nil
        }

        let observed = expectation(description: "events observer sees callCommandResult")
        let events = await socket.events
        let observer = Task { () -> FrickCallCommandResult? in
            do {
                for try await event in events {
                    if case .callCommandResult(let result) = event {
                        observed.fulfill()
                        return result
                    }
                }
            } catch { /* stream finished */ }
            return nil
        }

        async let joinResult: FrickCallCommandResult = socket.callCommand(.join(callId: "call-1"))
        _ = await waitForCondition { task.sentFrameCount >= 2 }
        let joinFrame = try FrickMsgPackCodec.decodeFrame(task.sentFrame(at: 1))
        let requestId = try XCTUnwrap(joinFrame.payload.mapValue?["requestId"]?.stringValue)

        // Reply with a CallCommandResult carrying a media grant + token.
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
                (.string("userId"), .string("u1")),
                (.string("deviceId"), .string("d-1")),
                (.string("joinedAt"), .string("t1")),
            ])),
            (.string("mediaGrant"), .map([
                (.string("callId"), .string("call-1")),
                (.string("mediaSessionId"), .string("ms-1")),
                (.string("userId"), .string("u1")),
                (.string("deviceId"), .string("d-1")),
                (.string("token"), .string("SUPER-SECRET-MEDIA-TOKEN")),
                (.string("expiresAt"), .string("t2")),
            ])),
        ])))
        task.deliver(.data(resultFrame))

        // The caller gets the grant + token.
        let caller = try await joinResult
        XCTAssertEqual(caller.mediaGrant?.token, "SUPER-SECRET-MEDIA-TOKEN")

        // The broadcast observer gets the result but WITHOUT the media grant.
        await fulfillment(of: [observed], timeout: 2)
        let broadcast = await observer.value
        XCTAssertEqual(broadcast?.op, "join")
        XCTAssertNil(broadcast?.mediaGrant, "media grant/token must not ride the broadcast events stream")

        observer.cancel()
        await socket.close()
    }

    // MARK: native-swift-7 — flushPending uses stored kind (no re-decode)

    /// After a reconnect, the flushed queued append must still be sent AND its
    /// telemetry counter labeled with the correct frame kind — now sourced from
    /// the kind captured at enqueue time rather than a hot-path re-decode.
    func testFlushedAppendRecordsCorrectKindAfterReconnect() async throws {
        let factory = MockWebSocketFactory()
        let firstTask = MockWebSocketTask()
        let secondTask = MockWebSocketTask()
        factory.enqueue(firstTask)
        factory.enqueue(secondTask)
        let telemetry = FlushRecordingTelemetry()
        let socket = makeSocket(factory: factory, sleepFor: { _ in /* no-op */ }, telemetry: telemetry)

        // Queue an append before connecting (lands in `pending` with its kind).
        try await socket.append(stream: "MessageStream", key: "c1", event: "MessageSent", payload: ["body": "queued"])

        await socket.connect()
        // Hello + flushed append on the first task.
        _ = await waitForCondition { firstTask.sentFrameCount >= 2 }

        // The flushed append must be sent as an Append frame.
        let kinds = firstTask.allSentFrames().compactMap { try? FrickMsgPackCodec.decodeFrame($0).kind }
        XCTAssertTrue(kinds.contains(.append), "queued append should flush on connect")

        // Telemetry must have labeled a sent Append frame via the stored kind.
        let labeled = await waitForCondition {
            await telemetry.sentKinds().contains("Append")
        }
        XCTAssertTrue(labeled, "flush should record the Append kind without re-decoding")

        await socket.close()
    }

}

// MARK: - Flush telemetry spy (native-swift-7)

private actor FlushRecordingStore {
    private(set) var sentKinds: [String] = []
    func append(_ kind: String) { sentKinds.append(kind) }
}

private final class FlushRecordingTelemetry: FrickClientTelemetryRuntime, @unchecked Sendable {
    private let store = FlushRecordingStore()

    func startSpan(_ input: FrickClientTelemetrySpanStart) throws -> any FrickClientTelemetrySpan {
        FlushNoopSpan()
    }

    func recordCounter(name: String, value: Double, attributes: FrickClientTelemetryAttributes) throws {
        guard name == "frick.client.ws.frames.sent.total" else { return }
        if case .string(let kind)? = attributes["kind"] {
            let store = self.store
            Task { await store.append(kind) }
        }
    }

    func recordHistogram(name: String, value: Double, attributes: FrickClientTelemetryAttributes) throws {}

    func sentKinds() async -> [String] { await store.sentKinds }
}

private final class FlushNoopSpan: FrickClientTelemetrySpan, @unchecked Sendable {
    func end(_ result: FrickClientTelemetrySpanResult?) throws {}
}

// MARK: - Telemetry spy

/// Recording telemetry runtime local to the sync-socket tests. Captures
/// started/finished spans and counter/histogram measurements so assertions
/// can verify the WS sync telemetry contract (FR-74).
private actor SyncRecordingTelemetryStore {
    struct Measurement {
        let name: String
        let value: Double
        let attributes: FrickClientTelemetryAttributes
    }

    private(set) var startedSpans: [FrickClientTelemetrySpanStart] = []
    private(set) var finishedSpans: [FrickClientTelemetrySpanResult] = []
    private(set) var counters: [Measurement] = []
    private(set) var histograms: [Measurement] = []

    func appendStarted(_ input: FrickClientTelemetrySpanStart) { startedSpans.append(input) }
    func appendFinished(_ result: FrickClientTelemetrySpanResult) { finishedSpans.append(result) }
    func appendCounter(_ m: Measurement) { counters.append(m) }
    func appendHistogram(_ m: Measurement) { histograms.append(m) }
}

private final class SyncRecordingTelemetry: FrickClientTelemetryRuntime, @unchecked Sendable {
    typealias Measurement = SyncRecordingTelemetryStore.Measurement
    private let store = SyncRecordingTelemetryStore()

    func startSpan(_ input: FrickClientTelemetrySpanStart) throws -> any FrickClientTelemetrySpan {
        let store = self.store
        Task { await store.appendStarted(input) }
        return SyncRecordingSpan { result in
            Task { await store.appendFinished(result ?? FrickClientTelemetrySpanResult()) }
        }
    }

    func recordCounter(name: String, value: Double, attributes: FrickClientTelemetryAttributes) throws {
        let store = self.store
        Task { await store.appendCounter(Measurement(name: name, value: value, attributes: attributes)) }
    }

    func recordHistogram(name: String, value: Double, attributes: FrickClientTelemetryAttributes) throws {
        let store = self.store
        Task { await store.appendHistogram(Measurement(name: name, value: value, attributes: attributes)) }
    }

    func startedSpans() async -> [FrickClientTelemetrySpanStart] { await store.startedSpans }
    func finishedSpans() async -> [FrickClientTelemetrySpanResult] { await store.finishedSpans }
    func counters() async -> [Measurement] { await store.counters }
    func histograms() async -> [Measurement] { await store.histograms }
    func startedSpanCount() async -> Int { await store.startedSpans.count }
    func finishedSpanCount() async -> Int { await store.finishedSpans.count }
}

private final class SyncRecordingSpan: FrickClientTelemetrySpan, @unchecked Sendable {
    private let onEnd: @Sendable (FrickClientTelemetrySpanResult?) -> Void

    init(onEnd: @escaping @Sendable (FrickClientTelemetrySpanResult?) -> Void) {
        self.onEnd = onEnd
    }

    func end(_ result: FrickClientTelemetrySpanResult?) throws {
        onEnd(result)
    }
}
