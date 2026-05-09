import XCTest
@testable import FrickSwift

final class FrickEventStreamParserTests: XCTestCase {
    func testParsesSnapshotEventsSplitAcrossChunks() throws {
        var parser = FrickEventStreamParser()

        XCTAssertEqual(parser.push(": connected\n\n"), [])
        XCTAssertEqual(parser.push("event: snapshot\ndata: {\"data\":[{\"id\":\"message-1\","), [])

        let events = parser.push("\"body\":\"Streamed\"}]}\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].event, "snapshot")
        XCTAssertEqual(events[0].data, "{\"data\":[{\"id\":\"message-1\",\"body\":\"Streamed\"}]}")
    }

    func testClientExposesMessageSSEStream() throws {
        let client = FrickClient(
            baseURL: URL(string: "http://127.0.0.1:4099")!,
            storage: try FrickSQLiteStorage(path: ":memory:")
        )

        _ = client.streamMessages(conversationId: "conversation-general")
    }

    func testMessageStreamReconnectsAfterSseResponseEnds() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(
            try ssePayload(for: "stream-page", events: [streamEvent(sequence: 1, eventId: "event-1", body: "first")]),
            for: "/streams/MessageStream/conversation-general/events?after=0"
        )
        FrickStreamingURLProtocol.enqueue(
            try ssePayload(for: "delta", events: [streamEvent(sequence: 2, eventId: "event-2", body: "second")]),
            for: "/streams/MessageStream/conversation-general/events?after=1"
        )

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FrickStreamingURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let client = FrickClient(
            baseURL: URL(string: "http://frick.test")!,
            session: session,
            streamingSession: session,
            storage: try FrickSQLiteStorage(path: ":memory:")
        )

        let snapshots = try await withTimeout {
            var snapshots: [[FrickStreamEvent]] = []
            for try await snapshot in client.streamMessages(conversationId: "conversation-general") {
                snapshots.append(snapshot)
                if snapshots.count == 2 {
                    return snapshots
                }
            }
            return snapshots
        }

        XCTAssertEqual(snapshots.map(\.count), [1, 2])
        XCTAssertEqual(snapshots.last?.map { $0.payload["body"] }, ["first", "second"])
        XCTAssertEqual(FrickStreamingURLProtocol.requestedPaths, [
            "/streams/MessageStream/conversation-general/events?after=0",
            "/streams/MessageStream/conversation-general/events?after=1",
        ])
    }

    func testGeneratedFoundationDTOsCarrySchemaContract() throws {
        XCTAssertEqual(FrickSchema.schemaHash, "frick-foundation-2026-05-09")

        let user = UserDTO(id: "user-ada", displayName: "Ada Lovelace", avatarBlobId: nil)
        let message = MessageSentDTO(
            messageId: "message-1",
            senderId: "user-ada",
            body: "Hello",
            createdAt: "2026-05-09T00:00:00.000Z"
        )

        XCTAssertEqual(user.displayName, "Ada Lovelace")
        XCTAssertEqual(message.body, "Hello")
    }

    func testSQLiteStoragePersistsFoundationStateAcrossInstances() throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "frick-swift-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let path = directory.appending(path: "frick.sqlite").path
        let userData = try JSONEncoder().encode(
            UserDTO(id: "user-ada", displayName: "Ada Lovelace", avatarBlobId: nil)
        )
        let event = FrickStreamEvent(
            stream: "MessageStream",
            streamId: "conversation-general",
            sequence: 1,
            eventId: "event-1",
            event: "MessageSent",
            payload: [
                "messageId": "message-1",
                "senderId": "user-ada",
                "body": "SQL backed",
                "createdAt": "2026-05-09T00:00:00.000Z",
            ]
        )
        let append = PendingAppend(requestId: "request-1", body: Data(#"{"stream":"MessageStream"}"#.utf8))

        do {
            let storage = try FrickSQLiteStorage(path: path)
            try storage.saveObjectData(type: "User", id: "user-ada", data: userData, version: 1)
            try storage.saveStreamEvent(event)
            try storage.appendPendingAppend(append)
        }

        let reopened = try FrickSQLiteStorage(path: path)
        XCTAssertEqual(try reopened.loadObjectData(type: "User", id: "user-ada"), userData)
        XCTAssertEqual(try reopened.loadStreamEvents(stream: "MessageStream", key: "conversation-general"), [event])
        XCTAssertEqual(try reopened.loadPendingAppends(), [append])

        try reopened.removePendingAppend(requestId: "request-1")
        XCTAssertEqual(try reopened.loadPendingAppends(), [])
    }
}

private final class FrickStreamingURLProtocol: URLProtocol {
    nonisolated(unsafe) private static var lock = NSLock()
    nonisolated(unsafe) private static var responses: [String: [Data]] = [:]
    nonisolated(unsafe) private static var paths: [String] = []

    static var requestedPaths: [String] {
        lock.lock()
        defer { lock.unlock() }
        return paths
    }

    static func reset() {
        lock.lock()
        responses = [:]
        paths = []
        lock.unlock()
    }

    static func enqueue(_ payload: String, for path: String) {
        lock.lock()
        responses[path, default: []].append(Data(payload.utf8))
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }

        let path = url.path + url.query.map { "?\($0)" }.orEmpty
        Self.lock.lock()
        Self.paths.append(path)
        var queuedResponses = Self.responses[path] ?? []
        let responseBody = queuedResponses.isEmpty ? nil : queuedResponses.removeFirst()
        Self.responses[path] = queuedResponses
        Self.lock.unlock()

        let statusCode = responseBody == nil ? 404 : 200
        let response = HTTPURLResponse(
            url: url,
            statusCode: statusCode,
            httpVersion: nil,
            headerFields: [
                "content-type": "text/event-stream; charset=utf-8",
                "x-frick-schema-hash": FrickSchema.schemaHash,
            ]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if let responseBody {
            client?.urlProtocol(self, didLoad: responseBody)
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private extension Optional where Wrapped == String {
    var orEmpty: String {
        self ?? ""
    }
}

private func ssePayload(for event: String, events: [FrickStreamEvent]) throws -> String {
    let data = try JSONEncoder().encode(
        StreamEventsResponsePayload(
            schemaHash: FrickSchema.schemaHash,
            stream: "MessageStream",
            key: "conversation-general",
            data: events
        )
    )
    return "event: \(event)\ndata: \(String(data: data, encoding: .utf8)!)\n\n"
}

private func streamEvent(sequence: Int, eventId: String, body: String) -> FrickStreamEvent {
    FrickStreamEvent(
        stream: "MessageStream",
        streamId: "conversation-general",
        sequence: sequence,
        eventId: eventId,
        event: "MessageSent",
        payload: [
            "messageId": "message-\(sequence)",
            "senderId": "user-ada",
            "body": body,
            "createdAt": "2026-05-09T00:00:00.000Z",
        ]
    )
}

private struct StreamEventsResponsePayload: Encodable {
    let schemaHash: String
    let stream: String
    let key: String
    let data: [FrickStreamEvent]
}

private func withTimeout<T: Sendable>(
    seconds: TimeInterval = 2,
    _ operation: @escaping @Sendable () async throws -> T
) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask {
            try await operation()
        }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            throw XCTestError(.timeoutWhileWaiting)
        }

        let result = try await group.next()!
        group.cancelAll()
        return result
    }
}
