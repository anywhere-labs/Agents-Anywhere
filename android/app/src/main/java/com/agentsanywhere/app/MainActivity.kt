package com.agentsanywhere.app

import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import coil3.ImageLoader
import coil3.SingletonImageLoader
import coil3.disk.DiskCache
import coil3.memory.MemoryCache
import com.agentsanywhere.app.app.AgentsAnywhereApp
import com.agentsanywhere.app.feature.auth.WebLoginViewModel
import com.agentsanywhere.app.feature.update.AppUpdateCheckSource
import com.agentsanywhere.app.feature.update.AppUpdateInstaller
import com.agentsanywhere.app.feature.update.AppUpdateViewModel
import com.agentsanywhere.app.ui.designsystem.AAAppearanceMode
import com.agentsanywhere.app.ui.designsystem.AALanguageMode
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import com.agentsanywhere.app.ui.screens.home.HomeSidebarViewMode
import java.io.File
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okio.Path.Companion.toOkioPath

class MainActivity : ComponentActivity() {
    private val oauthCallbackUri = mutableStateOf<Uri?>(null)
    private val webLoginViewModel by viewModels<WebLoginViewModel>()
    private val appUpdateViewModel by viewModels<AppUpdateViewModel>()
    private var appearanceMode by mutableStateOf(AAAppearanceMode.System)
    private var languageMode by mutableStateOf(AALanguageMode.System)
    private var sidebarViewMode by mutableStateOf(HomeSidebarViewMode.Project)
    private var pendingUpdateApk: File? = null
    private var installingUpdate = false

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
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                val compatible = appUpdateViewModel.checkBackendCompatibility()
                if (compatible) {
                    delay(AUTOMATIC_UPDATE_CHECK_DELAY_MILLIS)
                    appUpdateViewModel.checkForUpdate(AppUpdateCheckSource.Automatic)
                }
            }
        }
        setContent {
            AgentsAnywhereTheme(appearanceMode = appearanceMode) {
                AgentsAnywhereApp(
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
                    onInstallUpdate = ::requestUpdateInstall,
                )
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
        val pending = pendingUpdateApk ?: return
        if (packageManager.canRequestPackageInstalls()) {
            requestUpdateInstall(pending)
        } else {
            pendingUpdateApk = null
            appUpdateViewModel.reportInstallFailure()
        }
    }

    private fun requestUpdateInstall(apk: File) {
        if (installingUpdate) return
        if (!apk.isFile) {
            appUpdateViewModel.reportInstallFailure()
            return
        }
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
        installingUpdate = true
        lifecycleScope.launch {
            runCatching {
                withContext(Dispatchers.IO) { AppUpdateInstaller.install(this@MainActivity, apk) }
            }.onSuccess {
                appUpdateViewModel.markInstallStarted()
            }.onFailure {
                appUpdateViewModel.reportInstallFailure()
            }
            installingUpdate = false
        }
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
        private const val AUTOMATIC_UPDATE_CHECK_DELAY_MILLIS = 60_000L
    }
}
