import XCTest
@testable import FrickSwift

final class FrickTimestampTests: XCTestCase {
    /// A DTO-shaped holder so we decode/encode the timestamp exactly as it
    /// travels inside a generated struct (a bare JSON string member), not as a
    /// top-level fragment.
    private struct Holder: Codable, Equatable {
        var at: FrickTimestamp
    }

    /// FR-308: an RFC3339 value with fractional seconds and a non-Z offset
    /// decodes to the typed wrapper and re-encodes byte-identically — no
    /// precision drift on the wire.
    func testFractionalSecondsNonZeroOffsetRoundTripsByteIdentically() throws {
        let wire = #"{"at":"2026-06-14T09:30:45.123456+05:30"}"#
        let data = Data(wire.utf8)

        let decoded = try JSONDecoder().decode(Holder.self, from: data)
        XCTAssertEqual(decoded.at.rawValue, "2026-06-14T09:30:45.123456+05:30")

        // The wrapper owns the codec, so re-encoding reproduces the wire bytes
        // verbatim regardless of fractional digits or offset spelling.
        let encoder = JSONEncoder()
        let reencoded = try encoder.encode(decoded)
        XCTAssertEqual(String(decoding: reencoded, as: UTF8.self), wire)
    }

    /// The `Z` spelling and a `+00:00` offset are distinct strings on the wire;
    /// the wrapper preserves whichever the server sent rather than normalizing.
    func testZuluAndOffsetSpellingsArePreservedDistinctly() throws {
        for raw in ["2026-06-14T09:30:45Z", "2026-06-14T09:30:45+00:00"] {
            let wire = "{\"at\":\"\(raw)\"}"
            let decoded = try JSONDecoder().decode(Holder.self, from: Data(wire.utf8))
            XCTAssertEqual(decoded.at.rawValue, raw)
            let reencoded = try JSONEncoder().encode(decoded)
            XCTAssertEqual(String(decoding: reencoded, as: UTF8.self), wire)
        }
    }

    /// `date` is the ergonomic accessor: a valid RFC3339 value parses; the wire
    /// string remains the source of truth.
    func testDateAccessorParsesValidTimestamps() {
        XCTAssertNotNil(FrickTimestamp("2026-06-14T09:30:45.123+05:30").date)
        XCTAssertNotNil(FrickTimestamp("2026-06-14T09:30:45Z").date)
        XCTAssertNil(FrickTimestamp("not-a-timestamp").date)
    }
}
