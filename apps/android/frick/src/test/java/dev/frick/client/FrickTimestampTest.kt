package dev.frick.client

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * FR-308: the generated `FrickTimestamp` inline value class owns the RFC3339
 * codec — it serializes as the bare wire string and re-encodes byte-identically,
 * so fractional seconds and the exact offset survive a round-trip.
 */
class FrickTimestampTest {
    /** A DTO-shaped holder so we (de)serialize the wrapper as a nested string member. */
    @Serializable
    private data class Holder(val at: FrickTimestamp)

    @Test
    fun fractionalSecondsNonZeroOffsetRoundTripsByteIdentically() {
        val wire = """{"at":"2026-06-14T09:30:45.123456+05:30"}"""

        val decoded = Json.decodeFromString(Holder.serializer(), wire)
        assertEquals("2026-06-14T09:30:45.123456+05:30", decoded.at.rawValue)

        val reencoded = Json.encodeToString(Holder.serializer(), decoded)
        assertEquals(wire, reencoded)
    }

    @Test
    fun zuluAndOffsetSpellingsArePreservedDistinctly() {
        for (raw in listOf("2026-06-14T09:30:45Z", "2026-06-14T09:30:45+00:00")) {
            val wire = """{"at":"$raw"}"""
            val decoded = Json.decodeFromString(Holder.serializer(), wire)
            assertEquals(raw, decoded.at.rawValue)
            assertEquals(wire, Json.encodeToString(Holder.serializer(), decoded))
        }
    }

    @Test
    fun instantAccessorParsesValidTimestamps() {
        assertNotNull(FrickTimestamp("2026-06-14T09:30:45.123456+05:30").instant)
        assertNotNull(FrickTimestamp("2026-06-14T09:30:45Z").instant)
        assertNull(FrickTimestamp("not-a-timestamp").instant)
    }
}
