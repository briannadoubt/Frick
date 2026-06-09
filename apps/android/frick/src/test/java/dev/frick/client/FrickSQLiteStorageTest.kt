package dev.frick.client

import android.database.sqlite.SQLiteDatabase
import java.util.UUID
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FrickSQLiteStorageTest {
    private val databaseNames = mutableListOf<String>()

    @After
    fun deleteDatabases() {
        val context = RuntimeEnvironment.getApplication()
        databaseNames.forEach(context::deleteDatabase)
    }

    private fun session(userId: String, token: String): FrickSession =
        FrickSession(
            schemaHash = FRICK_SCHEMA_HASH,
            sessionToken = token,
            userId = userId,
            deviceId = "android-device",
            replicaId = "android-replica",
            expiresAt = "2026-05-09T22:00:00.000Z",
        )

    @Test
    fun persistsFoundationObjectsStreamEventsAndPendingAppendsAcrossInstances() {
        val context = RuntimeEnvironment.getApplication()
        val databaseName = "frick-test-${UUID.randomUUID()}.sqlite"
        databaseNames += databaseName

        val userJson = """{"id":"user-ada","displayName":"Ada Lovelace","avatarBlobId":null}"""
        val event = FrickStreamEvent(
            stream = "MessageStream",
            streamId = "conversation-general",
            sequence = 42,
            eventId = "event-42",
            event = "MessageSent",
            payload = mapOf(
                "messageId" to "message-42",
                "senderId" to "user-ada",
                "body" to "SQL backed",
                "createdAt" to "2026-05-09T12:00:00.000Z",
            ),
        )
        val append = PendingAppend(
            requestId = "request-1",
            body = """{"requestId":"request-1","stream":"MessageStream"}""",
        )

        SQLiteFrickStorage(context, name = databaseName).use { storage ->
            storage.saveObjectJson(type = "User", id = "user-ada", json = userJson, version = 1)
            storage.saveStreamEvent(event)
            storage.appendPendingAppend(append)
        }

        SQLiteFrickStorage(context, name = databaseName).use { storage ->
            assertEquals(userJson, storage.loadObjectJson(type = "User", id = "user-ada"))
            assertEquals(listOf(event), storage.loadStreamEvents(stream = "MessageStream", key = "conversation-general"))
            assertEquals(listOf(append), storage.loadPendingAppends())

            storage.removePendingAppend("request-1")
            assertEquals(emptyList<PendingAppend>(), storage.loadPendingAppends())
        }
    }

    @Test
    fun roundTripsCacheMetadataScopeAcrossInstances() {
        val context = RuntimeEnvironment.getApplication()
        val databaseName = "frick-test-${UUID.randomUUID()}.sqlite"
        databaseNames += databaseName

        val metadata = FrickCacheMetadata.currentSchema.copy(
            tenantId = "tenant-alpha",
            userId = "user-ada",
        )

        SQLiteFrickStorage(context, name = databaseName).use { storage ->
            storage.saveCacheMetadata(metadata)
        }

        SQLiteFrickStorage(context, name = databaseName).use { storage ->
            assertEquals(metadata, storage.loadCacheMetadata())
        }
    }

    @Test
    fun upgradesLegacyCacheMetadataWithoutDroppingCachedRows() {
        val context = RuntimeEnvironment.getApplication()
        val databaseName = "frick-test-${UUID.randomUUID()}.sqlite"
        databaseNames += databaseName
        val userJson = """{"id":"user-ada","displayName":"Ada Lovelace","avatarBlobId":null}"""

        context.openOrCreateDatabase(databaseName, 0, null).use { database ->
            createVersionFourSchema(database)
            database.execSQL(
                """
                INSERT INTO local_objects (object_type, object_id, json, version)
                VALUES ('User', 'user-ada', ?, 1)
                """.trimIndent(),
                arrayOf(userJson),
            )
            database.execSQL(
                """
                INSERT INTO frick_cache_metadata (id, schema_id, schema_version, schema_revision, schema_hash)
                VALUES ('current', ?, ?, ?, ?)
                """.trimIndent(),
                arrayOf<Any>(
                    FRICK_SCHEMA_ID,
                    FRICK_SCHEMA_VERSION,
                    FRICK_SCHEMA_REVISION,
                    FRICK_SCHEMA_HASH,
                ),
            )
            database.version = 4
        }

        SQLiteFrickStorage(context, name = databaseName).use { storage ->
            assertEquals(userJson, storage.loadObjectJson(type = "User", id = "user-ada"))

            val legacyMetadata = storage.loadCacheMetadata()
            assertEquals(FRICK_SCHEMA_ID, legacyMetadata?.schemaId)
            assertNull(legacyMetadata?.tenantId)
            assertNull(legacyMetadata?.userId)

            val scoped = FrickCacheMetadata.currentSchema.copy(
                tenantId = "tenant-alpha",
                userId = "user-ada",
            )
            storage.saveCacheMetadata(scoped)
            assertEquals(scoped, storage.loadCacheMetadata())
        }
    }

    // -- native-android-1: session secret is NOT in plaintext SQLite ----------

    @Test
    fun sessionSecretIsRoutedThroughTheSecretStoreNotPlaintextSqlite() {
        val context = RuntimeEnvironment.getApplication()
        val databaseName = "frick-test-${UUID.randomUUID()}.sqlite"
        databaseNames += databaseName
        val secretStore = InMemorySessionSecretStore()
        val token = "super-secret-bearer-token"

        SQLiteFrickStorage(context, name = databaseName, sessionSecretStore = secretStore).use { storage ->
            storage.saveSession(session("user-ada", token))

            // Round-trips through the (here: in-memory, prod: encrypted) secret store.
            assertEquals(token, storage.loadSession()?.sessionToken)
            assertNotNull(secretStore.loadSecret())
            assertTrue(secretStore.loadSecret()!!.contains(token))
        }

        // The raw SQLite file must NOT contain the bearer token anywhere — in
        // particular the legacy `auth_session` table must be empty.
        context.openOrCreateDatabase(databaseName, 0, null).use { database ->
            database.rawQuery("SELECT COUNT(*) FROM auth_session", null).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals(0, cursor.getInt(0))
            }
        }
    }

    @Test
    fun clearSessionWipesTheSecretStore() {
        val context = RuntimeEnvironment.getApplication()
        val databaseName = "frick-test-${UUID.randomUUID()}.sqlite"
        databaseNames += databaseName
        val secretStore = InMemorySessionSecretStore()

        SQLiteFrickStorage(context, name = databaseName, sessionSecretStore = secretStore).use { storage ->
            storage.saveSession(session("user-ada", "tok"))
            assertNotNull(storage.loadSession())

            storage.clearSession()

            assertNull(storage.loadSession())
            assertNull(secretStore.loadSecret())
        }
    }

    @Test
    fun migratesLegacyPlaintextSessionIntoTheSecretStoreThenDeletesIt() {
        val context = RuntimeEnvironment.getApplication()
        val databaseName = "frick-test-${UUID.randomUUID()}.sqlite"
        databaseNames += databaseName
        val token = "legacy-plaintext-token"
        val legacyJson =
            """{"schemaHash":"$FRICK_SCHEMA_HASH","sessionToken":"$token","userId":"user-leg","deviceId":"d","replicaId":"r","expiresAt":"2026-05-09T22:00:00.000Z"}"""

        // Seed the DB the way an OLD build did: a plaintext row in `auth_session`.
        SQLiteFrickStorage(context, name = databaseName, sessionSecretStore = InMemorySessionSecretStore()).use { storage ->
            // Touch the DB so SQLiteOpenHelper runs onCreate and the auth_session
            // table exists, then write a legacy plaintext row by hand.
            storage.loadCacheMetadata()
            storage.writableDatabase.execSQL(
                "INSERT OR REPLACE INTO auth_session (session_id, json) VALUES ('current', ?)",
                arrayOf(legacyJson),
            )
        }

        val secretStore = InMemorySessionSecretStore()
        SQLiteFrickStorage(context, name = databaseName, sessionSecretStore = secretStore).use { storage ->
            // First load migrates the plaintext row into the secret store.
            assertEquals(token, storage.loadSession()?.sessionToken)
            assertNotNull(secretStore.loadSecret())
        }

        // The plaintext row is gone afterward — no cleartext token left behind.
        context.openOrCreateDatabase(databaseName, 0, null).use { database ->
            database.rawQuery("SELECT COUNT(*) FROM auth_session", null).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals(0, cursor.getInt(0))
            }
        }
    }

    // -- native-android-3: clearCache leaves no cached rows on disk ------------

    @Test
    fun clearCacheWipesObjectsStreamEventsAndMetadataButNotSecretStore() {
        val context = RuntimeEnvironment.getApplication()
        val databaseName = "frick-test-${UUID.randomUUID()}.sqlite"
        databaseNames += databaseName
        val secretStore = InMemorySessionSecretStore()

        SQLiteFrickStorage(context, name = databaseName, sessionSecretStore = secretStore).use { storage ->
            storage.saveSession(session("user-ada", "tok"))
            storage.saveObjectJson(type = "User", id = "user-ada", json = """{"id":"user-ada"}""", version = 1)
            storage.saveStreamEvent(
                FrickStreamEvent(
                    stream = "MessageStream",
                    streamId = "c1",
                    sequence = 1,
                    eventId = "e1",
                    event = "MessageSent",
                    payload = mapOf("body" to "hi"),
                ),
            )
            storage.saveCacheMetadata(FrickCacheMetadata.currentSchema)

            storage.clearCache()

            assertNull(storage.loadObjectJson(type = "User", id = "user-ada"))
            assertTrue(storage.loadStreamEvents(stream = "MessageStream", key = "c1").isEmpty())
            assertNull(storage.loadCacheMetadata())
            // The session secret is independent of the cache and survives clearCache().
            assertNotNull(storage.loadSession())
        }
    }

    private fun createVersionFourSchema(database: SQLiteDatabase) {
        database.execSQL(
            """
            CREATE TABLE local_objects (
              object_type TEXT NOT NULL,
              object_id TEXT NOT NULL,
              json TEXT NOT NULL,
              version INTEGER NOT NULL,
              PRIMARY KEY (object_type, object_id)
            )
            """.trimIndent(),
        )
        database.execSQL(
            """
            CREATE TABLE frick_cache_metadata (
              id TEXT PRIMARY KEY NOT NULL,
              schema_id TEXT NOT NULL,
              schema_version TEXT NOT NULL,
              schema_revision INTEGER NOT NULL,
              schema_hash TEXT NOT NULL
            )
            """.trimIndent(),
        )
    }
}
