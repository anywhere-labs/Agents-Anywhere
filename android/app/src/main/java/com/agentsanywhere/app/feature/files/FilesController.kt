package com.agentsanywhere.app.feature.files

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.FilesApi
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.UUID

class FilesController(
    private val filesApi: FilesApi,
    private val sessionStore: AuthSessionStore,
) {
    suspend fun listFiles(
        connectorId: String,
        root: String,
        path: String = ".",
    ): Result<FilesDirectory> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                val directory = filesApi.listFiles(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                    root = root,
                    path = path,
                )
                FilesDirectory(
                    path = directory.path,
                    entries = directory.entries
                        .filter { it.type == "directory" || it.type == "file" }
                        .map {
                            FileEntry(
                                name = it.name,
                                path = it.path,
                                isDirectory = it.type == "directory",
                                size = it.size,
                            )
                        }
                        .sortedWith(compareBy<FileEntry> { !it.isDirectory }.thenBy { it.name.lowercase() }),
                )
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not load files.", error)
            }
        }
    }

    suspend fun readTextFile(
        connectorId: String,
        root: String,
        path: String,
    ): Result<TextFile> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                val file = filesApi.readTextFile(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                    root = root,
                    path = path,
                )
                TextFile(
                    path = file.path,
                    name = file.name,
                    size = file.size,
                    sha256 = file.sha256,
                    encoding = file.encoding,
                    content = file.content,
                    truncated = file.truncated,
                    binary = file.binary,
                )
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not open file.", error)
            }
        }
    }

    suspend fun downloadWorkspaceFile(
        connectorId: String,
        workspaceRoot: String,
        path: String,
        cacheDir: java.io.File,
    ): Result<DownloadedFile> {
        val normalizedPath = normalizeRemotePath(path)
        val deviceOs = if (windowsDriveRoot(workspaceRoot) != null) "windows" else null
        val root = remoteRootForPath(
            targetPath = normalizedPath,
            deviceOs = deviceOs,
            fallbackRoot = workspaceRoot,
        )
        val safeName = normalizedPath.substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[^A-Za-z0-9._-]"), "_")
            .take(96)
            .ifBlank { "image" }
        val cacheRoot = java.io.File(cacheDir, "session-files").apply { mkdirs() }
        pruneCache(cacheRoot)
        val temporary = java.io.File(cacheRoot, ".incoming-${UUID.randomUUID()}.part")
        return downloadFile(
            connectorId = connectorId,
            root = root,
            path = normalizedPath,
            destination = temporary,
        ).map { downloaded ->
            val key = downloaded.sha256.takeIf { it.isNotBlank() }
                ?: downloaded.file.nameWithoutExtension
            val cached = java.io.File(cacheRoot, "${key.take(64)}-$safeName")
            if (downloaded.file != cached) {
                if (cached.exists()) cached.delete()
                if (!downloaded.file.renameTo(cached)) {
                    downloaded.file.copyTo(cached, overwrite = true)
                    downloaded.file.delete()
                }
            }
            downloaded.copy(file = cached)
        }
    }

    suspend fun downloadFile(
        connectorId: String,
        root: String,
        path: String,
        destination: java.io.File,
    ): Result<DownloadedFile> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                val transfer = filesApi.prepareFile(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                    root = root,
                    path = path,
                )
                val file = filesApi.downloadFile(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    transfer = transfer,
                    destination = destination,
                )
                DownloadedFile(
                    path = transfer.path,
                    name = transfer.name,
                    mediaType = transfer.mediaType,
                    size = transfer.size,
                    sha256 = transfer.sha256,
                    file = file,
                )
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not download file.", error)
            }
        }
    }

    fun isWithinWorkspace(workspaceRoot: String, path: String): Boolean {
        val root = normalizeRemotePath(workspaceRoot).trimEnd('/')
        val target = normalizeRemotePath(path)
        if (root.isBlank()) return false
        if (root == "/") return target.startsWith("/")
        return target.equals(root, ignoreCase = true) ||
            target.startsWith("$root/", ignoreCase = true)
    }

    private fun pruneCache(cacheRoot: java.io.File) {
        val entries = cacheRoot.listFiles() ?: return
        val cutoff = System.currentTimeMillis() - 7L * 24 * 60 * 60 * 1000
        entries.filter { it.isFile }.forEach { file ->
            if (file.name.endsWith(".part") || file.lastModified() < cutoff) {
                file.delete()
            }
        }
        val remaining = cacheRoot.listFiles()?.filter { it.isFile }?.sortedBy { it.lastModified() }
            ?: return
        if (remaining.size > 64) {
            remaining.take(remaining.size - 64).forEach { it.delete() }
        }
    }

    private fun authSession(): ApiAuth {
        val serverUrl = sessionStore.readServerUrl()
        val accessToken = sessionStore.readAccessToken()
        if (serverUrl.isBlank() || accessToken.isBlank()) {
            throw IllegalStateException("Sign in again to browse files.")
        }
        return ApiAuth(serverUrl = serverUrl, accessToken = accessToken)
    }

    private data class ApiAuth(
        val serverUrl: String,
        val accessToken: String,
    )
}
