package dev.agentsanywhere.v3poc

import android.app.Application
import android.content.ComponentCallbacks2
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.agentsanywhere.v3poc.bridge.RendererBridge
import dev.agentsanywhere.v3poc.bridge.StressMetrics
import dev.agentsanywhere.v3poc.design.GlassSettings
import dev.agentsanywhere.v3poc.model.DevContentProfile
import dev.agentsanywhere.v3poc.model.Fixtures
import dev.agentsanywhere.v3poc.model.MockSessionsClient
import dev.agentsanywhere.v3poc.model.NativeAccount
import dev.agentsanywhere.v3poc.model.OnlineWorkspace
import dev.agentsanywhere.v3poc.model.SessionsClient
import dev.agentsanywhere.v3poc.model.Workspace
import dev.agentsanywhere.v3poc.model.SessionController
import dev.agentsanywhere.v3poc.model.StressConfig

/**
 * Process-wide objects: the one WebView (prewarmed on the first Activity start, kept across Activity recreation and
 * session switches), the mock client and the controller.
 */
class App : Application() {
    internal var activeController by mutableStateOf<SessionController?>(null)
        private set
    val controller: SessionController get() = checkNotNull(activeController)
    internal val account by lazy { NativeAccount(this) }
    internal var online: OnlineWorkspace? = null
        private set
    lateinit var glass: GlassSettings
        private set
    private var started = false
    internal var resumeWorkspace = true
    internal var revokedDevice: Workspace.Device? = null

    override fun onCreate() {
        super.onCreate()
        LaunchClock.mark("Application.onCreate")
        glass = GlassSettings(this)
    }

    /** Called by the first Activity, after the debug extras are read (stress changes the workspace). */
    fun start(demo: Boolean) {
        if (started) return
        started = true
        val profile = if (BuildConfig.DEBUG) DevContentProfile.read(this) else null
        if (profile == null && !demo) return
        val stress = if (profile == null) StressConfig.parse(DebugLaunch.stress) else null
        if (stress != null || DebugLaunch.metrics) StressMetrics.enable()
        val workspace = profile?.workspace ?: Fixtures.workspace(this)
        val sessions = if (stress != null) listOf(stress.summary) + workspace.sessions else workspace.sessions
        val client = profile?.sessionsClient(this) ?: MockSessionsClient(workspace.copy(sessions = sessions), Fixtures.demo(this), stress)
        show(workspace.copy(sessions = sessions), client)
    }

    internal fun open(connection: OnlineWorkspace) {
        online = connection
        show(connection.workspace, connection.client)
    }

    internal suspend fun closeWorkspace(signOut: Boolean) {
        val connection = online
        val controller = activeController
        controller?.close()
        connection?.close?.invoke()
        if (signOut) account.signOut()
        online = null
        activeController = null
    }

    private fun show(workspace: Workspace, client: SessionsClient) {
        val bridge = RendererBridge(this)
        activeController = SessionController(this, workspace.account, workspace.devices, workspace.projects, workspace.sessions, client, bridge)
        // The renderer starts loading before the first frame is drawn.
        bridge.start()
    }

    @Suppress("DEPRECATION")
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        val controller = activeController ?: return
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
