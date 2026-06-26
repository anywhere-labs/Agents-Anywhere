package com.agentsanywhere.app

import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import coil3.ImageLoader
import coil3.SingletonImageLoader
import coil3.disk.DiskCache
import coil3.memory.MemoryCache
import com.agentsanywhere.app.app.AgentsAnywhereApp
import com.agentsanywhere.app.ui.designsystem.AAAppearanceMode
import com.agentsanywhere.app.ui.designsystem.AALanguageMode
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import java.io.File
import java.util.Locale
import okio.Path.Companion.toOkioPath

class MainActivity : ComponentActivity() {
    private val oauthCallbackUri = mutableStateOf<Uri?>(null)
    private var appearanceMode by mutableStateOf(AAAppearanceMode.System)
    private var languageMode by mutableStateOf(AALanguageMode.System)

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
        oauthCallbackUri.value = intent?.data
        setContent {
            AgentsAnywhereTheme(appearanceMode = appearanceMode) {
                AgentsAnywhereApp(
                    appearanceMode = appearanceMode,
                    languageMode = languageMode,
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
                    oauthCallbackUri = oauthCallbackUri.value,
                    onOAuthCallbackConsumed = { oauthCallbackUri.value = null },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        oauthCallbackUri.value = intent.data
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
    }
}
