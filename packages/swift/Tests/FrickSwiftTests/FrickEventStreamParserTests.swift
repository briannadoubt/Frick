import XCTest
import SQLite3
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

    func testDevLoginPostsExpectedJsonAndStoresReturnedSession() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(
            devLoginResponse(userId: "user-ada", token: "token-ada", tenantId: "tenant-a"),
            for: "/auth/dev-login"
        )
        let client = try makeTestClient()

        let session = try await client.devLogin(
            userId: "user-ada",
            deviceId: "ios-device",
            replicaId: "ios-replica",
            platform: "ios"
        )

        XCTAssertEqual(session.sessionToken, "token-ada")
        XCTAssertEqual(session.tenantId, "tenant-a")
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

    func testTrackPostsProductAnalyticsWithSessionAuth() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-ada", token: "token-ada"), for: "/auth/dev-login")
        FrickStreamingURLProtocol.enqueue(
            """
            {
              "ok": true,
              "eventId": "platform-event-ios-1",
              "sequence": 42,
              "acceptedAt": "2026-05-17T12:00:00.000Z",
              "duplicate": false
            }
            """,
            for: "/analytics/events"
        )
        let client = try makeTestClient()

        _ = try await client.devLogin(userId: "user-ada")
        let receipt = try await client.track(
            "screen.viewed",
            properties: [
                "path": .string("/settings"),
                "attempt": .int(3),
            ],
            options: FrickAnalyticsTrackOptions(
                context: ["source": .string("ios")],
                attributes: [
                    "coldStart": .bool(true),
                    "launchCount": .int(2),
                ],
                traceId: "trace-ios-1",
                idempotencyKey: "screen-ios-1",
                occurredAt: "2026-05-17T11:59:00.000Z"
            )
        )

        XCTAssertEqual(receipt.eventId, "platform-event-ios-1")
        XCTAssertEqual(receipt.sequence, 42)
        XCTAssertFalse(receipt.duplicate)
        let requests = FrickStreamingURLProtocol.recordedRequests
        XCTAssertEqual(requests.map(\.path), ["/auth/dev-login", "/analytics/events"])
        XCTAssertEqual(requests.last?.method, "POST")
        XCTAssertEqual(requests.last?.headerValue("authorization"), "Bearer token-ada")
        XCTAssertEqual(requests.last?.headerValue("content-type"), "application/json")
        let body = try XCTUnwrap(requests.last?.jsonBody)
        XCTAssertEqual(body["name"] as? String, "screen.viewed")
        let properties = try XCTUnwrap(body["properties"] as? [String: Any])
        XCTAssertEqual(properties["path"] as? String, "/settings")
        XCTAssertEqual(properties["attempt"] as? Int, 3)
        let context = try XCTUnwrap(body["context"] as? [String: Any])
        XCTAssertEqual(context["source"] as? String, "ios")
        let attributes = try XCTUnwrap(body["attributes"] as? [String: Any])
        XCTAssertEqual(attributes["coldStart"] as? Bool, true)
        XCTAssertEqual(attributes["launchCount"] as? Int, 2)
        XCTAssertEqual(body["traceId"] as? String, "trace-ios-1")
        XCTAssertEqual(body["idempotencyKey"] as? String, "screen-ios-1")
        XCTAssertEqual(body["occurredAt"] as? String, "2026-05-17T11:59:00.000Z")
    }

    func testTrackRecordsTelemetryAndCorrelatesSpanTraceId() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-ada", token: "token-ada"), for: "/auth/dev-login")
        FrickStreamingURLProtocol.enqueue(
            """
            {
              "ok": true,
              "eventId": "platform-event-ios-telemetry",
              "sequence": 43,
              "acceptedAt": "2026-05-17T12:00:01.000Z",
              "duplicate": false
            }
            """,
            for: "/analytics/events"
        )
        let telemetry = RecordingFrickClientTelemetryRuntime(traceId: "trace-ios-auto")
        let client = try makeTestClient(telemetry: telemetry)

        _ = try await client.devLogin(userId: "user-ada")
        _ = try await client.track("screen.viewed", properties: ["path": .string("/settings")])

        let analyticsBody = try XCTUnwrap(FrickStreamingURLProtocol.recordedRequests.last?.jsonBody)
        XCTAssertEqual(analyticsBody["traceId"] as? String, "trace-ios-auto")
        XCTAssertEqual(
            FrickStreamingURLProtocol.recordedRequests.last?.headerValue("traceparent"),
            "00-trace-ios-auto-span-01"
        )
        XCTAssertEqual(telemetry.startedSpans, [
            FrickClientTelemetrySpanStart(
                name: "frick.analytics.track",
                kind: .client,
                attributes: [
                    "frick.analytics.event_name": .string("screen.viewed"),
                    "url.path": .string("/analytics/events"),
                ]
            ),
        ])
        XCTAssertEqual(telemetry.finishedSpans.map(\.status), [.ok])
        XCTAssertEqual(telemetry.finishedSpans.first?.attributes["frick.analytics.status"], .string("accepted"))
        XCTAssertEqual(telemetry.finishedSpans.first?.attributes["http.response.status_code"], .int(200))
        XCTAssertEqual(telemetry.finishedSpans.first?.attributes["frick.analytics.duplicate"], .bool(false))
        XCTAssertEqual(telemetry.counters, [
            RecordingFrickClientTelemetryRuntime.Measurement(
                name: "frick.client.analytics.events.total",
                value: 1,
                attributes: ["status": .string("accepted")]
            ),
        ])
        XCTAssertEqual(telemetry.histograms.map(\.name), ["frick.client.analytics.duration_ms"])
        XCTAssertEqual(telemetry.histograms.first?.attributes, ["status": .string("accepted")])
    }

    func testTrackIgnoresTelemetryFailures() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-ada", token: "token-ada"), for: "/auth/dev-login")
        FrickStreamingURLProtocol.enqueue(
            """
            {
              "ok": true,
              "eventId": "platform-event-ios-resilient",
              "sequence": 44,
              "acceptedAt": "2026-05-17T12:00:02.000Z",
              "duplicate": false
            }
            """,
            for: "/analytics/events"
        )
        let client = try makeTestClient(telemetry: ThrowingFrickClientTelemetryRuntime())

        _ = try await client.devLogin(userId: "user-ada")
        let receipt = try await client.track("button.clicked")

        XCTAssertEqual(receipt.eventId, "platform-event-ios-resilient")
    }

    func testTrackPrefersCallerTraceIdOverSpanTraceId() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-ada", token: "token-ada"), for: "/auth/dev-login")
        FrickStreamingURLProtocol.enqueue(
            """
            {
              "ok": true,
              "eventId": "platform-event-ios-caller-trace",
              "sequence": 45,
              "acceptedAt": "2026-05-17T12:00:03.000Z",
              "duplicate": false
            }
            """,
            for: "/analytics/events"
        )
        let telemetry = RecordingFrickClientTelemetryRuntime(traceId: "trace-ios-span")
        let client = try makeTestClient(telemetry: telemetry)

        _ = try await client.devLogin(userId: "user-ada")
        _ = try await client.track("screen.viewed", options: FrickAnalyticsTrackOptions(traceId: "trace-ios-caller"))

        let analyticsBody = try XCTUnwrap(FrickStreamingURLProtocol.recordedRequests.last?.jsonBody)
        XCTAssertEqual(analyticsBody["traceId"] as? String, "trace-ios-caller")
    }

    func testTrackRecordsDuplicateTelemetryStatus() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-ada", token: "token-ada"), for: "/auth/dev-login")
        FrickStreamingURLProtocol.enqueue(
            """
            {
              "ok": true,
              "eventId": "platform-event-ios-duplicate",
              "sequence": 46,
              "acceptedAt": "2026-05-17T12:00:04.000Z",
              "duplicate": true
            }
            """,
            for: "/analytics/events"
        )
        let telemetry = RecordingFrickClientTelemetryRuntime(traceId: "trace-ios-duplicate")
        let client = try makeTestClient(telemetry: telemetry)

        _ = try await client.devLogin(userId: "user-ada")
        let receipt = try await client.track("button.clicked")

        XCTAssertTrue(receipt.duplicate)
        XCTAssertEqual(telemetry.finishedSpans.first?.attributes["frick.analytics.status"], .string("duplicate"))
        XCTAssertEqual(telemetry.finishedSpans.first?.attributes["frick.analytics.duplicate"], .bool(true))
        XCTAssertEqual(telemetry.counters.first?.attributes, ["status": .string("duplicate")])
        XCTAssertEqual(telemetry.histograms.first?.attributes, ["status": .string("duplicate")])
    }

    func testTrackRecordsRejectedTelemetryStatus() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-ada", token: "token-ada"), for: "/auth/dev-login")
        FrickStreamingURLProtocol.enqueue(
            """
            {
              "error": {
                "code": "auth.forbidden",
                "message": "Nope",
                "requestId": "req-analytics",
                "retryable": false
              }
            }
            """,
            status: 403,
            for: "/analytics/events"
        )
        let telemetry = RecordingFrickClientTelemetryRuntime(traceId: "trace-ios-rejected")
        let client = try makeTestClient(telemetry: telemetry)

        _ = try await client.devLogin(userId: "user-ada")
        do {
            _ = try await client.track("button.clicked")
            XCTFail("expected rejected analytics response")
        } catch is FrickServerError {
            // expected
        }

        XCTAssertEqual(telemetry.finishedSpans.map(\.status), [.error])
        XCTAssertEqual(telemetry.finishedSpans.first?.attributes["frick.analytics.status"], .string("rejected"))
        XCTAssertEqual(telemetry.finishedSpans.first?.attributes["http.response.status_code"], .int(403))
        XCTAssertEqual(telemetry.counters.first?.attributes, ["status": .string("rejected")])
        XCTAssertEqual(telemetry.histograms.first?.attributes, ["status": .string("rejected")])
    }

    func testTrackRecordsNetworkTelemetryStatus() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-ada", token: "token-ada"), for: "/auth/dev-login")
        FrickStreamingURLProtocol.fail(URLError(.notConnectedToInternet), for: "/analytics/events")
        let telemetry = RecordingFrickClientTelemetryRuntime(traceId: "trace-ios-network")
        let client = try makeTestClient(telemetry: telemetry)

        _ = try await client.devLogin(userId: "user-ada")
        do {
            _ = try await client.track("button.clicked")
            XCTFail("expected network analytics failure")
        } catch is URLError {
            // expected
        }

        XCTAssertEqual(telemetry.finishedSpans.map(\.status), [.error])
        XCTAssertEqual(telemetry.finishedSpans.first?.attributes["frick.analytics.status"], .string("network_error"))
        XCTAssertNil(telemetry.finishedSpans.first?.attributes["http.response.status_code"])
        XCTAssertEqual(telemetry.counters.first?.attributes, ["status": .string("network_error")])
        XCTAssertEqual(telemetry.histograms.first?.attributes, ["status": .string("network_error")])
    }

    func testTrackRequiresSessionBeforePosting() async throws {
        FrickStreamingURLProtocol.reset()
        let client = try makeTestClient()

        do {
            _ = try await client.track("button.clicked")
            XCTFail("expected auth requirement before posting analytics")
        } catch is FrickAuthenticationRequiredError {
            // expected
        }

        XCTAssertEqual(FrickStreamingURLProtocol.recordedRequests, [])
    }

    func testSignOutClearsCurrentSession() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-ada", token: "token-ada"), for: "/auth/dev-login")
        let client = try makeTestClient()

        _ = try await client.devLogin(userId: "user-ada")
        client.signOut()

        XCTAssertNil(client.currentSession)
    }

    func testSignOutClearsSessionAndPendingAppends() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-ada", token: "token-ada"), for: "/auth/dev-login")
        let storage = try FrickSQLiteStorage(path: ":memory:")
        try storage.appendPendingAppend(PendingAppend(requestId: "request-1", body: Data("{}".utf8)))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FrickStreamingURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let client = FrickClient(
            baseURL: URL(string: "http://frick.test")!,
            session: session,
            streamingSession: session,
            storage: storage,
            sessionPersistence: FrickInMemorySessionStore()
        )

        _ = try await client.devLogin(userId: "user-ada")
        client.signOut()

        XCTAssertNil(client.currentSession)
        XCTAssertEqual(try storage.loadPendingAppends(), [])
    }

    func testFlushPendingAppendsRequiresSessionBeforePosting() async throws {
        FrickStreamingURLProtocol.reset()
        let storage = try FrickSQLiteStorage(path: ":memory:")
        try storage.appendPendingAppend(PendingAppend(requestId: "request-1", body: Data("{}".utf8)))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FrickStreamingURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let client = FrickClient(
            baseURL: URL(string: "http://frick.test")!,
            session: session,
            streamingSession: session,
            storage: storage,
            sessionPersistence: FrickInMemorySessionStore()
        )

        do {
            try await client.flushPendingAppends()
            XCTFail("expected auth requirement before flushing pending appends")
        } catch is FrickAuthenticationRequiredError {
            // expected
        }

        XCTAssertEqual(FrickStreamingURLProtocol.recordedRequests, [])
        XCTAssertEqual(try storage.loadPendingAppends().map(\.requestId), ["request-1"])
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
        // Blob upload/download require an authenticated session, so sign in
        // first (mirrors the queue/flush blob tests).
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-ada", token: "token-ada"), for: "/auth/dev-login")

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FrickStreamingURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let client = FrickClient(
            baseURL: URL(string: "http://frick.test")!,
            session: session,
            streamingSession: session,
            storage: try FrickSQLiteStorage(path: ":memory:"),
            sessionPersistence: FrickInMemorySessionStore()
        )
        _ = try await client.devLogin(userId: "user-ada")

        // Blob upload/download require an authenticated session (sendBlob →
        // requireAuthenticatedSession). Inject one without a network round-trip
        // so the recorded requests stay exactly [PUT, GET].
        client.restoreSession(
            FrickSession(
                schemaHash: nil,
                sessionToken: "token-ada",
                userId: "user-ada",
                deviceId: "device-1",
                replicaId: "replica-1",
                expiresAt: "2099-01-01T00:00:00.000Z"
            )
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

        // Scope to the blob traffic — the dev-login request is also recorded.
        let requests = FrickStreamingURLProtocol.recordedRequests.filter { $0.path.hasPrefix("/blobs/") }
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
            storage: try FrickSQLiteStorage(path: ":memory:"),
            sessionPersistence: FrickInMemorySessionStore()
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

    func testSQLiteStoragePersistsFoundationStateAcrossInstances() throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "frick-swift-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let path = directory.appending(path: "frick.sqlite").path
        let userData = try JSONEncoder().encode(
            TestUserFixture(id: "user-ada", displayName: "Ada Lovelace", avatarBlobId: nil)
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

    func testStorageRoundTripsCacheMetadata() throws {
        let storage = try FrickSQLiteStorage(path: ":memory:")
        XCTAssertNil(try storage.loadCacheMetadata())

        let metadata = FrickCacheMetadata.currentSchema(tenantId: "tenant-a", userId: "user-ada")
        try storage.saveCacheMetadata(metadata)
        XCTAssertEqual(try storage.loadCacheMetadata(), metadata)

        let next = FrickCacheMetadata(
            schemaId: metadata.schemaId,
            schemaVersion: "0.2.0",
            schemaRevision: 2,
            schemaHash: "rolling-upgrade-hash",
            tenantId: "tenant-b",
            userId: "user-grace"
        )
        try storage.saveCacheMetadata(next)
        XCTAssertEqual(try storage.loadCacheMetadata(), next)
    }

    func testSQLiteStorageMigratesLegacyCacheMetadataWithoutClearingIt() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "frick-swift-migration-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appending(path: "frick.sqlite").path
        try createLegacyCacheMetadataDatabase(path: path)

        let storage = try FrickSQLiteStorage(path: path)

        let metadata = try XCTUnwrap(storage.loadCacheMetadata())
        XCTAssertEqual(metadata.schemaId, FrickSchema.schemaId)
        XCTAssertNil(metadata.tenantId)
        XCTAssertNil(metadata.userId)

        try storage.saveCacheMetadata(.currentSchema(tenantId: "tenant-a", userId: "user-ada"))
        XCTAssertEqual(try storage.loadCacheMetadata()?.tenantId, "tenant-a")
        XCTAssertEqual(try storage.loadCacheMetadata()?.userId, "user-ada")
    }

    func testVerifyCacheCompatibilityStampsCurrentSessionScopeOnFirstRun() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(
            devLoginResponse(userId: "user-ada", token: "token-ada", tenantId: "tenant-a"),
            for: "/auth/dev-login"
        )
        let storage = try FrickSQLiteStorage(path: ":memory:")
        let client = try makeTestClient(storage: storage)
        _ = try await client.devLogin(userId: "user-ada")

        let stamped = try client.verifyCacheCompatibility()

        XCTAssertEqual(stamped.tenantId, "tenant-a")
        XCTAssertEqual(stamped.userId, "user-ada")
        XCTAssertEqual(try storage.loadCacheMetadata(), stamped)
    }

    func testClearCacheRemovesAllFrameworkState() throws {
        let storage = try FrickSQLiteStorage(path: ":memory:")
        try storage.saveObjectData(
            type: "User",
            id: "user-ada",
            data: try JSONEncoder().encode(TestUserFixture(id: "user-ada", displayName: "Ada", avatarBlobId: nil)),
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
        let client = FrickClient(storage: storage, sessionPersistence: FrickInMemorySessionStore())

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
        let client = FrickClient(storage: storage, sessionPersistence: FrickInMemorySessionStore())

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
        let client = FrickClient(storage: storage, sessionPersistence: FrickInMemorySessionStore())

        do {
            _ = try client.verifyCacheCompatibility(minimumClientRevision: 5)
            XCTFail("expected FrickCacheIncompatibleError")
        } catch let error as FrickCacheIncompatibleError {
            XCTAssertEqual(error.reason, .cacheTooOld)
            XCTAssertEqual(error.minimumClientRevision, 5)
        }
    }

    func testVerifyCacheCompatibilityThrowsWhenSessionScopeDiffers() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(
            devLoginResponse(userId: "user-grace", token: "token-grace", tenantId: "tenant-b"),
            for: "/auth/dev-login"
        )
        let storage = try FrickSQLiteStorage(path: ":memory:")
        try storage.saveCacheMetadata(.currentSchema(tenantId: "tenant-a", userId: "user-ada"))
        try storage.appendPendingAppend(PendingAppend(requestId: "request-1", body: Data("x".utf8)))
        let client = try makeTestClient(storage: storage)
        _ = try await client.devLogin(userId: "user-grace")

        do {
            _ = try client.verifyCacheCompatibility()
            XCTFail("expected FrickCacheIncompatibleError")
        } catch let error as FrickCacheIncompatibleError {
            XCTAssertEqual(error.reason, .sessionScopeMismatch)
            XCTAssertEqual(error.cachedMetadata.tenantId, "tenant-a")
            XCTAssertEqual(error.cachedMetadata.userId, "user-ada")
            XCTAssertEqual(error.currentMetadata.tenantId, "tenant-b")
            XCTAssertEqual(error.currentMetadata.userId, "user-grace")
            XCTAssertEqual(error.pendingAppendCount, 1)
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

    // MARK: - FR-310: Offline blob queue

    func testUploadBlobContentQueuesOnNetworkFailure() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-ada", token: "token-ada"), for: "/auth/dev-login")
        // Inject a network error for the PUT path so the upload is queued.
        FrickStreamingURLProtocol.fail(URLError(.notConnectedToInternet), for: "/blobs/blob-1/content?ownerId=owner-1")
        let storage = try FrickSQLiteStorage(path: ":memory:")
        let client = try makeTestClient(storage: storage, requestIdFactory: { "req-blob-1" })
        _ = try await client.devLogin(userId: "user-ada")

        let blobData = Data("hello world".utf8)
        let metadata = try await client.uploadBlobContent(
            blobId: "blob-1",
            ownerId: "owner-1",
            mimeType: "text/plain",
            data: blobData
        )

        // The call should return an optimistic metadata value (no server round-trip).
        XCTAssertEqual(metadata.blobId, "blob-1")
        XCTAssertEqual(metadata.ownerId, "owner-1")
        XCTAssertEqual(metadata.mimeType, "text/plain")
        XCTAssertEqual(metadata.byteLength, blobData.count)

        // The blob must be persisted in the pending queue.
        let pending = try storage.loadPendingBlobs()
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending[0].requestId, "req-blob-1")
        XCTAssertEqual(pending[0].blobId, "blob-1")
        XCTAssertEqual(pending[0].ownerId, "owner-1")
        XCTAssertEqual(pending[0].mimeType, "text/plain")
        XCTAssertEqual(pending[0].data, blobData)
    }

    func testFlushPendingBlobsReplaysAndRemoves() async throws {
        FrickStreamingURLProtocol.reset()
        FrickStreamingURLProtocol.enqueue(devLoginResponse(userId: "user-ada", token: "token-ada"), for: "/auth/dev-login")

        let storage = try FrickSQLiteStorage(path: ":memory:")
        let client = try makeTestClient(storage: storage)
        _ = try await client.devLogin(userId: "user-ada")

        // Pre-populate the queue directly (simulates a blob that was queued in a prior session).
        let blobData = Data("image bytes".utf8)
        let blob = PendingBlob(requestId: "req-flush-1", blobId: "blob-2", ownerId: "owner-2", mimeType: "image/png", data: blobData)
        try storage.appendPendingBlob(blob)
        XCTAssertEqual(try storage.loadPendingBlobs().count, 1)

        // Enqueue a success response for the PUT.
        let successPayload = """
        {
          "blobId": "blob-2",
          "ownerId": "owner-2",
          "contentHash": "abc123",
          "byteLength": \(blobData.count),
          "mimeType": "image/png",
          "storageKey": "s3://bucket/blob-2",
          "createdAt": "2026-06-18T00:00:00.000Z"
        }
        """
        FrickStreamingURLProtocol.enqueue(successPayload, for: "/blobs/blob-2/content?ownerId=owner-2")

        try await client.flushPendingBlobs()

        // After a successful flush the pending queue must be empty.
        XCTAssertEqual(try storage.loadPendingBlobs().count, 0)
    }

    func testFlushPendingBlobsRequiresAuthenticatedSession() async throws {
        FrickStreamingURLProtocol.reset()
        let storage = try FrickSQLiteStorage(path: ":memory:")
        let blobData = Data("payload".utf8)
        try storage.appendPendingBlob(PendingBlob(requestId: "req-1", blobId: "b1", ownerId: "o1", mimeType: "application/octet-stream", data: blobData))
        let client = try makeTestClient(storage: storage)

        do {
            try await client.flushPendingBlobs()
            XCTFail("expected FrickAuthenticationRequiredError")
        } catch is FrickAuthenticationRequiredError {
            // expected
        }

        // Queue must still be intact — auth error must not dequeue anything.
        XCTAssertEqual(try storage.loadPendingBlobs().map(\.requestId), ["req-1"])
    }
}

private struct QueuedResponse {
    let body: Data
    let statusCode: Int
}

private final class FrickStreamingURLProtocol: URLProtocol {
    nonisolated(unsafe) private static var lock = NSLock()
    nonisolated(unsafe) private static var responses: [String: [QueuedResponse]] = [:]
    nonisolated(unsafe) private static var failures: [String: [Error]] = [:]
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
        failures = [:]
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

    static func fail(_ error: Error, for path: String) {
        lock.lock()
        failures[path, default: []].append(error)
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
            if var pathFailures = Self.failures[path], !pathFailures.isEmpty {
                let failure = pathFailures.removeFirst()
                Self.failures[path] = pathFailures
                Self.lock.unlock()
                client?.urlProtocol(self, didFailWithError: failure)
                return
            }
            let queued: QueuedResponse?
            if path.hasPrefix("/auth/") || path == "/conversations" || path == "/append" || path == "/analytics/events" {
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

        if request.httpMethod == "PUT" {
            if var pathFailures = Self.failures[path], !pathFailures.isEmpty {
                let failure = pathFailures.removeFirst()
                Self.failures[path] = pathFailures
                Self.lock.unlock()
                client?.urlProtocol(self, didFailWithError: failure)
                return
            }
            var putResponses = Self.responses[path] ?? []
            let putQueued = putResponses.isEmpty ? nil : putResponses.removeFirst()
            Self.responses[path] = putResponses
            Self.lock.unlock()
            let response = HTTPURLResponse(
                url: url,
                statusCode: putQueued?.statusCode ?? 200,
                httpVersion: nil,
                headerFields: ["x-frick-schema-hash": FrickSchema.schemaHash]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if let putQueued {
                client?.urlProtocol(self, didLoad: putQueued.body)
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

/// Stand-in for the removed generated `UserDTO`. Used by the SQLite storage
/// tests to confirm that arbitrary app-owned object payloads round-trip
/// through the framework cache. Apps now define their own `User` shape.
private struct TestUserFixture: Codable, Equatable {
    let id: String
    let displayName: String
    let avatarBlobId: String?
}

private func makeTestClient(
    storage: FrickStorage? = nil,
    telemetry: any FrickClientTelemetryRuntime = FrickNoopClientTelemetryRuntime(),
    requestIdFactory: @escaping @Sendable () -> String = { UUID().uuidString }
) throws -> FrickClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [FrickStreamingURLProtocol.self]
    let session = URLSession(configuration: configuration)
    let resolvedStorage: FrickStorage
    if let storage {
        resolvedStorage = storage
    } else {
        resolvedStorage = try FrickSQLiteStorage(path: ":memory:")
    }
    return FrickClient(
        baseURL: URL(string: "http://frick.test")!,
        session: session,
        streamingSession: session,
        storage: resolvedStorage,
        sessionPersistence: FrickInMemorySessionStore(),
        telemetry: telemetry,
        requestIdFactory: requestIdFactory
    )
}

private func devLoginResponse(userId: String, token: String, tenantId: String? = nil) -> String {
    var fields = [
        #""schemaHash": "\#(FrickSchema.schemaHash)""#,
        #""sessionToken": "\#(token)""#,
        #""userId": "\#(userId)""#,
        #""deviceId": "device-\#(userId)""#,
        #""replicaId": "replica-\#(userId)""#,
        #""expiresAt": "2026-05-09T12:00:00.000Z""#,
    ]
    if let tenantId {
        fields.insert(#""tenantId": "\#(tenantId)""#, at: 2)
    }
    return "{\n" + fields.map { "  \($0)" }.joined(separator: ",\n") + "\n}"
}

private final class RecordingFrickClientTelemetryRuntime: FrickClientTelemetryRuntime, @unchecked Sendable {
    struct Measurement: Equatable {
        let name: String
        let value: Double
        let attributes: [String: FrickClientTelemetryAttributeValue]
    }

    private let traceId: String
    private let lock = NSLock()
    private(set) var startedSpans: [FrickClientTelemetrySpanStart] = []
    private(set) var finishedSpans: [FrickClientTelemetrySpanResult] = []
    private(set) var counters: [Measurement] = []
    private(set) var histograms: [Measurement] = []

    init(traceId: String) {
        self.traceId = traceId
    }

    func startSpan(_ input: FrickClientTelemetrySpanStart) throws -> any FrickClientTelemetrySpan {
        lock.lock()
        startedSpans.append(input)
        lock.unlock()
        return RecordingFrickClientTelemetrySpan(traceId: traceId) { [weak self] result in
            self?.lock.lock()
            self?.finishedSpans.append(result ?? FrickClientTelemetrySpanResult())
            self?.lock.unlock()
        }
    }

    func recordCounter(name: String, value: Double, attributes: [String: FrickClientTelemetryAttributeValue]) throws {
        lock.lock()
        counters.append(Measurement(name: name, value: value, attributes: attributes))
        lock.unlock()
    }

    func recordHistogram(name: String, value: Double, attributes: [String: FrickClientTelemetryAttributeValue]) throws {
        lock.lock()
        histograms.append(Measurement(name: name, value: value, attributes: attributes))
        lock.unlock()
    }
}

private final class RecordingFrickClientTelemetrySpan: FrickClientTelemetrySpan, @unchecked Sendable {
    let traceId: String?

    private let onEnd: @Sendable (FrickClientTelemetrySpanResult?) -> Void

    init(traceId: String?, onEnd: @escaping @Sendable (FrickClientTelemetrySpanResult?) -> Void) {
        self.traceId = traceId
        self.onEnd = onEnd
    }

    func injectHeaders(_ headers: inout [String: String]) throws {
        headers["traceparent"] = "00-\(traceId ?? "missing")-span-01"
    }

    func end(_ result: FrickClientTelemetrySpanResult?) throws {
        onEnd(result)
    }
}

private struct ThrowingFrickClientTelemetryRuntime: FrickClientTelemetryRuntime {
    func startSpan(_ input: FrickClientTelemetrySpanStart) throws -> any FrickClientTelemetrySpan {
        throw TestTelemetryError()
    }

    func recordCounter(name: String, value: Double, attributes: [String: FrickClientTelemetryAttributeValue]) throws {
        throw TestTelemetryError()
    }

    func recordHistogram(name: String, value: Double, attributes: [String: FrickClientTelemetryAttributeValue]) throws {
        throw TestTelemetryError()
    }
}

private struct TestTelemetryError: Error {}

private func createLegacyCacheMetadataDatabase(path: String) throws {
    var database: OpaquePointer?
    let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
    guard sqlite3_open_v2(path, &database, flags, nil) == SQLITE_OK, let database else {
        throw TestSQLiteError.open(database.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown sqlite error")
    }
    defer { sqlite3_close(database) }

    let sql = """
    CREATE TABLE frick_cache_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_id TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      schema_revision INTEGER NOT NULL,
      schema_hash TEXT NOT NULL
    );
    INSERT INTO frick_cache_metadata (id, schema_id, schema_version, schema_revision, schema_hash)
    VALUES (1, '\(FrickSchema.schemaId)', '\(FrickSchema.schemaVersion)', \(FrickSchema.schemaRevision), '\(FrickSchema.schemaHash)');
    """
    var error: UnsafeMutablePointer<CChar>?
    guard sqlite3_exec(database, sql, nil, nil, &error) == SQLITE_OK else {
        let message = error.map { String(cString: $0) } ?? "unknown sqlite error"
        sqlite3_free(error)
        throw TestSQLiteError.exec(message)
    }
}

private enum TestSQLiteError: Error {
    case open(String)
    case exec(String)
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
