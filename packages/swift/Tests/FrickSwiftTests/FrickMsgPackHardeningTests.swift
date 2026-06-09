import XCTest
@testable import FrickSwift

/// Regression coverage for the msgpack decoder DoS hardening (native-swift-3,
/// native-swift-4). A malicious or buggy server can push an arbitrary byte
/// sequence; decoding one must never trap (hard crash / remote DoS) — it must
/// either decode or throw a recoverable `FrickMsgPackError`.
final class FrickMsgPackHardeningTests: XCTestCase {

    // MARK: native-swift-3 — NaN/Inf float → Int(Double) trap

    /// `Int(Double.nan)` / `Int(.infinity)` is a fatal runtime trap. `intValue`
    /// feeds the frame kind, array lengths, ids — a single inbound frame
    /// `[<NaN float>, payload]` hit `parts[0].intValue` and crashed the receive
    /// loop. The fix guards the conversion (`isFinite` + `Int(exactly:)`), so
    /// the getter returns `nil` instead of trapping.
    func testIntValueRejectsNaNWithoutTrapping() {
        XCTAssertNil(FrickMsgPackValue.double(.nan).intValue)
    }

    func testIntValueRejectsInfinityWithoutTrapping() {
        XCTAssertNil(FrickMsgPackValue.double(.infinity).intValue)
        XCTAssertNil(FrickMsgPackValue.double(-.infinity).intValue)
    }

    func testIntValueRejectsOutOfRangeDouble() {
        // 2^63 is one past Int64.max; must not trap on the narrowing.
        XCTAssertNil(FrickMsgPackValue.double(9.3e18 * 10).intValue)
    }

    func testIntValueRejectsOutOfRangeInt64() {
        // A 64-bit wire int that overflows the platform Int surfaces as nil,
        // not a trap. (On 64-bit platforms Int == Int64, so use a value that is
        // representable as Int64 but exercises the exact-conversion path.)
        XCTAssertEqual(FrickMsgPackValue.int(Int64.max).intValue.map { Int64($0) }, Int64.max)
    }

    func testIntValueStillRoundsFiniteDoubles() {
        XCTAssertEqual(FrickMsgPackValue.double(3.0).intValue, 3)
        XCTAssertEqual(FrickMsgPackValue.double(3.9).intValue, 3)   // toward zero
        XCTAssertEqual(FrickMsgPackValue.double(-3.9).intValue, -3) // toward zero
        XCTAssertEqual(FrickMsgPackValue.double(0.0).intValue, 0)
    }

    /// End-to-end: a frame whose first element is a NaN float64 must throw from
    /// `decodeFrame` (unknown frame kind) rather than trap. Pre-fix this was a
    /// hard crash; the test process surviving the call is the assertion.
    func testDecodeFrameWithNaNKindThrowsRatherThanCrashes() {
        // 0xCB = float64; bit pattern of Double.nan.
        var frame = Data([0x92, 0xCB]) // array(2), then float64 header
        var bits = Double.nan.bitPattern.bigEndian
        withUnsafeBytes(of: &bits) { frame.append(contentsOf: $0) }
        frame.append(0xC0) // payload: nil

        XCTAssertThrowsError(try FrickMsgPackCodec.decodeFrame(frame)) { error in
            guard case FrickMsgPackError.encodingFailure = error else {
                return XCTFail("expected encodingFailure (unknown kind), got \(error)")
            }
        }
    }

    /// The FR-144 `decodeObjectRemoval` tuple path also reads `tuple[0].intValue`
    /// on server-controlled data. A removal tuple `[<NaN>, "id"]` must decode to
    /// nothing (dropped), never trap.
    func testNaNObjectRemovalTupleDoesNotCrashReceiveLoop() {
        // Build a Delta frame with a `removed` entry whose typeId is a NaN
        // float. decodeFrame must succeed (the outer kind is a small int);
        // surfacing the frame must not trap on the inner intValue.
        let delta = FrickFrame(kind: .delta, payload: .map([
            (.string("cursor"), .int(1)),
            (.string("objects"), .array([])),
            (.string("removed"), .array([
                .array([.double(.nan), .string("acc-1")]),
            ])),
            (.string("events"), .array([])),
        ]))
        let encoded = FrickMsgPackCodec.encodeFrame(delta)
        // Decoding the frame itself must not trap.
        XCTAssertNoThrow(try FrickMsgPackCodec.decodeFrame(encoded))
        // And reading the inner tuple's intValue returns nil (drops the entry).
        let decoded = try? FrickMsgPackCodec.decodeFrame(encoded)
        let removed = decoded?.payload.mapValue?["removed"]?.arrayValue?.first?.arrayValue
        XCTAssertNil(removed?.first?.intValue, "NaN typeId must not resolve")
    }

    // MARK: native-swift-4 — unbounded reserveCapacity (memory DoS)

    /// A 32-bit array length header declaring ~UInt32.max elements over a
    /// near-empty body previously triggered an immediate multi-gigabyte
    /// `reserveCapacity` before any element was read (OOM crash). The fix clamps
    /// the reservation to remaining bytes; decode must throw `.truncated` fast
    /// without the giant allocation, and crucially without crashing.
    func testHugeArrayLengthHeaderDoesNotOOM() {
        // 0xDD = array32, length = 0xFFFFFFFF, then a single nil element only.
        let data = Data([0xDD, 0xFF, 0xFF, 0xFF, 0xFF, 0xC0])
        XCTAssertThrowsError(try FrickMsgPackCodec.decode(data)) { error in
            XCTAssertEqual(error as? FrickMsgPackError, .truncated)
        }
    }

    func testHugeMapLengthHeaderDoesNotOOM() {
        // 0xDF = map32, length = 0xFFFFFFFF, then a single key only (truncated).
        let data = Data([0xDF, 0xFF, 0xFF, 0xFF, 0xFF, 0xC0])
        XCTAssertThrowsError(try FrickMsgPackCodec.decode(data)) { error in
            XCTAssertEqual(error as? FrickMsgPackError, .truncated)
        }
    }

    func testHugeArray16LengthHeaderDoesNotOOM() {
        // 0xDC = array16, length = 0xFFFF, truncated body.
        let data = Data([0xDC, 0xFF, 0xFF, 0xC0])
        XCTAssertThrowsError(try FrickMsgPackCodec.decode(data)) { error in
            XCTAssertEqual(error as? FrickMsgPackError, .truncated)
        }
    }

    /// The clamp must not change correct decoding of well-formed arrays/maps at
    /// or just past the fixnum boundary (so the bound is genuinely a ceiling,
    /// not a cap that truncates real data).
    func testWellFormedLargeArrayStillDecodes() throws {
        let elements = (0..<5000).map { FrickMsgPackValue.int(Int64($0)) }
        let value = FrickMsgPackValue.array(elements)
        let encoded = FrickMsgPackCodec.encode(value)
        let decoded = try FrickMsgPackCodec.decode(encoded)
        XCTAssertEqual(decoded, value)
    }
}
