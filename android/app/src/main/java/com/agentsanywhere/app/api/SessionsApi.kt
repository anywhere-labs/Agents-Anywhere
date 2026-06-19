package com.agentsanywhere.app.api

import org.json.JSONArray
import org.json.JSONObject

class SessionsApi(
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

    fun createSession(
        serverUrl: String,
        authorizationToken: String,
        connectorId: String,
        runtime: String,
        title: String?,
        cwd: String?,
    ): RemoteSession {
        val body = JSONObject().apply {
            put("connectorId", connectorId)
            put("runtime", runtime)
            title?.takeIf { it.isNotBlank() }?.let { put("title", it) }
            cwd?.takeIf { it.isNotBlank() }?.let { put("cwd", it) }
        }
        return client.postJson(
            serverUrl = serverUrl,
            path = "/sessions",
            body = body,
            authorizationToken = authorizationToken,
        ).getJSONObject("session").toRemoteSession()
    }

    fun listConnectorFiles(
        serverUrl: String,
        authorizationToken: String,
        connectorId: String,
        root: String,
        path: String = ".",
    ): RemoteDirectory {
        val body = JSONObject().apply {
            put("root", root)
            put("path", path)
        }
        val response = client.postJson(
            serverUrl = serverUrl,
            path = "/connectors/${connectorId.urlEncode()}/fs/list",
            body = body,
            authorizationToken = authorizationToken,
        )
        val result = response.optJSONObject("result") ?: JSONObject()
        return RemoteDirectory(
            path = result.optString("path", root).ifBlank { root },
            entries = result.optJSONArray("entries").toObjectList { toRemoteDirectoryEntry() },
            truncated = result.optBoolean("truncated", false),
        )
    }

    fun readConnectorTextFile(
        serverUrl: String,
        authorizationToken: String,
        connectorId: String,
        root: String,
        path: String,
        maxBytes: Int = 1_048_576,
    ): RemoteTextFile {
        val body = JSONObject().apply {
            put("path", path)
            put("maxBytes", maxBytes)
        }
        return client.postJson(
            serverUrl = serverUrl,
            path = "/connectors/${connectorId.urlEncode()}/fs/readText?root=${root.urlEncode()}",
            body = body,
            authorizationToken = authorizationToken,
        ).toRemoteTextFile()
    }

    fun createConnectorTerminal(
        serverUrl: String,
        authorizationToken: String,
        connectorId: String,
        root: String,
        cols: Int,
        rows: Int,
        cwd: String = ".",
        ephemeralGroupId: String,
    ): RemoteTerminal {
        val body = JSONObject().apply {
            put("cols", cols)
            put("rows", rows)
            put("cwd", cwd)
            put("ephemeralGroupId", ephemeralGroupId)
        }
        return client.postJson(
            serverUrl = serverUrl,
            path = "/connectors/${connectorId.urlEncode()}/terminals?root=${root.urlEncode()}",
            body = body,
            authorizationToken = authorizationToken,
        ).getJSONObject("terminal").toRemoteTerminal()
    }

    fun closeConnectorTerminal(
        serverUrl: String,
        authorizationToken: String,
        connectorId: String,
        terminalId: String,
    ) {
        client.deleteJson(
            serverUrl = serverUrl,
            path = "/connectors/${connectorId.urlEncode()}/terminals/${terminalId.urlEncode()}",
            authorizationToken = authorizationToken,
        )
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

    fun getRuntimeConfigSchema(
        serverUrl: String,
        authorizationToken: String,
        runtime: String,
    ): RemoteRuntimeConfigSchema {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/agents/${runtime.urlEncode()}/config-schema",
            authorizationToken = authorizationToken,
        ).getJSONObject("schema").toRemoteRuntimeConfigSchema()
    }

    fun getSessionRuntimeSettings(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
    ): RemoteRuntimeSettings {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/runtime-settings",
            authorizationToken = authorizationToken,
        ).toRemoteRuntimeSettings()
    }

    fun patchSessionRuntimeSettings(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        settings: Map<String, Any?>,
    ): RemoteRuntimeSettings {
        val body = JSONObject().put("settings", settings.toJsonObject())
        return client.patchJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/runtime-settings",
            body = body,
            authorizationToken = authorizationToken,
        ).toRemoteRuntimeSettings()
    }

    fun getSessionState(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        afterSeq: Int = 0,
        limit: Int = 500,
    ): RemoteSessionState {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/state?afterSeq=$afterSeq&limit=$limit",
            authorizationToken = authorizationToken,
        ).toRemoteSessionState()
    }

    fun streamSessionEvents(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        onOpen: () -> Unit = {},
        onEvent: (RemoteSessionEvent) -> Unit,
    ) {
        client.streamSse(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/events?token=${authorizationToken.urlEncode()}",
            onOpen = onOpen,
        ) { event ->
            onEvent(event.toRemoteSessionEvent())
        }
    }

    fun sendSessionMessage(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        content: String,
        clientMessageId: String,
        attachments: List<RemoteUploadedAttachment> = emptyList(),
    ): RemoteRpcResponse {
        val body = JSONObject()
            .put("content", content)
            .put("clientMessageId", clientMessageId)
        if (attachments.isNotEmpty()) {
            body.put(
                "attachments",
                JSONArray(attachments.map { JSONObject().put("fileId", it.fileId) }),
            )
        }
        return client.postJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/messages",
            body = body,
            authorizationToken = authorizationToken,
        ).toRemoteRpcResponse()
    }

    fun uploadSessionAttachments(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        files: List<UploadFilePart>,
    ): List<RemoteUploadedAttachment> {
        return client.postMultipart(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/attachments",
            files = files,
            authorizationToken = authorizationToken,
        ).optJSONArray("attachments").toObjectList { toRemoteUploadedAttachment() }
    }

    fun attachmentOpenUrl(
        serverUrl: String,
        sessionId: String,
        fileId: String,
    ): String {
        return "${serverUrl.trimEnd('/')}/sessions/${sessionId.urlEncode()}/attachments/${fileId.urlEncode()}/open"
    }

    fun interruptSession(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
    ): RemoteRpcResponse {
        return client.postJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/interrupt",
            body = JSONObject(),
            authorizationToken = authorizationToken,
        ).toRemoteRpcResponse()
    }

    fun enableTakeover(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
    ): RemoteSession {
        return client.postJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/takeover",
            body = JSONObject(),
            authorizationToken = authorizationToken,
        ).getJSONObject("session").toRemoteSession()
    }

    fun disableTakeover(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
    ): RemoteSession {
        return client.deleteJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/takeover",
            authorizationToken = authorizationToken,
        ).getJSONObject("session").toRemoteSession()
    }

    fun resolveApproval(
        serverUrl: String,
        authorizationToken: String,
        approvalId: String,
        status: String,
    ): RemoteRpcResponse {
        return client.postJson(
            serverUrl = serverUrl,
            path = "/approvals/${approvalId.urlEncode()}/resolve",
            body = JSONObject().put("status", status),
            authorizationToken = authorizationToken,
        ).toRemoteRpcResponse()
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
            status = optString("status", "offline"),
            lastSeenAt = optNullableString("lastSeenAt"),
            attachedRuntimes = attached,
            createdAt = optNullableString("createdAt"),
            updatedAt = optNullableString("updatedAt"),
        )
    }

    private fun JSONObject.toRemoteSessionState(): RemoteSessionState {
        return RemoteSessionState(
            session = getJSONObject("session").toRemoteSession(),
            items = optJSONArray("items").toObjectList { toRemoteTimelineItem() },
            approvals = optJSONArray("approvals").toObjectList { toRemoteApproval() },
            nextSeq = optInt("nextSeq", 0),
            hasMore = optBoolean("hasMore", false),
        )
    }

    private fun JSONObject.toRemoteRuntimeConfigSchema(): RemoteRuntimeConfigSchema {
        return RemoteRuntimeConfigSchema(
            runtime = optString("runtime", ""),
            schemaVersion = optInt("schemaVersion", 0),
            fields = optJSONArray("fields").toObjectList { toRemoteRuntimeConfigField() },
        )
    }

    private fun JSONObject.toRemoteRuntimeConfigField(): RemoteRuntimeConfigField {
        return RemoteRuntimeConfigField(
            key = optString("key", ""),
            label = optString("label", ""),
            type = optString("type", "string"),
            description = optNullableString("description"),
            options = optJSONArray("options").toObjectList { toRemoteRuntimeConfigOption() },
            visibleWhen = optJSONObject("visibleWhen").toMap(),
            allowSessionOverride = optBoolean("allowSessionOverride", false),
            hidden = optBoolean("hidden", false),
        )
    }

    private fun JSONObject.toRemoteRuntimeConfigOption(): RemoteRuntimeConfigOption {
        return RemoteRuntimeConfigOption(
            value = opt("value")?.toString().orEmpty(),
            label = optString("label", ""),
            description = optNullableString("description"),
        )
    }

    private fun JSONObject.toRemoteRuntimeSettings(): RemoteRuntimeSettings {
        return RemoteRuntimeSettings(
            runtime = optString("runtime", ""),
            settings = (optJSONObject("runtimeSettings") ?: optJSONObject("settings")).toMap(),
            runtimeSettingsOverride = optJSONObject("runtimeSettingsOverride").toMap(),
            effectiveRunMode = optNullableString("effectiveRunMode"),
            defaultRunModeConfigured = optBoolean("defaultRunModeConfigured", false),
            schemaVersion = optInt("schemaVersion", 0),
        )
    }

    private fun JSONObject.toRemoteTimelineItem(): RemoteTimelineItem {
        val content = optJSONObject("content") ?: JSONObject()
        return RemoteTimelineItem(
            id = getString("id"),
            sessionId = optString("sessionId", ""),
            turnId = optNullableString("turnId"),
            type = optString("type", "message"),
            status = optString("status", "done"),
            role = optNullableString("role"),
            text = content.optNullableString("text")
                ?: content.optNullableString("message")
                ?: content.optNullableString("description")
                ?: "",
            content = content,
            source = optJSONObject("source") ?: JSONObject(),
            orderSeq = optInt("orderSeq", 0),
            updatedSeq = optInt("updatedSeq", 0),
            createdAt = optString("createdAt", ""),
        )
    }

    private fun JSONObject.toRemoteDirectoryEntry(): RemoteDirectoryEntry {
        return RemoteDirectoryEntry(
            name = optString("name", "Untitled").ifBlank { "Untitled" },
            path = optString("path", ""),
            type = optString("type", "other"),
            size = if (has("size") && !isNull("size")) optLong("size") else null,
        )
    }

    private fun JSONObject.toRemoteTextFile(): RemoteTextFile {
        return RemoteTextFile(
            path = optString("path", ""),
            name = optString("name", "Untitled").ifBlank { "Untitled" },
            size = optLong("size", 0L),
            sha256 = optString("sha256", ""),
            encoding = optString("encoding", "utf8"),
            content = optString("content", ""),
            truncated = optBoolean("truncated", false),
            binary = optBoolean("binary", false),
            serverTime = optString("serverTime", ""),
        )
    }

    private fun JSONObject.toRemoteTerminal(): RemoteTerminal {
        return RemoteTerminal(
            terminalId = getString("terminalId"),
            sessionId = optString("sessionId", ""),
            label = optString("label", "zsh").ifBlank { "zsh" },
            cwd = optString("cwd", ""),
            cols = optInt("cols", 80),
            rows = optInt("rows", 24),
            purpose = optString("purpose", "user"),
            pid = if (has("pid") && !isNull("pid")) optInt("pid") else null,
            status = optString("status", "starting"),
            exitCode = if (has("exitCode") && !isNull("exitCode")) optInt("exitCode") else null,
            scrollbackSeq = optInt("scrollbackSeq", 0),
        )
    }

    private fun JSONObject.toRemoteApproval(): RemoteApproval {
        return RemoteApproval(
            id = getString("id"),
            sessionId = optString("sessionId", ""),
            turnId = optNullableString("turnId"),
            status = optString("status", "pending"),
            kind = optString("kind", "unknown"),
            targetItemId = optNullableString("targetItemId"),
            title = optString("title", "Permission request"),
            description = optNullableString("description"),
            choices = optJSONArray("choices").toStringList(),
            updatedSeq = optInt("updatedSeq", 0),
            createdAt = optString("createdAt", ""),
        )
    }

    private fun JSONObject.toRemoteSessionEvent(): RemoteSessionEvent {
        return RemoteSessionEvent(
            sessionId = optString("sessionId", ""),
            items = optJSONArray("items").toObjectList { toRemoteTimelineItem() },
            approvals = if (has("approvals")) {
                optJSONArray("approvals").toObjectList { toRemoteApproval() }
            } else {
                null
            },
            session = optJSONObject("session")?.toRemoteSession(),
            nextSeq = optInt("nextSeq", 0),
            refetch = optBoolean("refetch", false),
        )
    }

    private fun JSONObject.toRemoteRpcResponse(): RemoteRpcResponse {
        val result = optJSONObject("result")
        return RemoteRpcResponse(
            ok = optBoolean("ok", false),
            turnId = result?.optNullableString("turnId"),
        )
    }

    private fun JSONObject.toRemoteUploadedAttachment(): RemoteUploadedAttachment {
        return RemoteUploadedAttachment(
            fileId = getString("fileId"),
            name = optString("name", "attachment"),
            mediaType = optString("mediaType", ""),
            size = optLong("size", 0L),
        )
    }

    private fun JSONObject.optNullableString(name: String): String? {
        if (!has(name) || isNull(name)) return null
        return optString(name).takeIf { it.isNotBlank() }
    }

    private fun JSONObject?.toMap(): Map<String, Any?> {
        if (this == null) return emptyMap()
        return keys().asSequence().associateWith { key ->
            val value = opt(key)
            when (value) {
                JSONObject.NULL -> null
                is JSONObject -> value.toMap()
                is JSONArray -> List(value.length()) { index -> value.opt(index) }
                else -> value
            }
        }
    }

    private fun Map<String, Any?>.toJsonObject(): JSONObject {
        val json = JSONObject()
        forEach { (key, value) ->
            json.put(key, value ?: JSONObject.NULL)
        }
        return json
    }

    private inline fun <T> JSONArray?.toObjectList(
        transform: JSONObject.() -> T,
    ): List<T> {
        if (this == null) return emptyList()
        return List(length()) { index ->
            getJSONObject(index).transform()
        }
    }

    private fun JSONArray?.toStringList(): List<String> {
        if (this == null) return emptyList()
        return List(length()) { index -> optString(index) }.filter { it.isNotBlank() }
    }

    private fun String.urlEncode(): String {
        return java.net.URLEncoder.encode(this, Charsets.UTF_8.name()).replace("+", "%20")
    }
}

data class RemoteSession(
    val id: String,
    val connectorId: String,
    val connectorStatus: String,
    val runtime: String,
    val externalSessionId: String?,
    val title: String?,
    val cwd: String?,
    val status: String,
    val takeover: Boolean,
    val pinned: Boolean,
    val archived: Boolean,
    val unread: Boolean,
    val lastSyncedAt: String?,
    val sourceObservedAt: String?,
    val lastActivityAt: String?,
    val lastItemAt: String?,
    val sortAt: String?,
    val updatedSeq: Int,
    val effectiveRunMode: String?,
    val runtimeSettings: Map<String, Any?>,
    val runtimeSettingsOverride: Map<String, Any?>,
)

data class RemoteRuntimeConfigSchema(
    val runtime: String,
    val schemaVersion: Int,
    val fields: List<RemoteRuntimeConfigField>,
)

data class RemoteRuntimeConfigField(
    val key: String,
    val label: String,
    val type: String,
    val description: String?,
    val options: List<RemoteRuntimeConfigOption>,
    val visibleWhen: Map<String, Any?>,
    val allowSessionOverride: Boolean,
    val hidden: Boolean,
)

data class RemoteRuntimeConfigOption(
    val value: String,
    val label: String,
    val description: String?,
)

data class RemoteRuntimeSettings(
    val runtime: String,
    val settings: Map<String, Any?>,
    val runtimeSettingsOverride: Map<String, Any?>,
    val effectiveRunMode: String?,
    val defaultRunModeConfigured: Boolean,
    val schemaVersion: Int,
)

data class RemoteConnector(
    val id: String,
    val name: String,
    val status: String,
    val lastSeenAt: String?,
    val attachedRuntimes: List<String>,
    val createdAt: String?,
    val updatedAt: String?,
)

data class RemoteSessionState(
    val session: RemoteSession,
    val items: List<RemoteTimelineItem>,
    val approvals: List<RemoteApproval>,
    val nextSeq: Int,
    val hasMore: Boolean,
)

data class RemoteTimelineItem(
    val id: String,
    val sessionId: String,
    val turnId: String?,
    val type: String,
    val status: String,
    val role: String?,
    val text: String,
    val content: JSONObject,
    val source: JSONObject,
    val orderSeq: Int,
    val updatedSeq: Int,
    val createdAt: String,
)

data class RemoteDirectory(
    val path: String,
    val entries: List<RemoteDirectoryEntry>,
    val truncated: Boolean,
)

data class RemoteDirectoryEntry(
    val name: String,
    val path: String,
    val type: String,
    val size: Long?,
)

data class RemoteTextFile(
    val path: String,
    val name: String,
    val size: Long,
    val sha256: String,
    val encoding: String,
    val content: String,
    val truncated: Boolean,
    val binary: Boolean,
    val serverTime: String,
)

data class RemoteTerminal(
    val terminalId: String,
    val sessionId: String,
    val label: String,
    val cwd: String,
    val cols: Int,
    val rows: Int,
    val purpose: String,
    val pid: Int?,
    val status: String,
    val exitCode: Int?,
    val scrollbackSeq: Int,
)

data class RemoteApproval(
    val id: String,
    val sessionId: String,
    val turnId: String?,
    val status: String,
    val kind: String,
    val targetItemId: String?,
    val title: String,
    val description: String?,
    val choices: List<String>,
    val updatedSeq: Int,
    val createdAt: String,
)

data class RemoteSessionEvent(
    val sessionId: String,
    val items: List<RemoteTimelineItem>,
    val approvals: List<RemoteApproval>?,
    val session: RemoteSession?,
    val nextSeq: Int,
    val refetch: Boolean,
)

data class RemoteRpcResponse(
    val ok: Boolean,
    val turnId: String?,
)

data class RemoteUploadedAttachment(
    val fileId: String,
    val name: String,
    val mediaType: String,
    val size: Long,
)
