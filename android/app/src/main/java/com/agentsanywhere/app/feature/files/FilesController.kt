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
    private companion object {
        /** The Server keeps a prepared transfer for five minutes; leave a margin. */
        const val TRANSFER_REUSE_MILLIS = 4L * 60 * 1000
    }

    private val workspaceCache = ConcurrentHashMap<String, java.io.File>()
    private val workspaceLocks = ConcurrentHashMap<String, Mutex>()
    private val previewLocks = ConcurrentHashMap<String, Mutex>()
    private val consumedTransfers = ConcurrentHashMap.newKeySet<String>()

    /**
     * Asks the Connector for the file's current name, size, type and hash.
     * The Server prepares a transfer that [downloadRemoteFile] can use once.
     */
    suspend fun prepareRemoteFile(target: FilePreviewTarget): Result<RemoteFileInfo> {
        return withContext(Dispatchers.IO) {
            runCatching { prepareRemoteFileBlocking(target) }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not open file.", error)
            }
        }
    }

    /** The local copy of exactly this version of the file, if it was downloaded before. */
    fun cachedRemoteFile(info: RemoteFileInfo, cacheDir: java.io.File): java.io.File? {
        if (info.sha256.isBlank()) return null
        val directory = filePreviewCacheDirectory(cacheDir, info.target.connectorId, info.path, info.sha256)
        val file = java.io.File(directory, localFileName(info.name))
        if (!file.isFile || file.length() != info.size) return null
        directory.setLastModified(System.currentTimeMillis())
        return file
    }

    /**
     * Downloads [info] into the preview cache under the original file name,
     * reusing an earlier copy with the same hash. A transfer that is already
     * used or close to expiring is prepared again first, which also picks up
     * a file the agent rewrote in the meantime.
     */
    suspend fun downloadRemoteFile(
        info: RemoteFileInfo,
        cacheDir: java.io.File,
        onProgress: (downloadedBytes: Long, totalBytes: Long) -> Unit = { _, _ -> },
    ): Result<LocalRemoteFile> {
        val lock = previewLocks.getOrPut(
            "${info.target.connectorId}\u0000${normalizeRemotePath(info.target.path)}",
        ) { Mutex() }
        return lock.withLock {
            withContext(Dispatchers.IO) {
                runCatching {
                    var current = info
                    cachedRemoteFile(current, cacheDir)?.let { return@runCatching LocalRemoteFile(current, it) }
                    val expired = System.currentTimeMillis() - current.preparedAtMillis > TRANSFER_REUSE_MILLIS
                    if (expired || !consumedTransfers.add(current.transfer.transferId)) {
                        current = prepareRemoteFileBlocking(current.target)
                        cachedRemoteFile(current, cacheDir)?.let { return@runCatching LocalRemoteFile(current, it) }
                        consumedTransfers.add(current.transfer.transferId)
                    }
                    val directory = filePreviewCacheDirectory(
                        cacheDir = cacheDir,
                        connectorId = current.target.connectorId,
                        path = current.path,
                        sha256 = current.sha256.ifBlank { UUID.randomUUID().toString() },
                    )
                    check(directory.isDirectory || directory.mkdirs()) { "Could not create the download folder." }
                    val auth = authSession()
                    val file = filesApi.downloadFile(
                        serverUrl = auth.serverUrl,
                        authorizationToken = auth.accessToken,
                        transfer = current.transfer,
                        destination = java.io.File(directory, localFileName(current.name)),
                        maxBytes = FilesApi.MAX_SAVE_BYTES,
                        onProgress = onProgress,
                    )
                    directory.setLastModified(System.currentTimeMillis())
                    pruneFilePreviewCache(cacheDir, keep = directory)
                    LocalRemoteFile(current, file)
                }.recoverCatching { error ->
                    if (error is ApiException) throw error
                    throw IllegalStateException(error.message ?: "Could not download file.", error)
                }
            }
        }
    }

    private fun prepareRemoteFileBlocking(target: FilePreviewTarget): RemoteFileInfo {
        val auth = authSession()
        val transfer = filesApi.prepareFile(
            serverUrl = auth.serverUrl,
            authorizationToken = auth.accessToken,
            deviceId = target.connectorId,
            root = target.root,
            path = target.path,
        )
        val name = transfer.name.takeIf { it.isNotBlank() && it != "download" }
            ?: fileNameFromRemotePath(transfer.path.ifBlank { target.path })
        return RemoteFileInfo(
            target = target,
            path = transfer.path.ifBlank { target.path },
            name = name,
            size = transfer.size,
            mediaType = transfer.mediaType,
            sha256 = transfer.sha256,
            transfer = transfer,
            preparedAtMillis = System.currentTimeMillis(),
        )
    }

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

/** Largest file the preview page downloads to show, save or share. */
const val MAX_REMOTE_FILE_DOWNLOAD_BYTES = FilesApi.MAX_SAVE_BYTES

/** Maps a failure from [FilesController] to the case the preview page explains. */
fun remoteFileFailure(error: Throwable): RemoteFileFailure {
    val text = error.message.orEmpty()
    val status = (error as? ApiException)?.statusCode
    return when {
        status == 413 -> RemoteFileFailure.TooLarge
        text.contains("not found", ignoreCase = true) && !text.contains("transfer", ignoreCase = true) ->
            RemoteFileFailure.NotFound
        text.contains("no such file", ignoreCase = true) -> RemoteFileFailure.NotFound
        status == 409 || text.contains("offline", ignoreCase = true) -> RemoteFileFailure.DeviceOffline
        else -> RemoteFileFailure.Other(text.takeIf { it.isNotBlank() })
    }
}
