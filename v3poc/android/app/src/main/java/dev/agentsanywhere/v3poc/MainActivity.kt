package dev.agentsanywhere.v3poc

import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import dev.agentsanywhere.v3poc.bridge.StressMetrics
import dev.agentsanywhere.v3poc.ui.Root
import dev.agentsanywhere.v3poc.ui.UiState

class MainActivity : ComponentActivity() {
    private val ui by lazy { UiState() }

    override fun onCreate(savedInstanceState: Bundle?) {
        LaunchClock.mark("MainActivity.onCreate")
        if (savedInstanceState == null) DebugLaunch.read(intent)
        applySystemBars()
        super.onCreate(savedInstanceState)
        val app = application as App
        app.start()
        app.controller.bridge.attach(this)
        StressMetrics.attach(this)
        setContent { Root(app, ui) }
    }

    override fun onResume() {
        super.onResume()
        // Contrast / animation settings may have changed while we were away.
        (application as App).glass.refreshAccessibility()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        (application as App).glass.refreshAccessibility()
        // uiMode and fontScale are handled in place (manifest configChanges): no Activity recreation, same WebView.
        applySystemBars()
    }

    private fun applySystemBars() {
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val style = if (night) SystemBarStyle.dark(Color.TRANSPARENT) else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
        enableEdgeToEdge(style, style)
        if (android.os.Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
    }

    override fun onDestroy() {
        (application as App).controller.bridge.attach(null)
        super.onDestroy()
    }
}
