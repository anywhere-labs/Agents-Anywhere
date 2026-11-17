package com.agentsanywhere.app.api

import com.agentsanywhere.app.api.e2ee.TunnelFileChunk
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

        /** `downloadUrl` of a transfer read through an encrypted device's channel (never sent anywhere). */
        private const val SECURE_FILE_SCHEME = "aa-e2ee-file://device"

        /** Upper bound for files the preview page downloads to share or save. */
        const val MAX_SAVE_BYTES = 512L * 1024 * 1024
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
        // An encrypted device: read through the channel in chunks; nothing passes the Server in plaintext.
        client.gate?.secureFiles(serverUrl, authorizationToken, deviceId)?.let { reader ->
            val probe = reader.read(root, path, offset = 0, length = 1)
            return RemoteFileTransfer(
                path = path,
                name = path.trimEnd('/').substringAfterLast('/').ifBlank { "download" },
                size = probe.size,
                sha256 = "",
                mediaType = java.net.URLConnection.guessContentTypeFromName(path) ?: "application/octet-stream",
                transferId = "e2ee:${UUID.randomUUID()}",
                downloadUrl = secureFileUrl(deviceId, root, path),
            )
        }
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
        onProgress: (downloadedBytes: Long, totalBytes: Long) -> Unit = { _, _ -> },
    ): File {
        val limit = minOf(maxBytes, MAX_SAVE_BYTES)
        if (transfer.size > limit) {
            throw ApiException("The file is too large to preview.", 413)
        }
        if (transfer.downloadUrl.startsWith(SECURE_FILE_SCHEME)) {
            return downloadSecureFile(serverUrl, authorizationToken, transfer, destination, limit, onProgress)
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
                        onProgress(total, transfer.size)
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

    /** Reads an encrypted device's file chunk by chunk until `eof` and saves it like a normal download. */
    private fun downloadSecureFile(
        serverUrl: String,
        authorizationToken: String,
        transfer: RemoteFileTransfer,
        destination: File,
        limit: Long,
        onProgress: (downloadedBytes: Long, totalBytes: Long) -> Unit,
    ): File {
        val uri = URI(transfer.downloadUrl)
        val query = uri.rawQuery.orEmpty().split('&').filter { '=' in it }.associate {
            it.substringBefore('=') to java.net.URLDecoder.decode(it.substringAfter('='), "UTF-8")
        }
        val deviceId = query["device"].orEmpty()
        val reader = client.gate?.secureFiles(serverUrl, authorizationToken, deviceId)
            ?: throw ApiException("The device no longer uses an encrypted connection; prepare the download again.")
        destination.parentFile?.mkdirs()
        val temporary = File(destination.parentFile, ".${destination.name}.${UUID.randomUUID()}.part")
        try {
            var offset = 0L
            var size = transfer.size
            temporary.outputStream().use { output ->
                while (true) {
                    val chunk = reader.read(query["root"].orEmpty(), query["path"].orEmpty(), offset, TunnelFileChunk.MAX_BYTES)
                    if (chunk.offset != offset) throw ApiException("The device returned a file chunk out of order.", 502)
                    size = chunk.size
                    if (offset + chunk.data.size > limit) throw ApiException("The file is too large to preview.", 413)
                    output.write(chunk.data)
                    offset += chunk.data.size
                    onProgress(offset, size)
                    if (chunk.eof) break
                    if (chunk.data.isEmpty()) throw ApiException("The file download was incomplete.", 502)
                }
            }
            if (offset != size) throw ApiException("The file download was incomplete.", 502)
            if (!temporary.renameTo(destination)) temporary.copyTo(destination, overwrite = true)
            return destination
        } finally {
            temporary.delete()
        }
    }

    private fun secureFileUrl(deviceId: String, root: String, path: String): String =
        "$SECURE_FILE_SCHEME?device=${deviceId.urlEncode()}&root=${root.urlEncode()}&path=${path.urlEncode()}"

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
        val namespace = "/api/v2"
        if (base.endsWith(namespace) && downloadUrl.startsWith(namespace)) {
            return base.removeSuffix(namespace) + downloadUrl
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
