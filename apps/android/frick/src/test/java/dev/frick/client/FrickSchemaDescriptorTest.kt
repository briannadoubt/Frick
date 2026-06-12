package dev.frick.client

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * FR-300: the injectable product schema descriptor. The foundation default
 * mirrors the generated constants/tables; an injected descriptor flows into the
 * Hello handshake so a product-schema app advertises its own identity.
 */
class FrickSchemaDescriptorTest {
    @Test
    fun foundationDescriptorMatchesGeneratedConstants() {
        val d = FrickSchemaDescriptor.FOUNDATION
        assertEquals(FRICK_SCHEMA_ID, d.schemaId)
        assertEquals(FRICK_SCHEMA_REVISION, d.schemaRevision)
        assertEquals(FRICK_SCHEMA_HASH, d.schemaHash)
        assertEquals(FRICK_OBJECT_NAMES, d.objectNames)
        assertEquals(FRICK_OBJECT_FIELDS, d.objectFields)
        assertEquals(FRICK_STREAM_NAMES, d.streamNames)
        assertEquals(FRICK_EVENT_NAMES, d.eventNames)
        assertEquals(FRICK_EVENT_FIELDS, d.eventFields)
    }

    @Test
    fun helloAdvertisesInjectedProductSchemaIdentity() {
        val product =
            FrickSchemaDescriptor(
                schemaId = "crate",
                schemaRevision = 7,
                schemaHash = "crate-hash-1.2.3",
                objectNames = mapOf(1 to "Listing"),
                objectFields = mapOf(1 to mapOf(1 to "title")),
            )

        val caps = defaultAndroidCapabilities(sdkVersion = "9.9.9", descriptor = product)

        @Suppress("UNCHECKED_CAST")
        val schema = caps["schema"] as Map<String, Any?>
        assertEquals("crate", schema["schemaId"])
        assertEquals(7, schema["schemaRevision"])
        assertEquals("crate-hash-1.2.3", schema["schemaHash"])
    }

    @Test
    fun helloDefaultsToFoundationWhenNoDescriptor() {
        val caps = defaultAndroidCapabilities()

        @Suppress("UNCHECKED_CAST")
        val schema = caps["schema"] as Map<String, Any?>
        assertEquals(FRICK_SCHEMA_ID, schema["schemaId"])
        assertEquals(FRICK_SCHEMA_REVISION, schema["schemaRevision"])
        assertEquals(FRICK_SCHEMA_HASH, schema["schemaHash"])
    }
}
