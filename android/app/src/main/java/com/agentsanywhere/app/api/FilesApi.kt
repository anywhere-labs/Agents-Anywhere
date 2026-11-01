package com.agentsanywhere.app.api

import org.json.JSONObject

class FilesApi(
    private val client: ApiClient = ApiClient(),
) {
    fun listFiles(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        root: String,
        path: String = ".",
    ): RemoteDirectory {
        val body = JSONObject().apply {
            put("root", root)
            put("path", path)
        }
        val response = client.postJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/fs/list",
            body = body,
            authorizationToken = authorizationToken,
        )
        val result = response.optJSONObject("result") ?: JSONObject()
        return RemoteDirectory(
            path = result.optString("path", root).ifBlank { root },
            entries = result.optJSONArray("entries").toObjectList { toRemoteDirectoryEntry() },
            truncated = result.optBoolean("truncated", false),
            targetType = result.optString("targetType", "directory"),
        )
    }

    fun readTextFile(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
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
            path = "/connectors/${deviceId.urlEncode()}/fs/readText?root=${root.urlEncode()}",
            body = body,
            authorizationToken = authorizationToken,
        ).toRemoteTextFile()
    }

    fun downloadFile(serverUrl: String, authorizationToken: String, deviceId: String, root: String, path: String): ByteArray {
        val result = client.postJson(
            serverUrl, "/connectors/${deviceId.urlEncode()}/fs/read?root=${root.urlEncode()}",
            JSONObject().put("path", path), authorizationToken,
        ).getJSONObject("result")
        val bytes = client.getFileBytes(serverUrl, result.getString("downloadUrl"), authorizationToken)
        require(result.optLong("size", -1L) == bytes.size.toLong()) { "Downloaded file size does not match." }
        val expected = result.optString("sha256").lowercase()
        val actual = java.security.MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }
        require(expected.length == 64 && expected == actual) { "Downloaded file checksum does not match." }
        return bytes
    }

    fun createPreviewToken(serverUrl: String, authorizationToken: String, deviceId: String, root: String, path: String): String {
        val result = client.postJson(
            serverUrl, "/connectors/${deviceId.urlEncode()}/fs/preview-token?root=${root.urlEncode()}",
            JSONObject().put("path", path), authorizationToken,
        )
        return result.getString("previewToken")
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
}
