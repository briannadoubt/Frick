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

public struct FrickSession: Codable, Equatable, Sendable {
    public let schemaHash: String?
    public let sessionToken: String
    public let userId: String
    public let displayName: String?
    public let handle: String?
    public let deviceId: String
    public let replicaId: String
    public let expiresAt: String

    public init(
        schemaHash: String?,
        sessionToken: String,
        userId: String,
        displayName: String? = nil,
        handle: String? = nil,
        deviceId: String,
        replicaId: String,
        expiresAt: String
    ) {
        self.schemaHash = schemaHash
        self.sessionToken = sessionToken
        self.userId = userId
        self.displayName = displayName
        self.handle = handle
        self.deviceId = deviceId
        self.replicaId = replicaId
        self.expiresAt = expiresAt
    }

    public func requireCompatibleSchema() throws {
        guard schemaHash == nil || schemaHash == FrickSchema.schemaHash else {
            throw FrickSchemaMismatchError(
                expectedSchemaHash: FrickSchema.schemaHash,
                actualSchemaHash: schemaHash
            )
        }
    }
}

public struct SignalsResponse: Decodable {
    public let schemaHash: String?
    public let name: String?
    public let key: String?
    public let data: [[String: String]]

    private enum CodingKeys: String, CodingKey {
        case schemaHash
        case name
        case key
        case data
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaHash = try container.decodeIfPresent(String.self, forKey: .schemaHash)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        key = try container.decodeIfPresent(String.self, forKey: .key)
        let decodedData = try container.decode([[String: FrickPayloadValue]].self, forKey: .data)
        data = decodedData.map { item in
            item.mapValues(\.stringValue)
        }
    }

    public func requireCompatibleSchema() throws {
        guard schemaHash == nil || schemaHash == FrickSchema.schemaHash else {
            throw FrickSchemaMismatchError(
                expectedSchemaHash: FrickSchema.schemaHash,
                actualSchemaHash: schemaHash
            )
        }
    }
}

public struct InboxResponse: Decodable {
    public let schemaHash: String?
    public let data: [FrickInboxItem]

    public func requireCompatibleSchema() throws {
        guard schemaHash == nil || schemaHash == FrickSchema.schemaHash else {
            throw FrickSchemaMismatchError(
                expectedSchemaHash: FrickSchema.schemaHash,
                actualSchemaHash: schemaHash
            )
        }
    }
}

public struct CreatedConversationResponse: Decodable, Equatable, Sendable {
    public let schemaHash: String?
    public let conversation: ConversationDTO
    public let member: RoomMemberDTO
    public let members: [RoomMemberDTO]

    public func requireCompatibleSchema() throws {
        guard schemaHash == nil || schemaHash == FrickSchema.schemaHash else {
            throw FrickSchemaMismatchError(
                expectedSchemaHash: FrickSchema.schemaHash,
                actualSchemaHash: schemaHash
            )
        }
    }
}

public struct FrickInboxItem: Codable, Equatable, Sendable, Identifiable {
    public var id: String { conversationId }

    public let conversationId: String
    public let userId: String?
    public let title: String?
    public let kind: String?
    public let lastSequence: Int
    public let lastMessageBody: String?
    public let lastMessageSenderId: String?
    public let readSequence: Int
    public let unreadCount: Int

    public init(
        conversationId: String,
        userId: String?,
        title: String?,
        kind: String?,
        lastSequence: Int,
        lastMessageBody: String?,
        lastMessageSenderId: String?,
        readSequence: Int,
        unreadCount: Int
    ) {
        self.conversationId = conversationId
        self.userId = userId
        self.title = title
        self.kind = kind
        self.lastSequence = lastSequence
        self.lastMessageBody = lastMessageBody
        self.lastMessageSenderId = lastMessageSenderId
        self.readSequence = readSequence
        self.unreadCount = unreadCount
    }
}

/// Single search hit returned from `FrickClient.search(...)`.
public struct FrickSearchHit: Codable, Equatable, Sendable, Identifiable {
    public var id: String { docId }
    public let docId: String
    public let score: Double
    /// Highlighted / projected fields, keyed by the index's projection
    /// schema. Stringified so the SDK doesn't have to know the field types
    /// at compile time.
    public let fields: [String: String]

    public init(docId: String, score: Double, fields: [String: String] = [:]) {
        self.docId = docId
        self.score = score
        self.fields = fields
    }
}

/// Response envelope from the server's `/search` route. Mirrors the
/// Kotlin `FrickSearchResponse` and the TS `SearchResponse`.
public struct FrickSearchResponse: Codable, Equatable, Sendable {
    public let schemaHash: String?
    public let index: String
    public let total: Int
    public let hits: [FrickSearchHit]

    public init(schemaHash: String? = nil, index: String, total: Int, hits: [FrickSearchHit]) {
        self.schemaHash = schemaHash
        self.index = index
        self.total = total
        self.hits = hits
    }
}

public struct FrickBlobMetadata: Codable, Equatable, Sendable, Identifiable {
    public var id: String { blobId }

    public let blobId: String
    public let ownerId: String
    public let contentHash: String
    public let byteLength: Int
    public let mimeType: String
    public let storageKey: String?
    public let createdAt: String?

    public init(
        blobId: String,
        ownerId: String,
        contentHash: String,
        byteLength: Int,
        mimeType: String,
        storageKey: String?,
        createdAt: String?
    ) {
        self.blobId = blobId
        self.ownerId = ownerId
        self.contentHash = contentHash
        self.byteLength = byteLength
        self.mimeType = mimeType
        self.storageKey = storageKey
        self.createdAt = createdAt
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

    private enum CodingKeys: String, CodingKey {
        case stream
        case streamId
        case sequence
        case eventId
        case event
        case payload
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        stream = try container.decode(String.self, forKey: .stream)
        streamId = try container.decode(String.self, forKey: .streamId)
        sequence = try container.decode(Int.self, forKey: .sequence)
        eventId = try container.decode(String.self, forKey: .eventId)
        event = try container.decode(String.self, forKey: .event)
        let decodedPayload = try container.decode([String: FrickPayloadValue].self, forKey: .payload)
        payload = decodedPayload.mapValues(\.stringValue)
    }
}

public extension FrickStreamEvent {
    var isVisibleChatMessage: Bool {
        event == "MessageSent" && !(payload["body"]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    }
}

private enum FrickPayloadValue: Decodable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case array([FrickPayloadValue])
    case object([String: FrickPayloadValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode(Int.self) {
            self = .int(value)
        } else if let value = try? container.decode(Double.self) {
            self = .double(value)
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode([FrickPayloadValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: FrickPayloadValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.typeMismatch(
                FrickPayloadValue.self,
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Unsupported JSON payload value")
            )
        }
    }

    var stringValue: String {
        switch self {
        case .string(let value):
            return value
        case .int(let value):
            return String(value)
        case .double(let value):
            return String(value)
        case .bool(let value):
            return String(value)
        case .array, .object:
            return jsonString
        case .null:
            return ""
        }
    }

    private var jsonString: String {
        guard
            JSONSerialization.isValidJSONObject(jsonObject),
            let data = try? JSONSerialization.data(withJSONObject: jsonObject, options: [.sortedKeys]),
            let value = String(data: data, encoding: .utf8)
        else {
            return ""
        }
        return value
    }

    private var jsonObject: Any {
        switch self {
        case .string(let value):
            return value
        case .int(let value):
            return value
        case .double(let value):
            return value
        case .bool(let value):
            return value
        case .array(let values):
            return values.map(\.jsonObject)
        case .object(let value):
            return value.mapValues(\.jsonObject)
        case .null:
            return NSNull()
        }
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
    func clearPendingAppends() throws
    func loadCacheMetadata() throws -> FrickCacheMetadata?
    func saveCacheMetadata(_ metadata: FrickCacheMetadata) throws
    func clearCache() throws
}

public extension FrickStorage {
    func clearPendingAppends() throws {
        for append in try loadPendingAppends() {
            try removePendingAppend(requestId: append.requestId)
        }
    }
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
            CREATE TABLE IF NOT EXISTS frick_cache_metadata (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              schema_id TEXT NOT NULL,
              schema_version TEXT NOT NULL,
              schema_revision INTEGER NOT NULL,
              schema_hash TEXT NOT NULL
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

    public func clearPendingAppends() throws {
        lock.lock()
        defer { lock.unlock() }
        try run("DELETE FROM pending_appends", bindings: [])
    }

    public func loadCacheMetadata() throws -> FrickCacheMetadata? {
        lock.lock()
        defer { lock.unlock() }
        let rows = try query(
            "SELECT schema_id, schema_version, schema_revision, schema_hash FROM frick_cache_metadata WHERE id = 1 LIMIT 1",
            bindings: []
        )
        guard let row = rows.first,
              let schemaId = row[0].text,
              let schemaVersion = row[1].text,
              let schemaRevision = row[2].intValue,
              let schemaHash = row[3].text else {
            return nil
        }
        return FrickCacheMetadata(
            schemaId: schemaId,
            schemaVersion: schemaVersion,
            schemaRevision: schemaRevision,
            schemaHash: schemaHash
        )
    }

    public func saveCacheMetadata(_ metadata: FrickCacheMetadata) throws {
        lock.lock()
        defer { lock.unlock() }
        try run(
            """
            INSERT INTO frick_cache_metadata (id, schema_id, schema_version, schema_revision, schema_hash)
            VALUES (1, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              schema_id = excluded.schema_id,
              schema_version = excluded.schema_version,
              schema_revision = excluded.schema_revision,
              schema_hash = excluded.schema_hash
            """,
            bindings: [
                .text(metadata.schemaId),
                .text(metadata.schemaVersion),
                .int(metadata.schemaRevision),
                .text(metadata.schemaHash),
            ]
        )
    }

    public func clearCache() throws {
        lock.lock()
        defer { lock.unlock() }
        try run("DELETE FROM local_objects", bindings: [])
        try run("DELETE FROM local_stream_events", bindings: [])
        try run("DELETE FROM pending_appends", bindings: [])
        try run("DELETE FROM frick_cache_metadata", bindings: [])
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

    var intValue: Int? {
        if case let .int(value) = self { return value }
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

private final class ReadReceiptTracker: @unchecked Sendable {
    private let lock = NSLock()
    private var sequences: [String: Int] = [:]

    func shouldAdvance(userId: String, conversationId: String, sequence: Int) -> Bool {
        guard sequence > 0 else {
            return false
        }
        let key = "\(userId):\(conversationId)"
        lock.lock()
        defer { lock.unlock() }
        if sequence <= (sequences[key] ?? 0) {
            return false
        }
        sequences[key] = sequence
        return true
    }
}

private final class FrickSessionStore: @unchecked Sendable {
    private let lock = NSLock()
    private var storedSession: FrickSession?

    var session: FrickSession? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return storedSession
        }
        set {
            lock.lock()
            storedSession = newValue
            lock.unlock()
        }
    }
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
    configuration.waitsForConnectivity = false
    return URLSession(configuration: configuration)
}

public final class FrickClient: Sendable {
    public static let localDevelopmentBaseURL = URL(string: "http://127.0.0.1:4099")!
    public static let secureLocalBaseURL = URL(string: "https://127.0.0.1:4099")!

    public static var defaultBaseURL: URL {
        #if DEBUG
        localDevelopmentBaseURL
        #else
        secureLocalBaseURL
        #endif
    }

    public static var defaultAllowsInsecureLocalTransport: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }

    private let baseURL: URL
    private let session: URLSession
    private let streamingSession: URLSession
    private let streamReconnectDelayNanoseconds: UInt64
    private let replicaId: String
    private let storage: FrickStorage
    private let requestIdFactory: @Sendable () -> String
    private let readReceiptTracker = ReadReceiptTracker()
    private let sessionStore = FrickSessionStore()
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(
        baseURL: URL = FrickClient.defaultBaseURL,
        session: URLSession = .shared,
        streamingSession: URLSession? = nil,
        streamReconnectDelayNanoseconds: UInt64 = 250_000_000,
        replicaId: String = "ios-demo",
        storage: FrickStorage = FrickSQLiteStorage.appStorage,
        allowInsecureLocalTransport: Bool = FrickClient.defaultAllowsInsecureLocalTransport,
        requestIdFactory: @escaping @Sendable () -> String = { UUID().uuidString }
    ) {
        Self.validateBaseURL(baseURL, allowInsecureLocalTransport: allowInsecureLocalTransport)
        self.baseURL = baseURL
        self.session = session
        self.streamingSession = streamingSession ?? makeFrickStreamingSession()
        self.streamReconnectDelayNanoseconds = streamReconnectDelayNanoseconds
        self.replicaId = replicaId
        self.storage = storage
        self.requestIdFactory = requestIdFactory
    }

    public var currentSession: FrickSession? {
        sessionStore.session
    }

    @discardableResult
    public func verifyCacheCompatibility(
        currentMetadata: FrickCacheMetadata = .currentSchema,
        minimumClientRevision: Int = FrickSchema.minimumClientRevision
    ) throws -> FrickCacheMetadata {
        if let cached = try storage.loadCacheMetadata() {
            if let reason = FrickCacheCompatibility.reason(
                cached: cached,
                current: currentMetadata,
                minimumClientRevision: minimumClientRevision
            ) {
                throw FrickCacheIncompatibleError(
                    reason: reason,
                    cachedMetadata: cached,
                    currentMetadata: currentMetadata,
                    minimumClientRevision: minimumClientRevision,
                    pendingAppendCount: (try? storage.loadPendingAppends().count) ?? 0
                )
            }
        }
        try storage.saveCacheMetadata(currentMetadata)
        return currentMetadata
    }

    public func resetCache() throws {
        try storage.clearCache()
    }

    /// Open a sync WebSocket against `baseURL` (defaults to the client's
    /// configured `baseURL`). Callers must hold a session. The active
    /// session token is sent in the Authorization header and in the
    /// WebSocket Hello payload.
    /// Cache compatibility is verified up-front; throws
    /// `FrickCacheIncompatibleError` if the local cache is stale.
    public func connectSync(baseURL: URL? = nil) throws -> FrickSyncSocket {
        guard let session = currentSession else {
            throw FrickSyncSocketError.notConnected
        }
        _ = try verifyCacheCompatibility()
        let socket = FrickSyncSocket(
            baseURL: baseURL ?? self.baseURL,
            sessionToken: session.sessionToken,
            clientCapabilities: .defaultIOS(),
            replicaId: replicaId,
            deviceId: session.deviceId
        )
        Task { await socket.connect() }
        return socket
    }

    public func signOut() {
        try? storage.clearPendingAppends()
        sessionStore.session = nil
    }

    public func devLogin(
        userId: String,
        deviceId: String? = nil,
        replicaId: String? = nil,
        platform: String? = nil
    ) async throws -> FrickSession {
        var request = URLRequest(url: baseURL.appending(path: "auth").appending(path: "dev-login"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try encoder.encode(
            DevLoginRequest(
                userId: userId,
                deviceId: deviceId,
                replicaId: replicaId,
                platform: platform
            )
        )

        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        let frickSession = try decoder.decode(FrickSession.self, from: data)
        try frickSession.requireCompatibleSchema()
        sessionStore.session = frickSession
        return frickSession
    }

    public func signUp(
        displayName: String,
        handle: String,
        password: String,
        deviceId: String? = nil,
        replicaId: String? = nil,
        platform: String? = nil
    ) async throws -> FrickSession {
        try await postAuthSession(
            path: "signup",
            body: AuthSignupRequest(
                displayName: displayName,
                handle: handle,
                password: password,
                deviceId: deviceId,
                replicaId: replicaId,
                platform: platform
            )
        )
    }

    public func login(
        identity: String,
        password: String,
        deviceId: String? = nil,
        replicaId: String? = nil,
        platform: String? = nil
    ) async throws -> FrickSession {
        try await postAuthSession(
            path: "login",
            body: AuthLoginRequest(
                identity: identity,
                password: password,
                deviceId: deviceId,
                replicaId: replicaId,
                platform: platform
            )
        )
    }

    public func fetchUsers() async throws -> [UserDTO] {
        try await fetchObjects(type: "User")
    }

    public func fetchConversations() async throws -> [ConversationDTO] {
        try await fetchObjects(type: "Conversation")
    }

    public func fetchRoomMembers() async throws -> [RoomMemberDTO] {
        try await fetchObjects(type: "RoomMember")
    }

    public func createConversation(
        title: String? = nil,
        kind: String = "group",
        participantUserIds: [String] = []
    ) async throws -> CreatedConversationResponse {
        var request = URLRequest(url: baseURL.appending(path: "conversations"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try encoder.encode(ConversationCreateRequest(
            title: title,
            kind: kind,
            participantUserIds: participantUserIds
        ))
        authenticate(&request)

        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        let created = try decoder.decode(CreatedConversationResponse.self, from: data)
        try created.requireCompatibleSchema()
        try storage.saveObjectData(type: "Conversation", id: created.conversation.id, data: encoder.encode(created.conversation), version: 0)
        for member in created.members {
            try storage.saveObjectData(type: "RoomMember", id: member.id, data: encoder.encode(member), version: 0)
        }
        return created
    }

    public func fetchInbox(userId: String? = nil) async throws -> [FrickInboxItem] {
        try? await flushPendingAppends()
        let resolvedUserId = try userId ?? requireAuthenticatedSession().userId
        let url = queryURL(path: "/inbox", args: ["userId": resolvedUserId])
        do {
            let (data, response) = try await session.data(for: authenticatedRequest(url: url))
            try validate(response, data: data)
            let decoded = try decoder.decode(InboxResponse.self, from: data)
            try decoded.requireCompatibleSchema()
            return decoded.data
        } catch {
            if shouldReturnEmptyRead(error) {
                return []
            }
            throw error
        }
    }

    public func fetchBlobMetadata(blobId: String) async throws -> FrickBlobMetadata? {
        do {
            let (data, response) = try await session.data(for: authenticatedRequest(
                url: baseURL.appending(path: "blobs").appending(path: blobId)
            ))
            try validate(response, data: data)
            return try decoder.decode(FrickBlobMetadata.self, from: data)
        } catch {
            if shouldReturnEmptyRead(error) {
                return nil
            }
            throw error
        }
    }

    public func uploadBlobContent(
        blobId: String,
        ownerId: String,
        mimeType: String,
        data: Data
    ) async throws -> FrickBlobMetadata {
        var components = URLComponents(url: blobContentURL(blobId: blobId), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "ownerId", value: ownerId)]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "PUT"
        request.setValue(mimeType, forHTTPHeaderField: "content-type")
        request.httpBody = data
        authenticate(&request)

        let (responseData, response) = try await session.data(for: request)
        try validate(response, data: responseData)
        return try decoder.decode(FrickBlobMetadata.self, from: responseData)
    }

    public func downloadBlobContent(blobId: String) async throws -> Data? {
        do {
            let (data, response) = try await session.data(for: authenticatedRequest(url: blobContentURL(blobId: blobId)))
            try validate(response, data: data)
            return data
        } catch {
            if shouldReturnEmptyRead(error) {
                return nil
            }
            throw error
        }
    }

    /// Full-text search via the server's `/search` route. `index` is the
    /// FTS index name (e.g. `"messages-fts"`). `filter` is an optional
    /// scope-narrowing map (e.g. `["conversationId": "abc"]`). Mirrors
    /// the Kotlin `FrickClient.search(...)` and TS `searchMessages`
    /// helpers — one canonical search call across every SDK.
    public func search(
        index: String,
        q: String,
        filter: [String: String]? = nil,
        limit: Int = 50
    ) async throws -> FrickSearchResponse {
        let body = SearchRequestBody(index: index, q: q, limit: limit, filter: filter)
        var request = URLRequest(url: baseURL.appendingPathComponent("/search"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try encoder.encode(body)
        authenticate(&request)
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(FrickSearchResponse.self, from: data)
    }

    private struct SearchRequestBody: Encodable {
        let index: String
        let q: String
        let limit: Int
        let filter: [String: String]?
    }

    public func sendSignal<Value: Encodable & Sendable>(
        name: String,
        key: String,
        value: Value
    ) async throws {
        var request = URLRequest(url: signalURL(name: name, key: key))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try encoder.encode(value)
        authenticate(&request)

        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
    }

    public func drainSignals(name: String, key: String) async throws -> [[String: String]] {
        do {
            let (data, response) = try await session.data(for: authenticatedRequest(url: signalURL(name: name, key: key)))
            try validate(response, data: data)
            let decoded = try decoder.decode(SignalsResponse.self, from: data)
            try decoded.requireCompatibleSchema()
            return decoded.data
        } catch {
            if shouldReturnEmptyRead(error) {
                return []
            }
            throw error
        }
    }

    public func fetchObjects<Object: Codable & Sendable>(type: String) async throws -> [Object] {
        try? await flushPendingAppends()
        let url = queryURL(path: "/objects", args: ["type": type])
        let (data, response) = try await session.data(for: authenticatedRequest(url: url))
        try validate(response, data: data)
        let decoded = try decoder.decode(ObjectsResponse<Object>.self, from: data)
        try decoded.requireCompatibleSchema()
        for object in decoded.data {
            if let id = extractId(from: object) {
                try storage.saveObjectData(type: type, id: id, data: encoder.encode(object), version: 0)
            }
        }
        return decoded.data
    }

    public func fetchMessages(
        conversationId: String = "conversation-general",
        readUserId: String? = nil
    ) async throws -> [FrickStreamEvent] {
        try? await flushPendingAppends()
        let url = baseURL
            .appending(path: "streams")
            .appending(path: "MessageStream")
            .appending(path: conversationId)
        do {
            let (data, response) = try await session.data(for: authenticatedRequest(url: url))
            try validate(response, data: data)
            let decoded = try decoder.decode(StreamEventsResponse.self, from: data)
            try decoded.requireCompatibleSchema()
            for event in decoded.data {
                try storage.saveStreamEvent(event)
            }
            try await advanceReadReceiptIfNeeded(
                conversationId: conversationId,
                userId: readUserId,
                events: decoded.data
            )
            return decoded.data
        } catch {
            let cached = try storage.loadStreamEvents(stream: "MessageStream", key: conversationId)
            if cached.isEmpty {
                throw error
            }
            try await advanceReadReceiptIfNeeded(
                conversationId: conversationId,
                userId: readUserId,
                events: cached
            )
            return cached
        }
    }

    public func streamMessages(
        conversationId: String = "conversation-general",
        readUserId: String? = nil
    ) -> AsyncThrowingStream<[FrickStreamEvent], Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var current = try storage.loadStreamEvents(stream: "MessageStream", key: conversationId)
                    if !current.isEmpty {
                        continuation.yield(current)
                        try await advanceReadReceiptIfNeeded(
                            conversationId: conversationId,
                            userId: readUserId,
                            events: current
                        )
                    }

                    while !Task.isCancelled {
                        do {
                            try? await flushPendingAppends()
                            let after = current.map(\.sequence).max() ?? 0
                            let streamRequest = authenticatedRequest(url: streamEventsURL(
                                stream: "MessageStream",
                                key: conversationId,
                                after: after
                            ))
                            let (bytes, response) = try await streamingSession.bytes(for: streamRequest)
                            try validate(response)

                            var parser = FrickEventStreamParser()
                            var lineBuffer = Data()
                            for try await byte in bytes {
                                lineBuffer.append(byte)
                                guard byte == 10 else {
                                    continue
                                }
                                try await processStreamLine(
                                    lineBuffer,
                                    parser: &parser,
                                    current: &current,
                                    continuation: continuation,
                                    conversationId: conversationId,
                                    readUserId: readUserId
                                )
                                lineBuffer.removeAll(keepingCapacity: true)
                            }
                            if !lineBuffer.isEmpty {
                                try await processStreamLine(
                                    lineBuffer,
                                    parser: &parser,
                                    current: &current,
                                    continuation: continuation,
                                    conversationId: conversationId,
                                    readUserId: readUserId
                                )
                            }
                        } catch is CancellationError {
                            if Task.isCancelled {
                                throw CancellationError()
                            }
                        } catch {
                            if isTerminalStreamError(error) {
                                throw error
                            }
                        }
                        try await Task.sleep(nanoseconds: streamReconnectDelayNanoseconds)
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

    private func processStreamLine(
        _ lineBuffer: Data,
        parser: inout FrickEventStreamParser,
        current: inout [FrickStreamEvent],
        continuation: AsyncThrowingStream<[FrickStreamEvent], Error>.Continuation,
        conversationId: String,
        readUserId: String?
    ) async throws {
        guard let line = String(data: lineBuffer, encoding: .utf8) else {
            return
        }
        for event in parser.push(line) where event.event == "stream-page" || event.event == "delta" {
            let decoded = try decoder.decode(StreamEventsResponse.self, from: Data(event.data.utf8))
            try decoded.requireCompatibleSchema()
            for streamEvent in decoded.data {
                try storage.saveStreamEvent(streamEvent)
            }
            current = mergeStreamEvents(current, decoded.data)
            continuation.yield(current)
            try await advanceReadReceiptIfNeeded(
                conversationId: conversationId,
                userId: readUserId,
                events: current
            )
        }
    }

    public func sendMessage(
        conversationId: String = "conversation-general",
        senderId: String? = nil,
        body: String
    ) async throws {
        let resolvedSenderId = try senderId ?? requireAuthenticatedSession().userId
        try await append(
            stream: "MessageStream",
            key: conversationId,
            event: "MessageSent",
            payload: [
                "messageId": "message-\(UUID().uuidString)",
                "senderId": resolvedSenderId,
                "body": body,
                "createdAt": ISO8601DateFormatter().string(from: Date()),
            ]
        )
    }

    public func append(stream: String, key: String, event: String, payload: [String: String]) async throws {
        try await appendPayload(
            stream: stream,
            key: key,
            event: event,
            payload: payload.reduce(into: [String: Any]()) { result, entry in
                result[entry.key] = entry.value
            }
        )
    }

    private func appendPayload(stream: String, key: String, event: String, payload: [String: Any]) async throws {
        let requestId = requestIdFactory()
        let body = try JSONSerialization.data(withJSONObject: [
            "requestId": requestId,
            "replicaId": replicaId,
            "stream": stream,
            "key": key,
            "event": event,
            "payload": payload,
        ])
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

    private func advanceReadReceiptIfNeeded(
        conversationId: String,
        userId: String?,
        events: [FrickStreamEvent]
    ) async throws {
        guard let userId else {
            return
        }
        let sequence = events
            .filter { $0.event != "ReceiptAdvanced" }
            .map(\.sequence)
            .max() ?? 0
        guard readReceiptTracker.shouldAdvance(userId: userId, conversationId: conversationId, sequence: sequence) else {
            return
        }
        try await appendPayload(
            stream: "MessageStream",
            key: conversationId,
            event: "ReceiptAdvanced",
            payload: [
                "userId": userId,
                "sequence": sequence,
            ]
        )
    }

    public func flushPendingAppends() async throws {
        _ = try requireAuthenticatedSession()
        for append in try storage.loadPendingAppends() {
            try await sendAppend(append)
            try storage.removePendingAppend(requestId: append.requestId)
        }
    }

    private func sendAppend(_ append: PendingAppend) async throws {
        _ = try requireAuthenticatedSession()
        var request = URLRequest(url: baseURL.appending(path: "/append"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = append.body
        authenticate(&request)

        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
    }

    private func shouldQueueAppend(_ error: Error) -> Bool {
        if error is FrickAuthenticationRequiredError {
            return false
        }
        if error is FrickSchemaMismatchError {
            return false
        }
        if error is FrickServerError {
            return false
        }
        if let urlError = error as? URLError, urlError.code == .badServerResponse {
            return false
        }
        return true
    }

    private func shouldReturnEmptyRead(_ error: Error) -> Bool {
        if error is FrickSchemaMismatchError {
            return false
        }
        if error is FrickServerError {
            return false
        }
        return true
    }

    private func isTerminalStreamError(_ error: Error) -> Bool {
        if error is FrickSchemaMismatchError {
            return true
        }
        if let serverError = error as? FrickServerError, !serverError.retryable {
            return true
        }
        if let urlError = error as? URLError, urlError.code == .badServerResponse {
            return true
        }
        return false
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

    private func blobContentURL(blobId: String) -> URL {
        baseURL
            .appending(path: "blobs")
            .appending(path: blobId)
            .appending(path: "content")
    }

    private func signalURL(name: String, key: String) -> URL {
        baseURL
            .appending(path: "signals")
            .appending(path: name)
            .appending(path: key)
    }

    private func authenticatedRequest(url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        authenticate(&request)
        return request
    }

    private func requireAuthenticatedSession() throws -> FrickSession {
        guard let session = currentSession, !session.sessionToken.isEmpty else {
            throw FrickAuthenticationRequiredError()
        }
        return session
    }

    private func postAuthSession<RequestBody: Encodable>(
        path: String,
        body: RequestBody
    ) async throws -> FrickSession {
        var request = URLRequest(url: baseURL.appending(path: "auth").appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try encoder.encode(body)

        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        let frickSession = try decoder.decode(FrickSession.self, from: data)
        try frickSession.requireCompatibleSchema()
        sessionStore.session = frickSession
        return frickSession
    }

    private func authenticate(_ request: inout URLRequest) {
        guard let token = currentSession?.sessionToken else {
            return
        }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }

    private static func validateBaseURL(_ url: URL, allowInsecureLocalTransport: Bool) {
        guard url.scheme?.lowercased() == "http" else {
            return
        }
        if allowInsecureLocalTransport {
            return
        }
        preconditionFailure(
            "FrickClient requires HTTPS outside debug/demo local transport. Pass an HTTPS baseURL or explicitly opt into insecure local transport only for debug/demo builds."
        )
    }

    private func validate(_ response: URLResponse, data: Data? = nil) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let bodyData = data ?? Data()
            let envelope = FrickErrorEnvelopeDecoder.decode(from: bodyData, using: decoder)
            throw FrickServerError(
                httpStatusCode: httpResponse.statusCode,
                envelope: envelope,
                body: bodyData
            )
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

private struct DevLoginRequest: Encodable, Sendable {
    let userId: String
    let deviceId: String?
    let replicaId: String?
    let platform: String?
}

private struct AuthSignupRequest: Encodable, Sendable {
    let displayName: String
    let handle: String
    let password: String
    let deviceId: String?
    let replicaId: String?
    let platform: String?
}

private struct AuthLoginRequest: Encodable, Sendable {
    let identity: String
    let password: String
    let deviceId: String?
    let replicaId: String?
    let platform: String?
}

private struct ConversationCreateRequest: Encodable, Sendable {
    let title: String?
    let kind: String
    let participantUserIds: [String]
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
