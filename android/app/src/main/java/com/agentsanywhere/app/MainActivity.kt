package com.agentsanywhere.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.lifecycleScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import coil3.ImageLoader
import coil3.SingletonImageLoader
import coil3.disk.DiskCache
import coil3.memory.MemoryCache
import com.agentsanywhere.app.app.AgentsAnywhereApp
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import com.agentsanywhere.app.feature.auth.WebLoginViewModel
import com.agentsanywhere.app.feature.update.AppUpdateCheckSource
import com.agentsanywhere.app.feature.update.AppUpdateInstaller
import com.agentsanywhere.app.feature.update.AppUpdateViewModel
import com.agentsanywhere.app.feature.update.effectiveUpdateServerOrigin
import com.agentsanywhere.app.ui.designsystem.AAAppearanceMode
import com.agentsanywhere.app.ui.designsystem.AALanguageMode
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.home.HomeSidebarViewMode
import com.agentsanywhere.app.ui.screens.update.AppUpdatePromptDialog
import java.io.File
import java.util.Locale
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import okio.Path.Companion.toOkioPath

class MainActivity : ComponentActivity() {
    private val oauthCallbackUri = mutableStateOf<Uri?>(null)
    private val webLoginViewModel by viewModels<WebLoginViewModel>()
    private val appUpdateViewModel by viewModels<AppUpdateViewModel>()
    private val authSessionStore by lazy { AuthSessionStore(this) }
    private var appearanceMode by mutableStateOf(AAAppearanceMode.System)
    private var languageMode by mutableStateOf(AALanguageMode.System)
    private var sidebarViewMode by mutableStateOf(HomeSidebarViewMode.Project)
    private var pendingUpdateApk: File? = null
    private var installResultReceiverRegistered = false
    private val installResultReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == AppUpdateInstaller.ACTION_INSTALL_RESULT) {
                appUpdateViewModel.refreshInstallResult()
            }
        }
    }

    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(newBase.withSavedLanguage())
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SingletonImageLoader.setSafe { context ->
            ImageLoader.Builder(context)
                .memoryCache {
                    MemoryCache.Builder()
                        .maxSizePercent(context, 0.25)
                        .build()
                }
                .diskCache {
                    DiskCache.Builder()
                        .directory(File(context.cacheDir, "attachment-images").toOkioPath())
                        .maxSizeBytes(100L * 1024L * 1024L)
                        .build()
                }
                .build()
        }
        val preferences = getSharedPreferences(UI_PREFERENCES_NAME, MODE_PRIVATE)
        appearanceMode = preferences.getString(KEY_APPEARANCE_MODE, AAAppearanceMode.System)
            ?: AAAppearanceMode.System
        languageMode = preferences.getString(KEY_LANGUAGE_MODE, AALanguageMode.System)
            ?: AALanguageMode.System
        sidebarViewMode = HomeSidebarViewMode.normalize(
            preferences.getString(KEY_SIDEBAR_VIEW_MODE, HomeSidebarViewMode.Project),
        )
        oauthCallbackUri.value = intent?.data
        registerInstallResultReceiver()
        lifecycleScope.launch {
            var updatePipelineJob: Job? = null
            authSessionStore.observeServerUrl()
                .map(::effectiveUpdateServerOrigin)
                .distinctUntilChanged()
                .collect { serverUrl ->
                    updatePipelineJob?.cancel()
                    updatePipelineJob = launch(start = CoroutineStart.UNDISPATCHED) {
                        appUpdateViewModel.runForegroundUpdatePipeline(serverUrl)
                    }
                }
        }
        setContent {
            AgentsAnywhereTheme(appearanceMode = appearanceMode) {
                val updateState = appUpdateViewModel.state
                when {
                    !updateState.initialHealthResolved -> AppUpdateGateBackdrop(showProgress = true)
                    updateState.forcedUpdateRequired -> AppUpdateGateBackdrop(showProgress = false)
                    else -> AgentsAnywhereApp(
                        appearanceMode = appearanceMode,
                        languageMode = languageMode,
                        sidebarViewMode = sidebarViewMode,
                        onAppearanceModeChange = { mode ->
                            appearanceMode = mode
                            preferences.edit().putString(KEY_APPEARANCE_MODE, mode).apply()
                        },
                        onLanguageModeChange = { mode ->
                            preferences.edit().putString(KEY_LANGUAGE_MODE, mode).apply()
                            if (mode != languageMode) {
                                languageMode = mode
                                recreate()
                            }
                        },
                        onSidebarViewModeChange = { mode ->
                            sidebarViewMode = HomeSidebarViewMode.normalize(mode)
                            preferences.edit().putString(KEY_SIDEBAR_VIEW_MODE, sidebarViewMode).apply()
                        },
                        oauthCallbackUri = oauthCallbackUri.value,
                        onOAuthCallbackConsumed = { oauthCallbackUri.value = null },
                        webLoginViewModel = webLoginViewModel,
                        appUpdateViewModel = appUpdateViewModel,
                    )
                }
                if (updateState.initialHealthResolved) {
                    AppUpdatePromptDialog(
                        state = updateState,
                        onCheckForUpdate = {
                            appUpdateViewModel.checkForUpdate(AppUpdateCheckSource.Forced)
                        },
                        onUpdate = appUpdateViewModel::downloadUpdate,
                        onLater = appUpdateViewModel::dismissPrompt,
                        onCancelDownload = appUpdateViewModel::cancelDownload,
                    )
                }
                LaunchedEffect(
                    updateState.installRequestId,
                    updateState.installFile,
                    updateState.preparingInstall,
                ) {
                    val installFile = updateState.installFile
                    if (updateState.preparingInstall && installFile != null) {
                        requestUpdateInstall(installFile)
                    }
                }
            }
        }
    }

    override fun onDestroy() {
        if (installResultReceiverRegistered) {
            unregisterReceiver(installResultReceiver)
            installResultReceiverRegistered = false
        }
        super.onDestroy()
    }

    private fun registerInstallResultReceiver() {
        val filter = IntentFilter(AppUpdateInstaller.ACTION_INSTALL_RESULT)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(installResultReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(installResultReceiver, filter)
        }
        installResultReceiverRegistered = true
    }

    @Composable
    private fun AppUpdateGateBackdrop(showProgress: Boolean) {
        val colors = LocalAAColors.current
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(colors.canvas),
            contentAlignment = Alignment.Center,
        ) {
            if (showProgress) {
                CircularProgressIndicator(color = colors.ink)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        oauthCallbackUri.value = intent.data
    }

    override fun onResume() {
        super.onResume()
        appUpdateViewModel.refreshInstallResult()
        val pending = pendingUpdateApk ?: return
        if (!appUpdateViewModel.canInstallFile(pending)) {
            pendingUpdateApk = null
            return
        }
        if (packageManager.canRequestPackageInstalls()) {
            requestUpdateInstall(pending)
        } else {
            pendingUpdateApk = null
            appUpdateViewModel.reportInstallFailure(
                message = "Permission to install this update was not granted.",
                file = pending,
                installRequestId = appUpdateViewModel.state.installRequestId,
            )
        }
    }

    private fun requestUpdateInstall(apk: File) {
        val installRequestId = appUpdateViewModel.state.installRequestId
        if (!apk.isFile) {
            appUpdateViewModel.reportInstallFailure(
                file = apk,
                installRequestId = installRequestId,
            )
            return
        }
        if (!appUpdateViewModel.canInstallFile(apk)) return
        if (!packageManager.canRequestPackageInstalls()) {
            pendingUpdateApk = apk
            startActivity(
                Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:$packageName"),
                ),
            )
            return
        }
        pendingUpdateApk = null
        appUpdateViewModel.startInstall(apk, installRequestId)
    }

    private fun Context.withSavedLanguage(): Context {
        val languageMode = getSharedPreferences(UI_PREFERENCES_NAME, Context.MODE_PRIVATE)
            .getString(KEY_LANGUAGE_MODE, AALanguageMode.System)
            ?: AALanguageMode.System
        val languageTag = when (languageMode) {
            AALanguageMode.English -> "en"
            AALanguageMode.SimplifiedChinese -> "zh-CN"
            else -> return this
        }
        val config = Configuration(resources.configuration)
        config.setLocale(Locale.forLanguageTag(languageTag))
        return createConfigurationContext(config)
    }

    companion object {
        private const val UI_PREFERENCES_NAME = "agents_anywhere_ui"
        private const val KEY_APPEARANCE_MODE = "appearance_mode"
        private const val KEY_LANGUAGE_MODE = "language_mode"
        private const val KEY_SIDEBAR_VIEW_MODE = "sidebar_view_mode"
    }
}
