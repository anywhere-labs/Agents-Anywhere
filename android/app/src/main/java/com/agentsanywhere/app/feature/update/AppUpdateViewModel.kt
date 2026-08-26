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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

data class AppUpdateUiState(
    val checking: Boolean = false,
    val checked: Boolean = false,
    val release: AndroidAppRelease? = null,
    val promptVisible: Boolean = false,
    val downloading: Boolean = false,
    val downloadFailed: Boolean = false,
    val checkFailed: Boolean = false,
    val installFile: File? = null,
)

class AppUpdateViewModel(application: Application) : AndroidViewModel(application) {
    private val api = AppUpdatesApi()
    private val downloadClient = OkHttpClient()
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
        state = state.copy(downloading = true, downloadFailed = false)
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) { downloadRelease(release) }
            }.onSuccess { file ->
                state = state.copy(downloading = false, installFile = file)
            }.onFailure {
                state = state.copy(downloading = false, downloadFailed = true)
            }
        }
    }

    fun markInstallStarted() {
        state = state.copy(promptVisible = false, installFile = null, downloadFailed = false)
    }

    fun reportInstallFailure() {
        state = state.copy(downloading = false, installFile = null, downloadFailed = true)
    }

    private fun downloadRelease(release: AndroidAppRelease): File {
        val updatesDir = File(getApplication<Application>().cacheDir, "app-updates").apply {
            mkdirs()
        }
        val target = File(updatesDir, "agents-anywhere-${release.versionCode}.apk")
        val request = Request.Builder().url(release.downloadUrl).get().build()
        downloadClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) error("Update download failed with status ${response.code}.")
            val body = response.body ?: error("Update download was empty.")
            FileOutputStream(target).use { output -> body.byteStream().use { it.copyTo(output) } }
        }
        return target
    }
}
