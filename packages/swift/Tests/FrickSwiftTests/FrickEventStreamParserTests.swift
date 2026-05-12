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

    func testDevLoginPostsExpectedJsonAndStoresReturnedSession() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-ada", token: "token-ada"), for: "/auth/dev-login")
        let client = try makeTestClient()

        let session = try await client.devLogin(
            userId: "user-ada",
            deviceId: "ios-device",
            replicaId: "ios-replica",
            platform: "ios"
        )

        XCTAssertEqual(session.sessionToken, "token-ada")
        XCTAssertEqual(session.userId, "user-ada")
        XCTAssertEqual(client.currentSession?.sessionToken, "token-ada")
        let request = try XCTUnwrap(FrickStreamingURLProtocol.recordedRequests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/auth/dev-login")
        XCTAssertEqual(request.headerValue("content-type"), "application/json")
        let body = try XCTUnwrap(request.jsonBody)
        XCTAssertEqual(body["userId"] as? String, "user-ada")
        XCTAssertEqual(body["deviceId"] as? String, "ios-device")
        XCTAssertEqual(body["replicaId"] as? String, "ios-replica")
        XCTAssertEqual(body["platform"] as? String, "ios")
    }

    func testSignUpPostsAccountDetailsAndStoresReturnedSession() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(
            authResponse(
                userId: "user-dorothy",
                token: "token-dorothy",
                displayName: "Dorothy Vaughan",
                handle: "dorothy"
            ),
            for: "/auth/signup"
        )
        let client = try makeTestClient()

        let session = try await client.signUp(
            displayName: "Dorothy Vaughan",
            handle: "dorothy",
            password: "foundation-secret",
            deviceId: "ios-device",
            replicaId: "ios-replica",
            platform: "ios"
        )

        XCTAssertEqual(session.sessionToken, "token-dorothy")
        XCTAssertEqual(session.userId, "user-dorothy")
        XCTAssertEqual(session.displayName, "Dorothy Vaughan")
        XCTAssertEqual(session.handle, "dorothy")
        XCTAssertEqual(client.currentSession, session)
        let request = try XCTUnwrap(FrickStreamingURLProtocol.recordedRequests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/auth/signup")
        let body = try XCTUnwrap(request.jsonBody)
        XCTAssertEqual(body["displayName"] as? String, "Dorothy Vaughan")
        XCTAssertEqual(body["handle"] as? String, "dorothy")
        XCTAssertEqual(body["password"] as? String, "foundation-secret")
        XCTAssertEqual(body["deviceId"] as? String, "ios-device")
        XCTAssertEqual(body["replicaId"] as? String, "ios-replica")
        XCTAssertEqual(body["platform"] as? String, "ios")
    }

    func testLoginPostsIdentityAndStoresReturnedSession() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(
            authResponse(
                userId: "user-dorothy",
                token: "token-dorothy",
                displayName: "Dorothy Vaughan",
                handle: "dorothy"
            ),
            for: "/auth/login"
        )
        let client = try makeTestClient()

        let session = try await client.login(
            identity: "dorothy",
            password: "foundation-secret",
            deviceId: "ios-device",
            replicaId: "ios-replica",
            platform: "ios"
        )

        XCTAssertEqual(session.sessionToken, "token-dorothy")
        XCTAssertEqual(session.displayName, "Dorothy Vaughan")
        XCTAssertEqual(session.handle, "dorothy")
        XCTAssertEqual(client.currentSession, session)
        let request = try XCTUnwrap(FrickStreamingURLProtocol.recordedRequests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/auth/login")
        let body = try XCTUnwrap(request.jsonBody)
        XCTAssertEqual(body["identity"] as? String, "dorothy")
        XCTAssertEqual(body["password"] as? String, "foundation-secret")
        XCTAssertEqual(body["deviceId"] as? String, "ios-device")
        XCTAssertEqual(body["replicaId"] as? String, "ios-replica")
        XCTAssertEqual(body["platform"] as? String, "ios")
    }

    func testCreateConversationPostsParticipantsWithSessionAuth() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-ada", token: "token-ada"), for: "/auth/dev-login")
        FrickStreamingURLProtocol.enqueue(
            """
            {
              "schemaHash": "\(FrickSchema.schemaHash)",
              "conversation": {
                "id": "conversation-launch-room-a1b2c3",
                "kind": "group",
                "title": "Launch Room",
                "createdBy": "user-ada",
                "lastMessageEventId": null
              },
              "member": {
                "id": "member-launch-room-a1b2c3-ada",
                "conversationId": "conversation-launch-room-a1b2c3",
                "userId": "user-ada",
                "role": "owner"
              },
              "members": [
                {
                  "id": "member-launch-room-a1b2c3-ada",
                  "conversationId": "conversation-launch-room-a1b2c3",
                  "userId": "user-ada",
                  "role": "owner"
                },
                {
                  "id": "member-launch-room-a1b2c3-grace",
                  "conversationId": "conversation-launch-room-a1b2c3",
                  "userId": "user-grace",
                  "role": "member"
                }
              ]
            }
            """,
            for: "/conversations"
        )
        let client = try makeTestClient()

        _ = try await client.devLogin(userId: "user-ada")
        let created = try await client.createConversation(
            title: "Launch Room",
            kind: "group",
            participantUserIds: ["user-grace"]
        )

        XCTAssertEqual(created.conversation.id, "conversation-launch-room-a1b2c3")
        XCTAssertEqual(created.conversation.title, "Launch Room")
        XCTAssertEqual(created.member.conversationId, created.conversation.id)
        XCTAssertEqual(created.member.userId, "user-ada")
        XCTAssertEqual(created.members.map(\.userId), ["user-ada", "user-grace"])
        let requests = FrickStreamingURLProtocol.recordedRequests
        XCTAssertEqual(requests.map(\.path), ["/auth/dev-login", "/conversations"])
        XCTAssertEqual(requests.last?.method, "POST")
        XCTAssertEqual(requests.last?.headerValue("authorization"), "Bearer token-ada")
        let body = try XCTUnwrap(requests.last?.jsonBody)
        XCTAssertEqual(body["title"] as? String, "Launch Room")
        XCTAssertEqual(body["kind"] as? String, "group")
        XCTAssertEqual(body["participantUserIds"] as? [String], ["user-grace"])
    }

    func testSignOutClearsCurrentSession() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-ada", token: "token-ada"), for: "/auth/dev-login")
        let client = try makeTestClient()

        _ = try await client.devLogin(userId: "user-ada")
        client.signOut()

        XCTAssertNil(client.currentSession)
    }

    func testAuthenticatedFetchUsersIncludesAuthorizationHeader() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-ada", token: "token-ada"), for: "/auth/dev-login")
        FrickStreamingURLProtocol.enqueue(
            """
            {
              "schemaHash": "\(FrickSchema.schemaHash)",
              "type": "User",
              "data": [
                { "id": "user-ada", "displayName": "Ada Lovelace" }
              ]
            }
            """,
            for: "/objects?type=User"
        )
        let client = try makeTestClient()

        _ = try await client.devLogin(userId: "user-ada")
        _ = try await client.fetchUsers()

        let requests = FrickStreamingURLProtocol.recordedRequests
        XCTAssertEqual(requests.map(\.path), ["/auth/dev-login", "/objects?type=User"])
        XCTAssertNil(requests.first?.headerValue("authorization"))
        XCTAssertEqual(requests.last?.headerValue("authorization"), "Bearer token-ada")
    }

    func testStreamMessagesRequestCarriesSessionAuth() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-ada", token: "token-ada"), for: "/auth/dev-login")
        FrickStreamingURLProtocol.enqueue(
            try ssePayload(for: "stream-page", events: [streamEvent(sequence: 1, eventId: "event-1", body: "authed")]),
            for: "/streams/MessageStream/conversation-general/events?after=0"
        )
        let client = try makeTestClient()

        _ = try await client.devLogin(userId: "user-ada")
        let snapshots = try await withTimeout {
            for try await snapshot in client.streamMessages(conversationId: "conversation-general") {
                return snapshot
            }
            return []
        }

        XCTAssertEqual(snapshots.first?.payload["body"], "authed")
        let streamRequest = try XCTUnwrap(FrickStreamingURLProtocol.recordedRequests.last)
        XCTAssertEqual(streamRequest.path, "/streams/MessageStream/conversation-general/events?after=0")
        XCTAssertEqual(streamRequest.headerValue("authorization"), "Bearer token-ada")
    }

    func testSendMessageDefaultsSenderIdToAuthenticatedUser() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-grace", token: "token-grace"), for: "/auth/dev-login")
        let client = try makeTestClient(requestIdFactory: { "request-1" })

        _ = try await client.devLogin(userId: "user-grace")
        try await client.sendMessage(body: "hello from session")

        let body = try XCTUnwrap(FrickStreamingURLProtocol.postedBodies.last)
        let payload = try XCTUnwrap(body["payload"] as? [String: Any])
        XCTAssertEqual(payload["senderId"] as? String, "user-grace")
        XCTAssertEqual(payload["body"] as? String, "hello from session")
    }

    func testFetchInboxDefaultsToAuthenticatedUser() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-grace", token: "token-grace"), for: "/auth/dev-login")
        FrickStreamingURLProtocol.enqueue(
            """
            {
              "schemaHash": "\(FrickSchema.schemaHash)",
              "data": []
            }
            """,
            for: "/inbox?userId=user-grace"
        )
        let client = try makeTestClient()

        _ = try await client.devLogin(userId: "user-grace")
        let inbox = try await client.fetchInbox()

        XCTAssertEqual(inbox, [])
        XCTAssertEqual(FrickStreamingURLProtocol.recordedRequests.last?.path, "/inbox?userId=user-grace")
        XCTAssertEqual(FrickStreamingURLProtocol.recordedRequests.last?.headerValue("authorization"), "Bearer token-grace")
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

    func testDecodesJsonPayloadFieldsWithoutDroppingMessageEvents() throws {
        let response = """
        {
          "schemaHash": "\(FrickSchema.schemaHash)",
          "data": [
            {
              "stream": "MessageStream",
              "streamId": "conversation-general",
              "sequence": 3,
              "eventId": "event-3",
              "event": "MessageSent",
              "payload": {
                "messageId": "message-3",
                "senderId": "user-ada",
                "body": "Attachment",
                "createdAt": "2026-05-09T00:00:00.000Z",
                "attachmentBlobIds": ["blob-1"]
              }
            }
          ]
        }
        """

        let decoded = try JSONDecoder().decode(StreamEventsResponse.self, from: Data(response.utf8))

        XCTAssertEqual(decoded.data.first?.payload["body"], "Attachment")
        XCTAssertEqual(decoded.data.first?.payload["attachmentBlobIds"], #"["blob-1"]"#)
    }

    func testOnlyMessageSentEventsWithBodyAreVisibleChatMessages() {
        let message = streamEvent(sequence: 1, eventId: "event-message", body: "Hello")
        let emptyMessage = streamEvent(sequence: 2, eventId: "event-empty", body: "")
        let receipt = FrickStreamEvent(
            stream: "MessageStream",
            streamId: "conversation-general",
            sequence: 3,
            eventId: "event-receipt",
            event: "ReceiptAdvanced",
            payload: [
                "userId": "user-ada",
                "sequence": "2",
            ]
        )

        XCTAssertTrue(message.isVisibleChatMessage)
        XCTAssertFalse(emptyMessage.isVisibleChatMessage)
        XCTAssertFalse(receipt.isVisibleChatMessage)
    }

    func testGeneratedFoundationDTOsCarrySchemaContract() throws {
        XCTAssertEqual(FrickSchema.schemaHash, "frick-foundation-0.2.0")

        let user = UserDTO(id: "user-ada", displayName: "Ada Lovelace", avatarBlobId: nil)
        let device = UserDeviceDTO(
            id: "device-web",
            userId: "user-ada",
            platform: "web"
        )
        let message = MessageSentDTO(
            messageId: "message-1",
            senderId: "user-ada",
            body: "Hello",
            createdAt: "2026-05-09T00:00:00.000Z"
        )

        XCTAssertEqual(user.displayName, "Ada Lovelace")
        XCTAssertEqual(device.userId, "user-ada")
        XCTAssertEqual(message.body, "Hello")
    }

    func testParsesInboxAndBlobMetadataResponses() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(
            """
            {
              "schemaHash": "\(FrickSchema.schemaHash)",
              "data": [
                {
                  "conversationId": "conversation-general",
                  "userId": "user-ada",
                  "title": "Foundation General",
                  "kind": "channel",
                  "lastSequence": 7,
                  "lastMessageBody": "Inbox preview",
                  "lastMessageSenderId": "user-grace",
                  "readSequence": 4,
                  "unreadCount": 3
                }
              ]
            }
            """,
            for: "/inbox?userId=user-ada"
        )
        FrickStreamingURLProtocol.enqueue(
            """
            {
              "blobId": "blob-1",
              "ownerId": "user-ada",
              "contentHash": "sha256-1",
              "byteLength": 42,
              "mimeType": "text/plain",
              "createdAt": "2026-05-09T00:00:00.000Z"
            }
            """,
            for: "/blobs/blob-1"
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

        let inbox = try await client.fetchInbox()
        let blob = try await client.fetchBlobMetadata(blobId: "blob-1")

        XCTAssertEqual(inbox, [
            FrickInboxItem(
                conversationId: "conversation-general",
                userId: "user-ada",
                title: "Foundation General",
                kind: "channel",
                lastSequence: 7,
                lastMessageBody: "Inbox preview",
                lastMessageSenderId: "user-grace",
                readSequence: 4,
                unreadCount: 3
            ),
        ])
        XCTAssertEqual(blob?.blobId, "blob-1")
        XCTAssertEqual(blob?.byteLength, 42)
        XCTAssertEqual(FrickStreamingURLProtocol.requestedPaths, [
            "/inbox?userId=user-ada",
            "/blobs/blob-1",
        ])
    }

    func testUploadsAndDownloadsBlobContentAsRawBytes() async throws {
        FrickStreamingURLProtocol.reset()
        let uploaded = Data("hello blob".utf8)
        let downloaded = Data([0, 1, 2, 3, 255])
        FrickStreamingURLProtocol.enqueue(
            """
            {
              "blobId": "blob-1",
              "ownerId": "user-ada",
              "contentHash": "sha256-upload",
              "byteLength": \(uploaded.count),
              "mimeType": "text/plain",
              "storageKey": "blob/blob-1",
              "createdAt": "2026-05-09T00:00:00.000Z"
            }
            """,
            for: "/blobs/blob-1/content?ownerId=user-ada"
        )
        FrickStreamingURLProtocol.enqueue(downloaded, for: "/blobs/blob-1/content")

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FrickStreamingURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let client = FrickClient(
            baseURL: URL(string: "http://frick.test")!,
            session: session,
            streamingSession: session,
            storage: try FrickSQLiteStorage(path: ":memory:")
        )

        let metadata = try await client.uploadBlobContent(
            blobId: "blob-1",
            ownerId: "user-ada",
            mimeType: "text/plain",
            data: uploaded
        )
        let content = try await client.downloadBlobContent(blobId: "blob-1")

        XCTAssertEqual(metadata.blobId, "blob-1")
        XCTAssertEqual(metadata.ownerId, "user-ada")
        XCTAssertEqual(metadata.byteLength, uploaded.count)
        XCTAssertEqual(content, downloaded)

        let requests = FrickStreamingURLProtocol.recordedRequests
        XCTAssertEqual(requests.map(\.method), ["PUT", "GET"])
        XCTAssertEqual(requests.map(\.path), [
            "/blobs/blob-1/content?ownerId=user-ada",
            "/blobs/blob-1/content",
        ])
        XCTAssertEqual(requests.first?.body, uploaded)
        XCTAssertEqual(requests.first?.headerValue("content-type"), "text/plain")
    }

    func testSendsAndDrainsSignalsWithAttachmentSafePayloadDecoding() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(
            """
            {
              "schemaHash": "\(FrickSchema.schemaHash)",
              "name": "webrtc",
              "key": "room-1",
              "data": [
                {
                  "senderDeviceId": "ios-1",
                  "recipientDeviceId": "web-1",
                  "kind": "offer",
                  "retry": 2,
                  "attachmentBlobIds": ["blob-1"],
                  "payload": {
                    "sdp": "fake-offer"
                  }
                }
              ]
            }
            """,
            for: "/signals/webrtc/room-1"
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

        try await client.sendSignal(
            name: "webrtc",
            key: "room-1",
            value: [
                "senderDeviceId": "ios-1",
                "recipientDeviceId": "web-1",
                "kind": "offer",
                "payload": "fake-offer",
            ]
        )
        let signals = try await client.drainSignals(name: "webrtc", key: "room-1")

        XCTAssertEqual(FrickStreamingURLProtocol.requestedPaths, [
            "/signals/webrtc/room-1",
            "/signals/webrtc/room-1",
        ])
        XCTAssertEqual(FrickStreamingURLProtocol.postedBodies.count, 1)
        XCTAssertEqual(FrickStreamingURLProtocol.postedBodies.first?["senderDeviceId"] as? String, "ios-1")
        XCTAssertEqual(signals, [
            [
                "senderDeviceId": "ios-1",
                "recipientDeviceId": "web-1",
                "kind": "offer",
                "retry": "2",
                "attachmentBlobIds": #"["blob-1"]"#,
                "payload": #"{"sdp":"fake-offer"}"#,
            ],
        ])
    }

    func testAdvancesReadReceiptOncePerLoadedSequence() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(
            try streamEventsResponse(events: [
                streamEvent(sequence: 1, eventId: "event-1", body: "first"),
                streamEvent(sequence: 2, eventId: "event-2", body: "second"),
            ]),
            for: "/streams/MessageStream/conversation-general"
        )
        FrickStreamingURLProtocol.enqueue(
            try streamEventsResponse(events: [
                streamEvent(sequence: 1, eventId: "event-1", body: "first"),
                streamEvent(sequence: 2, eventId: "event-2", body: "second"),
            ]),
            for: "/streams/MessageStream/conversation-general"
        )

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FrickStreamingURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let client = FrickClient(
            baseURL: URL(string: "http://frick.test")!,
            session: session,
            streamingSession: session,
            replicaId: "ios-test",
            storage: try FrickSQLiteStorage(path: ":memory:"),
            requestIdFactory: { "request-\(FrickStreamingURLProtocol.postedBodies.count + 1)" }
        )

        _ = try await client.fetchMessages(conversationId: "conversation-general", readUserId: "user-ada")
        _ = try await client.fetchMessages(conversationId: "conversation-general", readUserId: "user-ada")

        XCTAssertEqual(FrickStreamingURLProtocol.postedBodies.count, 1)
        let body = try XCTUnwrap(FrickStreamingURLProtocol.postedBodies.first)
        XCTAssertEqual(body["stream"] as? String, "MessageStream")
        XCTAssertEqual(body["key"] as? String, "conversation-general")
        XCTAssertEqual(body["event"] as? String, "ReceiptAdvanced")
        let payload = try XCTUnwrap(body["payload"] as? [String: Any])
        XCTAssertEqual(payload["userId"] as? String, "user-ada")
        XCTAssertEqual(payload["sequence"] as? Int, 2)
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

    func testLoginThrowsFrickServerErrorCarryingEnvelopeOnAuthFailure() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(
            """
            {
              "error": {
                "code": "auth.unauthenticated",
                "message": "Invalid identity or password",
                "requestId": "login_rejected",
                "retryable": false,
                "schemaHash": "\(FrickSchema.schemaHash)",
                "schemaRevision": 1
              },
              "code": "auth.unauthenticated",
              "message": "Invalid identity or password",
              "requestId": "login_rejected",
              "retryable": false
            }
            """,
            status: 401,
            for: "/auth/login"
        )
        let client = try makeTestClient()

        do {
            _ = try await client.login(identity: "dorothy", password: "wrong")
            XCTFail("login should have thrown")
        } catch let error as FrickServerError {
            XCTAssertEqual(error.httpStatusCode, 401)
            XCTAssertEqual(error.code, .authUnauthenticated)
            XCTAssertEqual(error.message, "Invalid identity or password")
            XCTAssertEqual(error.requestId, "login_rejected")
            XCTAssertFalse(error.retryable)
            XCTAssertEqual(error.envelope?.schemaHash, FrickSchema.schemaHash)
            XCTAssertEqual(error.envelope?.schemaRevision, 1)
            XCTAssertNil(client.currentSession)
        }
    }

    func testFetchInboxPropagatesFrickServerErrorInsteadOfReturningEmpty() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-ada", token: "token-ada"), for: "/auth/dev-login")
        FrickStreamingURLProtocol.enqueue(
            """
            {
              "error": {
                "code": "auth.forbidden",
                "message": "Inbox not visible",
                "requestId": "inbox_rejected",
                "retryable": false
              },
              "code": "auth.forbidden",
              "message": "Inbox not visible",
              "requestId": "inbox_rejected",
              "retryable": false
            }
            """,
            status: 403,
            for: "/inbox?userId=user-ada"
        )
        let client = try makeTestClient()
        _ = try await client.devLogin(userId: "user-ada")

        do {
            _ = try await client.fetchInbox()
            XCTFail("fetchInbox should have thrown")
        } catch let error as FrickServerError {
            XCTAssertEqual(error.httpStatusCode, 403)
            XCTAssertEqual(error.code, .authForbidden)
            XCTAssertEqual(error.message, "Inbox not visible")
            XCTAssertEqual(error.requestId, "inbox_rejected")
        }
    }

    func testFrickServerErrorWithoutBodyExposesStatusCodeButNoEnvelope() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-ada", token: "token-ada"), for: "/auth/dev-login")
        FrickStreamingURLProtocol.enqueue("", status: 500, for: "/inbox?userId=user-ada")
        let client = try makeTestClient()
        _ = try await client.devLogin(userId: "user-ada")

        do {
            _ = try await client.fetchInbox()
            XCTFail("fetchInbox should have thrown")
        } catch let error as FrickServerError {
            XCTAssertEqual(error.httpStatusCode, 500)
            XCTAssertNil(error.envelope)
            XCTAssertNil(error.code)
            XCTAssertFalse(error.retryable)
        }
    }

    func testSendAppendQueuesNetworkErrorsButPropagatesServerEnvelopes() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-ada", token: "token-ada"), for: "/auth/dev-login")
        FrickStreamingURLProtocol.enqueue(
            """
            {
              "error": {
                "code": "stream.appendRejected",
                "message": "Append rejected",
                "requestId": "append_rejected",
                "retryable": false
              },
              "code": "stream.appendRejected",
              "message": "Append rejected",
              "requestId": "append_rejected",
              "retryable": false
            }
            """,
            status: 400,
            for: "/append"
        )
        let storage = try FrickSQLiteStorage(path: ":memory:")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FrickStreamingURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let client = FrickClient(
            baseURL: URL(string: "http://frick.test")!,
            session: session,
            streamingSession: session,
            storage: storage
        )

        _ = try await client.devLogin(userId: "user-ada")

        do {
            try await client.sendMessage(body: "ignored")
            XCTFail("sendMessage should have thrown when server returns an envelope")
        } catch let error as FrickServerError {
            XCTAssertEqual(error.code, .streamAppendRejected)
        }

        // Server-error responses must NOT silently queue the append for replay.
        XCTAssertEqual(try storage.loadPendingAppends(), [])
    }

    func testStorageRoundTripsCacheMetadata() throws {
        let storage = try FrickSQLiteStorage(path: ":memory:")
        XCTAssertNil(try storage.loadCacheMetadata())

        let metadata = FrickCacheMetadata.currentSchema
        try storage.saveCacheMetadata(metadata)
        XCTAssertEqual(try storage.loadCacheMetadata(), metadata)

        let next = FrickCacheMetadata(
            schemaId: metadata.schemaId,
            schemaVersion: "0.2.0",
            schemaRevision: 2,
            schemaHash: "rolling-upgrade-hash"
        )
        try storage.saveCacheMetadata(next)
        XCTAssertEqual(try storage.loadCacheMetadata(), next)
    }

    func testClearCacheRemovesAllFrameworkState() throws {
        let storage = try FrickSQLiteStorage(path: ":memory:")
        try storage.saveObjectData(
            type: "User",
            id: "user-ada",
            data: try JSONEncoder().encode(UserDTO(id: "user-ada", displayName: "Ada", avatarBlobId: nil)),
            version: 1
        )
        try storage.saveStreamEvent(streamEvent(sequence: 1, eventId: "event-1", body: "kept"))
        try storage.appendPendingAppend(PendingAppend(requestId: "request-1", body: Data("x".utf8)))
        try storage.saveCacheMetadata(.currentSchema)

        try storage.clearCache()

        XCTAssertNil(try storage.loadObjectData(type: "User", id: "user-ada"))
        XCTAssertEqual(try storage.loadStreamEvents(stream: "MessageStream", key: "conversation-general"), [])
        XCTAssertEqual(try storage.loadPendingAppends(), [])
        XCTAssertNil(try storage.loadCacheMetadata())
    }

    func testVerifyCacheCompatibilityStampsMetadataOnFirstRun() async throws {
        let storage = try FrickSQLiteStorage(path: ":memory:")
        let client = FrickClient(storage: storage)

        let stamped = try client.verifyCacheCompatibility()

        XCTAssertEqual(stamped, .currentSchema)
        XCTAssertEqual(try storage.loadCacheMetadata(), .currentSchema)
    }

    func testVerifyCacheCompatibilityThrowsOnSchemaIdMismatch() async throws {
        let storage = try FrickSQLiteStorage(path: ":memory:")
        try storage.saveCacheMetadata(
            FrickCacheMetadata(
                schemaId: "legacy-app",
                schemaVersion: "0.0.1",
                schemaRevision: 1,
                schemaHash: "legacy-hash"
            )
        )
        try storage.appendPendingAppend(PendingAppend(requestId: "request-1", body: Data("x".utf8)))
        let client = FrickClient(storage: storage)

        do {
            _ = try client.verifyCacheCompatibility()
            XCTFail("expected FrickCacheIncompatibleError")
        } catch let error as FrickCacheIncompatibleError {
            XCTAssertEqual(error.reason, .schemaIdMismatch)
            XCTAssertEqual(error.cachedMetadata.schemaId, "legacy-app")
            XCTAssertEqual(error.currentMetadata.schemaId, FrickSchema.schemaId)
            XCTAssertEqual(error.pendingAppendCount, 1)
        }
    }

    func testVerifyCacheCompatibilityThrowsWhenCacheRevisionTooOld() async throws {
        let storage = try FrickSQLiteStorage(path: ":memory:")
        try storage.saveCacheMetadata(
            FrickCacheMetadata(
                schemaId: FrickSchema.schemaId,
                schemaVersion: "0.0.1",
                schemaRevision: 1,
                schemaHash: "old-hash"
            )
        )
        let client = FrickClient(storage: storage)

        do {
            _ = try client.verifyCacheCompatibility(minimumClientRevision: 5)
            XCTFail("expected FrickCacheIncompatibleError")
        } catch let error as FrickCacheIncompatibleError {
            XCTAssertEqual(error.reason, .cacheTooOld)
            XCTAssertEqual(error.minimumClientRevision, 5)
        }
    }

    func testFrickErrorEnvelopeDecoderHandlesWrappedAndDirectShapes() throws {
        let wrapped = """
        {
          "error": {
            "code": "auth.forbidden",
            "message": "Nope",
            "requestId": "req-1",
            "retryable": false
          }
        }
        """
        let direct = """
        {
          "code": "schema.incompatible",
          "message": "Schema mismatch",
          "requestId": "req-2",
          "retryable": false,
          "schemaHash": "\(FrickSchema.schemaHash)",
          "schemaRevision": 1
        }
        """
        let wrappedEnvelope = FrickErrorEnvelopeDecoder.decode(from: Data(wrapped.utf8))
        let directEnvelope = FrickErrorEnvelopeDecoder.decode(from: Data(direct.utf8))

        XCTAssertEqual(wrappedEnvelope?.code, .authForbidden)
        XCTAssertEqual(wrappedEnvelope?.message, "Nope")
        XCTAssertEqual(directEnvelope?.code, .schemaIncompatible)
        XCTAssertEqual(directEnvelope?.schemaRevision, 1)
    }
}

private struct QueuedResponse {
    let body: Data
    let statusCode: Int
}

private final class FrickStreamingURLProtocol: URLProtocol {
    nonisolated(unsafe) private static var lock = NSLock()
    nonisolated(unsafe) private static var responses: [String: [QueuedResponse]] = [:]
    nonisolated(unsafe) private static var paths: [String] = []
    nonisolated(unsafe) private static var requests: [RecordedURLRequest] = []
    nonisolated(unsafe) private static var posts: [[String: Any]] = []

    static var requestedPaths: [String] {
        lock.lock()
        defer { lock.unlock() }
        return paths
    }

    static var recordedRequests: [RecordedURLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return requests
    }

    static var postedBodies: [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return posts
    }

    static func reset() {
        lock.lock()
        responses = [:]
        paths = []
        requests = []
        posts = []
        lock.unlock()
    }

    static func enqueue(_ payload: String, status: Int = 200, for path: String) {
        lock.lock()
        responses[path, default: []].append(QueuedResponse(body: Data(payload.utf8), statusCode: status))
        lock.unlock()
    }

    static func enqueue(_ payload: Data, status: Int = 200, for path: String) {
        lock.lock()
        responses[path, default: []].append(QueuedResponse(body: payload, statusCode: status))
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
        let method = request.httpMethod ?? "GET"
        let body = Self.bodyData(from: request)
        let headers = request.allHTTPHeaderFields ?? [:]

        Self.lock.lock()
        Self.paths.append(path)
        Self.requests.append(RecordedURLRequest(method: method, path: path, headers: headers, body: body))
        if request.httpMethod == "POST" {
            if let body,
               let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
                Self.posts.append(json)
            }
            let queued: QueuedResponse?
            if path.hasPrefix("/auth/") || path == "/conversations" || path == "/append" {
                var queuedResponses = Self.responses[path] ?? []
                queued = queuedResponses.isEmpty ? nil : queuedResponses.removeFirst()
                Self.responses[path] = queuedResponses
            } else {
                queued = nil
            }
            Self.lock.unlock()
            let response = HTTPURLResponse(
                url: url,
                statusCode: queued?.statusCode ?? 200,
                httpVersion: nil,
                headerFields: ["x-frick-schema-hash": FrickSchema.schemaHash]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if let queued {
                client?.urlProtocol(self, didLoad: queued.body)
            }
            client?.urlProtocolDidFinishLoading(self)
            return
        }

        var queuedResponses = Self.responses[path] ?? []
        let queued = queuedResponses.isEmpty ? nil : queuedResponses.removeFirst()
        Self.responses[path] = queuedResponses
        Self.lock.unlock()

        let statusCode = queued?.statusCode ?? 404
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
        if let queued {
            client?.urlProtocol(self, didLoad: queued.body)
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func bodyData(from request: URLRequest) -> Data? {
        if let body = request.httpBody {
            return body
        }
        guard let stream = request.httpBodyStream else {
            return nil
        }

        stream.open()
        defer { stream.close() }

        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count > 0 {
                data.append(buffer, count: count)
            } else {
                break
            }
        }
        return data
    }
}

private struct RecordedURLRequest: Equatable {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data?

    func headerValue(_ name: String) -> String? {
        let lowercasedName = name.lowercased()
        return headers.first { $0.key.lowercased() == lowercasedName }?.value
    }

    var jsonBody: [String: Any]? {
        guard let body else {
            return nil
        }
        return try? JSONSerialization.jsonObject(with: body) as? [String: Any]
    }
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

private func makeTestClient(requestIdFactory: @escaping @Sendable () -> String = { UUID().uuidString }) throws -> FrickClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [FrickStreamingURLProtocol.self]
    let session = URLSession(configuration: configuration)
    return FrickClient(
        baseURL: URL(string: "http://frick.test")!,
        session: session,
        streamingSession: session,
        storage: try FrickSQLiteStorage(path: ":memory:"),
        requestIdFactory: requestIdFactory
    )
}

private func devLoginResponse(userId: String, token: String) -> String {
    """
    {
      "schemaHash": "\(FrickSchema.schemaHash)",
      "sessionToken": "\(token)",
      "userId": "\(userId)",
      "deviceId": "device-\(userId)",
      "replicaId": "replica-\(userId)",
      "expiresAt": "2026-05-09T12:00:00.000Z"
    }
    """
}

private func authResponse(userId: String, token: String, displayName: String, handle: String) -> String {
    """
    {
      "schemaHash": "\(FrickSchema.schemaHash)",
      "sessionToken": "\(token)",
      "userId": "\(userId)",
      "displayName": "\(displayName)",
      "handle": "\(handle)",
      "deviceId": "device-\(userId)",
      "replicaId": "replica-\(userId)",
      "expiresAt": "2026-05-09T12:00:00.000Z"
    }
    """
}

private func streamEventsResponse(events: [FrickStreamEvent]) throws -> String {
    let data = try JSONEncoder().encode(
        StreamEventsResponsePayload(
            schemaHash: FrickSchema.schemaHash,
            stream: "MessageStream",
            key: "conversation-general",
            data: events
        )
    )
    return String(data: data, encoding: .utf8)!
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

// MARK: - Cross-platform fixture decoding

private struct FoundationSchemaIdentityFixture: Decodable {
    let schemaId: String
    let schemaVersion: String
    let schemaRevision: Int
    let minimumClientRevision: Int
    let minimumServerRevision: Int
    let `protocol`: String
    let protocolVersion: Int
    let compatibility: String
    let hash: String
}

private struct HelloFrameClientCapabilitiesSchemaFixture: Decodable {
    let schemaId: String
    let schemaRevision: Int
    let schemaHash: String
}

private struct HelloFrameClientCapabilitiesFixture: Decodable {
    let platform: String
    let sdkVersion: String
    let schema: HelloFrameClientCapabilitiesSchemaFixture
}

private struct HelloFramePayloadFixture: Decodable {
    let replicaId: String
    let deviceId: String
    let schemaHash: String
    let knownCursors: [String: FrickJSONValue]
    let clientCapabilities: HelloFrameClientCapabilitiesFixture
}

final class FrickProtocolFixturesTests: XCTestCase {
    private func fixturesDirectory() -> URL {
        // #filePath is .../packages/swift/Tests/FrickSwiftTests/FrickEventStreamParserTests.swift
        let testFileURL = URL(fileURLWithPath: #filePath)
        let repoRoot = testFileURL
            .deletingLastPathComponent() // FrickSwiftTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // swift
            .deletingLastPathComponent() // packages
            .deletingLastPathComponent() // repo root
        return repoRoot
            .appendingPathComponent("packages")
            .appendingPathComponent("protocol")
            .appendingPathComponent("fixtures")
    }

    private func loadFixture(_ name: String) throws -> Data {
        let url = fixturesDirectory().appendingPathComponent(name)
        return try Data(contentsOf: url)
    }

    func testFoundationSchemaFixtureMatchesGeneratedConstants() throws {
        let data = try loadFixture("foundation-schema.json")
        XCTAssertFalse(data.isEmpty, "foundation-schema.json fixture should be readable from disk")

        let identity = try JSONDecoder().decode(FoundationSchemaIdentityFixture.self, from: data)
        XCTAssertEqual(identity.schemaId, FrickSchema.schemaId)
        XCTAssertEqual(identity.schemaRevision, FrickSchema.schemaRevision)
        XCTAssertEqual(identity.hash, FrickSchema.schemaHash)
        XCTAssertEqual(identity.schemaVersion, FrickSchema.schemaVersion)
        XCTAssertEqual(identity.minimumClientRevision, FrickSchema.minimumClientRevision)
        XCTAssertEqual(identity.minimumServerRevision, FrickSchema.minimumServerRevision)
        XCTAssertEqual(identity.protocolVersion, FrickSchema.protocolVersion)
        XCTAssertEqual(identity.protocol, "frick.realtime")
        XCTAssertEqual(identity.compatibility, "greenfield-cutover")
    }

    func testErrorEnvelopeFixtureMatchesGeneratedConstants() throws {
        let data = try loadFixture("error-envelope.json")
        let envelope = try XCTUnwrap(
            FrickErrorEnvelopeDecoder.decode(from: data),
            "error envelope fixture should decode through FrickErrorEnvelopeDecoder"
        )
        XCTAssertEqual(envelope.code, .schemaIncompatible)
        XCTAssertEqual(envelope.requestId, "fixture-error")
        XCTAssertFalse(envelope.retryable)
        XCTAssertEqual(envelope.schemaHash, FrickSchema.schemaHash)
        XCTAssertEqual(envelope.schemaRevision, FrickSchema.schemaRevision)
    }

    func testHelloFrameFixtureMatchesGeneratedConstants() throws {
        let data = try loadFixture("hello-frame.json")
        let raw = try JSONSerialization.jsonObject(with: data, options: [])
        let frameArray = try XCTUnwrap(raw as? [Any], "hello-frame.json should decode as a JSON array")
        XCTAssertEqual(frameArray.count, 2)
        XCTAssertEqual(frameArray[0] as? Int, 0, "frame kind should be FrameKind.Hello (0)")

        // Decode the payload (position 1) into a typed struct for clean assertions.
        let payloadObject = try XCTUnwrap(frameArray[1] as? [String: Any])
        let payloadData = try JSONSerialization.data(withJSONObject: payloadObject, options: [])
        let payload = try JSONDecoder().decode(HelloFramePayloadFixture.self, from: payloadData)

        XCTAssertEqual(payload.replicaId, "fixture-replica")
        XCTAssertEqual(payload.deviceId, "fixture-device")
        XCTAssertEqual(payload.schemaHash, FrickSchema.schemaHash)
        XCTAssertTrue(payload.knownCursors.isEmpty)
        XCTAssertEqual(payload.clientCapabilities.platform, "test")
        XCTAssertEqual(payload.clientCapabilities.sdkVersion, "0.0.0-fixture")
        XCTAssertEqual(payload.clientCapabilities.schema.schemaId, FrickSchema.schemaId)
        XCTAssertEqual(payload.clientCapabilities.schema.schemaRevision, FrickSchema.schemaRevision)
        XCTAssertEqual(payload.clientCapabilities.schema.schemaHash, FrickSchema.schemaHash)
    }
}
