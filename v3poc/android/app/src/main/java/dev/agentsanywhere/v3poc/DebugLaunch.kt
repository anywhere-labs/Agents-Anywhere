package dev.agentsanywhere.v3poc

import android.content.Intent
import android.os.Process
import android.os.SystemClock
import android.util.Log

/**
 * Debug switches for screenshots, passed as intent extras (adb has no tap tooling we rely on):
 *   adb shell am start -S -n dev.agentsanywhere.v3poc/.MainActivity --ez drawer true --es sheet options \
 *       --es session s-unread --ei auto_approve_seconds 8 --ez focus true
 * Read once, from the launching intent.
 */
object DebugLaunch {
    var drawerOpen = false; private set
    var sheet: String? = null; private set
    var session: String? = null; private set
    var autoApproveSeconds: Double? = null; private set
    var focus = false; private set
    var stress: String? = null; private set
    var metrics = false; private set
    /** `s-meshcall@5,s-unread@8`: select these sessions n seconds after launch. */
    var switches: List<Pair<String, Double>> = emptyList(); private set
    /** Scroll the thread up by n dp about 3 s after `ready` (shows the 到底部 pill). */
    var scrollUp: Int? = null; private set
    /** `backdrop` (default) | `tint`: how glass is drawn (see v3poc/design/README.md). */
    var glass: String? = null; private set
    /** `on` | `off`: overrides the 「面板和菜单的玻璃」 setting for this launch. */
    var sheetGlass: String? = null; private set
    /** Crash the renderer process n seconds after `ready` (`chrome://crash`), to check recovery. */
    var crashRendererAt: Int? = null; private set
    /** `window`: show the window-level blur evaluation windows over the thread (see WindowGlassSpike). */
    var webGlass: String = "off"; private set
    /** Open the 「打开文件」 sheet after launch (screenshots of the open sheet). */
    var openSheet = false; private set
    /** Items the session cache keeps per session (default 300); stress runs that hand the renderer a whole long session. */
    var cacheItems: Int? = null; private set
    /** How the WebView draws for backdrop recording: `both` (default: hardware layer + offscreenPreRaster), `hw`, `preraster`, `none`. */
    var webLayer: String = "both"; private set
    /** Panel material candidate over the thread (contrast choice for the user): `sample` (default), `dialog`, `scrim`. */
    var panel: String = "sample"; private set

    fun read(intent: Intent?) {
        val x = intent?.extras ?: return
        drawerOpen = x.getBoolean("drawer", false)
        sheet = x.getString("sheet")
        session = x.getString("session")
        autoApproveSeconds = when {
            !x.containsKey("auto_approve_seconds") -> null
            x.getString("auto_approve_seconds") != null -> x.getString("auto_approve_seconds")?.toDoubleOrNull()
            else -> x.getInt("auto_approve_seconds").toDouble()
        }
        focus = x.getBoolean("focus", false)
        stress = x.getString("stress")
        metrics = x.getBoolean("metrics", false)
        webLayer = x.getString("web_layer") ?: "both"
        panel = x.getString("panel") ?: "sample"
        cacheItems = if (x.containsKey("cache_items")) x.getInt("cache_items") else null
        switches = x.getString("switch").orEmpty().split(",").mapNotNull { e ->
            val p = e.split("@"); if (p.size == 2) p[1].toDoubleOrNull()?.let { p[0] to it } else null
        }
        scrollUp = if (x.containsKey("scroll_up")) x.getInt("scroll_up") else null
        glass = x.getString("glass")
        sheetGlass = x.getString("sheet_glass")
        crashRendererAt = if (x.containsKey("crash_renderer_at")) x.getInt("crash_renderer_at") else null
        openSheet = x.getBoolean("open_sheet", false)
        webGlass = x.getString("web_glass") ?: "off"
        LaunchClock.log("debug extras: ${x.keySet().joinToString()}")
    }
}

/** Startup timing in logcat (tag AAv3PoC): `+123ms label`, measured from the process start. */
object LaunchClock {
    const val TAG = "AAv3PoC"
    private val processStart = Process.getStartUptimeMillis()

    fun milliseconds(): Long = SystemClock.uptimeMillis() - processStart

    fun mark(label: String) = log("+${milliseconds()}ms $label")

    fun log(message: String) {
        // logcat truncates long lines; keep each under ~4000 bytes.
        if (message.length <= 3800) Log.i(TAG, message) else message.chunked(3800).forEach { Log.i(TAG, it) }
    }
}
