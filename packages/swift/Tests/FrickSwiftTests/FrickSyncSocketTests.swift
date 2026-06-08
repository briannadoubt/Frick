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

    private func makeSocket(factory: MockWebSocketFactory, sleepFor: @escaping @Sendable (UInt64) async throws -> Void = { _ in }) -> FrickSyncSocket {
        FrickSyncSocket(
            baseURL: URL(string: "http://127.0.0.1:4099")!,
            sessionToken: "token-1",
            clientCapabilities: .defaultIOS(sdkVersion: "0.1.0-test"),
            replicaId: "test-replica",
            deviceId: "test-device",
            factory: factory,
            sleepFor: sleepFor
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

}
