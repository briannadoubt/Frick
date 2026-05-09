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
