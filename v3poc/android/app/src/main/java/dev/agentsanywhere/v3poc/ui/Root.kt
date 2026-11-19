package dev.agentsanywhere.v3poc.ui

import com.kyant.backdrop.backdrops.layerBackdrop

import android.provider.Settings
import android.view.HapticFeedbackConstants
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import dev.agentsanywhere.v3poc.App
import dev.agentsanywhere.v3poc.DebugLaunch
import dev.agentsanywhere.v3poc.LaunchClock
import dev.agentsanywhere.v3poc.design.AAMenuHost
import dev.agentsanywhere.v3poc.design.AATheme
import dev.agentsanywhere.v3poc.design.GlassMode
import dev.agentsanywhere.v3poc.design.LocalGlassMode
import kotlinx.coroutines.delay

/** The shell: drawer (sidebar + page), sheets and menus over it, appearance sent to the renderer. */
@Composable
fun Root(app: App, ui: UiState) {
    val controller = app.controller
    val dark = isSystemInDarkTheme()
    val configuration = LocalConfiguration.current
    val context = LocalContext.current
    val view = LocalView.current
    val reduceMotion = remember(configuration) { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }
    val locale = configuration.locales[0].toLanguageTag()

    LaunchedEffect(dark, configuration.fontScale, reduceMotion, locale) {
        // textScale: the system font scale relative to the default (1.0), like iOS Dynamic Type relative to Large.
        controller.bridge.setAppearance(dark, configuration.fontScale, reduceMotion, locale, controller.account.name)
    }
    LaunchedEffect(Unit) {
        controller.haptic = { style ->
            view.performHapticFeedback(when (style) {
                "success" -> HapticFeedbackConstants.CONFIRM
                "medium" -> HapticFeedbackConstants.CONTEXT_CLICK
                else -> HapticFeedbackConstants.CLOCK_TICK
            })
        }
        val first = DebugLaunch.session ?: controller.sessions.firstOrNull { it.state == "running" }?.id ?: controller.sessions.firstOrNull()?.id
        first?.let { controller.select(it) }
        var elapsed = 0.0
        for ((id, at) in DebugLaunch.switches) {
            delay(((at - elapsed).coerceAtLeast(0.0) * 1000).toLong())
            elapsed = at
            LaunchClock.mark("debug switch to $id")
            controller.select(id)
        }
    }

    AATheme(dark) {
        // Launch overrides apply once; the settings switches clear them (re-applying them on every recomposition made
        // the switches look dead while the app was still running from a debug launch).
        remember {
            app.glass.debugOverride = DebugLaunch.glass
            app.glass.sheetGlassOverride = DebugLaunch.sheetGlass?.let { it != "off" }
            app.glass.frostOverride = DebugLaunch.frost
            true
        }
        val mode = app.glass.mode
        // The thread (WebView) is recorded once, here, for every glass that stands over it: the conversation page's
        // controls and the sheets drawn above the page. Null when glass is off: nothing is recorded.
        val recorded = com.kyant.backdrop.backdrops.rememberLayerBackdrop()
        val webBackdrop = if (mode == dev.agentsanywhere.v3poc.design.GlassMode.Blur && android.os.Build.VERSION.SDK_INT >= 31) recorded else null
        CompositionLocalProvider(LocalGlassMode provides mode, dev.agentsanywhere.v3poc.design.LocalGlassFrost provides app.glass.frost,
            dev.agentsanywhere.v3poc.design.LocalWebBackdrop provides webBackdrop) {
            // Everything under the sheets and menus (sidebar + conversation card, with their own glass) is recorded as
            // one more backdrop, so a sheet blurs whatever is under it: the sidebar too, not only the thread.
            // With 「面板和菜单的玻璃」 off nothing extra is recorded and the sheets/menus draw opaque (glass mode Off below).
            val screen = com.kyant.backdrop.backdrops.rememberLayerBackdrop()
            val sheetGlass = webBackdrop != null && app.glass.sheetGlass
            // Recorded only while a sheet or menu is on screen (including its closing animation): they register in
            // `overlays` for as long as they are composed.
            val overlays = remember { dev.agentsanywhere.v3poc.design.OverlayCount() }
            val recordScreen = sheetGlass && overlays.value > 0
            LaunchedEffect(recordScreen) {
                dev.agentsanywhere.v3poc.bridge.StressMetrics.event("screenRecording", mapOf("enabled" to recordScreen))
            }
            Box(Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxSize().then(if (recordScreen) Modifier.layerBackdrop(screen) else Modifier)) {
                    SidebarDrawer(
                        open = ui.drawerOpen,
                        onOpenChange = { ui.drawerOpen = it; if (it) ui.focusRequest = false },
                        sidebar = { Sidebar(controller, ui) { id -> controller.select(id); ui.drawerOpen = false } },
                        content = { ConversationPage(controller, ui) { ui.focusRequest = false; ui.drawerOpen = !ui.drawerOpen } },
                    )
                }
                CompositionLocalProvider(
                    dev.agentsanywhere.v3poc.design.LocalOverlayCount provides overlays,
                    LocalGlassMode provides if (sheetGlass) mode else GlassMode.Off,
                    dev.agentsanywhere.v3poc.design.LocalWebBackdrop provides if (sheetGlass) screen else null,
                ) {
                    OptionsSheet(controller, ui)
                    WorkspaceSheet(controller, ui)
                    OpenSheet(controller)
                    DemoSheet(ui)
                    AccountSheet(controller, ui, app)
                    AAMenuHost(ui.menu) { ui.menu = null }
                }
            }
        }
    }
}
