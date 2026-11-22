package dev.agentsanywhere.v3.core.cache

import dev.agentsanywhere.v3.core.AAJson
import dev.agentsanywhere.v3.core.model.Control
import dev.agentsanywhere.v3.core.model.DeviceRecord
import dev.agentsanywhere.v3.core.model.DeviceStatus
import dev.agentsanywhere.v3.core.model.Session
import dev.agentsanywhere.v3.core.model.SessionList
import dev.agentsanywhere.v3.core.store.CacheStore
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject

/** A conversation as last seen, for reading while its device is offline (`conversation.cached`, `stale: true`). */
@Serializable
data class CachedConversation(
    val device_id: String,
    val session: Session,
    val messages: List<JsonObject>,
    val control: Control,
    val saved_at: Long,
)

/**
 * The offline cache: device list, each device's conversation list and status, and the tail of every opened
 * conversation. Plain JSON in app-private storage (no secrets; tokens and keys live in the secure store).
 */
class OfflineCache(private val store: CacheStore, private val maxMessages: Int = 300) {
    fun devices(): List<DeviceRecord> = read("devices", ListSerializer(DeviceRecord.serializer())).orEmpty()
    fun saveDevices(devices: List<DeviceRecord>) = write("devices", ListSerializer(DeviceRecord.serializer()), devices)

    fun sessions(deviceId: String): SessionList? = read("sessions.$deviceId", SessionList.serializer())
    fun saveSessions(deviceId: String, list: SessionList) = write("sessions.$deviceId", SessionList.serializer(), list)

    fun status(deviceId: String): DeviceStatus? = read("status.$deviceId", DeviceStatus.serializer())
    fun saveStatus(status: DeviceStatus) = write("status.${status.device_id}", DeviceStatus.serializer(), status)

    fun conversation(sessionId: String): CachedConversation? = read("conv.$sessionId", CachedConversation.serializer())
    fun saveConversation(c: CachedConversation) =
        write("conv.${c.session.id}", CachedConversation.serializer(), c.copy(messages = c.messages.takeLast(maxMessages)))

    fun clear() = store.clear()

    private fun <T> read(key: String, ser: kotlinx.serialization.KSerializer<T>): T? =
        store.read(key)?.let { runCatching { AAJson.decodeFromString(ser, it) }.getOrNull() }

    private fun <T> write(key: String, ser: kotlinx.serialization.KSerializer<T>, value: T) =
        runCatching { store.write(key, AAJson.encodeToString(ser, value)) }.let { }
}
