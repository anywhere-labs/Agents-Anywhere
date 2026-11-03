package com.agentsanywhere.app.feature.files

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.FilesApi
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class FilesController(
    private val filesApi: FilesApi,
    private val sessionStore: AuthSessionStore,
) {
    private val workspaceCache = ConcurrentHashMap<String, java.io.File>()
    private val workspaceLocks = ConcurrentHashMap<String, Mutex>()

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

    /**
     * Returns an image this process already downloaded for [path], or null.
     * Lets timeline rows show a thumbnail again after scrolling back into view
     * without another Connector round trip.
     */
    fun cachedWorkspaceFile(
        connectorId: String,
        workspaceRoot: String,
        path: String,
    ): java.io.File? {
        val key = workspaceCacheKey(connectorId, workspaceRoot, path)
        val cached = workspaceCache[key] ?: return null
        if (!cached.isFile) {
            workspaceCache.remove(key, cached)
            return null
        }
        cached.setLastModified(System.currentTimeMillis())
        return cached
    }

    /**
     * Downloads [path] into the session image cache. With [preferCache] a file
     * already downloaded for the same path is reused; otherwise it is fetched
     * again so an explicit open shows the current contents. Concurrent calls
     * for the same path share one download.
     */
    suspend fun downloadWorkspaceFile(
        connectorId: String,
        workspaceRoot: String,
        path: String,
        cacheDir: java.io.File,
        preferCache: Boolean = false,
        maxBytes: Long = FilesApi.MAX_DOWNLOAD_BYTES,
    ): Result<DownloadedFile> {
        val normalizedPath = normalizeRemotePath(path)
        val key = workspaceCacheKey(connectorId, workspaceRoot, normalizedPath)
        val lock = workspaceLocks.getOrPut(key) { Mutex() }
        return lock.withLock {
            if (preferCache) {
                cachedWorkspaceFile(connectorId, workspaceRoot, normalizedPath)?.let { cached ->
                    return@withLock Result.success(
                        DownloadedFile(
                            path = normalizedPath,
                            name = fileNameFromRemotePath(normalizedPath),
                            mediaType = "",
                            size = cached.length(),
                            sha256 = "",
                            file = cached,
                        ),
                    )
                }
            }
            downloadWorkspaceFileLocked(connectorId, workspaceRoot, normalizedPath, cacheDir, maxBytes)
                .onSuccess { workspaceCache[key] = it.file }
        }
    }

    private suspend fun downloadWorkspaceFileLocked(
        connectorId: String,
        workspaceRoot: String,
        normalizedPath: String,
        cacheDir: java.io.File,
        maxBytes: Long,
    ): Result<DownloadedFile> {
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
        withContext(Dispatchers.IO) { pruneCache(cacheRoot) }
        val incoming = java.io.File(cacheRoot, ".incoming-${UUID.randomUUID()}.part")
        return downloadFile(
            connectorId = connectorId,
            root = root,
            path = normalizedPath,
            destination = incoming,
            maxBytes = maxBytes,
        ).mapCatching { downloaded ->
            withContext(Dispatchers.IO) {
                try {
                    val key = downloaded.sha256.takeIf { it.isNotBlank() }
                        ?: UUID.randomUUID().toString()
                    val cached = java.io.File(cacheRoot, "${key.take(64)}-$safeName")
                    // The name carries the content hash, so an existing file
                    // already holds these bytes. Never delete it first: another
                    // row may be decoding it right now.
                    if (cached.isFile) {
                        cached.setLastModified(System.currentTimeMillis())
                    } else if (!downloaded.file.renameTo(cached)) {
                        downloaded.file.copyTo(cached, overwrite = true)
                    }
                    downloaded.copy(file = cached)
                } finally {
                    incoming.delete()
                }
            }
        }
    }

    suspend fun downloadFile(
        connectorId: String,
        root: String,
        path: String,
        destination: java.io.File,
        maxBytes: Long = FilesApi.MAX_DOWNLOAD_BYTES,
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
                    maxBytes = maxBytes,
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

    private fun pruneCache(cacheRoot: java.io.File) {
        val entries = cacheRoot.listFiles() ?: return
        val now = System.currentTimeMillis()
        val cutoff = now - 7L * 24 * 60 * 60 * 1000
        // Temporary files belong to downloads that may still be running in
        // another coroutine; only clear the ones left behind by a crash.
        val staleIncomingCutoff = now - 60L * 60 * 1000
        entries.filter { it.isFile }.forEach { file ->
            val stale = if (file.name.endsWith(".part")) {
                file.lastModified() < staleIncomingCutoff
            } else {
                file.lastModified() < cutoff
            }
            if (stale) file.delete()
        }
        val remaining = cacheRoot.listFiles()
            ?.filter { it.isFile && !it.name.endsWith(".part") }
            ?.sortedBy { it.lastModified() }
            ?: return
        if (remaining.size > 64) {
            remaining.take(remaining.size - 64).forEach { it.delete() }
        }
    }

    private fun workspaceCacheKey(connectorId: String, workspaceRoot: String, path: String): String =
        "$connectorId\u0000${normalizeRemotePath(workspaceRoot)}\u0000${normalizeRemotePath(path)}"

    suspend fun createPreviewUrl(connectorId: String, root: String, path: String): Result<String> =
        withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                val token = filesApi.createPreviewToken(auth.serverUrl, auth.accessToken, connectorId, root, path)
                val fileName = path.substringAfterLast('/').substringAfterLast('\\').ifBlank { "preview" }
                val encodedToken = java.net.URLEncoder.encode(token, "UTF-8")
                val encodedName = java.net.URLEncoder.encode(fileName, "UTF-8")
                "${auth.serverUrl.trimEnd('/')}/#/preview?previewToken=$encodedToken&name=$encodedName"
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
