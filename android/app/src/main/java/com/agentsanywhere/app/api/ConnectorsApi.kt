package com.agentsanywhere.app.api

import org.json.JSONObject

class ConnectorsApi(
    private val client: ApiClient = ApiClient(),
) {
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

    fun updateConnector(
        serverUrl: String,
        authorizationToken: String,
        connectorId: String,
        name: String,
    ): RemoteConnector {
        return client.patchJson(
            serverUrl = serverUrl,
            path = "/connectors/${connectorId.urlEncode()}",
            body = JSONObject().put("name", name),
            authorizationToken = authorizationToken,
        ).getJSONObject("connector").toRemoteConnector()
    }

    fun deleteConnector(
        serverUrl: String,
        authorizationToken: String,
        connectorId: String,
    ) {
        client.deleteJson(
            serverUrl = serverUrl,
            path = "/connectors/${connectorId.urlEncode()}",
            authorizationToken = authorizationToken,
        )
    }

    fun revokeConnector(
        serverUrl: String,
        authorizationToken: String,
        connectorId: String,
    ): RemoteConnectorCredential {
        val response = client.postJson(
            serverUrl = serverUrl,
            path = "/connectors/${connectorId.urlEncode()}/revoke",
            body = JSONObject(),
            authorizationToken = authorizationToken,
        )
        return RemoteConnectorCredential(
            connector = response.getJSONObject("connector").toRemoteConnector(),
            connectorToken = response.getString("connectorToken"),
            tokenPrefix = response.optNullableString("tokenPrefix"),
        )
    }

    fun deleteConnectorRuntime(
        serverUrl: String,
        authorizationToken: String,
        connectorId: String,
        runtime: String,
    ): List<String> {
        return client.deleteJson(
            serverUrl = serverUrl,
            path = "/connectors/${connectorId.urlEncode()}/runtime-capabilities/${runtime.urlEncode()}",
            authorizationToken = authorizationToken,
        ).getJSONObject("runtimeCapabilities").attachedRuntimes()
    }

    fun claimPairing(
        serverUrl: String,
        authorizationToken: String,
        code: String,
        name: String,
        connectorId: String,
        connectorToken: String,
    ): RemoteConnector {
        val body = JSONObject().apply {
            put("code", code)
            put("name", name)
            put("serverUrl", serverUrl)
            put("connectorId", connectorId)
            put("connectorToken", connectorToken)
        }
        return client.postJson(
            serverUrl = serverUrl,
            path = "/pairing/claim",
            body = body,
            authorizationToken = authorizationToken,
        ).getJSONObject("connector").toRemoteConnector()
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

    private fun JSONObject.toRemoteConnector(): RemoteConnector {
        return RemoteConnector(
            id = getString("id"),
            name = optString("name", "Device").ifBlank { "Device" },
            deviceOs = optNullableString("deviceOs"),
            status = optString("status", "offline"),
            lastSeenAt = optNullableString("lastSeenAt"),
            attachedRuntimes = optJSONObject("runtimeCapabilities").attachedRuntimes(),
            createdAt = optNullableString("createdAt"),
            updatedAt = optNullableString("updatedAt"),
        )
    }

    private fun JSONObject?.attachedRuntimes(): List<String> {
        return this
            ?.optJSONObject("attached")
            ?.keys()
            ?.asSequence()
            ?.toList()
            .orEmpty()
            .sorted()
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
}
