package dev.agentsanywhere.v3

import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import dev.agentsanywhere.v3.ui.Root

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        applySystemBars()
        super.onCreate(savedInstanceState)
        val app = application as App
        app.bridge.attach(this)
        // The WebView is created once the window exists (the render bundle starts loading before the first conversation).
        window.decorView.post { app.bridge.start() }
        setContent { Root(app) }
    }

    override fun onResume() {
        super.onResume()
        (application as App).glass.refreshAccessibility()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        (application as App).glass.refreshAccessibility()
        applySystemBars()
        // The window re-applies its theme's bar appearance after this callback while handling uiMode: apply again.
        window.decorView.post { applySystemBars() }
    }

    private fun applySystemBars() {
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val style = if (night) SystemBarStyle.dark(Color.TRANSPARENT) else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
        enableEdgeToEdge(style, style)
        androidx.core.view.WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !night
            isAppearanceLightNavigationBars = !night
        }
        window.isNavigationBarContrastEnforced = false
    }

    override fun onDestroy() {
        (application as App).bridge.attach(null)
        super.onDestroy()
    }
}
