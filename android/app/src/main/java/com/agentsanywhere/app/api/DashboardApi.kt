package com.agentsanywhere.app.api

import org.json.JSONArray
import org.json.JSONObject

class DashboardApi(
    private val client: ApiClient = ApiClient(),
) {
    fun listSessions(
        serverUrl: String,
        authorizationToken: String,
    ): List<RemoteSession> {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/sessions",
            authorizationToken = authorizationToken,
        ).optJSONArray("sessions").toObjectList { toRemoteSession() }
    }

    fun listConnectors(
        serverUrl: String,
        authorizationToken: String,
    ): List<RemoteConnector> {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/connectors",
            authorizationToken = authorizationToken,
        ).optJSONArray("connectors").toObjectList { toRemoteConnector() }
    }

    fun patchSession(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        title: String? = null,
        pinned: Boolean? = null,
        archived: Boolean? = null,
    ): RemoteSession {
        val body = JSONObject().apply {
            title?.let { put("title", it) }
            pinned?.let { put("pinned", it) }
            archived?.let { put("archived", it) }
        }
        return client.patchJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}",
            body = body,
            authorizationToken = authorizationToken,
        ).getJSONObject("session").toRemoteSession()
    }

    private fun JSONObject.toRemoteSession(): RemoteSession {
        return RemoteSession(
            id = getString("id"),
            connectorId = getString("connectorId"),
            connectorStatus = optString("connectorStatus", "offline"),
            runtime = optString("runtime", "codex"),
            externalSessionId = optNullableString("externalSessionId"),
            title = optNullableString("title"),
            cwd = optNullableString("cwd"),
            status = optString("status", "idle"),
            takeover = optBoolean("takeover", false),
            pinned = optBoolean("pinned", false),
            archived = optBoolean("archived", false),
            unread = optBoolean("unread", false),
            lastSyncedAt = optNullableString("lastSyncedAt"),
            sourceObservedAt = optNullableString("sourceObservedAt"),
            lastActivityAt = optNullableString("lastActivityAt"),
            lastItemAt = optNullableString("lastItemAt"),
            sortAt = optNullableString("sortAt"),
            updatedSeq = optInt("updatedSeq", 0),
            effectiveRunMode = optNullableString("effectiveRunMode"),
            runtimeSettings = optJSONObject("runtimeSettings").toMap(),
            runtimeSettingsOverride = optJSONObject("runtimeSettingsOverride").toMap(),
        )
    }

    private fun JSONObject.toRemoteConnector(): RemoteConnector {
        val attached = optJSONObject("runtimeCapabilities")
            ?.optJSONObject("attached")
            ?.keys()
            ?.asSequence()
            ?.toList()
            .orEmpty()
            .sorted()

        return RemoteConnector(
            id = getString("id"),
            name = optString("name", "Device").ifBlank { "Device" },
            deviceOs = optNullableString("deviceOs"),
            status = optString("status", "offline"),
            lastSeenAt = optNullableString("lastSeenAt"),
            attachedRuntimes = attached,
            createdAt = optNullableString("createdAt"),
            updatedAt = optNullableString("updatedAt"),
        )
    }

    private fun JSONObject.optNullableString(name: String): String? {
        if (!has(name) || isNull(name)) return null
        return optString(name).takeIf { it.isNotBlank() }
    }

    private fun JSONObject?.toMap(): Map<String, Any?> {
        if (this == null) return emptyMap()
        return keys().asSequence().associateWith { key ->
            when (val value = opt(key)) {
                JSONObject.NULL -> null
                is JSONObject -> value.toMap()
                is JSONArray -> List(value.length()) { index -> value.opt(index) }
                else -> value
            }
        }
    }

    private inline fun <T> JSONArray?.toObjectList(
        transform: JSONObject.() -> T,
    ): List<T> {
        if (this == null) return emptyList()
        return List(length()) { index ->
            getJSONObject(index).transform()
        }
    }

    private fun String.urlEncode(): String {
        return java.net.URLEncoder.encode(this, Charsets.UTF_8.name()).replace("+", "%20")
    }
}
