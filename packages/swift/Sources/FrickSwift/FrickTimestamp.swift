import Foundation

/// An RFC3339 timestamp carried verbatim from the wire. The canonical
/// value is `rawValue` (a fixed RFC3339 string) — it re-encodes
/// byte-identically, so fractional seconds and the exact offset (`Z` vs
/// `+00:00`) never drift on round-trip. `date` is a lossy convenience that
/// parses `rawValue` into a `Date`; the wire value is unaffected by it, and
/// no app-level `JSONDecoder.dateDecodingStrategy` is required.
///
/// This is the runtime mirror of the type the codegen inlines into generated
/// artifacts (`generateSwiftArtifact`, `frick-codegen/src/swift.rs`). Keep the
/// two in sync — the generated copy is what downstream apps compile, this copy
/// is what `FrickSwift` ships and tests.
public struct FrickTimestamp: Codable, Equatable, Sendable {
    public let rawValue: String

    public init(_ rawValue: String) {
        self.rawValue = rawValue
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self.rawValue = try container.decode(String.self)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    /// The parsed instant, or `nil` if `rawValue` is not a valid RFC3339
    /// timestamp. Parsing is millisecond-precision; `rawValue` keeps the full
    /// wire precision.
    public var date: Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let value = withFraction.date(from: rawValue) {
            return value
        }
        let withoutFraction = ISO8601DateFormatter()
        withoutFraction.formatOptions = [.withInternetDateTime]
        return withoutFraction.date(from: rawValue)
    }
}
