package dev.frick.demo

import dev.frick.client.FrickSession
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

// FrickDemoExtras — thin HTTP helpers that the SDK does not yet expose.
//
// The round-10b FrickSyncSocket adds WebSocket subscribe/append/upsert, but
// presence-write and push registration are still HTTP-only on the server side.
// Rather than touch the SDK, the demo issues these requests directly with
// HttpURLConnection (no extra dependency) and the active session token.

internal data class PushRegistrationResult(val id: String)

internal object FrickDemoHttp {
    fun registerPush(
        session: FrickSession,
        deviceId: String,
        platform: String,
        token: String,
    ): PushRegistrationResult? {
        val body = JSONObject().apply {
            put("deviceId", deviceId)
            put("platform", platform)
            put("token", token)
            put("environment", "sandbox")
        }.toString()
        val response = postJson(session, "/push/registrations", body) ?: return null
        val parsed = JSONObject(response)
        val registration = parsed.optJSONObject("registration") ?: return null
        val id = registration.optString("id")
        return if (id.isNullOrEmpty()) null else PushRegistrationResult(id = id)
    }

    fun unregisterPush(session: FrickSession, registrationId: String): Boolean {
        val url = URL("$DemoBaseUrl/push/registrations/$registrationId")
        val connection = url.openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "DELETE"
            connection.setRequestProperty("Authorization", "Bearer ${session.sessionToken}")
            connection.connectTimeout = 5_000
            connection.readTimeout = 5_000
            val status = connection.responseCode
            status in 200..299
        } catch (error: Exception) {
            false
        } finally {
            connection.disconnect()
        }
    }

    private fun postJson(session: FrickSession, path: String, body: String): String? {
        val url = URL("$DemoBaseUrl$path")
        val connection = url.openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Authorization", "Bearer ${session.sessionToken}")
            connection.connectTimeout = 5_000
            connection.readTimeout = 5_000
            OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { writer ->
                writer.write(body)
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            stream?.use { input ->
                BufferedReader(InputStreamReader(input, Charsets.UTF_8)).readText()
            }
        } catch (error: Exception) {
            null
        } finally {
            connection.disconnect()
        }
    }
}
