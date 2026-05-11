package dev.frick.client

import java.io.File
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Decodes the canonical protocol fixtures under packages/protocol/fixtures
 * into the Android SDK's generated DTOs and runtime types. Catches wire-shape
 * drift between TypeScript-generated artifacts and the Kotlin SDK as the
 * schema evolves.
 */
class FrickProtocolFixturesTest {
    private val json = Json {
        ignoreUnknownKeys = true
    }

    @Serializable
    private data class FoundationSchemaIdentityFixture(
        val schemaId: String,
        val schemaVersion: String,
        val schemaRevision: Int,
        val minimumClientRevision: Int,
        val minimumServerRevision: Int,
        val protocol: String,
        val protocolVersion: Int,
        val compatibility: String,
        val hash: String,
    )

    @Serializable
    private data class HelloFrameClientCapabilitiesSchemaFixture(
        val schemaId: String,
        val schemaRevision: Int,
        val schemaHash: String,
    )

    @Serializable
    private data class HelloFrameClientCapabilitiesFixture(
        val platform: String,
        val sdkVersion: String,
        val schema: HelloFrameClientCapabilitiesSchemaFixture,
    )

    @Serializable
    private data class HelloFramePayloadFixture(
        val replicaId: String,
        val deviceId: String,
        val schemaHash: String,
        val knownCursors: JsonObject,
        val clientCapabilities: HelloFrameClientCapabilitiesFixture,
    )

    private fun loadFixture(name: String): String {
        // Walk up from the JVM working directory until we find the repo's
        // packages/protocol/fixtures directory. This works regardless of
        // whether gradle, the Android Studio runner, or a future task uses
        // apps/android/frick, apps/android, or the repo root as cwd.
        val userDir = System.getProperty("user.dir")
            ?: throw IllegalStateException("user.dir system property is not set")
        var dir: File? = File(userDir).absoluteFile
        while (dir != null) {
            val candidate = File(dir, "packages/protocol/fixtures/$name")
            if (candidate.isFile) {
                return candidate.readText()
            }
            dir = dir.parentFile
        }
        throw IllegalStateException(
            "Could not locate packages/protocol/fixtures/$name from cwd $userDir",
        )
    }

    @Test
    fun foundationSchemaFixtureMatchesGeneratedConstants() {
        val body = loadFixture("foundation-schema.json")
        assertTrue("foundation-schema.json fixture should be readable", body.isNotEmpty())

        val identity = json.decodeFromString(
            FoundationSchemaIdentityFixture.serializer(),
            body,
        )

        assertEquals(FRICK_SCHEMA_ID, identity.schemaId)
        assertEquals(FRICK_SCHEMA_REVISION, identity.schemaRevision)
        assertEquals(FRICK_SCHEMA_HASH, identity.hash)
        assertEquals(FRICK_SCHEMA_VERSION, identity.schemaVersion)
        assertEquals(FRICK_MINIMUM_CLIENT_REVISION, identity.minimumClientRevision)
        assertEquals(FRICK_MINIMUM_SERVER_REVISION, identity.minimumServerRevision)
        assertEquals("frick.realtime", identity.protocol)
        assertEquals(1, identity.protocolVersion)
        assertEquals("greenfield-cutover", identity.compatibility)
    }

    @Test
    fun errorEnvelopeFixtureMatchesGeneratedConstants() {
        val body = loadFixture("error-envelope.json")
        val envelope = parseFrickErrorEnvelope(body)
        assertNotNull("error-envelope.json should decode via parseFrickErrorEnvelope", envelope)
        val parsed = envelope!!

        assertEquals(FrickErrorCodes.SchemaIncompatible, parsed.code)
        assertEquals("fixture-error", parsed.requestId)
        assertFalse(parsed.retryable)
        assertEquals(FRICK_SCHEMA_HASH, parsed.schemaHash)
        assertEquals(FRICK_SCHEMA_REVISION, parsed.schemaRevision)
    }

    @Test
    fun helloFrameFixtureMatchesGeneratedConstants() {
        val body = loadFixture("hello-frame.json")
        val element = json.parseToJsonElement(body)
        val frame = element.jsonArray
        assertEquals("hello-frame.json should be a 2-tuple", 2, frame.size)

        val kind = (frame[0] as JsonPrimitive).int
        assertEquals("frame kind should be FrameKind.Hello (0)", 0, kind)

        val payloadObject = frame[1].jsonObject
        val payload = json.decodeFromJsonElement(
            HelloFramePayloadFixture.serializer(),
            payloadObject,
        )

        assertEquals("fixture-replica", payload.replicaId)
        assertEquals("fixture-device", payload.deviceId)
        assertEquals(FRICK_SCHEMA_HASH, payload.schemaHash)
        assertTrue("knownCursors should be empty", payload.knownCursors.isEmpty())
        assertEquals("test", payload.clientCapabilities.platform)
        assertEquals("0.0.0-fixture", payload.clientCapabilities.sdkVersion)
        assertEquals(FRICK_SCHEMA_ID, payload.clientCapabilities.schema.schemaId)
        assertEquals(FRICK_SCHEMA_REVISION, payload.clientCapabilities.schema.schemaRevision)
        assertEquals(FRICK_SCHEMA_HASH, payload.clientCapabilities.schema.schemaHash)
    }
}
