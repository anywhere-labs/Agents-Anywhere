package dev.agentsanywhere.v3.core.store

import dev.agentsanywhere.v3.core.AAJson
import dev.agentsanywhere.v3.core.model.UserView
import io.github.t4wefan.meshcall.E2EKeyPair
import kotlinx.serialization.Serializable
import java.security.SecureRandom

/**
 * Small secrets (tokens, the client's X25519 private key, device trust records). On Android this is encrypted with a
 * key held in the Android Keystore; tests use [MemorySecureStore].
 */
interface SecureStore {
    fun get(key: String): String?
    fun put(key: String, value: String)
    fun remove(key: String)
}

class MemorySecureStore : SecureStore {
    private val map = HashMap<String, String>()
    @Synchronized override fun get(key: String): String? = map[key]
    @Synchronized override fun put(key: String, value: String) { map[key] = value }
    @Synchronized override fun remove(key: String) { map.remove(key) }
}

/** Larger, non-secret cached data (device and session lists, conversation snapshots) for offline reading. */
interface CacheStore {
    fun read(key: String): String?
    fun write(key: String, value: String)
    fun delete(key: String)
    fun clear()
}

class MemoryCacheStore : CacheStore {
    private val map = HashMap<String, String>()
    @Synchronized override fun read(key: String): String? = map[key]
    @Synchronized override fun write(key: String, value: String) { map[key] = value }
    @Synchronized override fun delete(key: String) { map.remove(key) }
    @Synchronized override fun clear() = map.clear()
}

/**
 * This install's identity: `client_id` (sent at sign-in and in Router tokens) and the static X25519 key it uses to
 * authenticate itself to encrypted devices (Noise IK). Made once and kept; a new key forgets every paired device.
 */
@Serializable
data class ClientIdentity(val client_id: String, val private_key: String, val public_key: String) {
    override fun toString(): String = "ClientIdentity(client_id=$client_id, public_key=$public_key)"

    companion object {
        private const val KEY = "aa.identity"

        fun loadOrCreate(store: SecureStore): ClientIdentity {
            store.get(KEY)?.let { raw -> runCatching { return AAJson.decodeFromString(serializer(), raw) } }
            val bytes = ByteArray(12).also { SecureRandom().nextBytes(it) }
            val pair = E2EKeyPair.generate()
            val identity = ClientIdentity("cli_android_" + bytes.joinToString("") { "%02x".format(it) }, pair.privateKey, pair.publicKey)
            store.put(KEY, AAJson.encodeToString(serializer(), identity))
            return identity
        }
    }
}

/** The signed-in account: control URL, tokens and user. */
@Serializable
data class StoredAuth(
    val control_url: String,
    val access_token: String,
    val refresh_token: String,
    /** Epoch milliseconds. */
    val expires_at: Long,
    val user: UserView,
) {
    override fun toString(): String = "StoredAuth(control_url=$control_url, user=${user.id})"

    companion object {
        const val KEY = "aa.auth"
        fun load(store: SecureStore): StoredAuth? = store.get(KEY)?.let { runCatching { AAJson.decodeFromString(serializer(), it) }.getOrNull() }
        fun save(store: SecureStore, value: StoredAuth?) {
            if (value == null) store.remove(KEY) else store.put(KEY, AAJson.encodeToString(serializer(), value))
        }
    }
}
