package com.agentsanywhere.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf
import coil3.ImageLoader
import coil3.SingletonImageLoader
import coil3.disk.DiskCache
import coil3.memory.MemoryCache
import com.agentsanywhere.app.app.AgentsAnywhereApp
import com.agentsanywhere.app.ui.designsystem.AgentsAnywhereTheme
import java.io.File
import okio.Path.Companion.toOkioPath

class MainActivity : ComponentActivity() {
    private val oauthCallbackUri = mutableStateOf<Uri?>(null)

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
        oauthCallbackUri.value = intent?.data
        setContent {
            AgentsAnywhereTheme {
                AgentsAnywhereApp(
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
}
