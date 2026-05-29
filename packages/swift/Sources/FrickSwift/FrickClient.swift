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

    public func requireCompatibleSchema(expected: String = FrickSchema.schemaHash) throws {
        guard schemaHash == nil || schemaHash == expected else {
            throw FrickSchemaMismatchError(
                expectedSchemaHash: expected,
                actualSchemaHash: schemaHash
            )
        }
    }
}

/// Server reply shape for `POST /objects/:type/:id`. Internal — used by
/// `FrickClient.writeObject`. Surfaced to callers as `WriteObjectResult`.
struct WriteObjectEnvelope: Decodable {
    let schemaHash: String?
    let version: Int
    let previousVersion: Int?
    let mergePolicy: String?
}

/// Outcome of a `writeObject` call. `version` is the new authoritative
/// version on the server (use it as `expectedVersion` on the next write to
/// keep the optimistic-concurrency chain). `created` distinguishes a fresh
/// insert (HTTP 201) from an update (HTTP 200).
public struct WriteObjectResult: Sendable, Equatable {
    public let id: String
    public let version: Int
    public let previousVersion: Int?
    public let created: Bool
}

public struct StreamEventsResponse: Decodable {
    public let schemaHash: String?
    public let stream: String?
    public let key: String?
    public let data: [FrickStreamEvent]

    public func requireCompatibleSchema(expected: String = FrickSchema.schemaHash) throws {
        guard schemaHash == nil || schemaHash == expected else {
            throw FrickSchemaMismatchError(
                expectedSchemaHash: expected,
                actualSchemaHash: schemaHash
            )
        }
    }
}

public struct FrickSession: Codable, Equatable, Sendable {
    public let schemaHash: String?
    public let sessionToken: String
    public let tenantId: String?
    public let userId: String
    public let displayName: String?
    public let handle: String?
    public let deviceId: String
    public let replicaId: String
    public let expiresAt: String

    public init(
        schemaHash: String?,
        sessionToken: String,
        tenantId: String? = nil,
        userId: String,
        displayName: String? = nil,
        handle: String? = nil,
        deviceId: String,
        replicaId: String,
        expiresAt: String
    ) {
        self.schemaHash = schemaHash
        self.sessionToken = sessionToken
        self.tenantId = tenantId
        self.userId = userId
        self.displayName = displayName
        self.handle = handle
        self.deviceId = deviceId
        self.replicaId = replicaId
        self.expiresAt = expiresAt
    }

    public func requireCompatibleSchema(expected: String = FrickSchema.schemaHash) throws {
        guard schemaHash == nil || schemaHash == expected else {
            throw FrickSchemaMismatchError(
                expectedSchemaHash: expected,
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

    public func requireCompatibleSchema(expected: String = FrickSchema.schemaHash) throws {
        guard schemaHash == nil || schemaHash == expected else {
            throw FrickSchemaMismatchError(
                expectedSchemaHash: expected,
                actualSchemaHash: schemaHash
            )
        }
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

public enum FrickAnalyticsAttributeValue: Encodable, Equatable, Sendable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value):
            try container.encode(value)
        case .int(let value):
            try container.encode(value)
        case .double(let value):
            try container.encode(value)
        case .bool(let value):
            try container.encode(value)
        }
    }
}

public struct FrickAnalyticsTrackOptions: Equatable, Sendable {
    public let context: [String: FrickJSONValue]?
    public let attributes: [String: FrickAnalyticsAttributeValue]?
    public let traceId: String?
    public let idempotencyKey: String?
    public let occurredAt: String?

    public init(
        context: [String: FrickJSONValue]? = nil,
        attributes: [String: FrickAnalyticsAttributeValue]? = nil,
        traceId: String? = nil,
        idempotencyKey: String? = nil,
        occurredAt: String? = nil
    ) {
        self.context = context
        self.attributes = attributes
        self.traceId = traceId
        self.idempotencyKey = idempotencyKey
        self.occurredAt = occurredAt
    }
}

public struct FrickAnalyticsTrackReceipt: Codable, Equatable, Sendable {
    public let ok: Bool
    public let eventId: String
    public let sequence: Int
    public let acceptedAt: String
    public let duplicate: Bool

    public init(ok: Bool, eventId: String, sequence: Int, acceptedAt: String, duplicate: Bool) {
        self.ok = ok
        self.eventId = eventId
        self.sequence = sequence
        self.acceptedAt = acceptedAt
        self.duplicate = duplicate
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
    /// FR-2. Read back the locally-cached server version for an object,
    /// used by `FrickClient.writeObject` to auto-resolve `expectedVersion`
    /// when the caller doesn't pass one. Returns `nil` if the object has
    /// never been written through this client (no cache row yet).
    func loadObjectVersion(type: String, id: String) throws -> Int?
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

    /// FR-2. Default implementation for storages that haven't adopted
    /// version reads yet — returning `nil` is safe and preserves the
    /// pre-FR-2 behavior (writes go out without an `if-match` header).
    /// Concrete storages SHOULD override to enable auto-versioning.
    func loadObjectVersion(type: String, id: String) throws -> Int? {
        nil
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
              schema_hash TEXT NOT NULL,
              tenant_id TEXT,
              user_id TEXT
            );
            """)
        try ensureColumnExists(table: "frick_cache_metadata", column: "tenant_id", definition: "tenant_id TEXT")
        try ensureColumnExists(table: "frick_cache_metadata", column: "user_id", definition: "user_id TEXT")
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

    /// FR-2. Single indexed lookup against the PK `(object_type, object_id)`.
    /// Returns `nil` if we've never written this object locally — caller
    /// (`FrickClient.writeObject`) treats that as "send no if-match," which
    /// is correct for a first-time create.
    public func loadObjectVersion(type: String, id: String) throws -> Int? {
        lock.lock()
        defer { lock.unlock() }
        let rows = try query(
            "SELECT version FROM local_objects WHERE object_type = ? AND object_id = ? LIMIT 1",
            bindings: [.text(type), .text(id)]
        )
        return rows.first?.first?.intValue
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
            """
            SELECT schema_id, schema_version, schema_revision, schema_hash, tenant_id, user_id
            FROM frick_cache_metadata
            WHERE id = 1
            LIMIT 1
            """,
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
            schemaHash: schemaHash,
            tenantId: row[4].text,
            userId: row[5].text
        )
    }

    public func saveCacheMetadata(_ metadata: FrickCacheMetadata) throws {
        lock.lock()
        defer { lock.unlock() }
        try run(
            """
            INSERT INTO frick_cache_metadata (id, schema_id, schema_version, schema_revision, schema_hash, tenant_id, user_id)
            VALUES (1, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              schema_id = excluded.schema_id,
              schema_version = excluded.schema_version,
              schema_revision = excluded.schema_revision,
              schema_hash = excluded.schema_hash,
              tenant_id = excluded.tenant_id,
              user_id = excluded.user_id
            """,
            bindings: [
                .text(metadata.schemaId),
                .text(metadata.schemaVersion),
                .int(metadata.schemaRevision),
                .text(metadata.schemaHash),
                metadata.tenantId.map(SQLiteBinding.text) ?? .null,
                metadata.userId.map(SQLiteBinding.text) ?? .null,
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

    private func ensureColumnExists(table: String, column: String, definition: String) throws {
        let rows = try query("PRAGMA table_info(\(table))", bindings: [])
        let exists = rows.contains { row in
            row.count > 1 && row[1].text == column
        }
        if !exists {
            try run("ALTER TABLE \(table) ADD COLUMN \(definition)", bindings: [])
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
            case .null:
                result = sqlite3_bind_null(statement, sqliteIndex)
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
    case null
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
    private let telemetry: any FrickClientTelemetryRuntime
    private let requestIdFactory: @Sendable () -> String
    /// The schema hash this client expects from the server. Defaults to the
    /// generated foundation hash (`FrickSchema.schemaHash`). Apps with a
    /// custom protocol schema pass their own hash here so wire-level guards
    /// (response envelopes, sync Hello frame, `X-Frick-Schema-Hash` header)
    /// compare against the app's schema rather than the foundation default.
    public let schemaHash: String
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
        telemetry: any FrickClientTelemetryRuntime = FrickNoopClientTelemetryRuntime(),
        requestIdFactory: @escaping @Sendable () -> String = { UUID().uuidString },
        schemaHash: String = FrickSchema.schemaHash
    ) {
        Self.validateBaseURL(baseURL, allowInsecureLocalTransport: allowInsecureLocalTransport)
        self.baseURL = baseURL
        self.session = session
        self.streamingSession = streamingSession ?? makeFrickStreamingSession()
        self.streamReconnectDelayNanoseconds = streamReconnectDelayNanoseconds
        self.replicaId = replicaId
        self.storage = storage
        self.telemetry = telemetry
        self.requestIdFactory = requestIdFactory
        self.schemaHash = schemaHash
    }

    public var currentSession: FrickSession? {
        sessionStore.session
    }

    @discardableResult
    public func verifyCacheCompatibility(
        currentMetadata: FrickCacheMetadata? = nil,
        minimumClientRevision: Int = FrickSchema.minimumClientRevision
    ) throws -> FrickCacheMetadata {
        let resolvedMetadata = currentMetadata ?? FrickCacheMetadata.currentSchema(session: currentSession, schemaHash: schemaHash)
        if let cached = try storage.loadCacheMetadata() {
            if let reason = FrickCacheCompatibility.reason(
                cached: cached,
                current: resolvedMetadata,
                minimumClientRevision: minimumClientRevision
            ) {
                throw FrickCacheIncompatibleError(
                    reason: reason,
                    cachedMetadata: cached,
                    currentMetadata: resolvedMetadata,
                    minimumClientRevision: minimumClientRevision,
                    pendingAppendCount: (try? storage.loadPendingAppends().count) ?? 0
                )
            }
        }
        try storage.saveCacheMetadata(resolvedMetadata)
        return resolvedMetadata
    }

    public func resetCache() throws {
        try storage.clearCache()
    }

    /// Install a freshly-minted session into the local store, resetting the
    /// on-disk cache first if the persisted cache metadata is scoped to a
    /// different user or a different schema hash than the incoming session
    /// expects.
    ///
    /// Frick's cache metadata is scoped to `(userId, schemaHash)`; reusing a
    /// cache row minted under user A while signed in as user B (or under a
    /// different schema revision than this client compiled against) trips
    /// the scope guard in `verifyCacheCompatibility` and silently breaks
    /// every subsequent `fetchObjects` call. Sign-in entry points (Apple,
    /// Google, email, dev-login, generic login/signup) funnel through here
    /// so callers no longer have to remember to call `resetCache()` before
    /// swapping users or upgrading clients.
    ///
    /// FR-3. The earlier implementation only compared against the in-memory
    /// `sessionStore.session` — which is nil after `signOut()` or a fresh
    /// process launch — and missed two real flows: sign-out → sign-in as
    /// a different user (very common in shared simulators / family devices)
    /// and schema-hash drift across client upgrades. Comparing against the
    /// persisted metadata makes "sign in" the canonical cache-validity
    /// checkpoint; the `verifyCacheCompatibility` calls in `fetchObjects` /
    /// `connectSync` are now defense in depth rather than the only line.
    ///
    /// Reset failures are swallowed: a stale cache row is preferable to
    /// refusing to sign in, and the next `verifyCacheCompatibility` call
    /// will surface the real error.
    private func installSession(_ newSession: FrickSession) {
        let cached = try? storage.loadCacheMetadata()
        let userChanged = (cached?.userId).map { $0 != newSession.userId } ?? false
        let schemaChanged = (cached?.schemaHash).map { $0 != schemaHash } ?? false
        if userChanged || schemaChanged {
            try? storage.clearCache()
            try? storage.clearPendingAppends()
        }
        sessionStore.session = newSession
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
            clientCapabilities: .defaultIOS(schemaHash: schemaHash),
            replicaId: replicaId,
            deviceId: session.deviceId,
            schemaHash: schemaHash
        )
        Task { await socket.connect() }
        return socket
    }

    public func signOut() {
        try? storage.clearPendingAppends()
        sessionStore.session = nil
    }

    /// Server-side logout — POSTs to `/auth/logout` to invalidate the
    /// session token, then clears the local store. Use this in preference
    /// to bare `signOut()` for an explicit user-driven sign-out: a stolen
    /// device or keychain-backup leak otherwise leaves the bearer valid
    /// on the server until natural expiration.
    ///
    /// Always clears the local session, even if the network call fails —
    /// the user pressed Sign Out, they're getting signed out. Network
    /// errors are silently swallowed.
    public func logout() async {
        if let session = sessionStore.session {
            var request = URLRequest(url: baseURL.appending(path: "auth").appending(path: "logout"))
            request.httpMethod = "POST"
            request.setValue("Bearer \(session.sessionToken)", forHTTPHeaderField: "Authorization")
            _ = try? await self.session.data(for: request)
        }
        try? storage.clearPendingAppends()
        sessionStore.session = nil
    }

    /// Inject an externally-minted session into the client. Used when the
    /// app authenticates against a non-Frick provider (Sign in with Apple,
    /// Google, etc.) and the server hands back a Frick session via an
    /// app-defined route. Subsequent `fetchObjects` / `writeObject` /
    /// `connectSync` calls use this session.
    ///
    /// The session is treated identically to one produced by
    /// `devLogin` / `signUp` / `login` — pass a previously-saved session
    /// to restore across app launches once you wire up persistence.
    public func restoreSession(_ session: FrickSession) {
        installSession(session)
    }

    public func devLogin(
        userId: String,
        tenantId: String? = nil,
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
                tenantId: tenantId,
                deviceId: deviceId,
                replicaId: replicaId,
                platform: platform
            )
        )

        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        let frickSession = try decoder.decode(FrickSession.self, from: data)
        try frickSession.requireCompatibleSchema(expected: schemaHash)
        installSession(frickSession)
        return frickSession
    }

    /// Sign in (or sign up) via Apple's identity token. Called after
    /// `ASAuthorizationAppleIDProvider` returns an `identityToken` — pass
    /// the token bytes (UTF-8 decoded) and Apple's `fullName`, which the
    /// system only provides on the very first sign-in for a given app.
    ///
    /// The server (when configured with an Apple `identityProviders.apple`
    /// entry) verifies the JWT against Apple's JWKS, finds or creates the
    /// matching User row, and mints a Frick session.
    ///
    /// `WriteObjectResult` for `User` is not surfaced here — the caller
    /// gets the full server reply (including isNewUser + the user row)
    /// via the `extraInfo` map.
    @discardableResult
    public func signInWithApple(
        identityToken: String,
        fullName: AppleFullName? = nil,
        deviceId: String? = nil,
        replicaId: String? = nil
    ) async throws -> SignInWithAppleResult {
        var request = URLRequest(
            url: baseURL.appending(path: "auth").appending(path: "apple").appending(path: "verify"),
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try encoder.encode(
            SignInWithAppleRequest(
                identityToken: identityToken,
                fullName: fullName,
                deviceId: deviceId,
                replicaId: replicaId,
            ),
        )

        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        let envelope = try decoder.decode(SignInWithAppleEnvelope.self, from: data)
        try envelope.session.requireCompatibleSchema(expected: schemaHash)
        installSession(envelope.session)
        return SignInWithAppleResult(
            session: envelope.session,
            user: envelope.user,
            isNewUser: envelope.isNewUser,
        )
    }

    /// Email/password sign-up via Frick's identityProviders.email surface.
    /// Hits `/auth/email/signup`, which wraps the framework account store
    /// and threads the app's `onFirstSignIn` hook for tenant creation —
    /// same shape as `signInWithApple`. The returned session is stored in
    /// the client, ready for `fetchObjects` / `writeObject` calls.
    @discardableResult
    public func signUpWithEmail(
        email: String,
        password: String,
        displayName: String? = nil
    ) async throws -> SignInWithEmailResult {
        var request = URLRequest(
            url: baseURL.appending(path: "auth").appending(path: "email").appending(path: "signup"),
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try encoder.encode(
            EmailSignupRequest(email: email, password: password, displayName: displayName),
        )
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        let envelope = try decoder.decode(SignInWithEmailEnvelope.self, from: data)
        try envelope.session.requireCompatibleSchema(expected: schemaHash)
        installSession(envelope.session)
        return SignInWithEmailResult(
            session: envelope.session,
            user: envelope.user,
            isNewUser: envelope.isNewUser,
        )
    }

    /// Email/password sign-in via Frick's identityProviders.email surface.
    /// Hits `/auth/email/login`, returning the session bound to the user's
    /// primary tenant (read from `User.primaryTenantId`).
    @discardableResult
    public func signInWithEmail(
        email: String,
        password: String
    ) async throws -> SignInWithEmailResult {
        var request = URLRequest(
            url: baseURL.appending(path: "auth").appending(path: "email").appending(path: "login"),
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try encoder.encode(
            EmailLoginRequest(email: email, password: password),
        )
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        let envelope = try decoder.decode(SignInWithEmailEnvelope.self, from: data)
        try envelope.session.requireCompatibleSchema(expected: schemaHash)
        installSession(envelope.session)
        return SignInWithEmailResult(
            session: envelope.session,
            user: envelope.user,
            isNewUser: envelope.isNewUser,
        )
    }

    /// Sign in via a Google ID token. Pass the `id_token` you received
    /// from whichever Google sign-in flow you're using on the client
    /// (GoogleSignIn iOS SDK, ASWebAuthenticationSession's OpenID Connect
    /// redirect, a server-side web flow). Frick verifies against Google's
    /// JWKS and mints a session bound to the Crate tenant.
    @discardableResult
    public func signInWithGoogle(
        idToken: String,
        deviceId: String? = nil,
        replicaId: String? = nil
    ) async throws -> SignInWithGoogleResult {
        var request = URLRequest(
            url: baseURL.appending(path: "auth").appending(path: "google").appending(path: "verify"),
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try encoder.encode(
            SignInWithGoogleRequest(idToken: idToken, deviceId: deviceId, replicaId: replicaId),
        )
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        let envelope = try decoder.decode(SignInWithGoogleEnvelope.self, from: data)
        try envelope.session.requireCompatibleSchema(expected: schemaHash)
        installSession(envelope.session)
        return SignInWithGoogleResult(
            session: envelope.session,
            user: envelope.user,
            isNewUser: envelope.isNewUser,
        )
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
    /// FTS index name (e.g. `"activity-fts"`). `filter` is an optional
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

    @discardableResult
    public func track(
        _ name: String,
        properties: [String: FrickJSONValue] = [:],
        options: FrickAnalyticsTrackOptions = FrickAnalyticsTrackOptions()
    ) async throws -> FrickAnalyticsTrackReceipt {
        _ = try requireAuthenticatedSession()
        let startedAt = Date()
        let span = startFrickClientTelemetrySpan(telemetry, FrickClientTelemetrySpanStart(
            name: "frick.analytics.track",
            kind: .client,
            attributes: [
                "frick.analytics.event_name": .string(name),
                "url.path": .string("/analytics/events"),
            ]
        ))
        var finished = false
        func finish(
            status: FrickClientTelemetrySpanStatus,
            metricStatus: String,
            httpStatusCode: Int? = nil,
            duplicate: Bool? = nil,
            error: Error? = nil
        ) {
            guard !finished else {
                return
            }
            finished = true
            var attributes: FrickClientTelemetryAttributes = [
                "frick.analytics.status": .string(metricStatus),
            ]
            if let httpStatusCode {
                attributes["http.response.status_code"] = .int(httpStatusCode)
            }
            if let duplicate {
                attributes["frick.analytics.duplicate"] = .bool(duplicate)
            }
            finishFrickClientTelemetrySpan(span, FrickClientTelemetrySpanResult(
                status: status,
                attributes: attributes,
                errorDescription: error.map { String(describing: $0) }
            ))
            recordFrickClientTelemetryCounter(
                telemetry,
                name: "frick.client.analytics.events.total",
                value: 1,
                attributes: ["status": .string(metricStatus)]
            )
            recordFrickClientTelemetryHistogram(
                telemetry,
                name: "frick.client.analytics.duration_ms",
                value: Date().timeIntervalSince(startedAt) * 1000,
                attributes: ["status": .string(metricStatus)]
            )
        }

        var statusCode: Int?
        var request = URLRequest(url: baseURL.appending(path: "analytics").appending(path: "events"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        do {
            request.httpBody = try encoder.encode(AnalyticsTrackRequest(
                name: name,
                properties: properties,
                context: options.context,
                attributes: options.attributes,
                traceId: options.traceId ?? span.traceId,
                idempotencyKey: options.idempotencyKey,
                occurredAt: options.occurredAt
            ))
            authenticate(&request)
            var telemetryHeaders: [String: String] = [:]
            injectFrickClientTelemetryHeaders(span, into: &telemetryHeaders)
            if let traceparent = telemetryHeaders.first(where: { name, _ in name.lowercased() == "traceparent" })?.value {
                request.setValue(traceparent, forHTTPHeaderField: "traceparent")
            }

            let (data, response) = try await session.data(for: request)
            statusCode = (response as? HTTPURLResponse)?.statusCode
            try validate(response, data: data)
            let receipt = try decoder.decode(FrickAnalyticsTrackReceipt.self, from: data)
            finish(
                status: .ok,
                metricStatus: receipt.duplicate ? "duplicate" : "accepted",
                httpStatusCode: statusCode,
                duplicate: receipt.duplicate
            )
            return receipt
        } catch {
            finish(
                status: .error,
                metricStatus: statusCode == nil && error is URLError ? "network_error" : "rejected",
                httpStatusCode: statusCode,
                error: error
            )
            throw error
        }
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
            try decoded.requireCompatibleSchema(expected: schemaHash)
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
        try decoded.requireCompatibleSchema(expected: schemaHash)
        _ = try verifyCacheCompatibility()
        for object in decoded.data {
            if let id = extractId(from: object) {
                try storage.saveObjectData(type: type, id: id, data: encoder.encode(object), version: 0)
            }
        }
        return decoded.data
    }

    /// Write an object to the server via `POST /objects/:type/:id`. The
    /// server validates the value against the runtime schema, persists it
    /// in the store, and broadcasts the resulting delta to any open sync
    /// connections (so other clients see the update without a refetch).
    ///
    /// Pass `expectedVersion` to opt into optimistic concurrency — the
    /// server returns `storage.conflict` (HTTP 409) when the on-disk
    /// version doesn't match, surfaced here as
    /// `FrickObjectVersionConflictError`. Omit it for last-write-wins.
    ///
    /// `Object` should match the schema's field shape. The `id` is sent in
    /// the URL; if the type's payload also carries an `id` field the server
    /// strips it before persisting.
    @discardableResult
    public func writeObject<Object: Codable & Sendable>(
        type: String,
        id: String,
        value: Object,
        expectedVersion: Int? = nil
    ) async throws -> WriteObjectResult {
        _ = try requireAuthenticatedSession()
        let encodedType = type.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? type
        let encodedId = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let url = baseURL.appending(path: "objects").appending(path: encodedType).appending(path: encodedId)
        var request = authenticatedRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        /// FR-2. Auto-resolve `expectedVersion` from local storage when the
        /// caller didn't pass one. Before this, `writeObject(... expectedVersion: nil)`
        /// always omitted the `if-match` header, which the server treats as
        /// "create only" for types whose schema uses `versionPrecondition`
        /// merge policy — so every UPDATE silently 409'd. The version is
        /// already tracked locally (we wrote it in the previous
        /// `saveObjectData(... version:)` call below); reading it back here
        /// closes the loop. An explicit `expectedVersion` from the caller
        /// still wins. A storage that hasn't adopted `loadObjectVersion`
        /// returns nil via the protocol default, preserving pre-FR-2
        /// behavior. True conflicts (cached version stale vs. server) still
        /// surface as 409 — apps that want clobber semantics can refetch
        /// and retry on top.
        let effectiveExpectedVersion: Int? = expectedVersion
            ?? (try? storage.loadObjectVersion(type: type, id: id))
        if let effectiveExpectedVersion {
            request.setValue("\(effectiveExpectedVersion)", forHTTPHeaderField: "if-match")
        }
        request.httpBody = try encoder.encode(value)

        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        let envelope = try decoder.decode(WriteObjectEnvelope.self, from: data)
        // Mirror fetchObjects' cache write so a subsequent fetchObjects
        // resolves locally without a network round-trip in the same session.
        try storage.saveObjectData(type: type, id: id, data: try encoder.encode(value), version: envelope.version)
        let created = (response as? HTTPURLResponse)?.statusCode == 201
        return WriteObjectResult(
            id: id,
            version: envelope.version,
            previousVersion: envelope.previousVersion,
            created: created
        )
    }

    /// Kick off the email password-reset flow. The server always returns
    /// 200 (privacy: no email-enumeration leak) — present the success UI
    /// regardless of whether the address is on file. The actual email is
    /// dispatched by the app's `onPasswordResetRequested` hook on the
    /// server; if no hook is wired in production, the user won't get an
    /// email and you should surface that as a known limitation.
    public func requestPasswordReset(email: String) async throws {
        struct Body: Encodable { let email: String }
        var request = URLRequest(url: baseURL.appending(path: "auth").appending(path: "email").appending(path: "forgot-password"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try encoder.encode(Body(email: email))
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
    }

    /// Complete the email password-reset flow. The user enters a new
    /// password + the one-time token from the email link; server-side
    /// the token is single-use, expiring within ~60 minutes of issue.
    /// Sessions for the user are invalidated on success.
    public func resetPassword(token: String, newPassword: String) async throws {
        struct Body: Encodable { let token: String; let password: String }
        var request = URLRequest(url: baseURL.appending(path: "auth").appending(path: "email").appending(path: "reset-password"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try encoder.encode(Body(token: token, password: newPassword))
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
    }

    /// Remove an object on the server via `DELETE /objects/:type/:id`.
    /// Idempotent — calling twice with the same id returns `existed:
    /// false` on the second call rather than throwing.
    ///
    /// `Object` payload is not required (the route ignores the body); the
    /// `existed` flag distinguishes a real deletion (`true`) from a no-op
    /// against an already-absent row (`false`). Useful for the UI that
    /// wants to confirm "yes, the server saw this delete."
    @discardableResult
    /// Create a single-use invitation for another user to access the given
    /// record. The returned `FrickInvitation.token` is the opaque string
    /// the owner ships to the recipient out-of-band (push, link, email,
    /// QR code — Frick doesn't dictate the channel). Recipients call
    /// `acceptInvitation(token:)` to redeem.
    ///
    /// - Parameter expiresIn: Lifetime in seconds. `nil` uses the server
    ///   default (14 days). The server clamps to a 90-day ceiling.
    public func createInvitation(
        recordType: String,
        recordId: String,
        permission: FrickSharingPermission,
        expiresIn: TimeInterval? = nil
    ) async throws -> FrickInvitation {
        _ = try requireAuthenticatedSession()
        let body = CreateInvitationBody(
            recordType: recordType,
            recordId: recordId,
            permission: permission,
            expiresInSeconds: expiresIn.map { Int($0) }
        )
        var request = URLRequest(url: baseURL.appending(path: "share").appending(path: "invite"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try encoder.encode(body)
        authenticate(&request)
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(CreateInvitationEnvelope.self, from: data).invitation
    }


    /// Redeem an invitation token. Single-use; the server rejects replays
    /// after the first successful accept. Returns the durable grant that
    /// now authorises the principal to read/write the underlying record.
    public func acceptInvitation(token: String) async throws -> FrickGrant {
        _ = try requireAuthenticatedSession()
        let body = AcceptInvitationBody(token: token)
        var request = URLRequest(url: baseURL.appending(path: "share").appending(path: "accept"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try encoder.encode(body)
        authenticate(&request)
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(AcceptInvitationEnvelope.self, from: data).grant
    }


    /// List active grants the principal is either the owner or grantee of.
    /// Pass `recordType` / `recordId` to filter to a specific record.
    /// Revoked grants are excluded unless `includeRevoked` is `true`.
    public func listGrants(
        recordType: String? = nil,
        recordId: String? = nil,
        includeRevoked: Bool = false
    ) async throws -> [FrickGrant] {
        _ = try requireAuthenticatedSession()
        var components = URLComponents(
            url: baseURL.appending(path: "share").appending(path: "grants"),
            resolvingAgainstBaseURL: false
        )!
        var queryItems: [URLQueryItem] = []
        if let recordType {
            queryItems.append(URLQueryItem(name: "recordType", value: recordType))
        }
        if let recordId {
            queryItems.append(URLQueryItem(name: "recordId", value: recordId))
        }
        if includeRevoked {
            queryItems.append(URLQueryItem(name: "includeRevoked", value: "true"))
        }
        if !queryItems.isEmpty {
            components.queryItems = queryItems
        }
        let request = authenticatedRequest(url: components.url!)
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(ListGrantsEnvelope.self, from: data).grants
    }


    /// Revoke a grant by id. Only the owner who issued the underlying
    /// invitation can revoke. Idempotent: revoking an already-revoked
    /// grant is a no-op and returns the same row.
    @discardableResult
    public func revokeGrant(grantId: String) async throws -> FrickGrant {
        _ = try requireAuthenticatedSession()
        let encoded = grantId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? grantId
        let url = baseURL
            .appending(path: "share")
            .appending(path: "grants")
            .appending(path: encoded)
        var request = authenticatedRequest(url: url)
        request.httpMethod = "DELETE"
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(RevokeGrantEnvelope.self, from: data).grant
    }


    public func deleteObject(type: String, id: String) async throws -> Bool {
        _ = try requireAuthenticatedSession()
        let encodedType = type.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? type
        let encodedId = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let url = baseURL.appending(path: "objects").appending(path: encodedType).appending(path: encodedId)
        var request = authenticatedRequest(url: url)
        request.httpMethod = "DELETE"

        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        // Best-effort decode of `{existed: Bool}`; if the server response
        // is empty or shaped differently we just assume the delete landed.
        struct DeleteResult: Decodable { let existed: Bool? }
        if let parsed = try? decoder.decode(DeleteResult.self, from: data) {
            return parsed.existed ?? true
        }
        return true
    }

    private func loadCompatibleStreamEvents(stream: String, key: String) throws -> [FrickStreamEvent] {
        let hadMetadata = try storage.loadCacheMetadata() != nil
        _ = try verifyCacheCompatibility()
        guard hadMetadata else {
            return []
        }
        return try storage.loadStreamEvents(stream: stream, key: key)
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
                _ = try verifyCacheCompatibility()
                try storage.appendPendingAppend(append)
                return
            }
            throw error
        }
    }

    public func flushPendingAppends() async throws {
        _ = try requireAuthenticatedSession()
        _ = try verifyCacheCompatibility()
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
        try frickSession.requireCompatibleSchema(expected: schemaHash)
        installSession(frickSession)
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
        guard hashHeader == nil || hashHeader == schemaHash else {
            throw FrickSchemaMismatchError(
                expectedSchemaHash: schemaHash,
                actualSchemaHash: hashHeader
            )
        }
    }
}

/// Apple's `fullName` payload. Only populated on a user's first sign-in
/// for the given app — Apple deliberately drops it on subsequent
/// authorizations.
public struct AppleFullName: Codable, Sendable, Equatable {
    public let givenName: String?
    public let familyName: String?

    public init(givenName: String? = nil, familyName: String? = nil) {
        self.givenName = givenName
        self.familyName = familyName
    }
}

/// Outcome of `signInWithApple`. `session` is already installed in the
/// client's session store; surfaced here too in case the caller wants it
/// (e.g. to persist outside the client). `user` is the server's view of
/// the User row; `isNewUser` distinguishes signup from signin.
public struct SignInWithAppleResult: Sendable {
    public let session: FrickSession
    public let user: [String: FrickJSONValue]
    public let isNewUser: Bool
}

private struct SignInWithAppleRequest: Encodable, Sendable {
    let identityToken: String
    let fullName: AppleFullName?
    let deviceId: String?
    let replicaId: String?
}

private struct SignInWithAppleEnvelope: Decodable {
    let session: FrickSession
    let user: [String: FrickJSONValue]
    let isNewUser: Bool
}

/// Outcome of `signUpWithEmail` / `signInWithEmail`. Shape mirrors
/// `SignInWithAppleResult` so UI code can treat the providers uniformly.
public struct SignInWithEmailResult: Sendable {
    public let session: FrickSession
    public let user: [String: FrickJSONValue]
    public let isNewUser: Bool
}

private struct EmailSignupRequest: Encodable, Sendable {
    let email: String
    let password: String
    let displayName: String?
}

private struct EmailLoginRequest: Encodable, Sendable {
    let email: String
    let password: String
}

private struct SignInWithEmailEnvelope: Decodable {
    let session: FrickSession
    let user: [String: FrickJSONValue]
    let isNewUser: Bool
}

/// Outcome of `signInWithGoogle`. Mirrors the Apple/email shapes so UI
/// code can route through the same `isNewUser` branch for onboarding.
public struct SignInWithGoogleResult: Sendable {
    public let session: FrickSession
    public let user: [String: FrickJSONValue]
    public let isNewUser: Bool
}

private struct SignInWithGoogleRequest: Encodable, Sendable {
    let idToken: String
    let deviceId: String?
    let replicaId: String?
}

private struct SignInWithGoogleEnvelope: Decodable {
    let session: FrickSession
    let user: [String: FrickJSONValue]
    let isNewUser: Bool
}

private struct DevLoginRequest: Encodable, Sendable {
    let userId: String
    let tenantId: String?
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

private struct AnalyticsTrackRequest: Encodable, Sendable {
    let name: String
    let properties: [String: FrickJSONValue]
    let context: [String: FrickJSONValue]?
    let attributes: [String: FrickAnalyticsAttributeValue]?
    let traceId: String?
    let idempotencyKey: String?
    let occurredAt: String?
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
