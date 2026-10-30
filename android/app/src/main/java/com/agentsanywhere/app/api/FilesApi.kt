package com.agentsanywhere.app.api

import okhttp3.Request
import org.json.JSONObject
import java.io.File

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

    fun prepareFile(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        root: String,
        path: String,
    ): RemoteFileTransfer {
        val body = JSONObject().apply { put("path", path) }
        val response = client.postJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/fs/read?root=${root.urlEncode()}",
            body = body,
            authorizationToken = authorizationToken,
        )
        val result = response.optJSONObject("result") ?: JSONObject()
        return RemoteFileTransfer(
            path = result.optString("path", path),
            name = result.optString("name", path.substringAfterLast('/')).ifBlank { "download" },
            size = result.optLong("size", 0L),
            sha256 = result.optString("sha256", ""),
            mediaType = result.optString("mediaType", "application/octet-stream"),
            transferId = result.optString("transferId", ""),
            downloadUrl = result.optString("downloadUrl", ""),
        )
    }

    fun downloadFile(
        serverUrl: String,
        authorizationToken: String,
        transfer: RemoteFileTransfer,
        destination: File,
    ): File {
        val url = absoluteDownloadUrl(serverUrl, transfer.downloadUrl)
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $authorizationToken")
            .get()
            .build()
        HttpClientProvider.client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val message = response.body?.string()?.takeIf(String::isNotBlank)
                    ?: "Could not download file."
                throw ApiException(message, response.code)
            }
            val body = response.body ?: throw ApiException("The server returned an empty file.", response.code)
            destination.parentFile?.mkdirs()
            body.byteStream().use { input ->
                destination.outputStream().use { output ->
                    input.copyTo(output, bufferSize = 64 * 1024)
                }
            }
        }
        return destination
    }

    private fun absoluteDownloadUrl(serverUrl: String, downloadUrl: String): String {
        if (downloadUrl.startsWith("http://") || downloadUrl.startsWith("https://")) return downloadUrl
        val base = serverUrl.trimEnd('/')
        if (base.endsWith("/api/v2") && downloadUrl.startsWith("/api/v2")) {
            return base.removeSuffix("/api/v2") + downloadUrl
        }
        return base + "/" + downloadUrl.trimStart('/')
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
