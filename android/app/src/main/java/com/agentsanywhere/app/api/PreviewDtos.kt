package com.agentsanywhere.app.api

import org.json.JSONArray
import org.json.JSONObject

/** Port preview lives under the v3 namespace (contracts/preview/1.0). */
const val PREVIEWS_PATH = "/api/v3/previews"

/** Session event: the device's complete list of listening ports (preview 1.0 `PortListeningEvent`). */
const val PORT_LISTENING_EVENT = "port.listening"

/** Session event: one port stopped listening (preview 1.0 `PortClosedEvent`). */
const val PORT_CLOSED_EVENT = "port.closed"

/** Port events are live device facts: they have no place in the session history. */
fun isPortEventType(type: String): Boolean = type == PORT_LISTENING_EVENT || type == PORT_CLOSED_EVENT

/** preview 1.0 `ListeningPort`. */
data class RemoteListeningPort(
    val port: Int,
    val pid: Long? = null,
    val processName: String? = null,
    val sessionId: String? = null,
    val url: String? = null,
)

/** preview 1.0 `CreatePreviewRequest`. */
data class CreatePreviewRequest(
    val deviceId: String,
    val port: Int,
    val sessionId: String? = null,
    val visibility: String = "private",
    val ttlHours: Int? = null,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("deviceId", deviceId)
        put("port", port)
        if (sessionId != null) put("sessionId", sessionId)
        put("visibility", visibility)
        if (ttlHours != null) put("ttlHours", ttlHours)
    }
}

/** preview 1.0 `PreviewView`. */
data class RemotePreviewView(
    val previewId: String,
    val slug: String,
    val deviceId: String,
    val sessionId: String?,
    val port: Int,
    val visibility: String,
    /** `opening`, `open` or `closed`. */
    val state: String,
    val closeReason: String?,
    /** The preview address; copying it shares the page with whoever may open it. */
    val url: String?,
    val expiresAt: String,
    /** E2EE mode: preview traffic is relayed by the Server, which can read it. */
    val plaintextNotice: Boolean,
)

/** preview 1.0 `PreviewTicketResponse`: one-time and short-lived. */
data class RemotePreviewTicket(
    val ticketUrl: String,
    val expiresAt: String,
)

internal fun JSONObject.toRemotePreviewView(): RemotePreviewView = RemotePreviewView(
    previewId = getString("previewId"),
    slug = optString("slug"),
    deviceId = optString("deviceId"),
    sessionId = optNullableString("sessionId"),
    port = getInt("port"),
    visibility = optString("visibility", "private"),
    state = optString("state", "opening"),
    closeReason = optNullableString("closeReason"),
    url = optNullableString("url"),
    expiresAt = optString("expiresAt"),
    plaintextNotice = optBoolean("plaintextNotice", false),
)

internal fun JSONObject.toRemotePreviewTicket(): RemotePreviewTicket = RemotePreviewTicket(
    ticketUrl = getString("ticketUrl"),
    expiresAt = optString("expiresAt"),
)

/** `port.listening` ports; malformed entries are skipped. */
internal fun JSONArray?.toListeningPorts(): List<RemoteListeningPort> {
    if (this == null) return emptyList()
    return (0 until length()).mapNotNull { index ->
        val value = optJSONObject(index) ?: return@mapNotNull null
        val port = value.optPortNumber("port") ?: return@mapNotNull null
        RemoteListeningPort(
            port = port,
            pid = value.optNullableLong("pid"),
            processName = value.optNullableString("processName"),
            sessionId = value.optNullableString("sessionId"),
            url = value.optNullableString("url"),
        )
    }
}

internal fun JSONObject.optPortNumber(name: String): Int? {
    val value = opt(name) as? Number ?: return null
    val port = value.toInt()
    return port.takeIf { it in 1..65535 && value.toDouble() == port.toDouble() }
}
