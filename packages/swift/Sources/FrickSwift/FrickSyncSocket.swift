import Foundation

// MARK: - FrameKind

/// Mirrors `FrameKind` from `@frick/protocol`. Values must stay in lock-step
/// with `packages/protocol/src/frame.ts`.
public enum FrickFrameKind: Int, Sendable {
    case hello = 0
    case schema = 1
    case subscribe = 2
    case snapshot = 3
    case streamPage = 4
    case append = 5
    case ack = 6
    case nack = 7
    case delta = 8
    case presenceSet = 9
    case presenceClear = 10
    case presenceDelta = 11
    case signalSend = 12
    case signalDeliver = 13
    case cursorCommit = 14
    case ping = 15
    case pong = 16
    case syncStatus = 17
    case helloAck = 18
    case projectionDelta = 19
    case objectUpsert = 20
}

// MARK: - Frame model

/// Tagged-tuple frame: `[kind, payload]`. The payload is loosely-typed so it
/// can carry any decoded msgpack tree; specific handlers extract the fields
/// they care about.
public struct FrickFrame: Sendable {
    public let kind: FrickFrameKind
    public let payload: FrickMsgPackValue

    public init(kind: FrickFrameKind, payload: FrickMsgPackValue) {
        self.kind = kind
        self.payload = payload
    }
}

// MARK: - MsgPack value tree

/// Loose, Sendable-friendly representation of msgpack values used on the
/// wire. We hand-roll just enough of the spec to round-trip frames the Swift
/// SDK actually sends or receives.
public indirect enum FrickMsgPackValue: Sendable, Equatable {
    case nilValue
    case bool(Bool)
    case int(Int64)
    case uint(UInt64)
    case double(Double)
    case string(String)
    case binary(Data)
    case array([FrickMsgPackValue])
    case map([(FrickMsgPackValue, FrickMsgPackValue)])

    public static func == (lhs: FrickMsgPackValue, rhs: FrickMsgPackValue) -> Bool {
        switch (lhs, rhs) {
        case (.nilValue, .nilValue): return true
        case (.bool(let a), .bool(let b)): return a == b
        case (.int(let a), .int(let b)): return a == b
        case (.uint(let a), .uint(let b)): return a == b
        case (.int(let a), .uint(let b)): return a >= 0 && UInt64(a) == b
        case (.uint(let a), .int(let b)): return b >= 0 && a == UInt64(b)
        case (.double(let a), .double(let b)): return a == b
        case (.string(let a), .string(let b)): return a == b
        case (.binary(let a), .binary(let b)): return a == b
        case (.array(let a), .array(let b)): return a == b
        case (.map(let a), .map(let b)):
            guard a.count == b.count else { return false }
            // map equality is order-insensitive over keys
            let am = Dictionary(uniqueKeysWithValues: a.compactMap { pair -> (String, FrickMsgPackValue)? in
                guard case .string(let k) = pair.0 else { return nil }
                return (k, pair.1)
            })
            let bm = Dictionary(uniqueKeysWithValues: b.compactMap { pair -> (String, FrickMsgPackValue)? in
                guard case .string(let k) = pair.0 else { return nil }
                return (k, pair.1)
            })
            return am == bm
        default: return false
        }
    }

    // MARK: Convenience getters

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    public var intValue: Int? {
        switch self {
        case .int(let v): return Int(v)
        case .uint(let v): return Int(exactly: v)
        case .double(let v): return Int(v)
        default: return nil
        }
    }

    public var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    public var arrayValue: [FrickMsgPackValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    /// Returns a `[String: FrickMsgPackValue]` view, ignoring any non-string keys.
    public var mapValue: [String: FrickMsgPackValue]? {
        guard case .map(let pairs) = self else { return nil }
        var result: [String: FrickMsgPackValue] = [:]
        result.reserveCapacity(pairs.count)
        for (k, v) in pairs {
            if case .string(let key) = k {
                result[key] = v
            }
        }
        return result
    }
}

// MARK: - Encoding helpers from native Swift types

public extension FrickMsgPackValue {
    /// Best-effort conversion from a JSON-shaped `[String: Any]` payload.
    static func from(_ value: Any?) -> FrickMsgPackValue {
        guard let value = value else { return .nilValue }
        if value is NSNull { return .nilValue }
        if let b = value as? Bool { return .bool(b) }
        if let i = value as? Int { return .int(Int64(i)) }
        if let i = value as? Int64 { return .int(i) }
        if let u = value as? UInt { return .uint(UInt64(u)) }
        if let u = value as? UInt64 { return .uint(u) }
        if let d = value as? Double { return .double(d) }
        if let f = value as? Float { return .double(Double(f)) }
        if let n = value as? NSNumber {
            // NSNumber needs special handling — distinguish bool from int
            let type = String(cString: n.objCType)
            if type == "c" || type == "B" { return .bool(n.boolValue) }
            if type == "d" || type == "f" { return .double(n.doubleValue) }
            return .int(n.int64Value)
        }
        if let s = value as? String { return .string(s) }
        if let d = value as? Data { return .binary(d) }
        if let arr = value as? [Any] { return .array(arr.map { Self.from($0) }) }
        if let dict = value as? [String: Any] {
            return .map(dict.map { (FrickMsgPackValue.string($0.key), Self.from($0.value)) })
        }
        return .nilValue
    }

    /// Convert back to a JSON-friendly Swift value tree.
    var anyValue: Any {
        switch self {
        case .nilValue: return NSNull()
        case .bool(let b): return b
        case .int(let i): return Int(i)
        case .uint(let u): return Int(exactly: u) ?? Int(clamping: u)
        case .double(let d): return d
        case .string(let s): return s
        case .binary(let d): return d
        case .array(let a): return a.map { $0.anyValue }
        case .map(let pairs):
            var dict: [String: Any] = [:]
            for (k, v) in pairs {
                if case .string(let key) = k {
                    dict[key] = v.anyValue
                }
            }
            return dict
        }
    }
}

// MARK: - MsgPack codec (hand-rolled, subset)

public enum FrickMsgPackError: Error, Equatable, Sendable {
    case truncated
    case unsupportedType(UInt8)
    case invalidUtf8
    case encodingFailure(String)
}

public enum FrickMsgPackCodec {
    // MARK: Encoding

    public static func encode(_ value: FrickMsgPackValue) -> Data {
        var data = Data()
        encode(value, into: &data)
        return data
    }

    private static func encode(_ value: FrickMsgPackValue, into out: inout Data) {
        switch value {
        case .nilValue:
            out.append(0xC0)
        case .bool(let b):
            out.append(b ? 0xC3 : 0xC2)
        case .int(let i):
            encodeInt(i, into: &out)
        case .uint(let u):
            encodeUInt(u, into: &out)
        case .double(let d):
            out.append(0xCB)
            var bits = d.bitPattern.bigEndian
            withUnsafeBytes(of: &bits) { out.append(contentsOf: $0) }
        case .string(let s):
            let bytes = [UInt8](s.utf8)
            encodeStringHeader(bytes.count, into: &out)
            out.append(contentsOf: bytes)
        case .binary(let d):
            encodeBinaryHeader(d.count, into: &out)
            out.append(d)
        case .array(let arr):
            encodeArrayHeader(arr.count, into: &out)
            for v in arr { encode(v, into: &out) }
        case .map(let pairs):
            encodeMapHeader(pairs.count, into: &out)
            for (k, v) in pairs {
                encode(k, into: &out)
                encode(v, into: &out)
            }
        }
    }

    private static func encodeInt(_ i: Int64, into out: inout Data) {
        if i >= 0 { encodeUInt(UInt64(i), into: &out); return }
        if i >= -32 {
            out.append(UInt8(bitPattern: Int8(i)))
        } else if i >= Int64(Int8.min) {
            out.append(0xD0)
            out.append(UInt8(bitPattern: Int8(i)))
        } else if i >= Int64(Int16.min) {
            out.append(0xD1)
            var v = Int16(i).bigEndian
            withUnsafeBytes(of: &v) { out.append(contentsOf: $0) }
        } else if i >= Int64(Int32.min) {
            out.append(0xD2)
            var v = Int32(i).bigEndian
            withUnsafeBytes(of: &v) { out.append(contentsOf: $0) }
        } else {
            out.append(0xD3)
            var v = i.bigEndian
            withUnsafeBytes(of: &v) { out.append(contentsOf: $0) }
        }
    }

    private static func encodeUInt(_ u: UInt64, into out: inout Data) {
        if u <= 0x7F {
            out.append(UInt8(u))
        } else if u <= UInt64(UInt8.max) {
            out.append(0xCC); out.append(UInt8(u))
        } else if u <= UInt64(UInt16.max) {
            out.append(0xCD)
            var v = UInt16(u).bigEndian
            withUnsafeBytes(of: &v) { out.append(contentsOf: $0) }
        } else if u <= UInt64(UInt32.max) {
            out.append(0xCE)
            var v = UInt32(u).bigEndian
            withUnsafeBytes(of: &v) { out.append(contentsOf: $0) }
        } else {
            out.append(0xCF)
            var v = u.bigEndian
            withUnsafeBytes(of: &v) { out.append(contentsOf: $0) }
        }
    }

    private static func encodeStringHeader(_ count: Int, into out: inout Data) {
        if count <= 31 {
            out.append(0xA0 | UInt8(count))
        } else if count <= Int(UInt8.max) {
            out.append(0xD9); out.append(UInt8(count))
        } else if count <= Int(UInt16.max) {
            out.append(0xDA)
            var v = UInt16(count).bigEndian
            withUnsafeBytes(of: &v) { out.append(contentsOf: $0) }
        } else {
            out.append(0xDB)
            var v = UInt32(count).bigEndian
            withUnsafeBytes(of: &v) { out.append(contentsOf: $0) }
        }
    }

    private static func encodeBinaryHeader(_ count: Int, into out: inout Data) {
        if count <= Int(UInt8.max) {
            out.append(0xC4); out.append(UInt8(count))
        } else if count <= Int(UInt16.max) {
            out.append(0xC5)
            var v = UInt16(count).bigEndian
            withUnsafeBytes(of: &v) { out.append(contentsOf: $0) }
        } else {
            out.append(0xC6)
            var v = UInt32(count).bigEndian
            withUnsafeBytes(of: &v) { out.append(contentsOf: $0) }
        }
    }

    private static func encodeArrayHeader(_ count: Int, into out: inout Data) {
        if count <= 15 {
            out.append(0x90 | UInt8(count))
        } else if count <= Int(UInt16.max) {
            out.append(0xDC)
            var v = UInt16(count).bigEndian
            withUnsafeBytes(of: &v) { out.append(contentsOf: $0) }
        } else {
            out.append(0xDD)
            var v = UInt32(count).bigEndian
            withUnsafeBytes(of: &v) { out.append(contentsOf: $0) }
        }
    }

    private static func encodeMapHeader(_ count: Int, into out: inout Data) {
        if count <= 15 {
            out.append(0x80 | UInt8(count))
        } else if count <= Int(UInt16.max) {
            out.append(0xDE)
            var v = UInt16(count).bigEndian
            withUnsafeBytes(of: &v) { out.append(contentsOf: $0) }
        } else {
            out.append(0xDF)
            var v = UInt32(count).bigEndian
            withUnsafeBytes(of: &v) { out.append(contentsOf: $0) }
        }
    }

    // MARK: Decoding

    public static func decode(_ data: Data) throws -> FrickMsgPackValue {
        var cursor = 0
        let value = try decode(data, cursor: &cursor)
        return value
    }

    private static func decode(_ data: Data, cursor: inout Int) throws -> FrickMsgPackValue {
        guard cursor < data.count else { throw FrickMsgPackError.truncated }
        let b = data[data.startIndex + cursor]
        cursor += 1
        switch b {
        case 0xC0: return .nilValue
        case 0xC2: return .bool(false)
        case 0xC3: return .bool(true)
        case 0x00...0x7F: return .uint(UInt64(b))
        case 0xE0...0xFF: return .int(Int64(Int8(bitPattern: b)))
        case 0xA0...0xBF:
            return try .string(readString(data, cursor: &cursor, count: Int(b & 0x1F)))
        case 0x90...0x9F:
            return try readArray(data, cursor: &cursor, count: Int(b & 0x0F))
        case 0x80...0x8F:
            return try readMap(data, cursor: &cursor, count: Int(b & 0x0F))
        case 0xCC: return .uint(UInt64(try readUInt8(data, cursor: &cursor)))
        case 0xCD: return .uint(UInt64(try readUInt16(data, cursor: &cursor)))
        case 0xCE: return .uint(UInt64(try readUInt32(data, cursor: &cursor)))
        case 0xCF: return .uint(try readUInt64(data, cursor: &cursor))
        case 0xD0: return .int(Int64(Int8(bitPattern: try readUInt8(data, cursor: &cursor))))
        case 0xD1: return .int(Int64(Int16(bitPattern: try readUInt16(data, cursor: &cursor))))
        case 0xD2: return .int(Int64(Int32(bitPattern: try readUInt32(data, cursor: &cursor))))
        case 0xD3: return .int(Int64(bitPattern: try readUInt64(data, cursor: &cursor)))
        case 0xCA:
            let bits = try readUInt32(data, cursor: &cursor)
            return .double(Double(Float(bitPattern: bits)))
        case 0xCB:
            let bits = try readUInt64(data, cursor: &cursor)
            return .double(Double(bitPattern: bits))
        case 0xD9: return try .string(readString(data, cursor: &cursor, count: Int(try readUInt8(data, cursor: &cursor))))
        case 0xDA: return try .string(readString(data, cursor: &cursor, count: Int(try readUInt16(data, cursor: &cursor))))
        case 0xDB: return try .string(readString(data, cursor: &cursor, count: Int(try readUInt32(data, cursor: &cursor))))
        case 0xC4: return try .binary(readBinary(data, cursor: &cursor, count: Int(try readUInt8(data, cursor: &cursor))))
        case 0xC5: return try .binary(readBinary(data, cursor: &cursor, count: Int(try readUInt16(data, cursor: &cursor))))
        case 0xC6: return try .binary(readBinary(data, cursor: &cursor, count: Int(try readUInt32(data, cursor: &cursor))))
        case 0xDC: return try readArray(data, cursor: &cursor, count: Int(try readUInt16(data, cursor: &cursor)))
        case 0xDD: return try readArray(data, cursor: &cursor, count: Int(try readUInt32(data, cursor: &cursor)))
        case 0xDE: return try readMap(data, cursor: &cursor, count: Int(try readUInt16(data, cursor: &cursor)))
        case 0xDF: return try readMap(data, cursor: &cursor, count: Int(try readUInt32(data, cursor: &cursor)))
        default: throw FrickMsgPackError.unsupportedType(b)
        }
    }

    private static func readUInt8(_ data: Data, cursor: inout Int) throws -> UInt8 {
        guard cursor < data.count else { throw FrickMsgPackError.truncated }
        let v = data[data.startIndex + cursor]
        cursor += 1
        return v
    }

    private static func readUInt16(_ data: Data, cursor: inout Int) throws -> UInt16 {
        guard cursor + 2 <= data.count else { throw FrickMsgPackError.truncated }
        let v = (UInt16(data[data.startIndex + cursor]) << 8) | UInt16(data[data.startIndex + cursor + 1])
        cursor += 2
        return v
    }

    private static func readUInt32(_ data: Data, cursor: inout Int) throws -> UInt32 {
        guard cursor + 4 <= data.count else { throw FrickMsgPackError.truncated }
        var v: UInt32 = 0
        for i in 0..<4 { v = (v << 8) | UInt32(data[data.startIndex + cursor + i]) }
        cursor += 4
        return v
    }

    private static func readUInt64(_ data: Data, cursor: inout Int) throws -> UInt64 {
        guard cursor + 8 <= data.count else { throw FrickMsgPackError.truncated }
        var v: UInt64 = 0
        for i in 0..<8 { v = (v << 8) | UInt64(data[data.startIndex + cursor + i]) }
        cursor += 8
        return v
    }

    private static func readString(_ data: Data, cursor: inout Int, count: Int) throws -> String {
        guard cursor + count <= data.count else { throw FrickMsgPackError.truncated }
        let slice = data.subdata(in: (data.startIndex + cursor)..<(data.startIndex + cursor + count))
        cursor += count
        guard let s = String(data: slice, encoding: .utf8) else { throw FrickMsgPackError.invalidUtf8 }
        return s
    }

    private static func readBinary(_ data: Data, cursor: inout Int, count: Int) throws -> Data {
        guard cursor + count <= data.count else { throw FrickMsgPackError.truncated }
        let slice = data.subdata(in: (data.startIndex + cursor)..<(data.startIndex + cursor + count))
        cursor += count
        return slice
    }

    private static func readArray(_ data: Data, cursor: inout Int, count: Int) throws -> FrickMsgPackValue {
        var items: [FrickMsgPackValue] = []
        items.reserveCapacity(count)
        for _ in 0..<count {
            items.append(try decode(data, cursor: &cursor))
        }
        return .array(items)
    }

    private static func readMap(_ data: Data, cursor: inout Int, count: Int) throws -> FrickMsgPackValue {
        var pairs: [(FrickMsgPackValue, FrickMsgPackValue)] = []
        pairs.reserveCapacity(count)
        for _ in 0..<count {
            let k = try decode(data, cursor: &cursor)
            let v = try decode(data, cursor: &cursor)
            pairs.append((k, v))
        }
        return .map(pairs)
    }

    // MARK: Frame helpers

    public static func encodeFrame(_ frame: FrickFrame) -> Data {
        encode(.array([.uint(UInt64(frame.kind.rawValue)), frame.payload]))
    }

    public static func decodeFrame(_ data: Data) throws -> FrickFrame {
        let value = try decode(data)
        guard case .array(let parts) = value, parts.count == 2 else {
            throw FrickMsgPackError.encodingFailure("frame must be a 2-element array")
        }
        guard let rawKind = parts[0].intValue, let kind = FrickFrameKind(rawValue: rawKind) else {
            throw FrickMsgPackError.encodingFailure("unknown frame kind \(parts[0])")
        }
        return FrickFrame(kind: kind, payload: parts[1])
    }
}

// MARK: - Capabilities (Swift mirrors of @frick/protocol)

public struct FrickClientCapabilities: Sendable, Equatable {
    public let platform: String
    public let sdkVersion: String
    public let schemaId: String
    public let schemaRevision: Int
    public let schemaHash: String
    public let transports: [String]
    public let encodings: [String]
    public let primitives: [String]
    public let offlineCache: Bool
    public let offlinePendingAppends: Bool
    public let blobUploads: [String]
    public let push: [String]
    public let experimental: [String]
    public let required: [String]

    public static func defaultIOS(sdkVersion: String = "0.1.0") -> FrickClientCapabilities {
        FrickClientCapabilities(
            platform: "ios",
            sdkVersion: sdkVersion,
            schemaId: FrickSchema.schemaId,
            schemaRevision: FrickSchema.schemaRevision,
            schemaHash: FrickSchema.schemaHash,
            transports: ["websocket"],
            encodings: ["msgpack"],
            primitives: ["objects", "streams", "presence", "signals"],
            offlineCache: true,
            offlinePendingAppends: true,
            blobUploads: ["direct"],
            push: [],
            experimental: [],
            required: []
        )
    }

    fileprivate func asMsgPack() -> FrickMsgPackValue {
        .map([
            (.string("platform"), .string(platform)),
            (.string("sdkVersion"), .string(sdkVersion)),
            (.string("schema"), .map([
                (.string("schemaId"), .string(schemaId)),
                (.string("schemaRevision"), .int(Int64(schemaRevision))),
                (.string("schemaHash"), .string(schemaHash)),
            ])),
            (.string("transports"), .array(transports.map { .string($0) })),
            (.string("encodings"), .array(encodings.map { .string($0) })),
            (.string("primitives"), .array(primitives.map { .string($0) })),
            (.string("offline"), .map([
                (.string("cache"), .bool(offlineCache)),
                (.string("pendingAppends"), .bool(offlinePendingAppends)),
            ])),
            (.string("blobUploads"), .array(blobUploads.map { .string($0) })),
            (.string("push"), .array(push.map { .string($0) })),
            (.string("experimental"), .array(experimental.map { .string($0) })),
            (.string("required"), .array(required.map { .string($0) })),
        ])
    }
}

public struct FrickServerCapabilities: Sendable, Equatable {
    public let schemaId: String
    public let schemaRevision: Int
    public let schemaHash: String
    public let transports: [String]
    public let encodings: [String]
    public let primitives: [String]
    public let blobUploads: [String]
    public let push: [String]
    public let experimental: [String]

    fileprivate init(map: [String: FrickMsgPackValue]) {
        let schema = map["schema"]?.mapValue ?? [:]
        self.schemaId = schema["schemaId"]?.stringValue ?? ""
        self.schemaRevision = schema["schemaRevision"]?.intValue ?? 0
        self.schemaHash = schema["schemaHash"]?.stringValue ?? ""
        self.transports = (map["transports"]?.arrayValue ?? []).compactMap { $0.stringValue }
        self.encodings = (map["encodings"]?.arrayValue ?? []).compactMap { $0.stringValue }
        self.primitives = (map["primitives"]?.arrayValue ?? []).compactMap { $0.stringValue }
        self.blobUploads = (map["blobUploads"]?.arrayValue ?? []).compactMap { $0.stringValue }
        self.push = (map["push"]?.arrayValue ?? []).compactMap { $0.stringValue }
        self.experimental = (map["experimental"]?.arrayValue ?? []).compactMap { $0.stringValue }
    }
}

public struct FrickSchemaCompatibility: Sendable, Equatable {
    /// "ok" | "client-ahead" | "server-ahead" | "incompatible"
    public let status: String
    public let clientSchemaHash: String?
    public let serverSchemaHash: String?
    public let reason: String?

    fileprivate init(map: [String: FrickMsgPackValue]) {
        self.status = map["status"]?.stringValue ?? "unknown"
        self.clientSchemaHash = map["clientSchemaHash"]?.stringValue
        self.serverSchemaHash = map["serverSchemaHash"]?.stringValue
        self.reason = map["reason"]?.stringValue
    }
}

// MARK: - Status & inbound events

public struct FrickSyncStatus: Sendable, Equatable {
    public enum ConnectionState: String, Sendable {
        case idle, connecting, connected, reconnecting, closed
    }

    public let state: ConnectionState
    public let serverCapabilities: FrickServerCapabilities?
    public let schemaCompatibility: FrickSchemaCompatibility?
    public let lastError: String?
    public let pendingAppendCount: Int

    public static let initial = FrickSyncStatus(
        state: .idle,
        serverCapabilities: nil,
        schemaCompatibility: nil,
        lastError: nil,
        pendingAppendCount: 0
    )

    public init(
        state: ConnectionState,
        serverCapabilities: FrickServerCapabilities?,
        schemaCompatibility: FrickSchemaCompatibility?,
        lastError: String?,
        pendingAppendCount: Int
    ) {
        self.state = state
        self.serverCapabilities = serverCapabilities
        self.schemaCompatibility = schemaCompatibility
        self.lastError = lastError
        self.pendingAppendCount = pendingAppendCount
    }
}

public struct FrickProjectionChange: Sendable, Equatable {
    public let key: String
    /// `nil` means delete; non-nil replaces the current row value. Carried as
    /// a msgpack value to stay `Sendable`; use `.anyValue` for a JSON view.
    public let value: FrickMsgPackValue?

    public init(key: String, value: FrickMsgPackValue?) {
        self.key = key
        self.value = value
    }
}

public enum FrickInboundEvent: Sendable {
    case status(FrickSyncStatus)
    case delta(stream: String?, events: [FrickStreamEvent], cursor: Int)
    case projectionDelta(projection: String, changes: [FrickProjectionChange])
    case ack(requestId: String, version: Int?, cursor: Int?)
    case nack(envelope: FrickErrorEnvelope?, requestId: String)
    case schema
    case syncStatus(connected: Bool, inFlight: Int)
    /// Inbound presence delta. `records` carry the live presence rows for the
    /// subscription key, `cleared` lists keys whose leases were revoked.
    case presenceDelta(name: String, records: [FrickPresenceRecord], cleared: [String])
}

/// Single presence row delivered in a `presenceDelta` frame.
public struct FrickPresenceRecord: Sendable, Equatable {
    public let key: String
    public let value: [String: String]

    public init(key: String, value: [String: String]) {
        self.key = key
        self.value = value
    }
}

// MARK: - WebSocket task abstraction (mockable boundary)

/// Minimal protocol covering the subset of `URLSessionWebSocketTask` that
/// `FrickSyncSocket` consumes. Tests substitute their own implementation so
/// the production code can be exercised without a real server.
public protocol FrickWebSocketTaskProtocol: AnyObject, Sendable {
    func resume()
    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?)
    func send(_ message: URLSessionWebSocketTask.Message) async throws
    func receiveMessage() async throws -> URLSessionWebSocketTask.Message
}

extension URLSessionWebSocketTask: FrickWebSocketTaskProtocol, @retroactive @unchecked Sendable {
    public func receiveMessage() async throws -> URLSessionWebSocketTask.Message {
        try await self.receive()
    }
}

/// Factory used by `FrickSyncSocket` to open a new task. Tests inject a
/// mock factory that returns a fake task fed by hand.
public protocol FrickWebSocketFactory: Sendable {
    func makeTask(url: URL) -> FrickWebSocketTaskProtocol
}

public struct URLSessionWebSocketFactory: FrickWebSocketFactory {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func makeTask(url: URL) -> FrickWebSocketTaskProtocol {
        session.webSocketTask(with: url)
    }
}

// MARK: - Pending append entry (in-memory only for v1)

private struct PendingSocketAppend: Sendable {
    let requestId: String
    let frame: Data
}

// MARK: - FrickSyncSocket

/// Persistent sync transport over WebSocket. Public API is async and
/// Sendable-safe. Durability of pending appends across process restart is
/// out of scope for this slice (in-memory queue only).
public actor FrickSyncSocket {
    public let baseURL: URL
    public let sessionToken: String
    public let clientCapabilities: FrickClientCapabilities
    public let replicaId: String
    public let deviceId: String

    private let factory: FrickWebSocketFactory
    private let sleepFor: @Sendable (UInt64) async throws -> Void

    private var task: FrickWebSocketTaskProtocol?
    private var receiveLoop: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var reconnectAttempt: Int = 0
    private var explicitlyClosed: Bool = false
    private var pending: [PendingSocketAppend] = []
    private var pendingResponders: [String: CheckedContinuation<Int?, Error>] = [:]

    private var statusValue: FrickSyncStatus = .initial
    private var statusContinuations: [UUID: AsyncStream<FrickSyncStatus>.Continuation] = [:]
    private var eventContinuation: AsyncThrowingStream<FrickInboundEvent, Error>.Continuation?
    private var eventStream: AsyncThrowingStream<FrickInboundEvent, Error>!

    public init(
        baseURL: URL,
        sessionToken: String,
        clientCapabilities: FrickClientCapabilities = .defaultIOS(),
        replicaId: String = "ios-replica",
        deviceId: String = "ios-device",
        factory: FrickWebSocketFactory = URLSessionWebSocketFactory(),
        sleepFor: @escaping @Sendable (UInt64) async throws -> Void = { ns in
            try await Task.sleep(nanoseconds: ns)
        }
    ) {
        self.baseURL = baseURL
        self.sessionToken = sessionToken
        self.clientCapabilities = clientCapabilities
        self.replicaId = replicaId
        self.deviceId = deviceId
        self.factory = factory
        self.sleepFor = sleepFor

        // Defer construction of the AsyncThrowingStream until after self init so
        // we can capture the continuation.
        let (stream, cont) = makeEventStream()
        self.eventStream = stream
        self.eventContinuation = cont
    }

    // MARK: Public surface

    public var status: FrickSyncStatus { statusValue }

    public func statusUpdates() -> AsyncStream<FrickSyncStatus> {
        AsyncStream { continuation in
            let id = UUID()
            statusContinuations[id] = continuation
            continuation.yield(statusValue)
            continuation.onTermination = { [weak self] _ in
                Task { await self?.removeStatusContinuation(id: id) }
            }
        }
    }

    private func removeStatusContinuation(id: UUID) {
        statusContinuations.removeValue(forKey: id)
    }

    public var events: AsyncThrowingStream<FrickInboundEvent, Error> { eventStream }

    public func connect() {
        explicitlyClosed = false
        reconnectAttempt = 0
        Task { await openSocket() }
    }

    public func close() async {
        explicitlyClosed = true
        reconnectTask?.cancel()
        reconnectTask = nil
        receiveLoop?.cancel()
        receiveLoop = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        // Fail all in-flight responders
        for (_, cont) in pendingResponders {
            cont.resume(throwing: CancellationError())
        }
        pendingResponders.removeAll()
        updateStatus { $0.state = .closed }
        eventContinuation?.finish()
    }

    // MARK: Send paths

    public func append(stream: String, key: String, event: String, payload: [String: Any]) async throws {
        let requestId = UUID().uuidString
        let frame = FrickFrame(kind: .append, payload: .map([
            (.string("requestId"), .string(requestId)),
            (.string("stream"), .string(stream)),
            (.string("key"), .string(key)),
            (.string("event"), .string(event)),
            (.string("payload"), FrickMsgPackValue.from(payload)),
        ]))
        try await sendOrQueue(requestId: requestId, frame: frame, expectResponse: true)
    }

    public func subscribe(stream: String, key: String) async throws {
        let subId = UUID().uuidString
        let frame = FrickFrame(kind: .subscribe, payload: .map([
            (.string("subscriptionId"), .string(subId)),
            (.string("kind"), .string("stream")),
            (.string("name"), .string(stream)),
            (.string("key"), .string(key)),
        ]))
        try await sendFrame(frame)
    }

    /// Subscribe to a presence type (e.g. "TypingState"). Inbound presence
    /// deltas surface via `events` as `.presenceDelta`. Mirrors the gateway's
    /// `kind: "presence"` subscribe payload.
    public func subscribePresence(name: String, key: String) async throws {
        let subId = UUID().uuidString
        let frame = FrickFrame(kind: .subscribe, payload: .map([
            (.string("subscriptionId"), .string(subId)),
            (.string("kind"), .string("presence")),
            (.string("name"), .string(name)),
            (.string("key"), .string(key)),
        ]))
        try await sendFrame(frame)
    }

    /// Publish a presence record. The `key` is opaque to the gateway and must
    /// match how subscribers expect to look it up (the demo composes it as
    /// "conversationId:userId:deviceId" for TypingState).
    public func setPresence(name: String, key: String, value: [String: Any]) async throws {
        let requestId = UUID().uuidString
        let frame = FrickFrame(kind: .presenceSet, payload: .map([
            (.string("requestId"), .string(requestId)),
            (.string("name"), .string(name)),
            (.string("key"), .string(key)),
            (.string("value"), FrickMsgPackValue.from(value)),
        ]))
        try await sendFrame(frame)
    }

    public func clearPresence(name: String, key: String) async throws {
        let requestId = UUID().uuidString
        let frame = FrickFrame(kind: .presenceClear, payload: .map([
            (.string("requestId"), .string(requestId)),
            (.string("name"), .string(name)),
            (.string("key"), .string(key)),
        ]))
        try await sendFrame(frame)
    }

    public func subscribeProjection(name: String) async throws {
        let subId = UUID().uuidString
        let frame = FrickFrame(kind: .subscribe, payload: .map([
            (.string("subscriptionId"), .string(subId)),
            (.string("kind"), .string("projection")),
            (.string("name"), .string(name)),
        ]))
        try await sendFrame(frame)
    }

    @discardableResult
    public func upsertObject(
        type: String,
        id: String,
        value: [String: Any],
        expectedVersion: Int? = nil
    ) async throws -> Int {
        let requestId = UUID().uuidString
        var pairs: [(FrickMsgPackValue, FrickMsgPackValue)] = [
            (.string("requestId"), .string(requestId)),
            (.string("objectType"), .string(type)),
            (.string("objectId"), .string(id)),
            (.string("value"), FrickMsgPackValue.from(value)),
        ]
        if let expectedVersion {
            pairs.append((.string("expectedVersion"), .int(Int64(expectedVersion))))
        }
        let frame = FrickFrame(kind: .objectUpsert, payload: .map(pairs))

        let version: Int? = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Int?, Error>) in
            pendingResponders[requestId] = cont
            Task { [self] in
                do {
                    try await sendOrQueue(requestId: requestId, frame: frame, expectResponse: false)
                } catch {
                    if let pending = await self.takeResponder(requestId: requestId) {
                        pending.resume(throwing: error)
                    }
                }
            }
        }
        return version ?? 0
    }

    fileprivate func takeResponder(requestId: String) -> CheckedContinuation<Int?, Error>? {
        pendingResponders.removeValue(forKey: requestId)
    }

    /// Number of frames buffered while disconnected (used by tests).
    public var pendingAppendCount: Int { pending.count }

    // MARK: Internal send pipeline

    private func sendOrQueue(requestId: String, frame: FrickFrame, expectResponse: Bool) async throws {
        let encoded = FrickMsgPackCodec.encodeFrame(frame)
        if statusValue.state == .connected, let task {
            do {
                try await task.send(.data(encoded))
            } catch {
                pending.append(PendingSocketAppend(requestId: requestId, frame: encoded))
                updateStatus { $0.pendingAppendCount = pending.count }
                throw error
            }
        } else {
            pending.append(PendingSocketAppend(requestId: requestId, frame: encoded))
            updateStatus { $0.pendingAppendCount = pending.count }
        }
    }

    private func sendFrame(_ frame: FrickFrame) async throws {
        guard let task else {
            throw FrickSyncSocketError.notConnected
        }
        try await task.send(.data(FrickMsgPackCodec.encodeFrame(frame)))
    }

    private func flushPending() async {
        guard let task else { return }
        let drained = pending
        pending.removeAll()
        updateStatus { $0.pendingAppendCount = 0 }
        for entry in drained {
            do {
                try await task.send(.data(entry.frame))
            } catch {
                // Re-queue at front; we'll retry on the next connection.
                pending.insert(entry, at: 0)
                updateStatus { $0.pendingAppendCount = pending.count }
                return
            }
        }
    }

    // MARK: Connection management

    private func openSocket() async {
        guard !explicitlyClosed else { return }
        updateStatus { $0.state = .connecting; $0.lastError = nil }

        let url = makeURL()
        let newTask = factory.makeTask(url: url)
        self.task = newTask
        newTask.resume()

        // Send Hello frame.
        let hello = FrickFrame(kind: .hello, payload: .map([
            (.string("replicaId"), .string(replicaId)),
            (.string("deviceId"), .string(deviceId)),
            (.string("schemaHash"), .string(FrickSchema.schemaHash)),
            (.string("knownCursors"), .map([])),
            (.string("clientCapabilities"), clientCapabilities.asMsgPack()),
        ]))
        do {
            try await newTask.send(.data(FrickMsgPackCodec.encodeFrame(hello)))
        } catch {
            await handleDisconnect(error: error)
            return
        }

        updateStatus { $0.state = .connected }
        await flushPending()

        // Start receive loop.
        receiveLoop = Task { [weak self] in
            await self?.runReceiveLoop(task: newTask)
        }
    }

    private func runReceiveLoop(task: FrickWebSocketTaskProtocol) async {
        while !Task.isCancelled {
            do {
                let message = try await task.receiveMessage()
                let data: Data
                switch message {
                case .data(let d): data = d
                case .string(let s): data = Data(s.utf8)
                @unknown default: continue
                }
                await handleIncoming(data: data)
            } catch {
                await handleDisconnect(error: error)
                return
            }
        }
    }

    private func handleIncoming(data: Data) async {
        guard let frame = try? FrickMsgPackCodec.decodeFrame(data) else {
            return
        }
        switch frame.kind {
        case .helloAck:
            handleHelloAck(payload: frame.payload)
        case .schema:
            eventContinuation?.yield(.schema)
        case .ping:
            // Respond with pong; mirror the sentAt timestamp if present.
            let pongPayload: FrickMsgPackValue
            if let map = frame.payload.mapValue, let sent = map["sentAt"]?.intValue {
                pongPayload = .map([
                    (.string("sentAt"), .int(Int64(sent))),
                    (.string("receivedAt"), .int(Int64(Date().timeIntervalSince1970 * 1000))),
                ])
            } else {
                pongPayload = .map([])
            }
            try? await sendFrame(FrickFrame(kind: .pong, payload: pongPayload))
        case .pong:
            break
        case .delta:
            handleDelta(payload: frame.payload)
        case .projectionDelta:
            handleProjectionDelta(payload: frame.payload)
        case .presenceDelta:
            handlePresenceDelta(payload: frame.payload)
        case .ack:
            handleAck(payload: frame.payload)
        case .nack:
            handleNack(payload: frame.payload)
        case .syncStatus:
            if let map = frame.payload.mapValue {
                let connected = map["connected"]?.boolValue ?? false
                let inFlight = map["inFlight"]?.intValue ?? 0
                eventContinuation?.yield(.syncStatus(connected: connected, inFlight: inFlight))
            }
        default:
            break
        }
    }

    private func handleHelloAck(payload: FrickMsgPackValue) {
        guard let map = payload.mapValue else { return }
        let server: FrickServerCapabilities? = map["serverCapabilities"].flatMap { value in
            guard let m = value.mapValue else { return nil }
            return FrickServerCapabilities(map: m)
        }
        let compatMap = map["schemaCompatibility"]?.mapValue ?? [:]
        let compat = FrickSchemaCompatibility(map: compatMap)
        updateStatus {
            $0.state = .connected
            $0.serverCapabilities = server
            $0.schemaCompatibility = compat
        }
    }

    private func handleDelta(payload: FrickMsgPackValue) {
        guard let map = payload.mapValue else { return }
        let cursor = map["cursor"]?.intValue ?? 0
        let eventArray = map["events"]?.arrayValue ?? []
        var streamEvents: [FrickStreamEvent] = []
        for e in eventArray {
            if let decoded = Self.decodePackedStreamEvent(e) {
                streamEvents.append(decoded)
                continue
            }
            // Tolerate the legacy `{stream, streamId, sequence, eventId, event, payload}`
            // map shape used by older fixtures and test harnesses. Production
            // gateways now ship the `PackedStreamEvent` tuple form above.
            guard let em = e.mapValue else { continue }
            let stream = em["stream"]?.stringValue ?? ""
            let streamId = em["streamId"]?.stringValue ?? em["key"]?.stringValue ?? ""
            let sequence = em["sequence"]?.intValue ?? 0
            let eventId = em["eventId"]?.stringValue ?? UUID().uuidString
            let eventName = em["event"]?.stringValue ?? ""
            let rawPayload = em["payload"]?.mapValue ?? [:]
            let payloadStrings = rawPayload.reduce(into: [String: String]()) { acc, entry in
                acc[entry.key] = Self.stringify(entry.value)
            }
            streamEvents.append(FrickStreamEvent(
                stream: stream,
                streamId: streamId,
                sequence: sequence,
                eventId: eventId,
                event: eventName,
                payload: payloadStrings
            ))
        }
        let streamName = streamEvents.first?.stream
        eventContinuation?.yield(.delta(stream: streamName, events: streamEvents, cursor: cursor))
    }

    /// Decode a `PackedStreamEvent` tuple
    /// `[streamTypeId, streamKey, sequence, eventId, eventTypeId, packedFields]`
    /// into a `FrickStreamEvent`, resolving stream/event/field ids via
    /// `FrickSchemaDescriptor`. Returns `nil` for unrecognized tuple shapes —
    /// callers fall back to the legacy map decoder.
    private static func decodePackedStreamEvent(_ value: FrickMsgPackValue) -> FrickStreamEvent? {
        guard let tuple = value.arrayValue, tuple.count >= 6 else { return nil }
        guard let streamTypeId = tuple[0].intValue,
              let streamKey = tuple[1].stringValue,
              let sequence = tuple[2].intValue,
              let eventId = tuple[3].stringValue,
              let eventTypeId = tuple[4].intValue
        else { return nil }
        let streamName = FrickSchemaDescriptor.streamNames[streamTypeId] ?? "#\(streamTypeId)"
        let eventName = FrickSchemaDescriptor.eventNames[eventTypeId] ?? "#\(eventTypeId)"
        let fieldTable = FrickSchemaDescriptor.eventFields[eventTypeId] ?? [:]
        let packedFields = tuple[5].arrayValue ?? []
        var payload: [String: String] = [:]
        for entry in packedFields {
            guard let pair = entry.arrayValue, pair.count >= 2,
                  let fieldId = pair[0].intValue else { continue }
            let name = fieldTable[fieldId] ?? "#\(fieldId)"
            payload[name] = Self.stringify(pair[1])
        }
        return FrickStreamEvent(
            stream: streamName,
            streamId: streamKey,
            sequence: sequence,
            eventId: eventId,
            event: eventName,
            payload: payload,
        )
    }

    private func handleProjectionDelta(payload: FrickMsgPackValue) {
        guard let map = payload.mapValue else { return }
        let projection = map["projection"]?.stringValue ?? ""
        let changesArray = map["changes"]?.arrayValue ?? []
        var changes: [FrickProjectionChange] = []
        for c in changesArray {
            guard let cm = c.mapValue, let key = cm["key"]?.stringValue else { continue }
            if case .some(.nilValue) = cm["value"] {
                changes.append(FrickProjectionChange(key: key, value: nil))
            } else if let value = cm["value"] {
                changes.append(FrickProjectionChange(key: key, value: value))
            } else {
                changes.append(FrickProjectionChange(key: key, value: nil))
            }
        }
        eventContinuation?.yield(.projectionDelta(projection: projection, changes: changes))
    }

    private func handlePresenceDelta(payload: FrickMsgPackValue) {
        guard let map = payload.mapValue else { return }
        let name = map["name"]?.stringValue ?? map["presence"]?.stringValue ?? ""
        let recordArray = map["records"]?.arrayValue ?? []
        var records: [FrickPresenceRecord] = []
        // The gateway packs records as msgpack arrays `[presenceId, key, packedFields]`.
        // We also accept the `{key, value}` map shape used by other transports.
        for entry in recordArray {
            if let arr = entry.arrayValue, arr.count >= 2, let key = arr[1].stringValue {
                let valueFields: [String: String]
                if arr.count >= 3, let fields = arr[2].mapValue {
                    valueFields = fields.reduce(into: [String: String]()) { acc, kv in
                        acc[kv.key] = Self.stringify(kv.value)
                    }
                } else {
                    valueFields = [:]
                }
                records.append(FrickPresenceRecord(key: key, value: valueFields))
            } else if let recMap = entry.mapValue {
                let key = recMap["key"]?.stringValue ?? ""
                let valueMap = recMap["value"]?.mapValue ?? [:]
                let valueFields = valueMap.reduce(into: [String: String]()) { acc, kv in
                    acc[kv.key] = Self.stringify(kv.value)
                }
                records.append(FrickPresenceRecord(key: key, value: valueFields))
            }
        }
        let cleared = (map["cleared"]?.arrayValue ?? []).compactMap { $0.stringValue }
        eventContinuation?.yield(.presenceDelta(name: name, records: records, cleared: cleared))
    }

    private func handleAck(payload: FrickMsgPackValue) {
        guard let map = payload.mapValue, let requestId = map["requestId"]?.stringValue else { return }
        let version = map["version"]?.intValue
        let cursor = map["cursor"]?.intValue
        if let cont = pendingResponders.removeValue(forKey: requestId) {
            cont.resume(returning: version)
        }
        eventContinuation?.yield(.ack(requestId: requestId, version: version, cursor: cursor))
    }

    private func handleNack(payload: FrickMsgPackValue) {
        guard let map = payload.mapValue else { return }
        let requestId = map["requestId"]?.stringValue ?? ""
        var envelope: FrickErrorEnvelope?
        if let errorValue = map["error"], let _ = errorValue.mapValue {
            // Re-encode via JSON to leverage existing decoder.
            let anyError = errorValue.anyValue
            if JSONSerialization.isValidJSONObject(anyError),
               let data = try? JSONSerialization.data(withJSONObject: anyError) {
                envelope = try? JSONDecoder().decode(FrickErrorEnvelope.self, from: data)
            }
        }
        if let cont = pendingResponders.removeValue(forKey: requestId) {
            let serverError = FrickServerError(httpStatusCode: 0, envelope: envelope, body: Data())
            cont.resume(throwing: serverError)
        }
        eventContinuation?.yield(.nack(envelope: envelope, requestId: requestId))
    }

    private static func stringify(_ value: FrickMsgPackValue) -> String {
        switch value {
        case .string(let s): return s
        case .int(let i): return String(i)
        case .uint(let u): return String(u)
        case .double(let d): return String(d)
        case .bool(let b): return String(b)
        case .nilValue: return ""
        case .binary(let d): return d.base64EncodedString()
        case .array, .map:
            let any = value.anyValue
            if let data = try? JSONSerialization.data(withJSONObject: any, options: [.sortedKeys]),
               let s = String(data: data, encoding: .utf8) {
                return s
            }
            return ""
        }
    }

    private func handleDisconnect(error: Error) async {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        receiveLoop?.cancel()
        receiveLoop = nil

        if explicitlyClosed {
            updateStatus { $0.state = .closed }
            return
        }
        updateStatus { $0.state = .reconnecting; $0.lastError = "\(error)" }

        reconnectAttempt += 1
        let delayMs = min(30_000, Int(pow(2.0, Double(reconnectAttempt))) * 250)
        let jitter = Int.random(in: 0...250)
        let delayNanos = UInt64((delayMs + jitter) * 1_000_000)

        reconnectTask = Task { [weak self] in
            try? await self?.sleepFor(delayNanos)
            await self?.openSocket()
        }
    }

    private func makeURL() -> URL {
        var components = URLComponents(url: baseURL.appending(path: "_frick").appending(path: "sync"), resolvingAgainstBaseURL: false)!
        // Force ws/wss scheme.
        if components.scheme == "http" { components.scheme = "ws" }
        else if components.scheme == "https" { components.scheme = "wss" }
        components.queryItems = [URLQueryItem(name: "sessionToken", value: sessionToken)]
        return components.url!
    }

    private func updateStatus(_ mutator: (inout MutableStatus) -> Void) {
        var m = MutableStatus(status: statusValue)
        mutator(&m)
        statusValue = m.build()
        for (_, cont) in statusContinuations {
            cont.yield(statusValue)
        }
        eventContinuation?.yield(.status(statusValue))
    }
}

// MARK: - Helpers

private struct MutableStatus {
    var state: FrickSyncStatus.ConnectionState
    var serverCapabilities: FrickServerCapabilities?
    var schemaCompatibility: FrickSchemaCompatibility?
    var lastError: String?
    var pendingAppendCount: Int

    init(status: FrickSyncStatus) {
        self.state = status.state
        self.serverCapabilities = status.serverCapabilities
        self.schemaCompatibility = status.schemaCompatibility
        self.lastError = status.lastError
        self.pendingAppendCount = status.pendingAppendCount
    }

    func build() -> FrickSyncStatus {
        FrickSyncStatus(
            state: state,
            serverCapabilities: serverCapabilities,
            schemaCompatibility: schemaCompatibility,
            lastError: lastError,
            pendingAppendCount: pendingAppendCount
        )
    }
}

private func makeEventStream() -> (AsyncThrowingStream<FrickInboundEvent, Error>, AsyncThrowingStream<FrickInboundEvent, Error>.Continuation) {
    var capturedCont: AsyncThrowingStream<FrickInboundEvent, Error>.Continuation!
    let stream = AsyncThrowingStream<FrickInboundEvent, Error>(bufferingPolicy: .unbounded) { continuation in
        capturedCont = continuation
    }
    return (stream, capturedCont)
}

// MARK: - Errors

public enum FrickSyncSocketError: Error, Equatable, Sendable {
    case notConnected
    case helloAckTimeout
    case unexpectedFrame(Int)
}

