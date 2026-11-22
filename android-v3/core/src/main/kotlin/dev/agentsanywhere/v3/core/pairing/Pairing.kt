package dev.agentsanywhere.v3.core.pairing

import dev.agentsanywhere.v3.core.AAJson
import dev.agentsanywhere.v3.core.mesh.AAException
import dev.agentsanywhere.v3.core.store.SecureStore
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64

/** The `aa-pair://v1/<base64url(JSON)>` payload a device shows as a QR code (contracts/aa-v3/1.0/pairing.schema.json). */
@Serializable
data class PairingPayload(
    val v: Int,
    val instance_id: String,
    val device_pub: String,
    val pairing_id: String,
    val psk: String,
    val expires_at: String,
) {
    val deviceId: String get() = instance_id
    override fun toString(): String = "PairingPayload(instance_id=$instance_id, device_pub=$device_pub, pairing_id=$pairing_id, psk=***)"

    companion object {
        const val PREFIX = "aa-pair://v1/"
        private val KEYS = setOf("v", "instance_id", "device_pub", "pairing_id", "psk", "expires_at")
        private val KEY32 = Regex("^[A-Za-z0-9_-]{43}$")

        /** Strict: exact keys, 32-byte keys, a pairing id of 8–128 characters, not expired by the local clock. */
        fun parse(uri: String, now: Instant = Instant.now()): PairingPayload {
            val text = uri.trim()
            if (!text.startsWith(PREFIX)) throw invalid("Not an Agents Anywhere pairing code")
            val json = try {
                String(Base64.getUrlDecoder().decode(text.removePrefix(PREFIX).trimEnd('=')), Charsets.UTF_8)
            } catch (e: IllegalArgumentException) {
                throw invalid("The pairing code is damaged")
            }
            val obj = runCatching { AAJson.parseToJsonElement(json) as JsonObject }.getOrNull() ?: throw invalid("The pairing code is damaged")
            if (obj.keys != KEYS) throw invalid("The pairing code has unexpected fields")
            if ((obj["v"] as? JsonPrimitive)?.content != "1") throw invalid("Unsupported pairing code version")
            val p = runCatching { AAJson.decodeFromJsonElement(serializer(), obj) }.getOrNull() ?: throw invalid("The pairing code is damaged")
            if (p.instance_id.isEmpty() || p.instance_id.length > 128) throw invalid("Invalid device id")
            if (!KEY32.matches(p.device_pub) || !KEY32.matches(p.psk)) throw invalid("Invalid key in the pairing code")
            if (p.pairing_id.length !in 8..128) throw invalid("Invalid pairing id")
            val expires = runCatching { Instant.parse(p.expires_at) }.getOrNull() ?: throw invalid("Invalid expiry")
            if (!expires.isAfter(now)) throw AAException("pairing_expired", "This pairing code has expired. Show a new one on the device.")
            return p
        }

        private fun invalid(message: String) = AAException("invalid_pairing_uri", message)
    }
}

/** What this client trusts about an encrypted device: its pinned key, from the QR code only (`ClientDeviceTrustRecord`). */
@Serializable
data class TrustRecord(
    val device_id: String,
    val device_pub: String,
    val require_e2ee: Boolean = true,
    /** Keystore-backed storage on Android: "verified_app" (green lock). */
    val trust_tier: String = "verified_app",
    val paired_at: String,
    val device_name_hint: String? = null,
)

/** Trust records in secure storage. */
class TrustStore(private val store: SecureStore) {
    private val ser = MapSerializer(String.serializer(), TrustRecord.serializer())

    @Synchronized fun all(): Map<String, TrustRecord> =
        store.get(KEY)?.let { runCatching { AAJson.decodeFromString(ser, it) }.getOrNull() } ?: emptyMap()

    fun get(deviceId: String): TrustRecord? = all()[deviceId]

    @Synchronized fun put(record: TrustRecord) = save(all() + (record.device_id to record))

    @Synchronized fun remove(deviceId: String) = save(all() - deviceId)

    @Synchronized fun clear() = store.remove(KEY)

    private fun save(map: Map<String, TrustRecord>) = store.put(KEY, AAJson.encodeToString(ser, map))

    private companion object { const val KEY = "aa.trust" }
}

/** SHA-256 of the raw key, first 16 bytes as uppercase hex in groups of four: `ABCD EF01 …`. */
fun keyFingerprint(base64UrlKey: String): String {
    val raw = Base64.getUrlDecoder().decode(base64UrlKey.trimEnd('='))
    val digest = MessageDigest.getInstance("SHA-256").digest(raw).copyOf(16)
    return digest.joinToString("") { "%02X".format(it) }.chunked(4).joinToString(" ")
}
