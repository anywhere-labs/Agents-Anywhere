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

class AppUpdateViewModel(application: Application) : AndroidViewModel(application) {
    private val api = AppUpdatesApi()
    private val downloadClient = OkHttpClient()
    private var downloadJob: Job? = null
    @Volatile
    private var activeDownloadCall: Call? = null
    @Suppress("DEPRECATION")
    private val currentVersionCode = application.packageManager
        .getPackageInfo(application.packageName, 0)
        .versionCode

    var state by mutableStateOf(AppUpdateUiState())
        private set

    fun checkForUpdate(showPrompt: Boolean) {
        if (state.checking || state.downloading) return
        state = state.copy(checking = true, checkFailed = false)
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    api.check(AppConfig.UPDATE_SERVICE_URL, currentVersionCode)
                }
            }.onSuccess { release ->
                state = state.copy(
                    checking = false,
                    checked = true,
                    release = release,
                    promptVisible = release != null && (showPrompt || state.promptVisible),
                    checkFailed = false,
                    downloadFailed = false,
                )
            }.onFailure {
                state = state.copy(
                    checking = false,
                    checked = true,
                    checkFailed = true,
                )
            }
        }
    }

    fun dismissPrompt() {
        if (!state.downloading) state = state.copy(promptVisible = false)
    }

    fun downloadUpdate() {
        val release = state.release ?: return
        if (state.downloading || state.installFile != null) return
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

    companion object {
        private const val PROGRESS_UPDATE_INTERVAL_NANOS = 100_000_000L
    }
}
