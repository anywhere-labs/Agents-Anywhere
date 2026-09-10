package com.agentsanywhere.app.feature.update

import android.app.Application
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.agentsanywhere.app.api.AndroidAppRelease
import com.agentsanywhere.app.api.AppUpdatesApi
import com.agentsanywhere.app.api.compareUpdateVersions
import com.agentsanywhere.app.BuildConfig
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request

data class AppUpdateUiState(
    val checking: Boolean = false,
    val checked: Boolean = false,
    val release: AndroidAppRelease? = null,
    val promptVisible: Boolean = false,
    val downloading: Boolean = false,
    val downloadedBytes: Long = 0,
    val totalBytes: Long? = null,
    val preparingInstall: Boolean = false,
    val downloadFailed: Boolean = false,
    val checkFailed: Boolean = false,
    val ignoring: Boolean = false,
    val ignoreFailed: Boolean = false,
    val downloadUnavailable: Boolean = false,
    val installFile: File? = null,
)

class AppUpdateViewModel(application: Application) : AndroidViewModel(application) {
    private val api = AppUpdatesApi()
    private val downloadClient = OkHttpClient()
    private var downloadJob: Job? = null
    private var checkJob: Job? = null
    private var checkGeneration = 0
    private var currentUpdateServer = ""
    private var sessionActive = false
    private val authSessionStore = AuthSessionStore(application)
    @Volatile
    private var activeDownloadCall: Call? = null
    private val updatePreferences = application.getSharedPreferences("app-updates", Context.MODE_PRIVATE)
    private val ignoredVersionKey: String get() = "ignored:$currentUpdateServer"

    var state by mutableStateOf(AppUpdateUiState())
        private set

    fun checkForUpdate(showPrompt: Boolean, forcePrompt: Boolean = false) {
        val serverUrl = authenticatedServer()
        if (serverUrl == null) {
            resetSession()
            return
        }
        if (state.downloading || state.preparingInstall || state.ignoring) return
        if (state.checking && serverUrl == currentUpdateServer) return
        checkJob?.cancel()
        val generation = ++checkGeneration
        if (serverUrl != currentUpdateServer) state = AppUpdateUiState()
        currentUpdateServer = serverUrl
        state = state.copy(checking = true, checkFailed = false)
        checkJob = viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    api.check(serverUrl, BuildConfig.VERSION_NAME)
                }
            }.onSuccess { release ->
                if (!isCurrentSession(serverUrl, generation)) return@onSuccess
                val ignored = release != null && updatePreferences.getString(ignoredVersionKey, null)
                    ?.let { compareUpdateVersions(it, release.versionName) == 0 } == true
                state = state.copy(
                    checking = false,
                    checked = true,
                    release = release,
                    promptVisible = release != null && (state.promptVisible || (showPrompt && (!ignored || forcePrompt))),
                    checkFailed = false,
                    downloadFailed = false,
                    ignoreFailed = false,
                    downloadUnavailable = false,
                )
            }.onFailure {
                if (!isCurrentSession(serverUrl, generation) || it is CancellationException) return@onFailure
                state = state.copy(
                    checking = false,
                    checked = true,
                    checkFailed = true,
                )
            }
        }
    }

    fun syncSession(allowed: Boolean) {
        sessionActive = allowed
        val serverUrl = authenticatedServer()
        if (serverUrl == null) {
            resetSession()
        } else if (serverUrl != currentUpdateServer) {
            resetSession()
            sessionActive = true
            checkForUpdate(showPrompt = true)
        }
    }

    private fun authenticatedServer(): String? {
        if (!sessionActive || !authSessionStore.hasAuthSession()) return null
        return authSessionStore.readServerUrl().takeIf(String::isNotBlank)
    }

    private fun isCurrentSession(serverUrl: String, generation: Int): Boolean {
        return generation == checkGeneration && serverUrl == currentUpdateServer && authenticatedServer() == serverUrl
    }

    private fun resetSession() {
        ++checkGeneration
        sessionActive = false
        currentUpdateServer = ""
        checkJob?.cancel()
        checkJob = null
        cancelDownload()
        downloadJob = null
        activeDownloadCall = null
        state = AppUpdateUiState()
    }

    fun showUpdatePrompt() {
        if (authenticatedServer() != currentUpdateServer || currentUpdateServer.isBlank()) {
            checkForUpdate(showPrompt = true, forcePrompt = true)
            return
        }
        if (state.release != null) state = state.copy(promptVisible = true)
        else checkForUpdate(showPrompt = true, forcePrompt = true)
    }

    fun ignoreVersion() {
        val serverUrl = authenticatedServer() ?: return
        val generation = checkGeneration
        val release = state.release ?: return
        if (serverUrl != currentUpdateServer) return
        if (state.downloading || state.preparingInstall || state.ignoring) return
        val preferenceKey = ignoredVersionKey
        state = state.copy(ignoring = true, ignoreFailed = false)
        viewModelScope.launch {
            val saved = withContext(Dispatchers.IO) {
                runCatching { updatePreferences.edit().putString(preferenceKey, release.versionName).commit() }.getOrDefault(false)
            }
            if (!isCurrentSession(serverUrl, generation)) return@launch
            val sameVersion = preferenceKey == ignoredVersionKey && state.release?.versionName == release.versionName
            state = state.copy(
                ignoring = false,
                ignoreFailed = !saved && sameVersion,
                promptVisible = if (saved && sameVersion) false else state.promptVisible,
            )
        }
    }

    fun downloadUpdate() {
        val serverUrl = authenticatedServer() ?: return
        val generation = checkGeneration
        val release = state.release ?: return
        if (serverUrl != currentUpdateServer) return
        if (state.downloading || state.installFile != null || state.ignoring) return
        val downloadConfigured = runCatching {
            val url = java.net.URI(release.downloadUrl)
            url.scheme == "https" && url.userInfo == null && url.host?.endsWith(".invalid") == false
        }.getOrDefault(false)
        if (!downloadConfigured) {
            state = state.copy(downloadUnavailable = true, promptVisible = true)
            return
        }
        state = state.copy(
            downloading = true,
            downloadedBytes = 0,
            totalBytes = null,
            preparingInstall = false,
            downloadFailed = false,
            downloadUnavailable = false,
        )
        downloadJob = viewModelScope.launch {
            try {
                val file = downloadRelease(release, serverUrl, generation)
                if (!isCurrentSession(serverUrl, generation)) {
                    file.delete()
                    return@launch
                }
                state = state.copy(
                    downloading = false,
                    preparingInstall = true,
                    installFile = file,
                )
            } catch (error: Throwable) {
                if (!isCurrentSession(serverUrl, generation)) return@launch
                val cancelled = error is CancellationException || !currentCoroutineContext().isActive
                state = state.copy(
                    downloading = false,
                    downloadedBytes = 0,
                    totalBytes = null,
                    preparingInstall = false,
                    downloadFailed = !cancelled,
                )
            } finally {
                if (generation == checkGeneration) {
                    activeDownloadCall = null
                    downloadJob = null
                }
            }
        }
    }

    fun cancelDownload() {
        activeDownloadCall?.cancel()
        downloadJob?.cancel()
    }

    fun markInstallStarted() {
        state = state.copy(
            promptVisible = false,
            installFile = null,
            preparingInstall = false,
            downloadFailed = false,
        )
    }

    fun reportInstallFailure() {
        state = state.copy(
            downloading = false,
            installFile = null,
            preparingInstall = false,
            downloadFailed = true,
        )
    }

    private suspend fun downloadRelease(release: AndroidAppRelease, serverUrl: String, generation: Int): File = withContext(Dispatchers.IO) {
        val updatesDir = File(getApplication<Application>().cacheDir, "app-updates").apply {
            mkdirs()
        }
        val target = File(updatesDir, "agents-anywhere-${release.versionName}-${UUID.randomUUID()}.apk")
        try {
            val request = Request.Builder().url(release.downloadUrl).get().build()
            val call = downloadClient.newCall(request)
            withContext(Dispatchers.Main.immediate) {
                if (!isCurrentSession(serverUrl, generation)) throw CancellationException("Update session ended")
                activeDownloadCall = call
            }
            call.execute().use { response ->
                if (!response.isSuccessful) error("Update download failed with status ${response.code}.")
                if (!response.request.url.isHttps) error("The APK download must use HTTPS.")
                val body = response.body ?: error("Update download was empty.")
                val contentType = body.contentType()?.toString().orEmpty()
                if (contentType.startsWith("text/") || contentType.contains("json") || contentType.contains("xml")) {
                    error("The download address returned a page instead of an APK.")
                }
                val totalBytes = body.contentLength().takeIf { it > 0 }
                publishDownloadProgress(serverUrl, generation, downloadedBytes = 0, totalBytes = totalBytes)
                FileOutputStream(target).use { output ->
                    body.byteStream().use { input ->
                        val buffer = ByteArray(64 * 1024)
                        var downloadedBytes = 0L
                        var lastPublishedAt = 0L
                        while (true) {
                            currentCoroutineContext().ensureActive()
                            val count = input.read(buffer)
                            if (count < 0) break
                            output.write(buffer, 0, count)
                            downloadedBytes += count
                            val now = System.nanoTime()
                            if (now - lastPublishedAt >= PROGRESS_UPDATE_INTERVAL_NANOS) {
                                publishDownloadProgress(serverUrl, generation, downloadedBytes, totalBytes)
                                lastPublishedAt = now
                            }
                        }
                        if (downloadedBytes == 0L || (totalBytes != null && downloadedBytes != totalBytes)) error("Update download is incomplete.")
                        publishDownloadProgress(serverUrl, generation, downloadedBytes, totalBytes)
                    }
                }
            }
            target
        } catch (error: Throwable) {
            target.delete()
            throw error
        }
    }

    private suspend fun publishDownloadProgress(serverUrl: String, generation: Int, downloadedBytes: Long, totalBytes: Long?) {
        withContext(Dispatchers.Main.immediate) {
            if (isCurrentSession(serverUrl, generation)) {
                state = state.copy(downloadedBytes = downloadedBytes, totalBytes = totalBytes)
            }
        }
    }

    companion object {
        private const val PROGRESS_UPDATE_INTERVAL_NANOS = 100_000_000L
    }

    override fun onCleared() {
        cancelDownload()
        super.onCleared()
    }
}
