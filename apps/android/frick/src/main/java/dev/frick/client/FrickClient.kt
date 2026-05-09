package dev.frick.client

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
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
    val payload: Map<String, String>,
)

class FrickSchemaMismatchException(
    val expectedSchemaHash: String,
    val actualSchemaHash: String?,
) : IllegalStateException(
    "Frick schema mismatch: expected $expectedSchemaHash, received $actualSchemaHash",
)

class FrickHttpException(
    val statusCode: Int,
    message: String,
) : IllegalStateException(message)

interface FrickTransport {
    suspend fun get(path: String): String
    suspend fun post(path: String, body: String)
}

interface FrickStorage {
    fun loadObjectJson(type: String, id: String): String?
    fun saveObjectJson(type: String, id: String, json: String, version: Int)
    fun loadStreamEvents(stream: String, key: String): List<FrickStreamEvent>
    fun saveStreamEvent(event: FrickStreamEvent)
    fun loadPendingAppends(): List<PendingAppend>
    fun appendPendingAppend(append: PendingAppend)
    fun removePendingAppend(requestId: String)
}

object NoopFrickStorage : FrickStorage {
    override fun loadObjectJson(type: String, id: String): String? = null
    override fun saveObjectJson(type: String, id: String, json: String, version: Int) = Unit
    override fun loadStreamEvents(stream: String, key: String): List<FrickStreamEvent> = emptyList()
    override fun saveStreamEvent(event: FrickStreamEvent) = Unit
    override fun loadPendingAppends(): List<PendingAppend> = emptyList()
    override fun appendPendingAppend(append: PendingAppend) = Unit
    override fun removePendingAppend(requestId: String) = Unit
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
    }

    override fun onUpgrade(database: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < newVersion) {
            onCreate(database)
        }
    }

    private companion object {
        const val DATABASE_VERSION = 2
        const val OBJECTS_TABLE = "local_objects"
        const val STREAM_EVENTS_TABLE = "local_stream_events"
        const val PENDING_APPENDS_TABLE = "pending_appends"
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
    }
}

class KtorFrickTransport(
    private val baseUrl: String = "http://10.0.2.2:4099",
    private val httpClient: HttpClient = defaultHttpClient(),
) : FrickTransport, AutoCloseable {
    override suspend fun get(path: String): String {
        val response = httpClient.get(resolve(path))
        requireSuccess(response)
        return response.bodyAsText()
    }

    override suspend fun post(path: String, body: String) {
        val response = httpClient.post(resolve(path)) {
            contentType(ContentType.Application.Json)
            setBody(body)
        }
        requireSuccess(response)
    }

    override fun close() {
        httpClient.close()
    }

    private fun resolve(path: String): String = "${baseUrl.trimEnd('/')}/${path.trimStart('/')}"
}

class FrickClient(
    baseUrl: String = "http://10.0.2.2:4099",
    private val replicaId: String = "android-demo",
    private val requestIdFactory: () -> String = { UUID.randomUUID().toString() },
    private val transport: FrickTransport = KtorFrickTransport(baseUrl = baseUrl),
    private val storage: FrickStorage = NoopFrickStorage,
) {
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

    suspend fun fetchMessages(conversationId: String = "conversation-general"): List<FrickStreamEvent> =
        withContext(Dispatchers.IO) {
            runCatching { flushPendingAppends() }
            try {
                val events = parseStreamEvents(transport.get("/streams/MessageStream/$conversationId"))
                events.forEach(storage::saveStreamEvent)
                events
            } catch (error: Exception) {
                val cached = storage.loadStreamEvents(stream = "MessageStream", key = conversationId)
                if (cached.isNotEmpty()) {
                    cached
                } else {
                    throw error
                }
            }
        }

    suspend fun sendMessage(
        conversationId: String = "conversation-general",
        senderId: String = "user-ada",
        body: String,
    ) {
        append(
            stream = "MessageStream",
            key = conversationId,
            event = "MessageSent",
            payload = mapOf(
                "messageId" to "message-${UUID.randomUUID()}",
                "senderId" to senderId,
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
        .map { item ->
            val conversation = item.jsonObject
            ConversationDto(
                id = conversation.requiredString("id"),
                kind = conversation.requiredString("kind"),
                title = conversation.optionalString("title"),
                createdBy = conversation.requiredString("createdBy"),
                lastMessageEventId = conversation.optionalString("lastMessageEventId"),
            )
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

private suspend fun requireSuccess(response: HttpResponse) {
    if (response.status.value !in 200..299) {
        val message = response.bodyAsText()
        throw FrickHttpException(
            statusCode = response.status.value,
            message = message.ifBlank { "Request failed with HTTP ${response.status.value}" },
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
            readTimeout(2_000, TimeUnit.MILLISECONDS)
            writeTimeout(2_000, TimeUnit.MILLISECONDS)
        }
    }
}

private fun shouldQueueAppend(error: Exception): Boolean =
    error !is FrickSchemaMismatchException && error !is FrickHttpException

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
