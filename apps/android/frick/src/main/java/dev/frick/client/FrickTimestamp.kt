package dev.frick.client

import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException
import kotlinx.serialization.Serializable

/**
 * An RFC3339 timestamp carried verbatim from the wire. The canonical value
 * is [rawValue] (a fixed RFC3339 string) — an inline value class serializes
 * as that bare string, so it re-encodes byte-identically and fractional
 * seconds and the exact offset (Z vs +00:00) never drift on round-trip.
 * [instant] is a convenience that parses [rawValue]; the wire value is
 * unaffected by it, and no custom serializer configuration is required.
 *
 * Runtime mirror of the type the codegen inlines into generated artifacts
 * (`generateKotlinArtifact`, `frick-codegen/src/kotlin.rs`). Keep the two in
 * sync — the generated copy is what downstream apps compile, this copy is what
 * the `frick` Android library ships and tests.
 */
@Serializable
@JvmInline
value class FrickTimestamp(val rawValue: String) {
    /** The parsed instant, or null if [rawValue] is not a valid RFC3339 timestamp. */
    val instant: Instant?
        get() = try {
            OffsetDateTime.parse(rawValue).toInstant()
        } catch (e: DateTimeParseException) {
            null
        }
}
