package dev.frick.client

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Encryption-at-rest seam for the durable session secret (the bearer
 * [FrickSession.sessionToken] and the identity it authenticates).
 *
 * The session blob is a full account-takeover credential, so it must never sit
 * in cleartext on disk. [SQLiteFrickStorage] persists everything *except* the
 * session row in plain SQLite (object cache, stream events, pending appends,
 * cache metadata — none of which is a secret) and routes the session JSON
 * through a [SessionSecretStore] so the secret lives behind an
 * AndroidKeyStore-wrapped key instead.
 *
 * This is the Android analogue of the iOS Keychain path, and it is deliberately
 * an interface with an injectable implementation so it is unit-testable: the
 * `:frick` unit tests run on the JVM (Robolectric) without a real Keystore, so
 * they inject [InMemorySessionSecretStore]; production uses
 * [keystoreBackedSessionSecretStore] (EncryptedSharedPreferences over an
 * AndroidKeyStore master key). Mirrors how the iOS side abstracts Keychain
 * access behind a protocol so tests can substitute a fake.
 */
interface SessionSecretStore {
    /** The persisted session JSON, or `null` when signed out. */
    fun loadSecret(): String?

    /** Persist (overwriting) the session JSON. */
    fun saveSecret(secret: String)

    /** Remove the persisted session JSON. */
    fun clearSecret()
}

/**
 * In-memory [SessionSecretStore]. Holds the secret in a process-local field —
 * **not** persistent and **not** for production use. Provided so unit tests can
 * exercise [SQLiteFrickStorage]'s session path without a real Keystore, matching
 * the fake-Keychain pattern on iOS.
 */
class InMemorySessionSecretStore(initial: String? = null) : SessionSecretStore {
    @Volatile private var secret: String? = initial

    override fun loadSecret(): String? = secret

    override fun saveSecret(secret: String) {
        this.secret = secret
    }

    override fun clearSecret() {
        secret = null
    }
}

/**
 * [SessionSecretStore] backed by [SharedPreferences]. Production wires an
 * [EncryptedSharedPreferences] instance (see [keystoreBackedSessionSecretStore])
 * whose entries are AES-256-GCM encrypted under an AndroidKeyStore master key,
 * so the stored value is never plaintext on disk. The class itself is agnostic
 * to whether the prefs are encrypted — tests can pass a plain in-memory prefs
 * double — but the only production constructor path encrypts.
 */
class SharedPreferencesSessionSecretStore(
    private val prefs: SharedPreferences,
    private val key: String = DEFAULT_KEY,
) : SessionSecretStore {
    override fun loadSecret(): String? = prefs.getString(key, null)

    override fun saveSecret(secret: String) {
        prefs.edit().putString(key, secret).apply()
    }

    override fun clearSecret() {
        prefs.edit().remove(key).apply()
    }

    companion object {
        const val DEFAULT_KEY = "session"
    }
}

/**
 * Build the production [SessionSecretStore]: an [EncryptedSharedPreferences]
 * file (`frick_session_secret` by default) encrypted under an AndroidKeyStore
 * master key. Values are AES-256-GCM encrypted at rest; the master key never
 * leaves the Keystore. Used by [SQLiteFrickStorage] when no explicit store is
 * injected, so the default storage really does encrypt the session secret.
 */
fun keystoreBackedSessionSecretStore(
    context: Context,
    fileName: String = "frick_session_secret",
): SessionSecretStore {
    val appContext = context.applicationContext
    val masterKey = MasterKey.Builder(appContext)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()
    val prefs = EncryptedSharedPreferences.create(
        appContext,
        fileName,
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
    return SharedPreferencesSessionSecretStore(prefs)
}
