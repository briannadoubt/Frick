import Foundation

/// A heterogeneous JSON value carried through analytics, error envelopes,
/// and any other field where the wire shape is "whatever JSON the server
/// gave us, untyped." Mirrors `unknown` in TypeScript and `Any` in dynamic
/// JSON consumers, but stays `Sendable`/`Equatable`/`Codable`.
///
/// Keep this lean — if a specific surface starts needing structured fields,
/// model them as a proper struct on that surface instead of bolting cases
/// onto this type.
public enum FrickJSONValue: Sendable, Equatable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([FrickJSONValue])
    case object([String: FrickJSONValue])
}

extension FrickJSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
            return
        }
        if let value = try? container.decode(Bool.self) {
            self = .bool(value)
            return
        }
        // Decode integers ahead of doubles so `1` round-trips as `.int(1)`
        // rather than `.double(1.0)`. Falls through to Double for any
        // value JSONDecoder treats as floating-point.
        if let value = try? container.decode(Int64.self) {
            self = .int(value)
            return
        }
        if let value = try? container.decode(Double.self) {
            self = .double(value)
            return
        }
        if let value = try? container.decode(String.self) {
            self = .string(value)
            return
        }
        if let value = try? container.decode([FrickJSONValue].self) {
            self = .array(value)
            return
        }
        if let value = try? container.decode([String: FrickJSONValue].self) {
            self = .object(value)
            return
        }
        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "Unsupported JSON value"
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case .bool(let value):
            try container.encode(value)
        case .int(let value):
            try container.encode(value)
        case .double(let value):
            try container.encode(value)
        case .string(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        }
    }
}

extension FrickJSONValue: ExpressibleByNilLiteral {
    public init(nilLiteral: ()) {
        self = .null
    }
}

extension FrickJSONValue: ExpressibleByBooleanLiteral {
    public init(booleanLiteral value: Bool) {
        self = .bool(value)
    }
}

extension FrickJSONValue: ExpressibleByIntegerLiteral {
    public init(integerLiteral value: Int64) {
        self = .int(value)
    }
}

extension FrickJSONValue: ExpressibleByFloatLiteral {
    public init(floatLiteral value: Double) {
        self = .double(value)
    }
}

extension FrickJSONValue: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) {
        self = .string(value)
    }
}

extension FrickJSONValue: ExpressibleByArrayLiteral {
    public init(arrayLiteral elements: FrickJSONValue...) {
        self = .array(elements)
    }
}

extension FrickJSONValue: ExpressibleByDictionaryLiteral {
    public init(dictionaryLiteral elements: (String, FrickJSONValue)...) {
        var dict: [String: FrickJSONValue] = [:]
        for (key, value) in elements {
            dict[key] = value
        }
        self = .object(dict)
    }
}
