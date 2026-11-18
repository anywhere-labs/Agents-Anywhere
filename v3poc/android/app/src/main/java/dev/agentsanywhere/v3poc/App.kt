package dev.agentsanywhere.v3poc

import android.app.Application
import android.content.ComponentCallbacks2
import dev.agentsanywhere.v3poc.bridge.RendererBridge
import dev.agentsanywhere.v3poc.bridge.StressMetrics
import dev.agentsanywhere.v3poc.design.GlassSettings
import dev.agentsanywhere.v3poc.model.Fixtures
import dev.agentsanywhere.v3poc.model.MockSessionsClient
import dev.agentsanywhere.v3poc.model.SessionController
import dev.agentsanywhere.v3poc.model.StressConfig

/**
 * Process-wide objects: the one WebView (prewarmed on the first Activity start, kept across Activity recreation and
 * session switches), the mock client and the controller.
 */
class App : Application() {
    lateinit var controller: SessionController
        private set
    lateinit var glass: GlassSettings
        private set
    private var started = false

    override fun onCreate() {
        super.onCreate()
        LaunchClock.mark("Application.onCreate")
        glass = GlassSettings(this)
    }

    /** Called by the first Activity, after the debug extras are read (stress changes the workspace). */
    fun start() {
        if (started) return
        started = true
        val stress = StressConfig.parse(DebugLaunch.stress)
        if (stress != null || DebugLaunch.metrics) StressMetrics.enable()
        val workspace = Fixtures.workspace(this)
        val sessions = if (stress != null) listOf(stress.summary) + workspace.sessions else workspace.sessions
        val client = MockSessionsClient(workspace.copy(sessions = sessions), Fixtures.demo(this), stress)
        val bridge = RendererBridge(this)
        controller = SessionController(this, workspace.account, workspace.devices, workspace.projects, sessions, client, bridge)
        // The renderer starts loading before the first frame is drawn.
        bridge.start()
    }

    @Suppress("DEPRECATION")
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (!started) return
        // Since Android 14 the RUNNING_* levels are no longer delivered; UI_HIDDEN / BACKGROUND still are.
        val pressure = when {
            level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL -> "critical"
            level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW -> "warning"
            else -> null
        }
        if (pressure != null && level != ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN) {
            LaunchClock.log("onTrimMemory($level) → memoryPressure $pressure")
            controller.memoryPressure(pressure)
        }
    }
}
