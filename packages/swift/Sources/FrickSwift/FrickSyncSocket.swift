import Foundation

// MARK: - FrameKind

/// Mirrors `FrameKind` from `@fricken/protocol`. Values must stay in lock-step
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
    case callCommand = 21
    case callCommandResult = 22

    /// Telemetry frame-kind label. Mirrors the TS `frameKindLabel` helper in
    /// `packages/core/src/runtime.ts`, which returns the PascalCase
    /// `FrameKind[kind]` enum-member name. Used as the `kind` attribute on
    /// the `frick.client.ws.frames.{sent,received}.total` counters.
    public var telemetryLabel: String {
        switch self {
        case .hello: return "Hello"
        case .schema: return "Schema"
        case .subscribe: return "Subscribe"
        case .snapshot: return "Snapshot"
        case .streamPage: return "StreamPage"
        case .append: return "Append"
        case .ack: return "Ack"
        case .nack: return "Nack"
        case .delta: return "Delta"
        case .presenceSet: return "PresenceSet"
        case .presenceClear: return "PresenceClear"
        case .presenceDelta: return "PresenceDelta"
        case .signalSend: return "SignalSend"
        case .signalDeliver: return "SignalDeliver"
        case .cursorCommit: return "CursorCommit"
        case .ping: return "Ping"
        case .pong: return "Pong"
        case .syncStatus: return "SyncStatus"
        case .helloAck: return "HelloAck"
        case .projectionDelta: return "ProjectionDelta"
        case .objectUpsert: return "ObjectUpsert"
        case .callCommand: return "CallCommand"
        case .callCommandResult: return "CallCommandResult"
        }
    }
}

// MARK: - WebSocket close categorization

/// Maps a WebSocket close code to a stable category label. Mirrors the TS
/// `webSocketCloseCategory` helper in `packages/core/src/runtime.ts` so the
/// Swift and TS clients emit identical `frick.ws.close_category` /
/// histogram `closeCategory` values.
public func frickWebSocketCloseCategory(_ code: Int?) -> String {
    switch code {
    case 1000: return "normal"
    case 1001: return "going_away"
    case 1002: return "protocol_error"
    case 1003: return "unsupported_data"
    case 1005: return "no_status"
    case 1006: return "abnormal"
    case 1007: return "invalid_payload"
    case 1008: return "policy_violation"
    case 1009: return "too_large"
    case 1010: return "mandatory_extension"
    case 1011: return "internal_error"
    case 1012: return "service_restart"
    case 1013: return "try_again_later"
    case 1014: return "bad_gateway"
    case 1015: return "tls_handshake"
    default:
        if let code, code >= 4000, code <= 4999 {
            return "private"
        }
        return "unknown"
    }
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
        // `Int(exactly:)` rejects out-of-range values (returning nil) rather
        // than trapping, so a 64-bit wire int that overflows the platform Int
        // surfaces as "no value" instead of crashing the receive loop.
        case .int(let v): return Int(exactly: v)
        case .uint(let v): return Int(exactly: v)
        // A decoded msgpack float can be any bit pattern, including NaN/Inf.
        // `Int(Double.nan)` / `Int(.infinity)` is a fatal runtime trap, so a
        // crafted frame carrying a non-finite float in a field this getter
        // feeds (frame kind, array lengths, ids) would hard-crash the client
        // (remote DoS, native-swift-3). Reject non-finite values, and round
        // toward zero before an `Int(exactly:)` range check.
        case .double(let v):
            guard v.isFinite else { return nil }
            return Int(exactly: v.rounded(.towardZero))
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

    /// Clamp an attacker-controlled element/pair count to a capacity the
    /// remaining buffer could plausibly produce before `reserveCapacity`.
    ///
    /// A length header (`0xDC..0xDF`) can declare a count near `UInt32.max`
    /// while the body is truncated; reserving that many slots up front forces
    /// an immediate multi-gigabyte allocation (memory DoS, native-swift-4)
    /// even though the subsequent `decode` would throw `.truncated`. Every
    /// element needs at least 1 byte on the wire, so `count` can never exceed
    /// the bytes left after the header — clamp the *reservation* to that. The
    /// loop still runs `count` iterations so a genuinely-short buffer surfaces
    /// the normal `.truncated` error; only the pre-allocation is bounded.
    private static func boundedReserve(_ count: Int, remainingBytes: Int) -> Int {
        max(0, min(count, remainingBytes))
    }

    private static func readArray(_ data: Data, cursor: inout Int, count: Int) throws -> FrickMsgPackValue {
        var items: [FrickMsgPackValue] = []
        items.reserveCapacity(boundedReserve(count, remainingBytes: data.count - cursor))
        for _ in 0..<count {
            items.append(try decode(data, cursor: &cursor))
        }
        return .array(items)
    }

    private static func readMap(_ data: Data, cursor: inout Int, count: Int) throws -> FrickMsgPackValue {
        var pairs: [(FrickMsgPackValue, FrickMsgPackValue)] = []
        // Each pair is two values ≥1 byte each, so remaining bytes still bounds
        // the pair count safely (an over-estimate at worst, never under).
        pairs.reserveCapacity(boundedReserve(count, remainingBytes: data.count - cursor))
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

// MARK: - Capabilities (Swift mirrors of @fricken/protocol)

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

    public static func defaultIOS(
        sdkVersion: String = "0.1.0",
        schemaId: String = FrickSchema.schemaId,
        schemaRevision: Int = FrickSchema.schemaRevision,
        schemaHash: String = FrickSchema.schemaHash
    ) -> FrickClientCapabilities {
        FrickClientCapabilities(
            platform: "ios",
            sdkVersion: sdkVersion,
            schemaId: schemaId,
            schemaRevision: schemaRevision,
            schemaHash: schemaHash,
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
    /// Inbound object-upsert delta. Surfaced when the gateway broadcasts
    /// `PackedObjectRecord` entries (e.g. via `publishObjects`). `records`
    /// is keyed by the object's declared field names, resolved through
    /// `FrickSchemaDescriptor`. Carried separately from `.delta` so existing
    /// stream-event consumers don't need to change.
    case objectsDelta(records: [FrickObjectRecord], cursor: Int)
    /// Inbound object **snapshot** — the authoritative full row set for a type,
    /// surfaced from a `Snapshot` frame (the server's reply to an object
    /// subscribe, also re-sent after a reconnect). Unlike `.objectsDelta` (an
    /// incremental merge), a snapshot is the complete current membership: a
    /// store must reconcile to it, dropping any cached row of that type NOT
    /// present here. This is what lets a row deleted *while the client was
    /// disconnected* — which generates no removal event, it simply doesn't
    /// appear in the reconnect snapshot — finally leave the cache instead of
    /// lingering as a stale (possibly access-revoked) row (native-swift-5).
    /// A snapshot may span multiple types; reconcile each type independently
    /// and only against types the snapshot actually carries.
    case objectsSnapshot(records: [FrickObjectRecord], cursor: Int)
    /// Inbound object removals (FR-142/FR-144). Surfaced when a Delta frame
    /// carries a non-empty `removed` list so consumers can drop the deleted
    /// rows directly without a refetch. The server also emits a back-compat
    /// tombstone record in `objects` (surfaced via `.objectsDelta`); consumers
    /// should apply removals after upserts so a delete wins over its tombstone.
    case objectsRemoved(removed: [FrickObjectRemoval], cursor: Int)
    case projectionDelta(projection: String, changes: [FrickProjectionChange])
    case ack(requestId: String, version: Int?, cursor: Int?)
    case nack(envelope: FrickErrorEnvelope?, requestId: String)
    /// Inbound `CallCommandResult` (frame kind 22). Surfaced alongside being
    /// resolved to the awaiting `callCommand` caller, so observers can also
    /// react to call lifecycle results.
    case callCommandResult(FrickCallCommandResult)
    case schema
    case syncStatus(connected: Bool, inFlight: Int)
    /// Inbound presence delta. `records` carry the live presence rows for the
    /// subscription key, `cleared` lists keys whose leases were revoked.
    case presenceDelta(name: String, records: [FrickPresenceRecord], cleared: [String])
}

/// Single object row delivered in an `objectsDelta` frame. `value` is the
/// object's full state keyed by the declared field names (resolved via
/// `FrickSchemaDescriptor`). Unknown field ids round-trip as `"#<id>"`
/// keys so a forward-incompatible schema bump still surfaces data.
public struct FrickObjectRecord: Sendable, Equatable {
    public let type: String
    public let id: String
    public let value: [String: String]

    public init(type: String, id: String, value: [String: String]) {
        self.type = type
        self.id = id
        self.value = value
    }
}

/// A single object removal delivered in a Delta frame's `removed` list
/// (FR-142/FR-144). Identifies the deleted row by its object `type` and `id`
/// so consumers can drop it directly without a refetch.
public struct FrickObjectRemoval: Sendable, Equatable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
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
    func makeTask(request: URLRequest) -> FrickWebSocketTaskProtocol
}

public extension FrickWebSocketFactory {
    func makeTask(request: URLRequest) -> FrickWebSocketTaskProtocol {
        guard let url = request.url else {
            preconditionFailure("Frick WebSocket requests require a URL")
        }
        return makeTask(url: url)
    }
}

public struct URLSessionWebSocketFactory: FrickWebSocketFactory {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func makeTask(url: URL) -> FrickWebSocketTaskProtocol {
        session.webSocketTask(with: url)
    }

    public func makeTask(request: URLRequest) -> FrickWebSocketTaskProtocol {
        session.webSocketTask(with: request)
    }
}

// MARK: - Pending append entry (in-memory only for v1)

private struct PendingSocketAppend: Sendable {
    let requestId: String
    let frame: Data
    /// Frame kind captured at enqueue time so `flushPending` can label the
    /// telemetry counter without re-decoding the (potentially large) encoded
    /// frame on the reconnect hot path (native-swift-7).
    let kind: FrickFrameKind
}

// MARK: - FrickSyncSocket

/// Type/field id → name tables `FrickSyncSocket` uses to decode packed
/// `Delta`/`Snapshot` frames into named-field records. Injected by the
/// consuming app so an app-defined protocol schema can be decoded without
/// baking app-specific types into the framework. Defaults to `.foundation`
/// (the generated foundation tables), preserving prior behavior.
public struct FrickSchemaDescriptorValues: Sendable {

    public let objectNames: [Int: String]
    public let objectFields: [Int: [Int: String]]
    public let streamNames: [Int: String]
    public let eventNames: [Int: String]
    public let eventFields: [Int: [Int: String]]


    public init(
        objectNames: [Int: String],
        objectFields: [Int: [Int: String]],
        streamNames: [Int: String],
        eventNames: [Int: String],
        eventFields: [Int: [Int: String]]
    ) {
        self.objectNames = objectNames
        self.objectFields = objectFields
        self.streamNames = streamNames
        self.eventNames = eventNames
        self.eventFields = eventFields
    }


    /// The generated foundation schema tables (`FrickSchemaDescriptor`).
    public static let foundation = FrickSchemaDescriptorValues(
        objectNames: FrickSchemaDescriptor.objectNames,
        objectFields: FrickSchemaDescriptor.objectFields,
        streamNames: FrickSchemaDescriptor.streamNames,
        eventNames: FrickSchemaDescriptor.eventNames,
        eventFields: FrickSchemaDescriptor.eventFields
    )

}


/// Persistent sync transport over WebSocket. Public API is async and
/// Sendable-safe. Durability of pending appends across process restart is
/// out of scope for this slice (in-memory queue only).
public actor FrickSyncSocket {
    public let baseURL: URL
    public let sessionToken: String
    public let clientCapabilities: FrickClientCapabilities
    public let replicaId: String
    public let deviceId: String
    /// Schema hash sent in the Hello frame. Defaults to the generated
    /// foundation hash; apps with a custom schema pass their own via
    /// `FrickClient(schemaHash:)`, which threads it through here.
    public let schemaHash: String

    private let factory: FrickWebSocketFactory
    private let sleepFor: @Sendable (UInt64) async throws -> Void
    private let descriptor: FrickSchemaDescriptorValues

    /// Telemetry runtime. Defaults to the no-op runtime so behavior is
    /// unchanged unless a runtime is supplied (mirrors `FrickClient`). The
    /// WS sync loop emits an OTEL-style span on connect/close plus frame
    /// counters and a connection-duration histogram, matching the TS client
    /// (`packages/core/src/runtime.ts`).
    private let telemetry: any FrickClientTelemetryRuntime

    /// Span + start time for the currently-open connection, if any. Mirrors
    /// the TS `#socketTelemetry` WeakMap keyed by the live socket.
    private var connectionSpan: (any FrickClientTelemetrySpan)?
    private var connectionStartedAt: Date?

    private var task: FrickWebSocketTaskProtocol?
    private var receiveLoop: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var reconnectAttempt: Int = 0
    private var explicitlyClosed: Bool = false
    private var pending: [PendingSocketAppend] = []
    private var pendingResponders: [String: CheckedContinuation<Int?, Error>] = [:]
    /// In-flight `CallCommand` requests keyed by `requestId`. Resolved by a
    /// matching `CallCommandResult` frame, or failed by a `Nack` carrying the
    /// same `requestId` — exactly the Append/ObjectUpsert↔Ack/Nack idiom, but
    /// the success value is the typed result payload the plain Ack can't carry.
    private var pendingCallResponders: [String: CheckedContinuation<FrickCallCommandResult, Error>] = [:]

    /// FR-256 (client half, opt-in): waiters parked by `subscribeObject` /
    /// `subscribe(stream:)` / `subscribeProjection` when called with
    /// `awaitRegistration: true`. Resolved when the server's initial
    /// Snapshot / StreamPage (keyed by `subscriptionId`) or ProjectionDelta
    /// (keyed by projection name) confirms registration; drained on close so a
    /// waiter never strands. Keyed by that correlation token.
    private var pendingRegistrations: [String: [CheckedContinuation<Void, Never>]] = [:]

    /// Subscribe frames keyed by a stable subscription identity, retained so
    /// they can be replayed after a reconnect. The server tracks
    /// subscriptions per-connection, so a reconnected socket that doesn't
    /// re-send these looks healthy but silently receives no deltas. Unlike
    /// `pending` (a consume-once outbound buffer that `flushPending()` drains
    /// and clears), this map persists for the life of the socket.
    private var activeSubscriptions: [String: FrickFrame] = [:]

    private var statusValue: FrickSyncStatus = .initial
    private var statusContinuations: [UUID: AsyncStream<FrickSyncStatus>.Continuation] = [:]

    /// Internal fan-out registry. Every inbound event is broadcast to ALL
    /// registered subscriber continuations (native-swift-1). An
    /// `AsyncThrowingStream` is single-consumer — each yielded element reaches
    /// exactly one awaiting iterator — so the previous design (handing the same
    /// backing stream to every caller via `events`) let 2+ stores/sessions on
    /// one socket race each yielded delta round-robin, silently dropping rows
    /// (e.g. an `Account` delta consumed and discarded by a `ContactStore`
    /// iterator). Each `events` access now vends a *fresh* child stream whose
    /// continuation is registered here, and `broadcast(_:)`/`finishSubscribers`
    /// fan every event/termination to all of them. The map is keyed by a
    /// per-subscriber `UUID` so `onTermination` can deregister an iterator that
    /// goes away (cancelled task / dropped store).
    private var eventSubscribers: [UUID: AsyncThrowingStream<FrickInboundEvent, Error>.Continuation] = [:]

    public init(
        baseURL: URL,
        sessionToken: String,
        clientCapabilities: FrickClientCapabilities = .defaultIOS(),
        replicaId: String = "ios-replica",
        deviceId: String = "ios-device",
        factory: FrickWebSocketFactory = URLSessionWebSocketFactory(),
        sleepFor: @escaping @Sendable (UInt64) async throws -> Void = { ns in
            try await Task.sleep(nanoseconds: ns)
        },
        schemaHash: String = FrickSchema.schemaHash,
        descriptor: FrickSchemaDescriptorValues = .foundation,
        telemetry: any FrickClientTelemetryRuntime = FrickNoopClientTelemetryRuntime()
    ) {
        self.baseURL = baseURL
        self.sessionToken = sessionToken
        self.clientCapabilities = clientCapabilities
        self.replicaId = replicaId
        self.deviceId = deviceId
        self.factory = factory
        self.sleepFor = sleepFor
        self.schemaHash = schemaHash
        self.descriptor = descriptor
        self.telemetry = telemetry
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

    /// A fresh broadcast subscription to the socket's inbound events. Each
    /// access vends an independent child stream, so multiple consumers (several
    /// `FrickStore`s / a `FrickProjectionStore` / a `FrickCallSession` on one
    /// socket) each receive EVERY event rather than racing for a single shared
    /// stream (native-swift-1). The child finishes when the socket is `close()`d
    /// or when the iterator's task is cancelled (its `onTermination` deregisters
    /// it). Buffering is unbounded so a slow consumer never drops events.
    public var events: AsyncThrowingStream<FrickInboundEvent, Error> {
        let id = UUID()
        return AsyncThrowingStream<FrickInboundEvent, Error>(bufferingPolicy: .unbounded) { continuation in
            registerEventSubscriber(id: id, continuation: continuation)
            continuation.onTermination = { [weak self] _ in
                Task { await self?.removeEventSubscriber(id: id) }
            }
        }
    }

    private func registerEventSubscriber(
        id: UUID,
        continuation: AsyncThrowingStream<FrickInboundEvent, Error>.Continuation
    ) {
        // If the socket is already closed, finish the new subscriber
        // immediately so its `for try await` loop terminates instead of
        // hanging on a stream that will never receive events.
        if statusValue.state == .closed {
            continuation.finish()
            return
        }
        eventSubscribers[id] = continuation
    }

    private func removeEventSubscriber(id: UUID) {
        eventSubscribers.removeValue(forKey: id)
    }

    /// Park the caller until the server confirms registration of `token` (the
    /// `subscriptionId` of an object/stream subscription or a projection name).
    /// Returns immediately if the socket is already closed — the subscribe
    /// replays on reconnect, and a closed socket would never deliver the
    /// snapshot that resolves the waiter. FR-256 client half (opt-in).
    /// Register a registration waiter for `token` and THEN send `frame`, parking
    /// the caller until the server's initial reply resolves it. Registering
    /// before the send is what closes the race: this actor can run `handleIncoming`
    /// (and so `resolveSubscriptionRegistration`) while `sendFrame` is suspended,
    /// which would resolve-and-drop a not-yet-parked waiter. The send is detached
    /// so the waiter is appended synchronously, strictly before the frame goes
    /// out — and the inbound reply can't arrive before the frame does. A send
    /// failure surfaces via nack/disconnect (which also drains the waiter), not
    /// from here. If the socket is already closed, just queue the frame and
    /// return — nothing would reply to resolve the waiter.
    private func registerThenSend(token: String, frame: FrickFrame) async {
        if status.state == .closed {
            try? await sendFrame(frame)
            return
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            pendingRegistrations[token, default: []].append(continuation)
            Task { [weak self] in try? await self?.sendFrame(frame) }
        }
    }

    /// Resume every waiter parked on `token`: its initial snapshot arrived, so
    /// the subscription is registered server-side.
    private func resolveSubscriptionRegistration(token: String) {
        guard let waiters = pendingRegistrations.removeValue(forKey: token) else { return }
        for waiter in waiters { waiter.resume() }
    }

    /// Resume every parked registration waiter regardless of token — used on a
    /// socket close so `subscribe…(awaitRegistration:)` callers don't hang; the
    /// subscriptions replay (and re-snapshot) on reconnect.
    private func resolveAllSubscriptionRegistrations() {
        for (_, waiters) in pendingRegistrations {
            for waiter in waiters { waiter.resume() }
        }
        pendingRegistrations.removeAll()
    }

    /// Fan an inbound event out to every registered subscriber.
    private func broadcast(_ event: FrickInboundEvent) {
        for (_, continuation) in eventSubscribers {
            continuation.yield(event)
        }
    }

    /// Finish every subscriber stream (clean socket shutdown). Mirrors the
    /// single-stream `finish()` the old design called in `close()`.
    private func finishSubscribers() {
        for (_, continuation) in eventSubscribers {
            continuation.finish()
        }
        eventSubscribers.removeAll()
        // Don't strand `subscribe…(awaitRegistration: true)` callers on a closed
        // socket (FR-256); reconnect replays + re-snapshots the subscription.
        resolveAllSubscriptionRegistrations()
    }

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
        for (_, cont) in pendingCallResponders {
            cont.resume(throwing: CancellationError())
        }
        pendingCallResponders.removeAll()
        // Explicit close is a clean shutdown — finish the span with the
        // normal-closure code (1000), matching the TS normal-close path.
        finishConnectionTelemetry(closeCode: 1000)
        updateStatus { $0.state = .closed }
        finishSubscribers()
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
        let frame = streamSubscribeFrame(subId: UUID().uuidString, stream: stream, key: key)
        activeSubscriptions["stream:\(stream):\(key)"] = frame
        try await sendFrame(frame)
    }

    /// Like `subscribe(stream:key:)` but resolves only once the server has
    /// REGISTERED the subscription — when the initial `StreamPage` for this
    /// subscription id arrives (the gateway sends it AFTER registering, FR-256
    /// client half) — so a write issued right after can't race ahead of
    /// registration. Additive: the existing `subscribe(stream:key:)` is unchanged.
    public func subscribeStreamRegistered(stream: String, key: String) async throws {
        let subId = UUID().uuidString
        let frame = streamSubscribeFrame(subId: subId, stream: stream, key: key)
        activeSubscriptions["stream:\(stream):\(key)"] = frame
        await registerThenSend(token: subId, frame: frame)
    }

    private func streamSubscribeFrame(subId: String, stream: String, key: String) -> FrickFrame {
        FrickFrame(kind: .subscribe, payload: .map([
            (.string("subscriptionId"), .string(subId)),
            (.string("kind"), .string("stream")),
            (.string("name"), .string(stream)),
            (.string("key"), .string(key)),
        ]))
    }

    /// Subscribe to a presence type (e.g. "CursorState"). Inbound presence
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
        activeSubscriptions["presence:\(name):\(key)"] = frame

        try await sendFrame(frame)
    }

    /// Publish a presence record. The `key` is opaque to the gateway and must
    /// match how subscribers expect to look it up (the demo composes it as
    /// "documentId:userId:deviceId" for a collaborative cursor state).
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
        let frame = projectionSubscribeFrame(subId: UUID().uuidString, name: name)
        activeSubscriptions["projection:\(name)"] = frame
        try await sendFrame(frame)
    }

    /// Like `subscribeProjection(name:)` but resolves once the initial
    /// `ProjectionDelta` (the post-registration reply, keyed by projection name)
    /// arrives (FR-256 client half). Additive; the existing method is unchanged.
    public func subscribeProjectionRegistered(name: String) async throws {
        let frame = projectionSubscribeFrame(subId: UUID().uuidString, name: name)
        activeSubscriptions["projection:\(name)"] = frame
        // Projections correlate by name (that is what the ProjectionDelta carries).
        await registerThenSend(token: name, frame: frame)
    }

    private func projectionSubscribeFrame(subId: String, name: String) -> FrickFrame {
        FrickFrame(kind: .subscribe, payload: .map([
            (.string("subscriptionId"), .string(subId)),
            (.string("kind"), .string("projection")),
            (.string("name"), .string(name)),
        ]))
    }

    /// Subscribe to all objects of `type`. The server replies with a
    /// Snapshot frame of the current row set (surfaced as
    /// `.objectsDelta(records:, cursor:)`) and then streams subsequent
    /// upserts the same way. Object subscriptions are type-scoped on
    /// the wire today; per-id filtering happens at the consumer
    /// (see `FrickDraftStore`).
    public func subscribeObject(type: String) async throws {
        let frame = objectSubscribeFrame(subId: UUID().uuidString, type: type)
        activeSubscriptions["object:\(type)"] = frame
        try await sendFrame(frame)
    }

    /// Like `subscribeObject(type:)` but resolves only once the server's initial
    /// `Snapshot` for this subscription id arrives — it is sent AFTER the gateway
    /// registers the subscription, so a write issued right after this can't race
    /// ahead of registration (FR-256 client half). Additive; the existing
    /// `subscribeObject(type:)` is unchanged. Use it before an
    /// immediately-following write you want to observe on the same connection.
    public func subscribeObjectRegistered(type: String) async throws {
        let subId = UUID().uuidString
        let frame = objectSubscribeFrame(subId: subId, type: type)
        activeSubscriptions["object:\(type)"] = frame
        await registerThenSend(token: subId, frame: frame)
    }

    private func objectSubscribeFrame(subId: String, type: String) -> FrickFrame {
        FrickFrame(kind: .subscribe, payload: .map([
            (.string("subscriptionId"), .string(subId)),
            (.string("kind"), .string("object")),
            (.string("name"), .string(type)),
        ]))
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
                    if let pending = self.takeResponder(requestId: requestId) {
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

    fileprivate func takeCallResponder(requestId: String) -> CheckedContinuation<FrickCallCommandResult, Error>? {
        pendingCallResponders.removeValue(forKey: requestId)
    }

    /// Issue a `CallCommand` (frame kind 21) and await the matching
    /// `CallCommandResult` (frame kind 22) — or a `Nack` keyed by the same
    /// `requestId`, which surfaces as a thrown `FrickServerError`. Mirrors the
    /// TS `FrickClient.callCommand`. The command body is encoded exactly like
    /// the wire contract in `packages/protocol/src/calls.ts`.
    public func callCommand(_ command: FrickCallCommand) async throws -> FrickCallCommandResult {
        let requestId = UUID().uuidString
        let frame = FrickFrame(kind: .callCommand, payload: .map([
            (.string("requestId"), .string(requestId)),
            (.string("command"), command.asMsgPack()),
        ]))
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<FrickCallCommandResult, Error>) in
            pendingCallResponders[requestId] = cont
            Task { [self] in
                do {
                    try await sendOrQueue(requestId: requestId, frame: frame, expectResponse: false)
                } catch {
                    if let pending = self.takeCallResponder(requestId: requestId) {
                        pending.resume(throwing: error)
                    }
                }
            }
        }
    }

    /// Number of frames buffered while disconnected (used by tests).
    public var pendingAppendCount: Int { pending.count }

    // MARK: Internal send pipeline

    private func sendOrQueue(requestId: String, frame: FrickFrame, expectResponse: Bool) async throws {
        let encoded = FrickMsgPackCodec.encodeFrame(frame)
        if statusValue.state == .connected, let task {
            do {
                try await task.send(.data(encoded))
                recordFrameTelemetry(direction: "sent", kind: frame.kind)
            } catch {
                pending.append(PendingSocketAppend(requestId: requestId, frame: encoded, kind: frame.kind))
                updateStatus { $0.pendingAppendCount = pending.count }
                throw error
            }
        } else {
            pending.append(PendingSocketAppend(requestId: requestId, frame: encoded, kind: frame.kind))
            updateStatus { $0.pendingAppendCount = pending.count }
        }
    }

    private func sendFrame(_ frame: FrickFrame) async throws {
        let encoded = FrickMsgPackCodec.encodeFrame(frame)
        // Buffer if the socket isn't fully open yet. `connect()` schedules
        // `openSocket()` on a detached Task, so callers that issue
        // subscribe/upsert immediately after `connect()` would otherwise race
        // the WS upgrade and hit `notConnected`. `flushPending()` drains the
        // buffer right after the hello lands, preserving FIFO order.
        guard statusValue.state == .connected, let task else {
            pending.append(PendingSocketAppend(requestId: "", frame: encoded, kind: frame.kind))
            updateStatus { $0.pendingAppendCount = pending.count }
            return
        }
        do {
            try await task.send(.data(encoded))
            recordFrameTelemetry(direction: "sent", kind: frame.kind)
        } catch {
            pending.append(PendingSocketAppend(requestId: "", frame: encoded, kind: frame.kind))
            updateStatus { $0.pendingAppendCount = pending.count }
            throw error
        }
    }

    private func flushPending() async {
        guard let task else { return }
        let drained = pending
        pending.removeAll()
        updateStatus { $0.pendingAppendCount = 0 }
        for entry in drained {
            do {
                try await task.send(.data(entry.frame))
                // Use the kind captured at enqueue time — re-decoding every
                // drained frame here just for the telemetry label re-parses
                // potentially large payloads on the reconnect hot path
                // (native-swift-7).
                recordFrameTelemetry(direction: "sent", kind: entry.kind)
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

        // Open the connection span before the upgrade so the span covers the
        // full connection lifetime (mirrors TS, which starts the span when the
        // socket is constructed in `connect()`).
        startConnectionTelemetry()

        let request = makeRequest()
        let newTask = factory.makeTask(request: request)
        self.task = newTask
        newTask.resume()

        // Send Hello frame.
        let hello = FrickFrame(kind: .hello, payload: .map([
            (.string("replicaId"), .string(replicaId)),
            (.string("deviceId"), .string(deviceId)),
            (.string("sessionToken"), .string(sessionToken)),
            (.string("schemaHash"), .string(schemaHash)),
            (.string("knownCursors"), .map([])),
            (.string("clientCapabilities"), clientCapabilities.asMsgPack()),
        ]))
        do {
            try await newTask.send(.data(FrickMsgPackCodec.encodeFrame(hello)))
            recordFrameTelemetry(direction: "sent", kind: hello.kind)
        } catch {
            await handleDisconnect(error: error)
            return
        }

        updateStatus { $0.state = .connected }

        // Replay subscriptions so a reconnect restores live delivery. The
        // server scopes subscriptions to the connection, so without this a
        // reconnected socket looks healthy but never receives deltas again —
        // the initial subscribe frame was consumed once via `pending` and is
        // not buffered for subsequent reconnects.
        for frame in activeSubscriptions.values {
            do {
                try await newTask.send(.data(FrickMsgPackCodec.encodeFrame(frame)))
                recordFrameTelemetry(direction: "sent", kind: frame.kind)
            } catch {
                await handleDisconnect(error: error)
                return
            }
        }

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
        recordFrameTelemetry(direction: "received", kind: frame.kind)
        switch frame.kind {
        case .helloAck:
            handleHelloAck(payload: frame.payload)
        case .schema:
            broadcast(.schema)
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
        case .streamPage:
            handleStreamPage(payload: frame.payload)
        case .snapshot:
            // Server response to `subscribe { kind: "object" }`. Same
            // `objects` payload as Delta — surface via the existing
            // `objectsDelta` case so consumers don't need a new branch
            // for the initial-state path vs. live updates.
            handleSnapshot(payload: frame.payload)
        case .projectionDelta:
            handleProjectionDelta(payload: frame.payload)
        case .presenceDelta:
            handlePresenceDelta(payload: frame.payload)
        case .callCommandResult:
            handleCallCommandResult(payload: frame.payload)
        case .ack:
            handleAck(payload: frame.payload)
        case .nack:
            handleNack(payload: frame.payload)
        case .syncStatus:
            if let map = frame.payload.mapValue {
                let connected = map["connected"]?.boolValue ?? false
                let inFlight = map["inFlight"]?.intValue ?? 0
                broadcast(.syncStatus(connected: connected, inFlight: inFlight))
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

    private func handleSnapshot(payload: FrickMsgPackValue) {
        guard let map = payload.mapValue else { return }
        let cursor = map["cursor"]?.intValue ?? 0
        let objectArray = map["objects"]?.arrayValue ?? []
        var records: [FrickObjectRecord] = []
        for o in objectArray {
            if let decoded = decodePackedObjectRecord(o) {
                records.append(decoded)
            }
        }
        // Surface as the authoritative full set so stores reconcile to it
        // (dropping rows deleted while disconnected), rather than a pure merge
        // that would leave such rows lingering (native-swift-5).
        broadcast(.objectsSnapshot(records: records, cursor: cursor))
        // FR-256: the object Snapshot is the server's post-registration reply,
        // so an opt-in `subscribeObject(awaitRegistration: true)` waiter on this
        // subscriptionId can resolve.
        if let subId = map["subscriptionId"]?.stringValue {
            resolveSubscriptionRegistration(token: subId)
        }
    }

    /// `StreamPage` is the server's reply to a stream subscribe (re-sent on
    /// reconnect). The Swift client does not surface stream pages as events yet,
    /// but the frame confirms registration, so resolve an opt-in
    /// `subscribe(stream:awaitRegistration: true)` waiter (FR-256).
    private func handleStreamPage(payload: FrickMsgPackValue) {
        guard let map = payload.mapValue else { return }
        if let subId = map["subscriptionId"]?.stringValue {
            resolveSubscriptionRegistration(token: subId)
        }
    }

    private func handleDelta(payload: FrickMsgPackValue) {
        guard let map = payload.mapValue else { return }
        let cursor = map["cursor"]?.intValue ?? 0
        let objectArray = map["objects"]?.arrayValue ?? []
        var objectRecords: [FrickObjectRecord] = []
        for o in objectArray {
            if let decoded = decodePackedObjectRecord(o) {
                objectRecords.append(decoded)
            }
        }
        if !objectRecords.isEmpty {
            broadcast(.objectsDelta(records: objectRecords, cursor: cursor))
        }
        // Object removals (FR-142/FR-144): the gateway carries a `removed`
        // list alongside the back-compat tombstone records in `objects`.
        // Surface them so consumers drop the deleted rows directly without a
        // refetch. Emitted after the upserts so a delete wins over its own
        // tombstone, and only when non-empty so existing consumers are
        // unaffected. Accepts both the `{type,id}` map shape and the packed
        // `[typeId, id]` tuple form (resolved via the schema descriptor).
        let removedArray = map["removed"]?.arrayValue ?? []
        var removals: [FrickObjectRemoval] = []
        for entry in removedArray {
            if let decoded = decodeObjectRemoval(entry) {
                removals.append(decoded)
            }
        }
        if !removals.isEmpty {
            broadcast(.objectsRemoved(removed: removals, cursor: cursor))
        }
        let eventArray = map["events"]?.arrayValue ?? []
        var streamEvents: [FrickStreamEvent] = []
        for e in eventArray {
            if let decoded = decodePackedStreamEvent(e) {
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
        broadcast(.delta(stream: streamName, events: streamEvents, cursor: cursor))
    }

    /// Decode a `PackedObjectRecord` tuple
    /// `[objectTypeId, recordId, packedFields]` into a `FrickObjectRecord`,
    /// resolving type and field ids via `FrickSchemaDescriptor`. Returns
    /// `nil` for malformed tuples or unknown object type ids.
    private func decodePackedObjectRecord(_ value: FrickMsgPackValue) -> FrickObjectRecord? {
        guard let tuple = value.arrayValue, tuple.count >= 3 else { return nil }
        guard let typeId = tuple[0].intValue,
              let id = tuple[1].stringValue
        else { return nil }
        guard let typeName = descriptor.objectNames[typeId] else { return nil }
        let fieldTable = descriptor.objectFields[typeId] ?? [:]
        let packedFields = tuple[2].arrayValue ?? []
        var fields: [String: String] = [:]
        for entry in packedFields {
            guard let pair = entry.arrayValue, pair.count >= 2,
                  let fieldId = pair[0].intValue else { continue }
            let name = fieldTable[fieldId] ?? "#\(fieldId)"
            fields[name] = Self.stringify(pair[1])
        }
        fields["id"] = id
        return FrickObjectRecord(type: typeName, id: id, value: fields)
    }

    /// Decode a single `Delta.removed` entry into a `FrickObjectRemoval`.
    /// Accepts both the packed tuple form `[objectTypeId, recordId]` (type id
    /// resolved via the schema descriptor) and the `{type, id}` map shape used
    /// by JSON-ish fixtures. Returns `nil` for malformed entries or unknown
    /// object type ids.
    private func decodeObjectRemoval(_ value: FrickMsgPackValue) -> FrickObjectRemoval? {
        if let tuple = value.arrayValue, tuple.count >= 2,
           let typeId = tuple[0].intValue,
           let id = tuple[1].stringValue,
           let typeName = descriptor.objectNames[typeId] {
            return FrickObjectRemoval(type: typeName, id: id)
        }
        if let map = value.mapValue,
           let type = map["type"]?.stringValue,
           let id = map["id"]?.stringValue {
            return FrickObjectRemoval(type: type, id: id)
        }
        return nil
    }

    /// Decode a `PackedStreamEvent` tuple
    /// `[streamTypeId, streamKey, sequence, eventId, eventTypeId, packedFields]`
    /// into a `FrickStreamEvent`, resolving stream/event/field ids via
    /// `FrickSchemaDescriptor`. Returns `nil` for unrecognized tuple shapes —
    /// callers fall back to the legacy map decoder.
    private func decodePackedStreamEvent(_ value: FrickMsgPackValue) -> FrickStreamEvent? {
        guard let tuple = value.arrayValue, tuple.count >= 6 else { return nil }
        guard let streamTypeId = tuple[0].intValue,
              let streamKey = tuple[1].stringValue,
              let sequence = tuple[2].intValue,
              let eventId = tuple[3].stringValue,
              let eventTypeId = tuple[4].intValue
        else { return nil }
        let streamName = descriptor.streamNames[streamTypeId] ?? "#\(streamTypeId)"
        let eventName = descriptor.eventNames[eventTypeId] ?? "#\(eventTypeId)"
        let fieldTable = descriptor.eventFields[eventTypeId] ?? [:]
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
        broadcast(.projectionDelta(projection: projection, changes: changes))
        // FR-256: the initial ProjectionDelta is the post-registration reply;
        // resolve an opt-in subscribeProjection waiter (keyed by name).
        resolveSubscriptionRegistration(token: projection)
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
        broadcast(.presenceDelta(name: name, records: records, cleared: cleared))
    }

    private func handleCallCommandResult(payload: FrickMsgPackValue) {
        guard let map = payload.mapValue,
              let requestId = map["requestId"]?.stringValue else { return }
        let result = FrickCallCommandResult(map: map)
        // The awaiting caller gets the full result (it needs `mediaGrant` to
        // join the media plane).
        if let cont = pendingCallResponders.removeValue(forKey: requestId) {
            cont.resume(returning: result)
        }
        // But the shared `events` stream is a broadcast surface every store /
        // telemetry sink / app observer iterates. `mediaGrant.token` is a
        // short-lived participant-scoped media credential that only the caller
        // needs; broadcasting it widens its exposure (e.g. an observer logging
        // unrecognized events would capture the token, native-swift-6). Strip
        // it from the broadcast copy — the caller already received the grant
        // via the awaited return value above.
        broadcast(.callCommandResult(result.redactingMediaGrant()))
    }

    private func handleAck(payload: FrickMsgPackValue) {
        guard let map = payload.mapValue, let requestId = map["requestId"]?.stringValue else { return }
        let version = map["version"]?.intValue
        let cursor = map["cursor"]?.intValue
        if let cont = pendingResponders.removeValue(forKey: requestId) {
            cont.resume(returning: version)
        }
        broadcast(.ack(requestId: requestId, version: version, cursor: cursor))
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
        // A `CallCommand` failure reuses the `Nack` frame keyed by the same
        // `requestId` (no separate error channel), so fail any in-flight call
        // responder identically — mirroring the TS client.
        if let cont = pendingCallResponders.removeValue(forKey: requestId) {
            let serverError = FrickServerError(httpStatusCode: 0, envelope: envelope, body: Data())
            cont.resume(throwing: serverError)
        }
        broadcast(.nack(envelope: envelope, requestId: requestId))
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

        // Fail every in-flight request/command awaiter (native-swift-2). The
        // frame was already sent on the now-dead socket, so its Ack/Nack/
        // CallCommandResult will never arrive: only `activeSubscriptions` and
        // the `pending` outbound buffer are replayed on reconnect, not an
        // already-transmitted request frame. Without this, an `upsertObject` /
        // `callCommand` (`join`/`leave`/`setMediaState`/…) awaited across a
        // mid-flight reconnect hangs forever — the call UI spinner never
        // resolves and the task leaks until `close()`. Mirror `close()`: drain
        // both responder maps and resume each throwing, so awaiters get a
        // reconnect error they can retry on instead of blocking.
        let disconnectError = FrickSyncSocketError.connectionDropped
        for (_, cont) in pendingResponders {
            cont.resume(throwing: disconnectError)
        }
        pendingResponders.removeAll()
        for (_, cont) in pendingCallResponders {
            cont.resume(throwing: disconnectError)
        }
        pendingCallResponders.removeAll()

        // The connection dropped on an error/receive failure with no clean
        // close handshake — categorize as abnormal (1006), matching the TS
        // error-close path. Finish the span before reconnecting so each
        // connection attempt gets its own span + duration sample.
        finishConnectionTelemetry(closeCode: 1006)

        if explicitlyClosed {
            updateStatus { $0.state = .closed }
            return
        }
        updateStatus { $0.state = .reconnecting; $0.lastError = "\(error)" }

        reconnectAttempt += 1
        // Exponential backoff capped at 30s. Cap the exponent BEFORE `pow` so a
        // long-unreachable server can't grow `reconnectAttempt` unbounded and
        // overflow `Int` in the `Double -> Int` conversion (a crash). 2^7 * 250ms
        // already exceeds the 30s ceiling, so a small cap loses nothing.
        let exponent = Double(min(reconnectAttempt, 7))
        let delayMs = min(30_000, Int(pow(2.0, exponent)) * 250)
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
        if let queryItems = components.queryItems {
            let filtered = queryItems.filter { $0.name != "sessionToken" }
            components.queryItems = filtered.isEmpty ? nil : filtered
        }
        return components.url!
    }

    private func makeRequest() -> URLRequest {
        var request = URLRequest(url: makeURL())
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func updateStatus(_ mutator: (inout MutableStatus) -> Void) {
        var m = MutableStatus(status: statusValue)
        mutator(&m)
        statusValue = m.build()
        for (_, cont) in statusContinuations {
            cont.yield(statusValue)
        }
        broadcast(.status(statusValue))
    }

    // MARK: Telemetry

    /// Path component of the WS endpoint, e.g. `/_frick/sync`. Mirrors the
    /// TS `urlPath` helper used for the span's `url.path` attribute.
    private func telemetryURLPath() -> String {
        let path = makeURL().path
        return path.isEmpty ? "/" : path
    }

    /// Open the connection span. Mirrors TS `#startWebSocketTelemetrySpan` +
    /// the `#socketTelemetry.set(...)` in `connect()`.
    private func startConnectionTelemetry() {
        let span = startFrickClientTelemetrySpan(telemetry, FrickClientTelemetrySpanStart(
            name: "WebSocket /_frick/sync",
            kind: .client,
            attributes: [
                "network.protocol.name": .string("websocket"),
                "url.path": .string(telemetryURLPath()),
                "frick.schema_id": .string(clientCapabilities.schemaId),
                "frick.schema_revision": .int(clientCapabilities.schemaRevision),
                "frick.authenticated": .bool(!sessionToken.isEmpty),
            ]
        ))
        connectionSpan = span
        connectionStartedAt = Date()
    }

    /// Finish the connection span and record the duration histogram. Mirrors
    /// TS `#finishWebSocketTelemetrySpan`. Idempotent: a no-op if no span is
    /// open (so a close following a disconnect doesn't double-emit).
    private func finishConnectionTelemetry(closeCode: Int?) {
        guard let span = connectionSpan else { return }
        let startedAt = connectionStartedAt
        connectionSpan = nil
        connectionStartedAt = nil

        let category = frickWebSocketCloseCategory(closeCode)
        var attributes: FrickClientTelemetryAttributes = [
            "frick.ws.close_category": .string(category),
        ]
        if let closeCode {
            attributes["frick.ws.close_code"] = .int(closeCode)
        }
        finishFrickClientTelemetrySpan(span, FrickClientTelemetrySpanResult(
            status: category == "normal" ? .ok : .error,
            attributes: attributes
        ))
        let durationMs = max(0, (startedAt.map { Date().timeIntervalSince($0) } ?? 0) * 1000)
        recordFrickClientTelemetryHistogram(
            telemetry,
            name: "frick.client.ws.connection.duration_ms",
            value: durationMs,
            attributes: ["closeCategory": .string(category)]
        )
    }

    /// Record a per-frame counter. Mirrors TS `#recordWebSocketFrameTelemetry`.
    private func recordFrameTelemetry(direction: String, kind: FrickFrameKind) {
        recordFrickClientTelemetryCounter(
            telemetry,
            name: "frick.client.ws.frames.\(direction).total",
            value: 1,
            attributes: ["kind": .string(kind.telemetryLabel)]
        )
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

// MARK: - Errors

public enum FrickSyncSocketError: Error, Equatable, Sendable {
    case notConnected
    case helloAckTimeout
    case unexpectedFrame(Int)
    /// The socket dropped (network error / abnormal close) while a request or
    /// call command was in-flight. The already-sent frame is not replayed on
    /// reconnect, so the awaiter is resumed with this rather than left to hang
    /// forever (native-swift-2). Idempotent retriable operations may re-issue.
    case connectionDropped
}
