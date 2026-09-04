package com.agentsanywhere.app.feature.update

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.agentsanywhere.app.api.AndroidAppRelease
import com.agentsanywhere.app.api.AppUpdatesApi
import com.agentsanywhere.app.config.AppConfig
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import java.io.File
import java.io.FileOutputStream
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
    val healthChecking: Boolean = false,
    val backendVersion: String? = null,
    val forcedUpdateRequired: Boolean = false,
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
    val installFile: File? = null,
)

enum class AppUpdateCheckSource {
    Automatic,
    Settings,
    Forced,
}

class AppUpdateViewModel(application: Application) : AndroidViewModel(application) {
    private val api = AppUpdatesApi()
    private val downloadClient = OkHttpClient()
    private val sessionStore = AuthSessionStore(application)
    private val preferenceStore = AppUpdatePreferenceStore(application)
    private var downloadJob: Job? = null
    private var releaseServerOrigin: String? = null
    @Volatile
    private var activeDownloadCall: Call? = null
    @Suppress("DEPRECATION")
    private val packageInfo = application.packageManager.getPackageInfo(application.packageName, 0)
    @Suppress("DEPRECATION")
    private val currentVersionCode = packageInfo.versionCode
    private val currentVersionName = packageInfo.versionName.orEmpty()

    var state by mutableStateOf(AppUpdateUiState())
        private set

    suspend fun checkBackendCompatibility(): Boolean {
        val serverOrigin = currentServerOrigin()
        if (serverOrigin.isBlank()) return !state.forcedUpdateRequired
        state = state.copy(healthChecking = true)
        return try {
            val health = withContext(Dispatchers.IO) { api.health(serverOrigin) }
            val comparison = compareNumericVersions(health.version, currentVersionName)
            if (comparison == null) {
                state = state.copy(
                    healthChecking = false,
                    backendVersion = health.version,
                )
                !state.forcedUpdateRequired
            } else {
                val forcedUpdateRequired = comparison > 0
                val resetRelease = (forcedUpdateRequired || releaseServerOrigin != serverOrigin) &&
                    !state.downloading && !state.preparingInstall
                if (resetRelease) releaseServerOrigin = null
                state = state.copy(
                    healthChecking = false,
                    backendVersion = health.version,
                    forcedUpdateRequired = forcedUpdateRequired,
                    checked = if (forcedUpdateRequired && resetRelease) false else state.checked,
                    release = if (resetRelease) null else state.release,
                    promptVisible = if (resetRelease) false else state.promptVisible,
                    checkFailed = if (forcedUpdateRequired && resetRelease) false else state.checkFailed,
                    downloadFailed = if (resetRelease) false else state.downloadFailed,
                )
                !forcedUpdateRequired
            }
        } catch (error: CancellationException) {
            state = state.copy(healthChecking = false)
            throw error
        } catch (_: Throwable) {
            state = state.copy(healthChecking = false)
            !state.forcedUpdateRequired
        }
    }

    fun checkForUpdate(source: AppUpdateCheckSource) {
        if (state.checking || state.downloading) return
        if (state.forcedUpdateRequired && source != AppUpdateCheckSource.Forced) return
        val serverOrigin = currentServerOrigin()
        if (serverOrigin.isBlank()) {
            state = state.copy(checked = true, checkFailed = true)
            return
        }
        val resetRelease = source == AppUpdateCheckSource.Forced ||
            (releaseServerOrigin != null && releaseServerOrigin != serverOrigin)
        if (resetRelease) releaseServerOrigin = null
        state = state.copy(
            checking = true,
            checked = if (source == AppUpdateCheckSource.Forced) false else state.checked,
            release = if (resetRelease) null else state.release,
            promptVisible = if (resetRelease) false else state.promptVisible,
            checkFailed = false,
            downloadFailed = if (resetRelease) false else state.downloadFailed,
        )
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    api.check(serverOrigin, currentVersionCode)
                }
            }.onSuccess { release ->
                releaseServerOrigin = release?.let { serverOrigin }
                val deferred = release?.let {
                    preferenceStore.isDeferred(serverOrigin, it.versionCode)
                } == true
                val promptVisible = source == AppUpdateCheckSource.Automatic &&
                    release != null && !deferred
                state = state.copy(
                    checking = false,
                    checked = true,
                    release = release,
                    promptVisible = promptVisible,
                    checkFailed = source == AppUpdateCheckSource.Forced && release == null,
                    downloadFailed = false,
                )
            }.onFailure {
                if (source == AppUpdateCheckSource.Forced) releaseServerOrigin = null
                state = state.copy(
                    checking = false,
                    checked = true,
                    release = if (source == AppUpdateCheckSource.Forced) null else state.release,
                    promptVisible = if (source == AppUpdateCheckSource.Forced) false else state.promptVisible,
                    checkFailed = true,
                )
            }
        }
    }

    fun dismissPrompt() {
        if (state.forcedUpdateRequired || state.downloading) return
        val release = state.release
        val serverOrigin = releaseServerOrigin
        if (release != null && serverOrigin != null) {
            preferenceStore.recordDeferred(serverOrigin, release.versionCode)
        }
        state = state.copy(promptVisible = false)
    }

    fun downloadUpdate() {
        val release = state.release ?: return
        if (state.downloading || state.installFile != null) return
        preferenceStore.recordAccepted(
            releaseServerOrigin ?: currentServerOrigin(),
            release.versionCode,
        )
        state = state.copy(
            downloading = true,
            downloadedBytes = 0,
            totalBytes = null,
            preparingInstall = false,
            downloadFailed = false,
        )
        downloadJob = viewModelScope.launch {
            try {
                val file = downloadRelease(release)
                state = state.copy(
                    downloading = false,
                    preparingInstall = true,
                    installFile = file,
                )
            } catch (error: Throwable) {
                val cancelled = error is CancellationException || !currentCoroutineContext().isActive
                state = state.copy(
                    downloading = false,
                    downloadedBytes = 0,
                    totalBytes = null,
                    preparingInstall = false,
                    downloadFailed = !cancelled,
                )
            } finally {
                activeDownloadCall = null
                downloadJob = null
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

    private suspend fun downloadRelease(release: AndroidAppRelease): File = withContext(Dispatchers.IO) {
        val updatesDir = File(getApplication<Application>().cacheDir, "app-updates").apply {
            mkdirs()
        }
        val target = File(updatesDir, "agents-anywhere-${release.versionCode}.apk")
        try {
            val request = Request.Builder().url(release.downloadUrl).get().build()
            val call = downloadClient.newCall(request)
            activeDownloadCall = call
            call.execute().use { response ->
                if (!response.isSuccessful) error("Update download failed with status ${response.code}.")
                val body = response.body ?: error("Update download was empty.")
                val totalBytes = body.contentLength().takeIf { it > 0 }
                publishDownloadProgress(downloadedBytes = 0, totalBytes = totalBytes)
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
                                publishDownloadProgress(downloadedBytes, totalBytes)
                                lastPublishedAt = now
                            }
                        }
                        publishDownloadProgress(downloadedBytes, totalBytes)
                    }
                }
            }
            target
        } catch (error: Throwable) {
            target.delete()
            throw error
        }
    }

    private suspend fun publishDownloadProgress(downloadedBytes: Long, totalBytes: Long?) {
        withContext(Dispatchers.Main.immediate) {
            state = state.copy(downloadedBytes = downloadedBytes, totalBytes = totalBytes)
        }
    }

    private fun currentServerOrigin(): String {
        return sessionStore.readServerUrl()
            .ifBlank { AppConfig.OFFICIAL_WEB_LOGIN_URL }
            .trim()
            .trimEnd('/')
    }

    companion object {
        private const val PROGRESS_UPDATE_INTERVAL_NANOS = 100_000_000L
    }
}

private fun compareNumericVersions(left: String, right: String): Int? {
    val leftParts = left.numericVersionParts() ?: return null
    val rightParts = right.numericVersionParts() ?: return null
    val size = maxOf(leftParts.size, rightParts.size)
    repeat(size) { index ->
        val leftPart = leftParts.getOrElse(index) { 0L }
        val rightPart = rightParts.getOrElse(index) { 0L }
        if (leftPart != rightPart) return leftPart.compareTo(rightPart)
    }
    return 0
}

private fun String.numericVersionParts(): List<Long>? {
    val normalized = trim().removePrefix("v").removePrefix("V")
    if (normalized.isBlank()) return null
    val parts = normalized.split('.')
    if (parts.any { it.isBlank() || it.any { character -> !character.isDigit() } }) return null
    return parts.map { it.toLongOrNull() ?: return null }
}
