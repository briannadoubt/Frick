package dev.frick.client

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
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
import java.time.Instant
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

fun FrickStreamEvent.isVisibleChatMessage(): Boolean =
    event == "MessageSent" && !payload["body"].isNullOrBlank()

data class FrickInboxItem(
    val conversationId: String,
    val userId: String?,
    val title: String?,
    val kind: String?,
    val lastSequence: Int,
    val lastMessageBody: String?,
    val lastMessageSenderId: String?,
    val readSequence: Int,
    val unreadCount: Int,
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

data class CreatedConversation(
    val schemaHash: String?,
    val conversation: ConversationDto,
    val member: RoomMemberDto,
    val members: List<RoomMemberDto>,
)

@Serializable
data class FrickSession(
    val schemaHash: String,
    val sessionToken: String,
    val userId: String,
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
private data class ConversationCreateRequest(
    val title: String?,
    val kind: String,
    val participantUserIds: List<String>,
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
) {
    companion object {
        val currentSchema: FrickCacheMetadata =
            FrickCacheMetadata(
                schemaId = FRICK_SCHEMA_ID,
                schemaVersion = FRICK_SCHEMA_VERSION,
                schemaRevision = FRICK_SCHEMA_REVISION,
                schemaHash = FRICK_SCHEMA_HASH,
            )
    }
}

enum class FrickCacheIncompatibilityReason {
    SCHEMA_ID_MISMATCH,
    CACHE_TOO_OLD,
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
        return null
    }
}

interface FrickTransport {
    suspend fun get(path: String): String
    suspend fun getBytes(path: String): ByteArray
    fun stream(path: String): Flow<String>
    suspend fun post(path: String, body: String): String
    suspend fun putBytes(path: String, mimeType: String, bytes: ByteArray): String
}

interface FrickStorage {
    fun loadObjectJson(type: String, id: String): String?
    fun saveObjectJson(type: String, id: String, json: String, version: Int)
    fun loadStreamEvents(stream: String, key: String): List<FrickStreamEvent>
    fun saveStreamEvent(event: FrickStreamEvent)
    fun loadPendingAppends(): List<PendingAppend>
    fun appendPendingAppend(append: PendingAppend)
    fun removePendingAppend(requestId: String)
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
    override fun loadSession(): FrickSession? = null
    override fun saveSession(session: FrickSession) = Unit
    override fun clearSession() = Unit
    override fun loadCacheMetadata(): FrickCacheMetadata? = null
    override fun saveCacheMetadata(metadata: FrickCacheMetadata) = Unit
    override fun clearCache() = Unit
}

class SQLiteFrickStorage(
    context: Context,
    name: String = "frick.sqlite",
    private val json: Json = frickJson,
) : SQLiteOpenHelper(context.applicationContext, name, null, DATABASE_VERSION), FrickStorage {
    private val lock = Any()

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

    override fun loadSession(): FrickSession? =
        synchronized(lock) {
            readableDatabase.query(
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
                    val body = cursor.getString(cursor.getColumnIndexOrThrow(SESSION_JSON))
                    runCatching { json.decodeFromString<FrickSession>(body) }.getOrNull()
                } else {
                    null
                }
            }
        }

    override fun saveSession(session: FrickSession) {
        synchronized(lock) {
            writableDatabase.replace(
                SESSION_TABLE,
                null,
                ContentValues().apply {
                    put(SESSION_ID, CURRENT_SESSION_ID)
                    put(SESSION_JSON, json.encodeToString(session))
                },
            )
        }
    }

    override fun clearSession() {
        synchronized(lock) {
            writableDatabase.delete(
                SESSION_TABLE,
                "$SESSION_ID = ?",
                arrayOf(CURRENT_SESSION_ID),
            )
        }
    }

    override fun loadCacheMetadata(): FrickCacheMetadata? =
        synchronized(lock) {
            readableDatabase.query(
                CACHE_METADATA_TABLE,
                arrayOf(METADATA_SCHEMA_ID, METADATA_SCHEMA_VERSION, METADATA_SCHEMA_REVISION, METADATA_SCHEMA_HASH),
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
              $METADATA_SCHEMA_HASH TEXT NOT NULL
            )
            """.trimIndent(),
        )
    }

    override fun onUpgrade(database: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < newVersion) {
            onCreate(database)
        }
    }

    private companion object {
        const val DATABASE_VERSION = 4
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
        const val CURRENT_METADATA_ID = "current"
    }
}

class KtorFrickTransport(
    private val baseUrl: String = "http://10.0.2.2:4099",
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

    override suspend fun post(path: String, body: String): String {
        val response = httpClient.post(resolve(path)) {
            authorize()
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
    baseUrl: String = "http://10.0.2.2:4099",
    private val replicaId: String = "android-demo",
    private val requestIdFactory: () -> String = { UUID.randomUUID().toString() },
    private val storage: FrickStorage = NoopFrickStorage,
    private val transport: FrickTransport = KtorFrickTransport(
        baseUrl = baseUrl,
        sessionTokenProvider = { storage.loadSession()?.sessionToken },
    ),
) {
    private val readSequenceLock = Any()
    private val readSequences = mutableMapOf<String, Int>()

    fun verifyCacheCompatibility(
        currentMetadata: FrickCacheMetadata = FrickCacheMetadata.currentSchema,
        minimumClientRevision: Int = FRICK_MINIMUM_CLIENT_REVISION,
    ): FrickCacheMetadata {
        val cached = storage.loadCacheMetadata()
        if (cached != null) {
            val reason = FrickCacheCompatibility.reason(
                cached = cached,
                current = currentMetadata,
                minimumClientRevision = minimumClientRevision,
            )
            if (reason != null) {
                throw FrickCacheIncompatibleException(
                    reason = reason,
                    cachedMetadata = cached,
                    currentMetadata = currentMetadata,
                    minimumClientRevision = minimumClientRevision,
                    pendingAppendCount = storage.loadPendingAppends().size,
                    message = incompatibilityMessage(reason, cached, currentMetadata, minimumClientRevision),
                )
            }
        }
        storage.saveCacheMetadata(currentMetadata)
        return currentMetadata
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

    fun signOut() {
        storage.clearSession()
    }

    suspend fun fetchUsers(): List<UserDto> = withContext(Dispatchers.IO) {
        runCatching { flushPendingAppends() }
        val response = transport.get("/objects?type=User")
        val users = parseUsers(response)
        cacheObjects(type = "User", responseJson = response)
        users
    }

    suspend fun fetchConversations(): List<ConversationDto> = withContext(Dispatchers.IO) {
        runCatching { flushPendingAppends() }
        val response = transport.get("/objects?type=Conversation")
        val conversations = parseConversations(response)
        cacheObjects(type = "Conversation", responseJson = response)
        conversations
    }

    suspend fun fetchRoomMembers(): List<RoomMemberDto> = withContext(Dispatchers.IO) {
        runCatching { flushPendingAppends() }
        val response = transport.get("/objects?type=RoomMember")
        val members = parseRoomMembers(response)
        cacheObjects(type = "RoomMember", responseJson = response)
        members
    }

    suspend fun createConversation(
        title: String? = null,
        kind: String = "group",
        participantUserIds: List<String> = emptyList(),
    ): CreatedConversation = withContext(Dispatchers.IO) {
        val response = transport.post(
            path = "/conversations",
            body = frickJson.encodeToString(
                ConversationCreateRequest(
                    title = title,
                    kind = kind,
                    participantUserIds = participantUserIds,
                ),
            ),
        )
        val created = parseCreatedConversation(response)
        storage.saveObjectJson(type = "Conversation", id = created.conversation.id, json = conversationJson(created.conversation), version = 0)
        created.members.forEach { member ->
            storage.saveObjectJson(type = "RoomMember", id = member.id, json = roomMemberJson(member), version = 0)
        }
        created
    }

    suspend fun fetchInbox(userId: String? = null): List<FrickInboxItem> = withContext(Dispatchers.IO) {
        runCatching { flushPendingAppends() }
        val resolvedUserId = userId ?: authenticatedUserId()
        try {
            parseInboxItems(transport.get("/inbox?userId=${encodeQueryValue(resolvedUserId)}"))
        } catch (error: Exception) {
            if (shouldReturnEmptyRead(error)) {
                emptyList()
            } else {
                throw error
            }
        }
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

    suspend fun fetchMessages(
        conversationId: String = "conversation-general",
        readUserId: String? = null,
    ): List<FrickStreamEvent> =
        withContext(Dispatchers.IO) {
            runCatching { flushPendingAppends() }
            try {
                val events = parseStreamEvents(transport.get("/streams/MessageStream/$conversationId"))
                events.forEach(storage::saveStreamEvent)
                advanceReadReceiptIfNeeded(conversationId = conversationId, userId = readUserId, events = events)
                events
            } catch (error: Exception) {
                val cached = storage.loadStreamEvents(stream = "MessageStream", key = conversationId)
                if (cached.isNotEmpty()) {
                    advanceReadReceiptIfNeeded(conversationId = conversationId, userId = readUserId, events = cached)
                    cached
                } else {
                    throw error
                }
            }
        }

    fun streamMessages(
        conversationId: String = "conversation-general",
        readUserId: String? = null,
    ): Flow<List<FrickStreamEvent>> = flow {
        var current = storage.loadStreamEvents(stream = "MessageStream", key = conversationId)
        val after = current.maxOfOrNull { event -> event.sequence } ?: 0
        val parser = FrickEventStreamParser()

        if (current.isNotEmpty()) {
            emit(current)
            advanceReadReceiptIfNeeded(conversationId = conversationId, userId = readUserId, events = current)
        }
        runCatching { flushPendingAppends() }
        transport.stream("/streams/MessageStream/$conversationId/events?after=$after").collect { chunk ->
            parser.push(chunk)
                .filter { event -> event.event == "stream-page" || event.event == "delta" }
                .forEach { event ->
                    val nextEvents = parseStreamEvents(event.data)
                    nextEvents.forEach(storage::saveStreamEvent)
                    current = mergeStreamEvents(current, nextEvents)
                    emit(current)
                    advanceReadReceiptIfNeeded(conversationId = conversationId, userId = readUserId, events = current)
                }
        }
    }.flowOn(Dispatchers.IO)

    suspend fun sendMessage(
        conversationId: String = "conversation-general",
        senderId: String? = null,
        body: String,
    ) {
        val resolvedSenderId = senderId ?: authenticatedUserId()
        append(
            stream = "MessageStream",
            key = conversationId,
            event = "MessageSent",
            payload = mapOf(
                "messageId" to "message-${UUID.randomUUID()}",
                "senderId" to resolvedSenderId,
                "body" to body,
                "createdAt" to Instant.now().toString(),
            ),
        )
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
                storage.appendPendingAppend(append)
                return
            }
            throw error
        }
    }

    private suspend fun appendJsonPayload(stream: String, key: String, event: String, payload: Map<String, JsonElement>) {
        val requestId = requestIdFactory()
        val body = frickJson.encodeToString(
            AppendRequest(
                requestId = requestId,
                replicaId = replicaId,
                stream = stream,
                key = key,
                event = event,
                payload = payload,
            ),
        )
        val append = PendingAppend(requestId = requestId, body = body)
        try {
            sendAppend(append)
        } catch (error: Exception) {
            if (shouldQueueAppend(error)) {
                storage.appendPendingAppend(append)
                return
            }
            throw error
        }
    }

    private suspend fun advanceReadReceiptIfNeeded(
        conversationId: String,
        userId: String?,
        events: List<FrickStreamEvent>,
    ) {
        if (userId == null) {
            return
        }
        val sequence = events
            .filterNot { event -> event.event == "ReceiptAdvanced" }
            .maxOfOrNull { event -> event.sequence } ?: 0
        if (!shouldAdvanceReadReceipt(userId = userId, conversationId = conversationId, sequence = sequence)) {
            return
        }
        appendJsonPayload(
            stream = "MessageStream",
            key = conversationId,
            event = "ReceiptAdvanced",
            payload = mapOf(
                "userId" to JsonPrimitive(userId),
                "sequence" to JsonPrimitive(sequence),
            ),
        )
    }

    private fun shouldAdvanceReadReceipt(userId: String, conversationId: String, sequence: Int): Boolean {
        if (sequence <= 0) {
            return false
        }
        val key = "$userId:$conversationId"
        return synchronized(readSequenceLock) {
            val previous = readSequences[key] ?: 0
            if (sequence <= previous) {
                false
            } else {
                readSequences[key] = sequence
                true
            }
        }
    }

    suspend fun flushPendingAppends() {
        for (append in storage.loadPendingAppends()) {
            sendAppend(append)
            storage.removePendingAppend(append.requestId)
        }
    }

    private suspend fun sendAppend(append: PendingAppend) {
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
        storage.loadSession()?.userId ?: "user-ada"
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

fun parseUsers(responseJson: String): List<UserDto> =
    parseResponseObject(responseJson)
        .requiredArray("data")
        .map { item ->
            val user = item.jsonObject
            UserDto(
                id = user.requiredString("id"),
                displayName = user.requiredString("displayName"),
                avatarBlobId = user.optionalString("avatarBlobId"),
            )
        }

fun parseConversations(responseJson: String): List<ConversationDto> =
    parseResponseObject(responseJson)
        .requiredArray("data")
        .map { item -> parseConversation(item.jsonObject) }

fun parseRoomMembers(responseJson: String): List<RoomMemberDto> =
    parseResponseObject(responseJson)
        .requiredArray("data")
        .map { item -> parseRoomMember(item.jsonObject) }

fun parseCreatedConversation(responseJson: String): CreatedConversation {
    val response = parseResponseObject(responseJson)
    return CreatedConversation(
        schemaHash = response.optionalString("schemaHash"),
        conversation = parseConversation(response.requiredObject("conversation")),
        member = parseRoomMember(response.requiredObject("member")),
        members = response.requiredArray("members").map { item -> parseRoomMember(item.jsonObject) },
    )
}

private fun parseConversation(conversation: JsonObject): ConversationDto =
    ConversationDto(
        id = conversation.requiredString("id"),
        kind = conversation.requiredString("kind"),
        title = conversation.optionalString("title"),
        createdBy = conversation.requiredString("createdBy"),
        lastMessageEventId = conversation.optionalString("lastMessageEventId"),
    )

private fun parseRoomMember(member: JsonObject): RoomMemberDto =
    RoomMemberDto(
        id = member.requiredString("id"),
        conversationId = member.requiredString("conversationId"),
        userId = member.requiredString("userId"),
        role = member.requiredString("role"),
    )

private fun conversationJson(conversation: ConversationDto): String =
    JsonObject(
        buildMap {
            put("id", JsonPrimitive(conversation.id))
            put("kind", JsonPrimitive(conversation.kind))
            conversation.title?.let { put("title", JsonPrimitive(it)) }
            put("createdBy", JsonPrimitive(conversation.createdBy))
            conversation.lastMessageEventId?.let { put("lastMessageEventId", JsonPrimitive(it)) }
        },
    ).toString()

private fun roomMemberJson(member: RoomMemberDto): String =
    JsonObject(
        mapOf(
            "id" to JsonPrimitive(member.id),
            "conversationId" to JsonPrimitive(member.conversationId),
            "userId" to JsonPrimitive(member.userId),
            "role" to JsonPrimitive(member.role),
        ),
    ).toString()

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

fun parseInboxItems(responseJson: String): List<FrickInboxItem> =
    parseResponseObject(responseJson)
        .requiredArray("data")
        .map { item ->
            val inboxItem = item.jsonObject
            FrickInboxItem(
                conversationId = inboxItem.requiredString("conversationId"),
                userId = inboxItem.optionalString("userId"),
                title = inboxItem.optionalString("title"),
                kind = inboxItem.optionalString("kind"),
                lastSequence = inboxItem.requiredInt("lastSequence"),
                lastMessageBody = inboxItem.optionalString("lastMessageBody"),
                lastMessageSenderId = inboxItem.optionalString("lastMessageSenderId"),
                readSequence = inboxItem.requiredInt("readSequence"),
                unreadCount = inboxItem.requiredInt("unreadCount"),
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
    }

private fun shouldQueueAppend(error: Exception): Boolean =
    error !is FrickSchemaMismatchException && error !is FrickHttpException

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
