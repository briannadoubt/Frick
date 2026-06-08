import XCTest
@testable import FrickSwift

/// FR-99 — Swift codec speed micro-benchmarks.
///
/// Measures the `FrickMsgPackCodec` encode/decode hot paths over the SAME four
/// representative frame shapes the TypeScript (`bench/src/codec.ts`) and Kotlin
/// (`FrickCodecBenchmarkTest`) benchmarks use, so results are comparable across
/// platforms:
///
///   - `appendMessage` — a single `Append` frame carrying one `MessageSent`.
///   - `objectUpsert`  — an `ObjectUpsert` of a `Conversation`.
///   - `streamPage`    — a `StreamPage` with `pageEvents` packed stream events.
///   - `delta`         — a `Delta` with one object + `pageEvents` events.
///
/// Each test runs a tight loop and reports a timing via XCTest's `measure {}`
/// and a hand-rolled per-op print. We assert only that the work completes and
/// round-trips — never an absolute speed, which is machine-dependent.
final class FrickCodecBenchmarkTests: XCTestCase {
    /// Encode/decode calls per measured iteration. Kept modest so the suite
    /// stays fast and CI-friendly; the per-op cost is what's reported.
    private let ops = 2_000
    /// Packed events in the multi-event `streamPage` / `delta` shapes.
    private let pageEvents = 32

    // MARK: - Representative payloads

    private func messageSentPayload(_ i: Int) -> FrickMsgPackValue {
        .from([
            "messageId": "msg-\(i)",
            "senderId": "user-bench",
            "body": "representative message body number \(i) with some unicode \u{2603} and length",
            "createdAt": "2026-06-07T00:00:00.000Z",
        ])
    }

    /// One packed stream event `[streamTypeId, key, sequence, eventId, eventTypeId, fields]`.
    private func packedEvent(_ i: Int) -> FrickMsgPackValue {
        .array([
            .uint(1),
            .string("bench-conv"),
            .uint(UInt64(i + 1)),
            .string("evt-\(i)"),
            .uint(1),
            .array([
                .array([.uint(1), .string("msg-\(i)")]),
                .array([.uint(2), .string("user-bench")]),
                .array([.uint(3), .string("representative body \(i) \u{2603}")]),
                .array([.uint(4), .string("2026-06-07T00:00:00.000Z")]),
            ]),
        ])
    }

    private var packedEventsArray: FrickMsgPackValue {
        .array((0..<pageEvents).map { packedEvent($0) })
    }

    private var packedConversation: FrickMsgPackValue {
        // Packed object record `[objectTypeId, objectId, fields]`.
        .array([
            .uint(2),
            .string("bench-conv"),
            .array([
                .array([.uint(1), .string("group")]),
                .array([.uint(2), .string("Representative bench conversation")]),
                .array([.uint(3), .string("user-bench")]),
                .array([.uint(4), .string("evt-31")]),
            ]),
        ])
    }

    private func makeFrames() -> [(String, FrickFrame)] {
        [
            ("appendMessage", FrickFrame(kind: .append, payload: .from([
                "requestId": "bench-append-1",
                "stream": "MessageStream",
                "key": "bench-conv",
                "event": "MessageSent",
                "payload": [
                    "messageId": "msg-append",
                    "senderId": "user-bench",
                    "body": "representative single-message append payload with unicode \u{2603}",
                    "createdAt": "2026-06-07T00:00:00.000Z",
                ],
            ]))),
            ("objectUpsert", FrickFrame(kind: .objectUpsert, payload: .from([
                "requestId": "bench-upsert-1",
                "objectType": "Conversation",
                "objectId": "bench-conv",
                "value": [
                    "kind": "group",
                    "title": "Representative bench conversation",
                    "createdBy": "user-bench",
                    "lastMessageEventId": "evt-31",
                ],
            ]))),
            ("streamPage", FrickFrame(kind: .streamPage, payload: .map([
                (.string("subscriptionId"), .string("bench-sub")),
                (.string("events"), packedEventsArray),
                (.string("cursor"), .uint(UInt64(pageEvents))),
                (.string("hasMore"), .bool(false)),
            ]))),
            ("delta", FrickFrame(kind: .delta, payload: .map([
                (.string("objects"), .array([packedConversation])),
                (.string("events"), packedEventsArray),
                (.string("cursor"), .uint(UInt64(pageEvents))),
            ]))),
        ]
    }

    // MARK: - Tests

    func testEncodeThroughput() {
        for (name, frame) in makeFrames() {
            let bytes = FrickMsgPackCodec.encodeFrame(frame).count
            let start = Date()
            for _ in 0..<ops {
                _ = FrickMsgPackCodec.encodeFrame(frame)
            }
            let elapsed = Date().timeIntervalSince(start)
            let perOpMicros = elapsed / Double(ops) * 1_000_000
            print(String(format:
                "[FR-99 codec] swift encode %@: %d bytes, %.3f us/op, %.0f ops/sec",
                name, bytes, perOpMicros, Double(ops) / max(elapsed, 1e-9)))
            XCTAssertGreaterThan(bytes, 0, "\(name) should encode to a non-empty frame")
        }
    }

    func testDecodeThroughput() throws {
        for (name, frame) in makeFrames() {
            let encoded = FrickMsgPackCodec.encodeFrame(frame)
            let bytes = encoded.count
            // Verify it round-trips before timing the hot loop.
            let decoded = try FrickMsgPackCodec.decodeFrame(encoded)
            XCTAssertEqual(decoded.kind, frame.kind, "\(name) should round-trip its kind")

            let start = Date()
            for _ in 0..<ops {
                _ = try FrickMsgPackCodec.decodeFrame(encoded)
            }
            let elapsed = Date().timeIntervalSince(start)
            let perOpMicros = elapsed / Double(ops) * 1_000_000
            print(String(format:
                "[FR-99 codec] swift decode %@: %d bytes, %.3f us/op, %.0f ops/sec",
                name, bytes, perOpMicros, Double(ops) / max(elapsed, 1e-9)))
        }
    }

    /// XCTest's built-in measurement harness over the encode path of the
    /// largest (multi-event `delta`) frame — gives Xcode/CI a tracked metric
    /// without asserting an absolute number.
    func testMeasureDeltaEncode() {
        let frame = makeFrames().first { $0.0 == "delta" }!.1
        measure {
            for _ in 0..<ops {
                _ = FrickMsgPackCodec.encodeFrame(frame)
            }
        }
    }

    func testMeasureDeltaDecode() throws {
        let encoded = FrickMsgPackCodec.encodeFrame(makeFrames().first { $0.0 == "delta" }!.1)
        measure {
            for _ in 0..<ops {
                _ = try? FrickMsgPackCodec.decodeFrame(encoded)
            }
        }
    }
}
