package dev.frick.client

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.prepareGet
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsBytes
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.utils.io.readLine
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

data class FrickEvent(
    val event: String,
    val data: String,
)

@Serializable
data class FrickStreamEvent(
    val stream: String,
    val streamId: String,
    val sequence: Int,
    val eventId: String,
    val event: String,
    val payload: Map<String, String>,
)

data class FrickBlobMetadata(
    val blobId: String,
    val ownerId: String,
    val contentHash: String,
    val byteLength: Int,
    val mimeType: String,
    val storageKey: String?,
    val createdAt: String?,
)

/** Single search hit returned from `FrickClient.search(...)`. */
@Serializable
data class FrickSearchHit(
    val docId: String,
    val score: Double,
    val fields: Map<String, JsonElement> = emptyMap(),
)

/** Response envelope from the server's `/search` route. */
@Serializable
data class FrickSearchResponse(
    val schemaHash: String? = null,
    val index: String,
    val total: Int,
    val hits: List<FrickSearchHit>,
)

@Serializable
data class FrickAnalyticsTrackReceipt(
    val ok: Boolean,
    val eventId: String,
    val sequence: Long,
    val acceptedAt: String,
    val duplicate: Boolean,
)

/**
 * Permission an invitation grants on accept. Wire values are `"read"` /
 * `"write"`, matching `@fricken/protocol`'s `FrickSharingPermission`. Kept as
 * a plain string-backed enum (not a Kotlin `enum class`) so an unknown future
 * value from a newer server deserializes via [fromWire] without crashing the
 * client.
 */
enum class FrickSharingPermission(val wire: String) {
    READ("read"),
    WRITE("write"),
    ;

    companion object {
        fun fromWire(value: String): FrickSharingPermission =
            entries.firstOrNull { it.wire == value }
                ?: throw IllegalArgumentException("Unknown sharing permission: $value")
    }
}

/**
 * Transient, single-use token issued by an owner — Kotlin analogue of
 * `@fricken/protocol`'s `FrickInvitation`. The opaque [token] is what the owner
 * ships to a recipient out-of-band (deep link, message, whatever); the
 * recipient redeems it via `acceptInvitation`. Returned by [FrickClient.createInvitation].
 */
@Serializable
data class FrickInvitation(
    val id: String,
    val tenantId: String,
    val ownerUserId: String,
    val recordType: String,
    val recordId: String,
    val permission: String,
    val token: String,
    val createdAt: String,
    val expiresAt: String,
    val redeemedAt: String? = null,
    val redeemedByUserId: String? = null,
) {
    val sharingPermission: FrickSharingPermission get() = FrickSharingPermission.fromWire(permission)
}

/**
 * Durable "user G has permission P on record R until revoked" record — Kotlin
 * analogue of `@fricken/protocol`'s `FrickGrant`. Created by `acceptInvitation`;
 * owners list and revoke them. [revokedAt] is set once revoked, after which the
 * framework's authz flow stops honoring it.
 */
@Serializable
data class FrickGrant(
    val id: String,
    val tenantId: String,
    val ownerUserId: String,
    val recordType: String,
    val recordId: String,
    val granteeUserId: String,
    val permission: String,
    val createdAt: String,
    val revokedAt: String? = null,
) {
    val sharingPermission: FrickSharingPermission get() = FrickSharingPermission.fromWire(permission)

    /** `true` while this grant is still active (not revoked). */
    val isActive: Boolean get() = revokedAt == null
}

@Serializable
data class FrickSession(
    val schemaHash: String,
    val sessionToken: String,
    val userId: String,
    val tenantId: String? = null,
    val displayName: String? = null,
    val handle: String? = null,
    val deviceId: String,
    val replicaId: String,
    val expiresAt: String,
)

@Serializable
data class PendingAppend(
    val requestId: String,
    val body: String,
)

@Serializable
data class AppendRequest(
    val requestId: String,
    val replicaId: String,
    val stream: String,
    val key: String,
    val event: String,
    val payload: Map<String, JsonElement>,
)

@Serializable
private data class DevLoginRequest(
    val userId: String,
    val deviceId: String? = null,
    val replicaId: String? = null,
    val platform: String? = null,
)

@Serializable
private data class SignUpRequest(
    val displayName: String,
    val handle: String,
    val password: String,
    val deviceId: String? = null,
    val replicaId: String? = null,
    val platform: String? = null,
)

@Serializable
private data class LoginRequest(
    val identity: String,
    val password: String,
    val deviceId: String? = null,
    val replicaId: String? = null,
    val platform: String? = null,
)

@Serializable
private data class ForgotPasswordRequest(
    val email: String,
)

@Serializable
private data class ResetPasswordRequest(
    val token: String,
    val password: String,
)

@Serializable
private data class AnalyticsTrackRequest(
    val name: String,
    val properties: Map<String, JsonElement>? = null,
    val context: Map<String, JsonElement>? = null,
    val attributes: Map<String, JsonPrimitive>? = null,
    val traceId: String? = null,
    val idempotencyKey: String? = null,
    val occurredAt: String? = null,
)

@Serializable
private data class CreateInvitationRequest(
    val recordType: String,
    val recordId: String,
    val permission: String,
    val expiresInSeconds: Long? = null,
)

@Serializable
private data class AcceptInvitationRequest(
    val token: String,
)

class FrickSchemaMismatchException(
    val expectedSchemaHash: String,
    val actualSchemaHash: String?,
) : IllegalStateException(
    "Frick schema mismatch: expected $expectedSchemaHash, received $actualSchemaHash",
)

object FrickErrorCodes {
    const val AuthUnauthenticated = "auth.unauthenticated"
    const val AuthForbidden = "auth.forbidden"
    const val AuthSessionExpired = "auth.sessionExpired"
    const val SchemaIncompatible = "schema.incompatible"
    const val SchemaMigrationRequired = "schema.migrationRequired"
    const val StorageConflict = "storage.conflict"
    const val StorageNotFound = "storage.notFound"
    const val StreamAppendRejected = "stream.appendRejected"
    const val SyncProtocolError = "sync.protocolError"
    const val SyncReconnectExhausted = "sync.reconnectExhausted"
    const val BlobTooLarge = "blob.tooLarge"
    const val BlobUnsupportedContentType = "blob.unsupportedContentType"
    const val RateLimitExceeded = "rateLimit.exceeded"
    const val ServerInternal = "server.internal"
}

@Serializable
data class FrickErrorEnvelope(
    val code: String,
    val message: String,
    val requestId: String,
    val retryable: Boolean,
    val details: Map<String, JsonElement>? = null,
    val schemaHash: String? = null,
    val schemaRevision: Int? = null,
)

@Serializable
private data class FrickHttpErrorBody(
    val error: FrickErrorEnvelope? = null,
)

class FrickHttpException(
    val statusCode: Int,
    val envelope: FrickErrorEnvelope?,
    val responseBody: String,
    message: String,
) : IllegalStateException(message) {
    val code: String? get() = envelope?.code
    val requestId: String? get() = envelope?.requestId
    val retryable: Boolean get() = envelope?.retryable ?: false
}

class FrickAuthenticationRequiredException(
    message: String = "Frick requires an authenticated session for this operation",
) : IllegalStateException(message)

fun parseFrickErrorEnvelope(body: String): FrickErrorEnvelope? {
    if (body.isBlank()) {
        return null
    }
    runCatching {
        val wrapped = frickJson.decodeFromString<FrickHttpErrorBody>(body)
        wrapped.error?.let { return it }
    }
    return runCatching { frickJson.decodeFromString<FrickErrorEnvelope>(body) }.getOrNull()
}

@Serializable
data class FrickCacheMetadata(
    val schemaId: String,
    val schemaVersion: String,
    val schemaRevision: Int,
    val schemaHash: String,
    val tenantId: String? = null,
    val userId: String? = null,
) {
    companion object {
        val currentSchema: FrickCacheMetadata = forDescriptor(FrickSchemaDescriptor.FOUNDATION)

        /**
         * Cache metadata for a product schema [descriptor] (FR-300), so a
         * product-schema app's cache is keyed by its own identity rather than
         * the foundation default.
         */
        fun forDescriptor(descriptor: FrickSchemaDescriptor): FrickCacheMetadata =
            FrickCacheMetadata(
                schemaId = descriptor.schemaId,
                schemaVersion = FRICK_SCHEMA_VERSION,
                schemaRevision = descriptor.schemaRevision,
                schemaHash = descriptor.schemaHash,
            )
    }
}

enum class FrickCacheIncompatibilityReason {
    SCHEMA_ID_MISMATCH,
    CACHE_TOO_OLD,
    SESSION_SCOPE_MISMATCH,
}

class FrickCacheIncompatibleException(
    val reason: FrickCacheIncompatibilityReason,
    val cachedMetadata: FrickCacheMetadata,
    val currentMetadata: FrickCacheMetadata,
    val minimumClientRevision: Int,
    val pendingAppendCount: Int,
    message: String,
) : IllegalStateException(message)

object FrickCacheCompatibility {
    fun reason(
        cached: FrickCacheMetadata,
        current: FrickCacheMetadata,
        minimumClientRevision: Int,
    ): FrickCacheIncompatibilityReason? {
        if (cached.schemaId != current.schemaId) {
            return FrickCacheIncompatibilityReason.SCHEMA_ID_MISMATCH
        }
        if (cached.schemaRevision < minimumClientRevision) {
            return FrickCacheIncompatibilityReason.CACHE_TOO_OLD
        }
        if (
            (current.tenantId != null && cached.tenantId != current.tenantId) ||
            (current.userId != null && cached.userId != current.userId)
        ) {
            return FrickCacheIncompatibilityReason.SESSION_SCOPE_MISMATCH
        }
        return null
    }
}

interface FrickTransport {
    suspend fun get(path: String): String
    suspend fun getBytes(path: String): ByteArray
    fun stream(path: String): Flow<String>
    suspend fun post(path: String, body: String): String
    suspend fun post(path: String, body: String, headers: Map<String, String>): String = post(path, body)
    suspend fun putBytes(path: String, mimeType: String, bytes: ByteArray): String

    /**
     * Issue an authenticated JSON `PUT`. Carries a default so existing
     * [FrickTransport] implementations (and test fakes) stay source-compatible;
     * the real [KtorFrickTransport] overrides it with `application/json`. App
     * command endpoints that migrate to canonical PUT routes are the callers —
     * [putBytes] would be semantically wrong for a JSON body.
     */
    suspend fun put(path: String, body: String, headers: Map<String, String> = emptyMap()): String =
        throw UnsupportedOperationException("PUT is not supported by this transport")

    /**
     * Issue an authenticated `DELETE`. Carries a default so existing
     * [FrickTransport] implementations (and test fakes) stay source-compatible;
     * the real [KtorFrickTransport] overrides it. The sharing revoke verb
     * (`DELETE /share/grants/:id`) is the first caller.
     */
    suspend fun delete(path: String): String =
        throw UnsupportedOperationException("DELETE is not supported by this transport")
}

interface FrickStorage {
    fun loadObjectJson(type: String, id: String): String?
    fun saveObjectJson(type: String, id: String, json: String, version: Int)
    fun loadStreamEvents(stream: String, key: String): List<FrickStreamEvent>
    fun saveStreamEvent(event: FrickStreamEvent)
    fun loadPendingAppends(): List<PendingAppend>
    fun appendPendingAppend(append: PendingAppend)
    fun removePendingAppend(requestId: String)
    fun clearPendingAppends() {
        loadPendingAppends().forEach { append -> removePendingAppend(append.requestId) }
    }
    fun loadSession(): FrickSession?
    fun saveSession(session: FrickSession)
    fun clearSession()
    fun loadCacheMetadata(): FrickCacheMetadata?
    fun saveCacheMetadata(metadata: FrickCacheMetadata)
    fun clearCache()
}

object NoopFrickStorage : FrickStorage {
    override fun loadObjectJson(type: String, id: String): String? = null
    override fun saveObjectJson(type: String, id: String, json: String, version: Int) = Unit
    override fun loadStreamEvents(stream: String, key: String): List<FrickStreamEvent> = emptyList()
    override fun saveStreamEvent(event: FrickStreamEvent) = Unit
    override fun loadPendingAppends(): List<PendingAppend> = emptyList()
    override fun appendPendingAppend(append: PendingAppend) = Unit
    override fun removePendingAppend(requestId: String) = Unit
    override fun clearPendingAppends() = Unit
    override fun loadSession(): FrickSession? = null
    override fun saveSession(session: FrickSession) = Unit
    override fun clearSession() = Unit
    override fun loadCacheMetadata(): FrickCacheMetadata? = null
    override fun saveCacheMetadata(metadata: FrickCacheMetadata) = Unit
    override fun clearCache() = Unit
}

/**
 * SQLite-backed [FrickStorage] for the Android SDK.
 *
 * Persistence is split by sensitivity:
 *  - The durable **session secret** (the bearer [FrickSession.sessionToken] and
 *    the identity it authenticates) is routed through an injectable
 *    [SessionSecretStore]. The default ([keystoreBackedSessionSecretStore]) is
 *    [EncryptedSharedPreferences][androidx.security.crypto.EncryptedSharedPreferences]
 *    over an AndroidKeyStore master key, so the secret is AES-256-GCM encrypted
 *    at rest — never plaintext on disk. This is the Android analogue of the iOS
 *    Keychain path.
 *  - The **non-secret cache** (object rows, stream events, pending appends,
 *    cache metadata) lives in plain SQLite. None of it is a credential.
 *
 * The legacy plaintext `auth_session` table is no longer written. On first
 * [loadSession] any pre-existing plaintext row is migrated into the secret store
 * and then deleted from SQLite, so an upgraded install does not leave the old
 * cleartext token behind.
 *
 * [sessionSecretStore] is injectable so the `:frick` unit tests (JVM/Robolectric,
 * no real Keystore) can substitute [InMemorySessionSecretStore], mirroring how
 * the iOS side fakes Keychain access.
 */
class SQLiteFrickStorage(
    context: Context,
    name: String = "frick.sqlite",
    private val json: Json = frickJson,
    sessionSecretStore: SessionSecretStore? = null,
) : SQLiteOpenHelper(context.applicationContext, name, null, DATABASE_VERSION), FrickStorage {
    private val lock = Any()

    private val appContext = context.applicationContext

    // The default keystore-backed store is built LAZILY so merely constructing
    // the storage (e.g. cache-only callers, or tests that never touch the
    // session) does not reach for the AndroidKeyStore — which is absent under
    // Robolectric. Pass [sessionSecretStore] (e.g. [InMemorySessionSecretStore])
    // in JVM/Robolectric unit tests with no real Keystore.
    private val injectedSecretStore: SessionSecretStore? = sessionSecretStore
    private val secretStore: SessionSecretStore by lazy {
        injectedSecretStore ?: keystoreBackedSessionSecretStore(appContext)
    }

    override fun loadObjectJson(type: String, id: String): String? =
        synchronized(lock) {
            readableDatabase.query(
                OBJECTS_TABLE,
                arrayOf(OBJECT_JSON),
                "$OBJECT_TYPE = ? AND $OBJECT_ID = ?",
                arrayOf(type, id),
                null,
                null,
                null,
                "1",
            ).use { cursor ->
                if (cursor.moveToFirst()) {
                    cursor.getString(cursor.getColumnIndexOrThrow(OBJECT_JSON))
                } else {
                    null
                }
            }
        }

    override fun saveObjectJson(type: String, id: String, json: String, version: Int) {
        synchronized(lock) {
            writableDatabase.replace(
                OBJECTS_TABLE,
                null,
                ContentValues().apply {
                    put(OBJECT_TYPE, type)
                    put(OBJECT_ID, id)
                    put(OBJECT_JSON, json)
                    put(OBJECT_VERSION, version)
                },
            )
        }
    }

    override fun loadStreamEvents(stream: String, key: String): List<FrickStreamEvent> =
        synchronized(lock) {
            readableDatabase.query(
                STREAM_EVENTS_TABLE,
                arrayOf(EVENT_JSON),
                "$STREAM_TYPE = ? AND $STREAM_KEY = ?",
                arrayOf(stream, key),
                null,
                null,
                "$SEQUENCE ASC",
            ).use { cursor ->
                buildList {
                    while (cursor.moveToNext()) {
                        val body = cursor.getString(cursor.getColumnIndexOrThrow(EVENT_JSON))
                        runCatching { json.decodeFromString<FrickStreamEvent>(body) }
                            .getOrNull()
                            ?.let(::add)
                    }
                }
            }
        }

    override fun saveStreamEvent(event: FrickStreamEvent) {
        synchronized(lock) {
            writableDatabase.insertWithOnConflict(
                STREAM_EVENTS_TABLE,
                null,
                ContentValues().apply {
                    put(STREAM_TYPE, event.stream)
                    put(STREAM_KEY, event.streamId)
                    put(SEQUENCE, event.sequence)
                    put(EVENT_ID, event.eventId)
                    put(EVENT_JSON, json.encodeToString(event))
                },
                SQLiteDatabase.CONFLICT_REPLACE,
            )
        }
    }

    override fun loadPendingAppends(): List<PendingAppend> =
        synchronized(lock) {
            readableDatabase.query(
                PENDING_APPENDS_TABLE,
                arrayOf(APPEND_BODY),
                null,
                null,
                null,
                null,
                "$CREATED_AT ASC",
            ).use { cursor ->
                buildList {
                    while (cursor.moveToNext()) {
                        val body = cursor.getString(cursor.getColumnIndexOrThrow(APPEND_BODY))
                        runCatching { json.decodeFromString<PendingAppend>(body) }
                            .getOrNull()
                            ?.let(::add)
                    }
                }
            }
        }

    override fun appendPendingAppend(append: PendingAppend) {
        synchronized(lock) {
            writableDatabase.insertWithOnConflict(
                PENDING_APPENDS_TABLE,
                null,
                ContentValues().apply {
                    put(REQUEST_ID, append.requestId)
                    put(APPEND_BODY, json.encodeToString(append))
                    put(CREATED_AT, System.currentTimeMillis())
                },
                SQLiteDatabase.CONFLICT_IGNORE,
            )
        }
    }

    override fun removePendingAppend(requestId: String) {
        synchronized(lock) {
            writableDatabase.delete(
                PENDING_APPENDS_TABLE,
                "$REQUEST_ID = ?",
                arrayOf(requestId),
            )
        }
    }

    override fun clearPendingAppends() {
        synchronized(lock) {
            writableDatabase.delete(PENDING_APPENDS_TABLE, null, null)
        }
    }

    override fun loadSession(): FrickSession? =
        synchronized(lock) {
            // One-time migration: an install upgraded from a build that wrote the
            // session to the plaintext `auth_session` table still has the
            // cleartext token on disk. Move it into the encrypted secret store and
            // delete the plaintext row so the bearer token stops sitting in the
            // clear. Once migrated, the secret store is the sole source of truth.
            if (secretStore.loadSecret() == null) {
                migrateLegacyPlaintextSession()
            }
            val body = secretStore.loadSecret() ?: return@synchronized null
            runCatching { json.decodeFromString<FrickSession>(body) }.getOrNull()
        }

    override fun saveSession(session: FrickSession) {
        synchronized(lock) {
            secretStore.saveSecret(json.encodeToString(session))
            // Defensively drop any legacy plaintext row so a save never leaves a
            // cleartext copy alongside the encrypted one.
            deleteLegacyPlaintextSession()
        }
    }

    override fun clearSession() {
        synchronized(lock) {
            secretStore.clearSecret()
            deleteLegacyPlaintextSession()
        }
    }

    /** Migrate a legacy plaintext session row into the encrypted store, then delete it. */
    private fun migrateLegacyPlaintextSession() {
        val legacy = readableDatabase.query(
            SESSION_TABLE,
            arrayOf(SESSION_JSON),
            "$SESSION_ID = ?",
            arrayOf(CURRENT_SESSION_ID),
            null,
            null,
            null,
            "1",
        ).use { cursor ->
            if (cursor.moveToFirst()) {
                cursor.getString(cursor.getColumnIndexOrThrow(SESSION_JSON))
            } else {
                null
            }
        } ?: return
        secretStore.saveSecret(legacy)
        deleteLegacyPlaintextSession()
    }

    private fun deleteLegacyPlaintextSession() {
        writableDatabase.delete(
            SESSION_TABLE,
            "$SESSION_ID = ?",
            arrayOf(CURRENT_SESSION_ID),
        )
    }

    override fun loadCacheMetadata(): FrickCacheMetadata? =
        synchronized(lock) {
            readableDatabase.query(
                CACHE_METADATA_TABLE,
                arrayOf(
                    METADATA_SCHEMA_ID,
                    METADATA_SCHEMA_VERSION,
                    METADATA_SCHEMA_REVISION,
                    METADATA_SCHEMA_HASH,
                    METADATA_TENANT_ID,
                    METADATA_USER_ID,
                ),
                "$METADATA_ID = ?",
                arrayOf(CURRENT_METADATA_ID),
                null,
                null,
                null,
                "1",
            ).use { cursor ->
                if (cursor.moveToFirst()) {
                    FrickCacheMetadata(
                        schemaId = cursor.getString(cursor.getColumnIndexOrThrow(METADATA_SCHEMA_ID)),
                        schemaVersion = cursor.getString(cursor.getColumnIndexOrThrow(METADATA_SCHEMA_VERSION)),
                        schemaRevision = cursor.getInt(cursor.getColumnIndexOrThrow(METADATA_SCHEMA_REVISION)),
                        schemaHash = cursor.getString(cursor.getColumnIndexOrThrow(METADATA_SCHEMA_HASH)),
                        tenantId = cursor.getNullableString(METADATA_TENANT_ID),
                        userId = cursor.getNullableString(METADATA_USER_ID),
                    )
                } else {
                    null
                }
            }
        }

    override fun saveCacheMetadata(metadata: FrickCacheMetadata) {
        synchronized(lock) {
            writableDatabase.replace(
                CACHE_METADATA_TABLE,
                null,
                ContentValues().apply {
                    put(METADATA_ID, CURRENT_METADATA_ID)
                    put(METADATA_SCHEMA_ID, metadata.schemaId)
                    put(METADATA_SCHEMA_VERSION, metadata.schemaVersion)
                    put(METADATA_SCHEMA_REVISION, metadata.schemaRevision)
                    put(METADATA_SCHEMA_HASH, metadata.schemaHash)
                    put(METADATA_TENANT_ID, metadata.tenantId)
                    put(METADATA_USER_ID, metadata.userId)
                },
            )
        }
    }

    override fun clearCache() {
        synchronized(lock) {
            val database = writableDatabase
            database.delete(OBJECTS_TABLE, null, null)
            database.delete(STREAM_EVENTS_TABLE, null, null)
            database.delete(PENDING_APPENDS_TABLE, null, null)
            database.delete(CACHE_METADATA_TABLE, null, null)
        }
    }

    override fun onConfigure(database: SQLiteDatabase) {
        database.enableWriteAheadLogging()
    }

    override fun onCreate(database: SQLiteDatabase) {
        database.execSQL(
            """
            CREATE TABLE IF NOT EXISTS $OBJECTS_TABLE (
              $OBJECT_TYPE TEXT NOT NULL,
              $OBJECT_ID TEXT NOT NULL,
              $OBJECT_JSON TEXT NOT NULL,
              $OBJECT_VERSION INTEGER NOT NULL,
              PRIMARY KEY ($OBJECT_TYPE, $OBJECT_ID)
            )
            """.trimIndent(),
        )
        database.execSQL(
            """
            CREATE TABLE IF NOT EXISTS $STREAM_EVENTS_TABLE (
              $STREAM_TYPE TEXT NOT NULL,
              $STREAM_KEY TEXT NOT NULL,
              $SEQUENCE INTEGER NOT NULL,
              $EVENT_ID TEXT NOT NULL UNIQUE,
              $EVENT_JSON TEXT NOT NULL,
              PRIMARY KEY ($STREAM_TYPE, $STREAM_KEY, $SEQUENCE)
            )
            """.trimIndent(),
        )
        database.execSQL(
            """
            CREATE TABLE IF NOT EXISTS $PENDING_APPENDS_TABLE (
              $REQUEST_ID TEXT PRIMARY KEY NOT NULL,
              $APPEND_BODY TEXT NOT NULL,
              $CREATED_AT INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        database.execSQL(
            """
            CREATE TABLE IF NOT EXISTS $SESSION_TABLE (
              $SESSION_ID TEXT PRIMARY KEY NOT NULL,
              $SESSION_JSON TEXT NOT NULL
            )
            """.trimIndent(),
        )
        database.execSQL(
            """
            CREATE TABLE IF NOT EXISTS $CACHE_METADATA_TABLE (
              $METADATA_ID TEXT PRIMARY KEY NOT NULL,
              $METADATA_SCHEMA_ID TEXT NOT NULL,
              $METADATA_SCHEMA_VERSION TEXT NOT NULL,
              $METADATA_SCHEMA_REVISION INTEGER NOT NULL,
              $METADATA_SCHEMA_HASH TEXT NOT NULL,
              $METADATA_TENANT_ID TEXT,
              $METADATA_USER_ID TEXT
            )
            """.trimIndent(),
        )
    }

    override fun onUpgrade(database: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < newVersion) {
            onCreate(database)
        }
        if (oldVersion < 5) {
            addColumnIfMissing(database, CACHE_METADATA_TABLE, METADATA_TENANT_ID, "TEXT")
            addColumnIfMissing(database, CACHE_METADATA_TABLE, METADATA_USER_ID, "TEXT")
        }
    }

    private fun addColumnIfMissing(database: SQLiteDatabase, table: String, column: String, definition: String) {
        if (hasColumn(database, table, column)) {
            return
        }
        database.execSQL("ALTER TABLE $table ADD COLUMN $column $definition")
    }

    private fun hasColumn(database: SQLiteDatabase, table: String, column: String): Boolean {
        database.rawQuery("PRAGMA table_info($table)", null).use { cursor ->
            while (cursor.moveToNext()) {
                if (cursor.getString(cursor.getColumnIndexOrThrow("name")) == column) {
                    return true
                }
            }
        }
        return false
    }

    private companion object {
        const val DATABASE_VERSION = 5
        const val OBJECTS_TABLE = "local_objects"
        const val STREAM_EVENTS_TABLE = "local_stream_events"
        const val PENDING_APPENDS_TABLE = "pending_appends"
        const val SESSION_TABLE = "auth_session"
        const val CACHE_METADATA_TABLE = "frick_cache_metadata"
        const val OBJECT_TYPE = "object_type"
        const val OBJECT_ID = "object_id"
        const val OBJECT_JSON = "json"
        const val OBJECT_VERSION = "version"
        const val STREAM_TYPE = "stream_type"
        const val STREAM_KEY = "stream_key"
        const val SEQUENCE = "sequence"
        const val EVENT_ID = "event_id"
        const val EVENT_JSON = "json"
        const val REQUEST_ID = "request_id"
        const val APPEND_BODY = "body"
        const val CREATED_AT = "created_at"
        const val SESSION_ID = "session_id"
        const val SESSION_JSON = "json"
        const val CURRENT_SESSION_ID = "current"
        const val METADATA_ID = "id"
        const val METADATA_SCHEMA_ID = "schema_id"
        const val METADATA_SCHEMA_VERSION = "schema_version"
        const val METADATA_SCHEMA_REVISION = "schema_revision"
        const val METADATA_SCHEMA_HASH = "schema_hash"
        const val METADATA_TENANT_ID = "tenant_id"
        const val METADATA_USER_ID = "user_id"
        const val CURRENT_METADATA_ID = "current"
    }
}

class KtorFrickTransport(
    private val baseUrl: String = FrickClient.DefaultBaseUrl,
    private val httpClient: HttpClient = defaultHttpClient(),
    private val sessionTokenProvider: () -> String? = { null },
) : FrickTransport, AutoCloseable {
    override suspend fun get(path: String): String {
        val response = httpClient.get(resolve(path)) {
            authorize()
        }
        requireSuccess(response)
        return response.bodyAsText()
    }

    override suspend fun getBytes(path: String): ByteArray {
        val response = httpClient.get(resolve(path)) {
            authorize()
        }
        requireSuccess(response)
        return response.bodyAsBytes()
    }

    override fun stream(path: String): Flow<String> = flow {
        httpClient.prepareGet(resolve(path)) {
            authorize()
        }.execute { response ->
            requireSuccess(response)
            val channel = response.bodyAsChannel()
            while (currentCoroutineContext().isActive) {
                val line = channel.readLine() ?: break
                emit("$line\n")
            }
        }
    }.flowOn(Dispatchers.IO)

    override suspend fun post(path: String, body: String): String =
        post(path = path, body = body, headers = emptyMap())

    override suspend fun post(path: String, body: String, headers: Map<String, String>): String {
        val response = httpClient.post(resolve(path)) {
            authorize()
            headers.forEach { (name, value) -> header(name, value) }
            contentType(ContentType.Application.Json)
            setBody(body)
        }
        requireSuccess(response)
        return response.bodyAsText()
    }

    override suspend fun put(path: String, body: String, headers: Map<String, String>): String {
        val response = httpClient.put(resolve(path)) {
            authorize()
            headers.forEach { (name, value) -> header(name, value) }
            contentType(ContentType.Application.Json)
            setBody(body)
        }
        requireSuccess(response)
        return response.bodyAsText()
    }

    override suspend fun putBytes(path: String, mimeType: String, bytes: ByteArray): String {
        val response = httpClient.put(resolve(path)) {
            authorize()
            contentType(ContentType.parse(mimeType))
            setBody(bytes)
        }
        requireSuccess(response)
        return response.bodyAsText()
    }

    override suspend fun delete(path: String): String {
        val response = httpClient.delete(resolve(path)) {
            authorize()
        }
        requireSuccess(response)
        return response.bodyAsText()
    }

    override fun close() {
        httpClient.close()
    }

    private fun resolve(path: String): String = "${baseUrl.trimEnd('/')}/${path.trimStart('/')}"

    private fun HttpRequestBuilder.authorize() {
        val token = sessionTokenProvider()?.takeIf { value -> value.isNotBlank() } ?: return
        header("Authorization", "Bearer $token")
    }
}

class FrickClient(
    baseUrl: String = DefaultBaseUrl,
    val replicaId: String = "android-demo",
    private val requestIdFactory: () -> String = { UUID.randomUUID().toString() },
    private val storage: FrickStorage = NoopFrickStorage,
    private val transport: FrickTransport = KtorFrickTransport(
        baseUrl = baseUrl,
        sessionTokenProvider = { storage.loadSession()?.sessionToken },
    ),
    private val telemetry: FrickClientTelemetryRuntime = NoopFrickClientTelemetryRuntime,
    /**
     * The product schema identity + field tables this client runs with
     * (FR-300). A product-schema app injects its generated descriptor; it flows
     * into cache-compatibility checks and the [connectSync] handshake so the
     * client is keyed by the product schema, not the foundation default.
     */
    private val descriptor: FrickSchemaDescriptor = FrickSchemaDescriptor.FOUNDATION,
) {
    companion object {
        const val DefaultBaseUrl = "https://127.0.0.1:4099"
        const val LocalDevelopmentBaseUrl = "http://10.0.2.2:4099"
    }


    fun verifyCacheCompatibility(
        currentMetadata: FrickCacheMetadata = FrickCacheMetadata.forDescriptor(descriptor),
        minimumClientRevision: Int = FRICK_MINIMUM_CLIENT_REVISION,
    ): FrickCacheMetadata {
        val resolvedCurrentMetadata = currentMetadata.withSessionScope(storage.loadSession())
        val cached = storage.loadCacheMetadata()
        if (cached != null) {
            val reason = FrickCacheCompatibility.reason(
                cached = cached,
                current = resolvedCurrentMetadata,
                minimumClientRevision = minimumClientRevision,
            )
            if (reason != null) {
                throw FrickCacheIncompatibleException(
                    reason = reason,
                    cachedMetadata = cached,
                    currentMetadata = resolvedCurrentMetadata,
                    minimumClientRevision = minimumClientRevision,
                    pendingAppendCount = storage.loadPendingAppends().size,
                    message = incompatibilityMessage(reason, cached, resolvedCurrentMetadata, minimumClientRevision),
                )
            }
        }
        storage.saveCacheMetadata(resolvedCurrentMetadata)
        return resolvedCurrentMetadata
    }

    fun resetCache() {
        storage.clearCache()
    }

    suspend fun devLogin(
        userId: String,
        deviceId: String? = null,
        replicaId: String? = this.replicaId,
        platform: String? = "android",
    ): FrickSession = withContext(Dispatchers.IO) {
        val response = transport.post(
            path = "/auth/dev-login",
            body = frickJson.encodeToString(
                DevLoginRequest(
                    userId = userId,
                    deviceId = deviceId,
                    replicaId = replicaId,
                    platform = platform,
                ),
            ),
        )
        parseSession(response).also(storage::saveSession)
    }

    suspend fun signUp(
        displayName: String,
        handle: String,
        password: String,
        deviceId: String? = null,
        replicaId: String? = this.replicaId,
        platform: String? = "android",
    ): FrickSession = withContext(Dispatchers.IO) {
        val response = transport.post(
            path = "/auth/signup",
            body = frickJson.encodeToString(
                SignUpRequest(
                    displayName = displayName,
                    handle = handle,
                    password = password,
                    deviceId = deviceId,
                    replicaId = replicaId,
                    platform = platform,
                ),
            ),
        )
        parseSession(response).also(storage::saveSession)
    }

    suspend fun login(
        identity: String,
        password: String,
        deviceId: String? = null,
        replicaId: String? = this.replicaId,
        platform: String? = "android",
    ): FrickSession = withContext(Dispatchers.IO) {
        val response = transport.post(
            path = "/auth/login",
            body = frickJson.encodeToString(
                LoginRequest(
                    identity = identity,
                    password = password,
                    deviceId = deviceId,
                    replicaId = replicaId,
                    platform = platform,
                ),
            ),
        )
        parseSession(response).also(storage::saveSession)
    }

    /**
     * The session the client currently holds, restored from (and kept in sync
     * with) the injected [FrickStorage]. With the default [SQLiteFrickStorage]
     * the session secret is encrypted at rest (see [SessionSecretStore]). `null`
     * when signed out.
     *
     * Mirrors Swift `FrickClient.currentSession`. This is the durable session
     * the auth verbs install — an observable auth-state holder
     * ([FrickSessionManager]) seeds from it so a persisted session is reflected
     * immediately on a warm launch without app-side restore code.
     */
    val currentSession: FrickSession?
        get() = storage.loadSession()

    /**
     * Local sign-out. Wipes ALL persisted state for the signed-out user:
     * the session secret, any queued appends, and the local cache (synced object
     * rows, stream events, and cache metadata). Clearing the cache too closes the
     * data-remanence gap where a prior account's records — including records
     * shared with them by other users — would otherwise survive sign-out on disk
     * (a privacy / tenant-isolation concern on shared devices).
     */
    fun signOut() {
        storage.clearPendingAppends()
        storage.clearSession()
        storage.clearCache()
    }

    /**
     * Kick off the email password-reset flow. The server always returns 200
     * (privacy: no email-enumeration leak) — present the success UI regardless
     * of whether the address is on file. Mirrors Swift
     * `FrickClient.requestPasswordReset`. Stateless: does not touch the active
     * session.
     */
    suspend fun requestPasswordReset(email: String) = withContext(Dispatchers.IO) {
        transport.post(
            path = "/auth/email/forgot-password",
            body = frickJson.encodeToString(ForgotPasswordRequest(email = email)),
        )
        Unit
    }

    /**
     * Complete the email password-reset flow with the one-time token and a new
     * password. Mirrors Swift `FrickClient.resetPassword`. The server
     * invalidates the user's sessions on success, so sign in again afterwards
     * to re-establish one. Stateless: does not touch the active session.
     */
    suspend fun resetPassword(token: String, newPassword: String) = withContext(Dispatchers.IO) {
        transport.post(
            path = "/auth/email/reset-password",
            body = frickJson.encodeToString(ResetPasswordRequest(token = token, password = newPassword)),
        )
        Unit
    }

    // MARK: - Sharing (cross-user grants/invitations)
    //
    // Raw verbs over the server's `/share/*` routes, Kotlin parity with the
    // Swift FrickSwift sharing surface. They marshal the same wire field names
    // as `@fricken/protocol`'s sharing types. The stateful, observable layer a
    // Compose app drives off lives in `FrickSharingService` (FR-152); these are
    // the primitives it orchestrates.

    /**
     * Create a single-use invitation for a record and return it (the caller
     * ships [FrickInvitation.token] out-of-band). Posts to `POST /share/invite`.
     * [expiresInSeconds] is optional — the server applies its default (and a
     * ceiling) when omitted.
     */
    suspend fun createInvitation(
        recordType: String,
        recordId: String,
        permission: FrickSharingPermission,
        expiresInSeconds: Long? = null,
    ): FrickInvitation = withContext(Dispatchers.IO) {
        requireAuthenticatedSession()
        val raw = transport.post(
            path = "/share/invite",
            body = frickJson.encodeToString(
                CreateInvitationRequest(
                    recordType = recordType,
                    recordId = recordId,
                    permission = permission.wire,
                    expiresInSeconds = expiresInSeconds,
                ),
            ),
        )
        parseInvitationEnvelope(raw)
    }

    /**
     * Redeem an invitation token, producing a durable [FrickGrant]. Posts to
     * `POST /share/accept`. The server rejects invalid/expired/already-redeemed
     * tokens and self-accepts (owner redeeming their own invitation) with an
     * authorization error.
     */
    suspend fun acceptInvitation(token: String): FrickGrant = withContext(Dispatchers.IO) {
        requireAuthenticatedSession()
        val raw = transport.post(
            path = "/share/accept",
            body = frickJson.encodeToString(AcceptInvitationRequest(token = token)),
        )
        parseGrantEnvelope(raw)
    }

    /**
     * List active grants the signed-in user owns OR is the grantee of. Optional
     * [recordType]/[recordId] narrow to one record; [includeRevoked] surfaces
     * revoked grants too. `GET /share/grants`.
     */
    suspend fun listGrants(
        recordType: String? = null,
        recordId: String? = null,
        includeRevoked: Boolean = false,
    ): List<FrickGrant> = withContext(Dispatchers.IO) {
        requireAuthenticatedSession()
        val query = buildList {
            if (recordType != null) add("recordType=${encodeQueryValue(recordType)}")
            if (recordId != null) add("recordId=${encodeQueryValue(recordId)}")
            if (includeRevoked) add("includeRevoked=true")
        }.joinToString("&")
        val path = if (query.isEmpty()) "/share/grants" else "/share/grants?$query"
        parseGrantsEnvelope(transport.get(path))
    }

    /**
     * Revoke a grant by id (owner-only on the server). `DELETE /share/grants/:id`.
     * Returns the now-revoked grant.
     */
    suspend fun revokeGrant(grantId: String): FrickGrant = withContext(Dispatchers.IO) {
        requireAuthenticatedSession()
        parseGrantEnvelope(transport.delete("/share/grants/${encodePathSegment(grantId)}"))
    }

    suspend fun fetchBlobMetadata(blobId: String): FrickBlobMetadata? = withContext(Dispatchers.IO) {
        try {
            parseBlobMetadata(transport.get("/blobs/${encodePathSegment(blobId)}"))
        } catch (error: Exception) {
            if (shouldReturnEmptyRead(error)) {
                null
            } else {
                throw error
            }
        }
    }

    suspend fun uploadBlobContent(
        blobId: String,
        ownerId: String,
        mimeType: String,
        bytes: ByteArray,
    ): FrickBlobMetadata = withContext(Dispatchers.IO) {
        parseBlobMetadata(
            transport.putBytes(
                path = "/blobs/${encodePathSegment(blobId)}/content?ownerId=${encodeQueryValue(ownerId)}",
                mimeType = mimeType,
                bytes = bytes,
            ),
        )
    }

    suspend fun downloadBlobContent(blobId: String): ByteArray? = withContext(Dispatchers.IO) {
        try {
            transport.getBytes("/blobs/${encodePathSegment(blobId)}/content")
        } catch (error: Exception) {
            if (shouldReturnEmptyRead(error)) {
                null
            } else {
                throw error
            }
        }
    }

    /**
     * Full-text search via the server's `/search` route. Mirrors the
     * Swift / TS `searchMessages` helper. `index` is the FTS index name
     * (e.g. `"activity-fts"` for app-owned activity search). `filter` is
     * an optional `{ conversationId: "..." }` map; pass `null` to search
     * across the tenant.
     */
    suspend fun search(
        index: String,
        q: String,
        filter: Map<String, String>? = null,
        limit: Int = 50,
    ): FrickSearchResponse = withContext(Dispatchers.IO) {
        val body = buildMap<String, JsonElement> {
            put("index", JsonPrimitive(index))
            put("q", JsonPrimitive(q))
            put("limit", JsonPrimitive(limit))
            if (!filter.isNullOrEmpty()) {
                put("filter", JsonObject(filter.mapValues { (_, v) -> JsonPrimitive(v) }))
            }
        }
        val raw = transport.post(
            path = "/search",
            body = frickJson.encodeToString(JsonObject(body)),
        )
        frickJson.decodeFromString(raw)
    }

    suspend fun track(
        name: String,
        properties: Map<String, JsonElement> = emptyMap(),
        context: Map<String, JsonElement>? = null,
        attributes: Map<String, JsonPrimitive>? = null,
        traceId: String? = null,
        idempotencyKey: String? = null,
        occurredAt: String? = null,
    ): FrickAnalyticsTrackReceipt = withContext(Dispatchers.IO) {
        requireAuthenticatedSession()
        val startedAtNanos = System.nanoTime()
        val span = startFrickClientTelemetrySpan(
            telemetry,
            FrickClientTelemetrySpanStart(
                name = "frick.analytics.track",
                kind = FrickClientTelemetrySpanKind.CLIENT,
                attributes = mapOf(
                    "frick.analytics.event_name" to JsonPrimitive(name),
                    "url.path" to JsonPrimitive("/analytics/events"),
                ),
            ),
        )
        var finished = false
        fun finish(
            status: FrickClientTelemetrySpanStatus,
            metricStatus: String,
            duplicate: Boolean? = null,
            error: Throwable? = null,
        ) {
            if (finished) {
                return
            }
            finished = true
            val spanAttributes = buildMap<String, JsonPrimitive> {
                put("frick.analytics.status", JsonPrimitive(metricStatus))
                if (duplicate != null) {
                    put("frick.analytics.duplicate", JsonPrimitive(duplicate))
                }
            }
            finishFrickClientTelemetrySpan(
                span,
                FrickClientTelemetrySpanResult(
                    status = status,
                    attributes = spanAttributes,
                    error = error,
                ),
            )
            val metricAttributes = mapOf("status" to JsonPrimitive(metricStatus))
            recordFrickClientTelemetryCounter(
                telemetry,
                name = "frick.client.analytics.events.total",
                value = 1.0,
                attributes = metricAttributes,
            )
            recordFrickClientTelemetryHistogram(
                telemetry,
                name = "frick.client.analytics.duration_ms",
                value = (System.nanoTime() - startedAtNanos).toDouble() / 1_000_000.0,
                attributes = metricAttributes,
            )
        }

        try {
            val telemetryHeaders = mutableMapOf<String, String>()
            injectFrickClientTelemetryHeaders(span, telemetryHeaders)
            val traceHeaders = telemetryHeaders
                .filterKeys { name -> name.equals("traceparent", ignoreCase = true) }
                .mapKeys { "traceparent" }
            val raw = transport.post(
                path = "/analytics/events",
                body = frickJson.encodeToString(
                    AnalyticsTrackRequest(
                        name = name,
                        properties = properties.takeIf { eventProperties -> eventProperties.isNotEmpty() },
                        context = context?.takeIf { eventContext -> eventContext.isNotEmpty() },
                        attributes = attributes?.takeIf { eventAttributes -> eventAttributes.isNotEmpty() },
                        traceId = traceId ?: getFrickClientTelemetryTraceId(span),
                        idempotencyKey = idempotencyKey,
                        occurredAt = occurredAt,
                    ),
                ),
                headers = traceHeaders,
            )
            val receipt = frickJson.decodeFromString<FrickAnalyticsTrackReceipt>(raw)
            finish(
                status = FrickClientTelemetrySpanStatus.OK,
                metricStatus = if (receipt.duplicate) "duplicate" else "accepted",
                duplicate = receipt.duplicate,
            )
            receipt
        } catch (error: Throwable) {
            finish(
                status = FrickClientTelemetrySpanStatus.ERROR,
                metricStatus = if (error is java.io.IOException) "network_error" else "rejected",
                error = error,
            )
            throw error
        }
    }

    suspend fun sendSignal(name: String, key: String, value: Map<String, JsonElement>) = withContext(Dispatchers.IO) {
        transport.post(
            path = "/signals/${encodePathSegment(name)}/${encodePathSegment(key)}",
            body = frickJson.encodeToString(JsonObject(value)),
        )
    }

    suspend fun drainSignals(name: String, key: String): List<Map<String, String>> = withContext(Dispatchers.IO) {
        try {
            parseSignalPayloads(transport.get("/signals/${encodePathSegment(name)}/${encodePathSegment(key)}"))
        } catch (error: Exception) {
            if (shouldReturnEmptyRead(error)) {
                emptyList()
            } else {
                throw error
            }
        }
    }

    suspend fun append(stream: String, key: String, event: String, payload: Map<String, String>) {
        val requestId = requestIdFactory()
        val body = frickJson.encodeToString(
            AppendRequest(
                requestId = requestId,
                replicaId = replicaId,
                stream = stream,
                key = key,
                event = event,
                payload = payload.mapValues { entry -> JsonPrimitive(entry.value) },
            ),
        )
        val append = PendingAppend(requestId = requestId, body = body)
        try {
            sendAppend(append)
        } catch (error: Exception) {
            if (shouldQueueAppend(error)) {
                verifyCacheCompatibility()
                storage.appendPendingAppend(append)
                return
            }
            throw error
        }
    }

    suspend fun flushPendingAppends() {
        requireAuthenticatedSession()
        verifyCacheCompatibility()
        for (append in storage.loadPendingAppends()) {
            sendAppend(append)
            storage.removePendingAppend(append.requestId)
        }
    }

    private suspend fun sendAppend(append: PendingAppend) {
        requireAuthenticatedSession()
        transport.post(path = "/append", body = append.body)
    }

    private fun cacheObjects(type: String, responseJson: String) {
        val data = parseResponseObject(responseJson).requiredArray("data")
        data.forEach { item ->
            val objectJson = item.jsonObject
            storage.saveObjectJson(
                type = type,
                id = objectJson.requiredString("id"),
                json = objectJson.toString(),
                version = 0,
            )
        }
    }

    private fun authenticatedUserId(): String =
        requireAuthenticatedSession().userId

    private fun requireAuthenticatedSession(): FrickSession {
        val session = storage.loadSession()
            ?: throw FrickAuthenticationRequiredException()
        if (session.sessionToken.isBlank()) {
            throw FrickAuthenticationRequiredException()
        }
        return session
    }

    /**
     * Open a WebSocket sync connection. The caller is responsible for calling
     * [FrickSyncSocket.connect] to begin the handshake and [FrickSyncSocket.close]
     * when finished. Schema/cache compatibility is verified eagerly via
     * [verifyCacheCompatibility].
     */
    fun connectSync(
        baseUrl: String,
        config: FrickSyncSocketConfig =
            FrickSyncSocketConfig(replicaId = replicaId, descriptor = descriptor),
        httpClient: okhttp3.OkHttpClient = FrickSyncSocket.defaultOkHttpClient(),
    ): FrickSyncSocket {
        requireAuthenticatedSession()
        verifyCacheCompatibility()
        return FrickSyncSocket(
            baseUrl = baseUrl,
            sessionTokenProvider = { storage.loadSession()?.sessionToken },
            config = config,
            httpClient = httpClient,
            telemetry = telemetry,
        )
    }
}

class FrickEventStreamParser {
    private var buffer = ""

    fun push(chunk: String): List<FrickEvent> {
        buffer += chunk.replace("\r\n", "\n")
        val events = mutableListOf<FrickEvent>()

        while (true) {
            val eventEnd = buffer.indexOf("\n\n")
            if (eventEnd == -1) {
                break
            }

            val rawEvent = buffer.substring(0, eventEnd)
            buffer = buffer.substring(eventEnd + 2)
            parse(rawEvent)?.let(events::add)
        }

        return events
    }

    private fun parse(rawEvent: String): FrickEvent? {
        var eventName = "message"
        val dataLines = mutableListOf<String>()

        rawEvent.lineSequence().forEach { line ->
            when {
                line.isEmpty() || line.startsWith(":") -> Unit
                line.startsWith("event:") -> eventName = line.removePrefix("event:").trim()
                line.startsWith("data:") -> dataLines += line.removePrefix("data:").trim()
            }
        }

        if (dataLines.isEmpty()) {
            return null
        }
        return FrickEvent(event = eventName, data = dataLines.joinToString("\n"))
    }
}

fun parseStreamEvents(responseJson: String): List<FrickStreamEvent> =
    parseResponseObject(responseJson)
        .requiredArray("data")
        .map { item ->
            val event = item.jsonObject
            FrickStreamEvent(
                stream = event.requiredString("stream"),
                streamId = event.requiredString("streamId"),
                sequence = event.requiredInt("sequence"),
                eventId = event.requiredString("eventId"),
                event = event.requiredString("event"),
                payload = event.requiredObject("payload").toStringMap(),
            )
        }

fun parseBlobMetadata(responseJson: String): FrickBlobMetadata {
    val metadata = parseResponseObject(responseJson)
    return FrickBlobMetadata(
        blobId = metadata.requiredString("blobId"),
        ownerId = metadata.requiredString("ownerId"),
        contentHash = metadata.requiredString("contentHash"),
        byteLength = metadata.requiredInt("byteLength"),
        mimeType = metadata.requiredString("mimeType"),
        storageKey = metadata.optionalString("storageKey"),
        createdAt = metadata.optionalString("createdAt"),
    )
}

fun parseSession(responseJson: String): FrickSession {
    parseResponseObject(responseJson)
    return frickJson.decodeFromString<FrickSession>(responseJson)
}

/** Parse a `{ invitation: {...} }` envelope from `POST /share/invite`. */
fun parseInvitationEnvelope(responseJson: String): FrickInvitation =
    frickJson.decodeFromJsonElement(
        FrickInvitation.serializer(),
        parseResponseObject(responseJson).requiredObject("invitation"),
    )

/** Parse a `{ grant: {...} }` envelope from `POST /share/accept` / `DELETE /share/grants/:id`. */
fun parseGrantEnvelope(responseJson: String): FrickGrant =
    frickJson.decodeFromJsonElement(
        FrickGrant.serializer(),
        parseResponseObject(responseJson).requiredObject("grant"),
    )

/** Parse a `{ grants: [...] }` envelope from `GET /share/grants`. */
fun parseGrantsEnvelope(responseJson: String): List<FrickGrant> =
    parseResponseObject(responseJson)
        .requiredArray("grants")
        .map { item -> frickJson.decodeFromJsonElement(FrickGrant.serializer(), item) }

fun parseSignalPayloads(responseJson: String): List<Map<String, String>> =
    parseResponseObject(responseJson)
        .requiredArray("data")
        .map { item -> item.jsonObject.toStringMap() }

private suspend fun requireSuccess(response: HttpResponse) {
    if (response.status.value !in 200..299) {
        val body = response.bodyAsText()
        val envelope = parseFrickErrorEnvelope(body)
        val message = envelope?.message
            ?: body.ifBlank { "Request failed with HTTP ${response.status.value}" }
        throw FrickHttpException(
            statusCode = response.status.value,
            envelope = envelope,
            responseBody = body,
            message = message,
        )
    }
    requireCompatibleSchemaHeaders(response)
}

private fun requireCompatibleSchemaHeaders(response: HttpResponse) {
    val headerHash = response.headers["x-frick-schema-hash"]
    if (headerHash != null && headerHash != FRICK_SCHEMA_HASH) {
        throw FrickSchemaMismatchException(
            expectedSchemaHash = FRICK_SCHEMA_HASH,
            actualSchemaHash = headerHash,
        )
    }
}

private fun defaultHttpClient(): HttpClient = HttpClient(OkHttp) {
    engine {
        config {
            connectTimeout(2_000, TimeUnit.MILLISECONDS)
            readTimeout(0, TimeUnit.MILLISECONDS)
            writeTimeout(2_000, TimeUnit.MILLISECONDS)
        }
    }
}

private fun incompatibilityMessage(
    reason: FrickCacheIncompatibilityReason,
    cached: FrickCacheMetadata,
    current: FrickCacheMetadata,
    minimumClientRevision: Int,
): String =
    when (reason) {
        FrickCacheIncompatibilityReason.SCHEMA_ID_MISMATCH ->
            "Cached schema id ${cached.schemaId} does not match current schema id ${current.schemaId}"
        FrickCacheIncompatibilityReason.CACHE_TOO_OLD ->
            "Cached schema revision ${cached.schemaRevision} is below current minimum client revision $minimumClientRevision"
        FrickCacheIncompatibilityReason.SESSION_SCOPE_MISMATCH ->
            "Cached session scope ${cached.tenantId ?: "unknown"}:${cached.userId ?: "unknown"} does not match current session scope ${current.tenantId ?: "unknown"}:${current.userId ?: "unknown"}"
    }

private fun FrickCacheMetadata.withSessionScope(session: FrickSession?): FrickCacheMetadata =
    copy(
        tenantId = tenantId ?: session?.tenantId,
        userId = userId ?: session?.userId,
    )

private fun android.database.Cursor.getNullableString(columnName: String): String? {
    val index = getColumnIndexOrThrow(columnName)
    return if (isNull(index)) null else getString(index)
}

private fun shouldQueueAppend(error: Exception): Boolean =
    error !is FrickAuthenticationRequiredException &&
        error !is FrickSchemaMismatchException &&
        error !is FrickHttpException

private fun shouldReturnEmptyRead(error: Exception): Boolean =
    error !is FrickSchemaMismatchException

private fun encodeQueryValue(value: String): String =
    URLEncoder.encode(value, StandardCharsets.UTF_8.name())

private fun encodePathSegment(value: String): String =
    encodeQueryValue(value).replace("+", "%20")

private fun mergeStreamEvents(
    current: List<FrickStreamEvent>,
    next: List<FrickStreamEvent>,
): List<FrickStreamEvent> =
    (current + next)
        .distinctBy { event -> event.eventId }
        .sortedBy { event -> event.sequence }

private fun parseResponseObject(responseJson: String): JsonObject =
    frickJson.parseToJsonElement(responseJson)
        .jsonObject
        .also(JsonObject::requireCompatibleSchema)

private fun JsonObject.requireCompatibleSchema() {
    val actualSchemaHash = optionalString("schemaHash")
    if (actualSchemaHash != null && actualSchemaHash != FRICK_SCHEMA_HASH) {
        throw FrickSchemaMismatchException(
            expectedSchemaHash = FRICK_SCHEMA_HASH,
            actualSchemaHash = actualSchemaHash,
        )
    }
}

private fun JsonObject.requiredString(name: String): String =
    optionalString(name) ?: throw IllegalArgumentException("$name must be a string")

private fun JsonObject.optionalString(name: String): String? =
    this[name]?.jsonPrimitive?.contentOrNull

private fun JsonObject.requiredInt(name: String): Int =
    this[name]?.jsonPrimitive?.int ?: throw IllegalArgumentException("$name must be an integer")

private fun JsonObject.requiredArray(name: String): List<JsonElement> =
    this[name]?.jsonArray ?: throw IllegalArgumentException("$name must be an array")

private fun JsonObject.requiredObject(name: String): JsonObject =
    this[name]?.jsonObject ?: throw IllegalArgumentException("$name must be an object")

private fun JsonObject.toStringMap(): Map<String, String> =
    entries.associate { (key, value) ->
        key to value.stringValue()
    }

private fun JsonElement.stringValue(): String =
    if (this is JsonPrimitive) {
        contentOrNull ?: toString()
    } else {
        toString()
    }

private val frickJson = Json {
    ignoreUnknownKeys = true
}
