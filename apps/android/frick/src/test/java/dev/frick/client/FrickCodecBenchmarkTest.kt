package dev.frick.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FR-99 — Kotlin codec speed micro-benchmark.
 *
 * Times the [FrickMsgPack] encode/decode hot paths over the SAME four
 * representative frame shapes the TypeScript (`bench/src/codec.ts`) and Swift
 * (`FrickCodecBenchmarkTests`) benchmarks use, so the numbers are comparable
 * across platforms:
 *
 *   - `appendMessage` — a single `Append` frame carrying one `MessageSent`.
 *   - `objectUpsert`  — an `ObjectUpsert` of a `Conversation`.
 *   - `streamPage`    — a `StreamPage` with [PAGE_EVENTS] packed stream events.
 *   - `delta`         — a `Delta` with one object + [PAGE_EVENTS] events.
 *
 * Deterministic timed loops, reported via stdout. We assert only that the work
 * completes and round-trips — never an absolute speed, which is machine- and
 * JIT-dependent, so the test stays green on any CI runner.
 */
class FrickCodecBenchmarkTest {
    private val ops = 2_000
    private val pageEvents = PAGE_EVENTS

    private fun messageSentFields(i: Int): List<Any?> = listOf(
        listOf(1, "msg-$i"),
        listOf(2, "user-bench"),
        listOf(3, "representative body $i ☃"),
        listOf(4, "2026-06-07T00:00:00.000Z"),
    )

    /** Packed stream event `[streamTypeId, key, sequence, eventId, eventTypeId, fields]`. */
    private fun packedEvent(i: Int): List<Any?> = listOf(
        1, "bench-conv", (i + 1), "evt-$i", 1, messageSentFields(i),
    )

    private fun packedEvents(): List<Any?> = (0 until pageEvents).map { packedEvent(it) }

    /** Packed object record `[objectTypeId, objectId, fields]`. */
    private fun packedConversation(): List<Any?> = listOf(
        2, "bench-conv",
        listOf(
            listOf(1, "group"),
            listOf(2, "Representative bench conversation"),
            listOf(3, "user-bench"),
            listOf(4, "evt-31"),
        ),
    )

    private fun frames(): List<Triple<String, Int, Map<String, Any?>>> = listOf(
        Triple(
            "appendMessage", FrameKindCodes.APPEND,
            mapOf(
                "requestId" to "bench-append-1",
                "stream" to "MessageStream",
                "key" to "bench-conv",
                "event" to "MessageSent",
                "payload" to mapOf(
                    "messageId" to "msg-append",
                    "senderId" to "user-bench",
                    "body" to "representative single-message append payload with unicode ☃",
                    "createdAt" to "2026-06-07T00:00:00.000Z",
                ),
            ),
        ),
        Triple(
            "objectUpsert", FrameKindCodes.OBJECT_UPSERT,
            mapOf(
                "requestId" to "bench-upsert-1",
                "objectType" to "Conversation",
                "objectId" to "bench-conv",
                "value" to mapOf(
                    "kind" to "group",
                    "title" to "Representative bench conversation",
                    "createdBy" to "user-bench",
                    "lastMessageEventId" to "evt-31",
                ),
            ),
        ),
        Triple(
            "streamPage", FrameKindCodes.STREAM_PAGE,
            mapOf(
                "subscriptionId" to "bench-sub",
                "events" to packedEvents(),
                "cursor" to pageEvents,
                "hasMore" to false,
            ),
        ),
        Triple(
            "delta", FrameKindCodes.DELTA,
            mapOf(
                "objects" to listOf(packedConversation()),
                "events" to packedEvents(),
                "cursor" to pageEvents,
            ),
        ),
    )

    @Test
    fun encodeThroughput() {
        for ((name, kind, payload) in frames()) {
            val bytes = FrickMsgPack.encodeFrame(kind, payload).size
            assertTrue("$name should encode to a non-empty frame", bytes > 0)
            val startNanos = System.nanoTime()
            repeat(ops) { FrickMsgPack.encodeFrame(kind, payload) }
            val elapsedNanos = System.nanoTime() - startNanos
            val perOpMicros = elapsedNanos / 1_000.0 / ops
            val opsPerSec = ops.toDouble() / (elapsedNanos / 1_000_000_000.0)
            println(
                "[FR-99 codec] kotlin encode %s: %d bytes, %.3f us/op, %.0f ops/sec"
                    .format(name, bytes, perOpMicros, opsPerSec),
            )
        }
    }

    @Test
    fun decodeThroughput() {
        for ((name, kind, payload) in frames()) {
            val encoded = FrickMsgPack.encodeFrame(kind, payload)
            val bytes = encoded.size
            // Verify it round-trips before timing the hot loop.
            val decoded = FrickMsgPack.decodeFrame(encoded)
            assertNotNull("$name should decode", decoded)
            assertEquals("$name should round-trip its kind", kind, decoded!!.first)

            val startNanos = System.nanoTime()
            repeat(ops) { FrickMsgPack.decodeFrame(encoded) }
            val elapsedNanos = System.nanoTime() - startNanos
            val perOpMicros = elapsedNanos / 1_000.0 / ops
            val opsPerSec = ops.toDouble() / (elapsedNanos / 1_000_000_000.0)
            println(
                "[FR-99 codec] kotlin decode %s: %d bytes, %.3f us/op, %.0f ops/sec"
                    .format(name, bytes, perOpMicros, opsPerSec),
            )
        }
    }

    private companion object {
        const val PAGE_EVENTS = 32
    }
}
