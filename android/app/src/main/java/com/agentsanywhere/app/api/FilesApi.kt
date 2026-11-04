package com.agentsanywhere.app.api

import org.json.JSONObject
import java.io.File
import java.net.URI
import java.security.MessageDigest
import java.util.UUID

class FilesApi(
    private val client: ApiClient = ApiClient(),
) {
    companion object {
        const val MAX_DOWNLOAD_BYTES = 64L * 1024 * 1024
        private const val DOWNLOAD_BUFFER_BYTES = 64 * 1024
    }

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
        maxBytes: Long = MAX_DOWNLOAD_BYTES,
    ): File {
        val limit = minOf(maxBytes, MAX_DOWNLOAD_BYTES)
        if (transfer.size > limit) {
            throw ApiException("The file is too large to preview.", 413)
        }
        val url = absoluteDownloadUrl(serverUrl, transfer.downloadUrl)
        destination.parentFile?.mkdirs()
        val temporary = File(
            destination.parentFile,
            ".${destination.name}.${UUID.randomUUID()}.part",
        )
        try {
            // Only send the account token back to the API origin; a 401 there
            // refreshes it through ApiClient like every other request.
            val actualSha = client.downloadStream(
                serverUrl = serverUrl,
                url = url,
                authorizationToken = authorizationToken.takeIf { isSameOrigin(url, serverUrl) },
            ) { input ->
                val digest = MessageDigest.getInstance("SHA-256")
                var total = 0L
                temporary.outputStream().use { output ->
                    val buffer = ByteArray(DOWNLOAD_BUFFER_BYTES)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        total += read
                        if (total > limit) {
                            throw ApiException("The file is too large to preview.", 413)
                        }
                        digest.update(buffer, 0, read)
                        output.write(buffer, 0, read)
                    }
                }
                if (transfer.size > 0 && total != transfer.size) {
                    throw ApiException("The file download was incomplete.", 502)
                }
                digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
            }
            if (transfer.sha256.isNotBlank() && !actualSha.equals(transfer.sha256, ignoreCase = true)) {
                throw ApiException("The downloaded file failed its integrity check.", 502)
            }
            if (!temporary.renameTo(destination)) {
                temporary.copyTo(destination, overwrite = true)
            }
            return destination
        } finally {
            temporary.delete()
        }
    }

    private fun isSameOrigin(first: String, second: String): Boolean {
        return runCatching {
            val a = URI(first)
            val b = URI(second)
            a.scheme.equals(b.scheme, ignoreCase = true) &&
                a.host.equals(b.host, ignoreCase = true) &&
                effectivePort(a) == effectivePort(b)
        }.getOrDefault(false)
    }

    private fun effectivePort(uri: URI): Int = when {
        uri.port >= 0 -> uri.port
        uri.scheme.equals("https", ignoreCase = true) -> 443
        else -> 80
    }

    private fun absoluteDownloadUrl(serverUrl: String, downloadUrl: String): String {
        if (downloadUrl.startsWith("http://") || downloadUrl.startsWith("https://")) return downloadUrl
        val base = serverUrl.trimEnd('/')
        if (base.endsWith("/api/v2") && downloadUrl.startsWith("/api/v2")) {
            return base.removeSuffix("/api/v2") + downloadUrl
        }
        return base + "/" + downloadUrl.trimStart('/')
    }

    fun createPreviewToken(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        root: String,
        path: String,
    ): String {
        val body = JSONObject().apply { put("path", path) }
        val response = client.postJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/fs/preview-token?root=${root.urlEncode()}",
            body = body,
            authorizationToken = authorizationToken,
        )
        return response.optJSONObject("result")?.optString("previewToken").orEmpty()
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
