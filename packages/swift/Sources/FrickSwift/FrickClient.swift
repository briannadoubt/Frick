import Foundation
import SQLite3

public struct FrickSchemaMismatchError: Error, Equatable, Sendable {
    public let expectedSchemaHash: String
    public let actualSchemaHash: String?
}

public struct ObjectsResponse<Object: Decodable>: Decodable {
    public let schemaHash: String?
    public let type: String?
    public let data: [Object]

    public func requireCompatibleSchema() throws {
        guard schemaHash == nil || schemaHash == FrickSchema.schemaHash else {
            throw FrickSchemaMismatchError(
                expectedSchemaHash: FrickSchema.schemaHash,
                actualSchemaHash: schemaHash
            )
        }
    }
}

public struct StreamEventsResponse: Decodable {
    public let schemaHash: String?
    public let stream: String?
    public let key: String?
    public let data: [FrickStreamEvent]

    public func requireCompatibleSchema() throws {
        guard schemaHash == nil || schemaHash == FrickSchema.schemaHash else {
            throw FrickSchemaMismatchError(
                expectedSchemaHash: FrickSchema.schemaHash,
                actualSchemaHash: schemaHash
            )
        }
    }
}

public struct FrickStreamEvent: Codable, Equatable, Sendable, Identifiable {
    public var id: String { eventId }

    public let stream: String
    public let streamId: String
    public let sequence: Int
    public let eventId: String
    public let event: String
    public let payload: [String: String]

    public init(
        stream: String,
        streamId: String,
        sequence: Int,
        eventId: String,
        event: String,
        payload: [String: String]
    ) {
        self.stream = stream
        self.streamId = streamId
        self.sequence = sequence
        self.eventId = eventId
        self.event = event
        self.payload = payload
    }
}

public struct PendingAppend: Codable, Equatable, Sendable {
    public let requestId: String
    public let body: Data

    public init(requestId: String, body: Data) {
        self.requestId = requestId
        self.body = body
    }
}

public protocol FrickStorage: AnyObject, Sendable {
    func loadObjectData(type: String, id: String) throws -> Data?
    func saveObjectData(type: String, id: String, data: Data, version: Int) throws
    func loadStreamEvents(stream: String, key: String) throws -> [FrickStreamEvent]
    func saveStreamEvent(_ event: FrickStreamEvent) throws
    func loadPendingAppends() throws -> [PendingAppend]
    func appendPendingAppend(_ append: PendingAppend) throws
    func removePendingAppend(requestId: String) throws
}

public final class FrickSQLiteStorage: FrickStorage, @unchecked Sendable {
    public static let appStorage: FrickSQLiteStorage = {
        do {
            return try FrickSQLiteStorage()
        } catch {
            fatalError("Failed to open Frick SQLite storage: \(error)")
        }
    }()

    private let database: OpaquePointer
    private let lock = NSLock()
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public convenience init() throws {
        try self.init(path: FrickSQLiteStorage.defaultPath())
    }

    public init(path: String) throws {
        var pointer: OpaquePointer?
        let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(path, &pointer, flags, nil) == SQLITE_OK, let pointer else {
            throw SQLiteStorageError.open(pointer.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown sqlite error")
        }
        self.database = pointer
        try exec("PRAGMA journal_mode = WAL")
        try exec("PRAGMA synchronous = NORMAL")
        try exec("""
            CREATE TABLE IF NOT EXISTS local_objects (
              object_type TEXT NOT NULL,
              object_id TEXT NOT NULL,
              json BLOB NOT NULL,
              version INTEGER NOT NULL,
              PRIMARY KEY (object_type, object_id)
            );
            CREATE TABLE IF NOT EXISTS local_stream_events (
              stream_type TEXT NOT NULL,
              stream_key TEXT NOT NULL,
              sequence INTEGER NOT NULL,
              event_id TEXT NOT NULL UNIQUE,
              json BLOB NOT NULL,
              PRIMARY KEY (stream_type, stream_key, sequence)
            );
            CREATE TABLE IF NOT EXISTS pending_appends (
              request_id TEXT PRIMARY KEY NOT NULL,
              body BLOB NOT NULL,
              created_at INTEGER NOT NULL
            );
            """)
    }

    deinit {
        sqlite3_close(database)
    }

    public func loadObjectData(type: String, id: String) throws -> Data? {
        lock.lock()
        defer { lock.unlock() }
        let rows = try query(
            "SELECT json FROM local_objects WHERE object_type = ? AND object_id = ? LIMIT 1",
            bindings: [.text(type), .text(id)]
        )
        return rows.first?.first?.data
    }

    public func saveObjectData(type: String, id: String, data: Data, version: Int) throws {
        lock.lock()
        defer { lock.unlock() }
        try run(
            """
            INSERT OR REPLACE INTO local_objects (object_type, object_id, json, version)
            VALUES (?, ?, ?, ?)
            """,
            bindings: [.text(type), .text(id), .data(data), .int(version)]
        )
    }

    public func loadStreamEvents(stream: String, key: String) throws -> [FrickStreamEvent] {
        lock.lock()
        defer { lock.unlock() }
        return try query(
            """
            SELECT json FROM local_stream_events
            WHERE stream_type = ? AND stream_key = ?
            ORDER BY sequence ASC
            """,
            bindings: [.text(stream), .text(key)]
        ).compactMap { row in
            guard let data = row.first?.data else {
                return nil
            }
            return try decoder.decode(FrickStreamEvent.self, from: data)
        }
    }

    public func saveStreamEvent(_ event: FrickStreamEvent) throws {
        let data = try encoder.encode(event)
        lock.lock()
        defer { lock.unlock() }
        try run(
            """
            INSERT OR REPLACE INTO local_stream_events
              (stream_type, stream_key, sequence, event_id, json)
            VALUES (?, ?, ?, ?, ?)
            """,
            bindings: [
                .text(event.stream),
                .text(event.streamId),
                .int(event.sequence),
                .text(event.eventId),
                .data(data),
            ]
        )
    }

    public func loadPendingAppends() throws -> [PendingAppend] {
        lock.lock()
        defer { lock.unlock() }
        return try query(
            "SELECT request_id, body FROM pending_appends ORDER BY created_at ASC",
            bindings: []
        ).compactMap { row in
            guard let requestId = row[0].text, let body = row[1].data else {
                return nil
            }
            return PendingAppend(requestId: requestId, body: body)
        }
    }

    public func appendPendingAppend(_ append: PendingAppend) throws {
        lock.lock()
        defer { lock.unlock() }
        try run(
            """
            INSERT OR IGNORE INTO pending_appends (request_id, body, created_at)
            VALUES (?, ?, ?)
            """,
            bindings: [.text(append.requestId), .data(append.body), .int(Int(Date().timeIntervalSince1970 * 1000))]
        )
    }

    public func removePendingAppend(requestId: String) throws {
        lock.lock()
        defer { lock.unlock() }
        try run(
            "DELETE FROM pending_appends WHERE request_id = ?",
            bindings: [.text(requestId)]
        )
    }

    private static func defaultPath() -> String {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let directory = root.appending(path: "Frick")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appending(path: "frick.sqlite").path
    }

    private func exec(_ sql: String) throws {
        lock.lock()
        defer { lock.unlock() }
        var error: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(database, sql, nil, nil, &error) == SQLITE_OK else {
            let message = error.map { String(cString: $0) } ?? "unknown sqlite error"
            sqlite3_free(error)
            throw SQLiteStorageError.exec(message)
        }
    }

    private func run(_ sql: String, bindings: [SQLiteBinding]) throws {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw SQLiteStorageError.prepare(lastErrorMessage())
        }
        defer { sqlite3_finalize(statement) }
        try bind(bindings, to: statement)
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw SQLiteStorageError.step(lastErrorMessage())
        }
    }

    private func query(_ sql: String, bindings: [SQLiteBinding]) throws -> [[SQLiteValue]] {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw SQLiteStorageError.prepare(lastErrorMessage())
        }
        defer { sqlite3_finalize(statement) }
        try bind(bindings, to: statement)

        var rows: [[SQLiteValue]] = []
        while true {
            let result = sqlite3_step(statement)
            if result == SQLITE_DONE {
                return rows
            }
            guard result == SQLITE_ROW else {
                throw SQLiteStorageError.step(lastErrorMessage())
            }
            let columnCount = sqlite3_column_count(statement)
            rows.append((0..<columnCount).map { index in
                switch sqlite3_column_type(statement, index) {
                case SQLITE_INTEGER:
                    return .int(Int(sqlite3_column_int64(statement, index)))
                case SQLITE_BLOB:
                    let size = Int(sqlite3_column_bytes(statement, index))
                    guard let bytes = sqlite3_column_blob(statement, index) else {
                        return .data(Data())
                    }
                    return .data(Data(bytes: bytes, count: size))
                case SQLITE_TEXT:
                    guard let text = sqlite3_column_text(statement, index) else {
                        return .text("")
                    }
                    return .text(String(cString: text))
                default:
                    return .null
                }
            })
        }
    }

    private func bind(_ bindings: [SQLiteBinding], to statement: OpaquePointer) throws {
        for (index, binding) in bindings.enumerated() {
            let sqliteIndex = Int32(index + 1)
            let result: Int32
            switch binding {
            case let .text(value):
                result = sqlite3_bind_text(statement, sqliteIndex, value, -1, SQLITE_TRANSIENT)
            case let .data(value):
                result = value.withUnsafeBytes { bytes in
                    sqlite3_bind_blob(statement, sqliteIndex, bytes.baseAddress, Int32(value.count), SQLITE_TRANSIENT)
                }
            case let .int(value):
                result = sqlite3_bind_int64(statement, sqliteIndex, sqlite3_int64(value))
            }
            guard result == SQLITE_OK else {
                throw SQLiteStorageError.bind(lastErrorMessage())
            }
        }
    }

    private func lastErrorMessage() -> String {
        String(cString: sqlite3_errmsg(database))
    }
}

public enum SQLiteStorageError: Error, Equatable, Sendable {
    case open(String)
    case exec(String)
    case prepare(String)
    case bind(String)
    case step(String)
}

private enum SQLiteBinding {
    case text(String)
    case data(Data)
    case int(Int)
}

private enum SQLiteValue {
    case text(String)
    case data(Data)
    case int(Int)
    case null

    var text: String? {
        if case let .text(value) = self { return value }
        return nil
    }

    var data: Data? {
        if case let .data(value) = self { return value }
        return nil
    }
}

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

public struct AppendRequest: Encodable, Sendable {
    public let requestId: String
    public let replicaId: String
    public let stream: String
    public let key: String
    public let event: String
    public let payload: [String: String]
}

public struct FrickEvent: Equatable, Sendable {
    public let event: String
    public let data: String
}

public struct FrickEventStreamParser: Sendable {
    private var buffer = ""

    public init() {}

    public mutating func push(_ chunk: String) -> [FrickEvent] {
        buffer += chunk.replacingOccurrences(of: "\r\n", with: "\n")
        var events: [FrickEvent] = []

        while let range = buffer.range(of: "\n\n") {
            let rawEvent = String(buffer[..<range.lowerBound])
            buffer.removeSubrange(buffer.startIndex..<range.upperBound)

            if let event = Self.parse(rawEvent) {
                events.append(event)
            }
        }

        return events
    }

    private static func parse(_ rawEvent: String) -> FrickEvent? {
        var eventName = "message"
        var dataLines: [String] = []

        for line in rawEvent.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.isEmpty || line.hasPrefix(":") {
                continue
            }
            if line.hasPrefix("event:") {
                eventName = String(line.dropFirst("event:".count)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                dataLines.append(String(line.dropFirst("data:".count)).trimmingCharacters(in: .whitespaces))
            }
        }

        guard !dataLines.isEmpty else {
            return nil
        }
        return FrickEvent(event: eventName, data: dataLines.joined(separator: "\n"))
    }
}

private func makeFrickStreamingSession() -> URLSession {
    let configuration = URLSessionConfiguration.default
    configuration.timeoutIntervalForRequest = 7 * 24 * 60 * 60
    configuration.timeoutIntervalForResource = 7 * 24 * 60 * 60
    configuration.waitsForConnectivity = true
    return URLSession(configuration: configuration)
}

public final class FrickClient: Sendable {
    private let baseURL: URL
    private let session: URLSession
    private let streamingSession: URLSession
    private let replicaId: String
    private let storage: FrickStorage
    private let requestIdFactory: @Sendable () -> String
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(
        baseURL: URL = URL(string: "http://127.0.0.1:4099")!,
        session: URLSession = .shared,
        streamingSession: URLSession? = nil,
        replicaId: String = "ios-demo",
        storage: FrickStorage = FrickSQLiteStorage.appStorage,
        requestIdFactory: @escaping @Sendable () -> String = { UUID().uuidString }
    ) {
        self.baseURL = baseURL
        self.session = session
        self.streamingSession = streamingSession ?? makeFrickStreamingSession()
        self.replicaId = replicaId
        self.storage = storage
        self.requestIdFactory = requestIdFactory
    }

    public func fetchUsers() async throws -> [UserDTO] {
        try await fetchObjects(type: "User")
    }

    public func fetchConversations() async throws -> [ConversationDTO] {
        try await fetchObjects(type: "Conversation")
    }

    public func fetchObjects<Object: Codable & Sendable>(type: String) async throws -> [Object] {
        try? await flushPendingAppends()
        let url = queryURL(path: "/objects", args: ["type": type])
        let (data, response) = try await session.data(from: url)
        try validate(response)
        let decoded = try decoder.decode(ObjectsResponse<Object>.self, from: data)
        try decoded.requireCompatibleSchema()
        for object in decoded.data {
            if let id = extractId(from: object) {
                try storage.saveObjectData(type: type, id: id, data: encoder.encode(object), version: 0)
            }
        }
        return decoded.data
    }

    public func fetchMessages(conversationId: String = "conversation-general") async throws -> [FrickStreamEvent] {
        try? await flushPendingAppends()
        let url = baseURL
            .appending(path: "streams")
            .appending(path: "MessageStream")
            .appending(path: conversationId)
        do {
            let (data, response) = try await session.data(from: url)
            try validate(response)
            let decoded = try decoder.decode(StreamEventsResponse.self, from: data)
            try decoded.requireCompatibleSchema()
            for event in decoded.data {
                try storage.saveStreamEvent(event)
            }
            return decoded.data
        } catch {
            let cached = try storage.loadStreamEvents(stream: "MessageStream", key: conversationId)
            if cached.isEmpty {
                throw error
            }
            return cached
        }
    }

    public func streamMessages(
        conversationId: String = "conversation-general"
    ) -> AsyncThrowingStream<[FrickStreamEvent], Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var current = try storage.loadStreamEvents(stream: "MessageStream", key: conversationId)
                    if !current.isEmpty {
                        continuation.yield(current)
                    }
                    try? await flushPendingAppends()

                    let after = current.map(\.sequence).max() ?? 0
                    let (bytes, response) = try await streamingSession.bytes(from: streamEventsURL(
                        stream: "MessageStream",
                        key: conversationId,
                        after: after
                    ))
                    try validate(response)

                    var parser = FrickEventStreamParser()
                    for try await line in bytes.lines {
                        for event in parser.push(line + "\n") where event.event == "stream-page" || event.event == "delta" {
                            let decoded = try decoder.decode(StreamEventsResponse.self, from: Data(event.data.utf8))
                            try decoded.requireCompatibleSchema()
                            for streamEvent in decoded.data {
                                try storage.saveStreamEvent(streamEvent)
                            }
                            current = mergeStreamEvents(current, decoded.data)
                            continuation.yield(current)
                        }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    public func sendMessage(
        conversationId: String = "conversation-general",
        senderId: String = "user-ada",
        body: String
    ) async throws {
        try await append(
            stream: "MessageStream",
            key: conversationId,
            event: "MessageSent",
            payload: [
                "messageId": "message-\(UUID().uuidString)",
                "senderId": senderId,
                "body": body,
                "createdAt": ISO8601DateFormatter().string(from: Date()),
            ]
        )
    }

    public func append(stream: String, key: String, event: String, payload: [String: String]) async throws {
        let requestId = requestIdFactory()
        let body = try encoder.encode(
            AppendRequest(
                requestId: requestId,
                replicaId: replicaId,
                stream: stream,
                key: key,
                event: event,
                payload: payload
            )
        )
        let append = PendingAppend(requestId: requestId, body: body)

        do {
            try await sendAppend(append)
        } catch {
            if shouldQueueAppend(error) {
                try storage.appendPendingAppend(append)
                return
            }
            throw error
        }
    }

    public func flushPendingAppends() async throws {
        for append in try storage.loadPendingAppends() {
            try await sendAppend(append)
            try storage.removePendingAppend(requestId: append.requestId)
        }
    }

    private func sendAppend(_ append: PendingAppend) async throws {
        var request = URLRequest(url: baseURL.appending(path: "/append"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = append.body

        let (_, response) = try await session.data(for: request)
        try validate(response)
    }

    private func shouldQueueAppend(_ error: Error) -> Bool {
        if error is FrickSchemaMismatchError {
            return false
        }
        if let urlError = error as? URLError, urlError.code == .badServerResponse {
            return false
        }
        return true
    }

    private func queryURL(path: String, args: [String: String]) -> URL {
        var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        components.queryItems = args
            .sorted { left, right in left.key < right.key }
            .map { key, value in URLQueryItem(name: key, value: value) }
        return components.url!
    }

    private func streamEventsURL(stream: String, key: String, after: Int) -> URL {
        var components = URLComponents(
            url: baseURL
                .appending(path: "streams")
                .appending(path: stream)
                .appending(path: key)
                .appending(path: "events"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "after", value: String(after))]
        return components.url!
    }

    private func validate(_ response: URLResponse) throws {
        guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
            throw URLError(.badServerResponse)
        }
        let hashHeader = httpResponse.value(forHTTPHeaderField: "X-Frick-Schema-Hash")
        guard hashHeader == nil || hashHeader == FrickSchema.schemaHash else {
            throw FrickSchemaMismatchError(
                expectedSchemaHash: FrickSchema.schemaHash,
                actualSchemaHash: hashHeader
            )
        }
    }
}

private func extractId<Object: Encodable>(from object: Object) -> String? {
    guard let data = try? JSONEncoder().encode(object),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return nil
    }
    return json["id"] as? String
}

private func mergeStreamEvents(_ current: [FrickStreamEvent], _ next: [FrickStreamEvent]) -> [FrickStreamEvent] {
    var eventsById = Dictionary(uniqueKeysWithValues: current.map { ($0.eventId, $0) })
    for event in next {
        eventsById[event.eventId] = event
    }
    return eventsById.values.sorted { left, right in
        left.sequence < right.sequence
    }
}
