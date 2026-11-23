package dev.agentsanywhere.v3.ui

import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import com.kyant.backdrop.backdrops.layerBackdrop
import com.kyant.backdrop.backdrops.rememberLayerBackdrop
import dev.agentsanywhere.v3.App
import dev.agentsanywhere.v3.design.AAMenuHost
import dev.agentsanywhere.v3.design.AATheme
import dev.agentsanywhere.v3.design.GlassMode
import dev.agentsanywhere.v3.design.LocalGlassFrost
import dev.agentsanywhere.v3.design.LocalGlassMode
import dev.agentsanywhere.v3.design.LocalOverlayCount
import dev.agentsanywhere.v3.design.LocalWebBackdrop
import dev.agentsanywhere.v3.design.MenuRequest
import dev.agentsanywhere.v3.design.OverlayCount

/** The screens of the phone layout (client-experience-proposal §2.5): single-column push navigation. */
sealed interface Route {
    data object Home : Route
    data class Device(val deviceId: String) : Route
    data class Conversation(val deviceId: String, val sessionId: String) : Route
    data class Terminal(val deviceId: String, val terminalId: String, val created: Boolean = false) : Route
    data object Settings : Route
    data class Pair(val uri: String? = null) : Route
}

/** A navigation stack with iOS push / pop transitions; system Back pops. */
class Navigator {
    val stack = mutableStateListOf<Route>(Route.Home)
    var popping by mutableStateOf(false); private set
    var menu by mutableStateOf<MenuRequest?>(null)
    val top: Route get() = stack.last()

    fun push(route: Route) { popping = false; stack += route }
    fun pop(): Boolean {
        if (stack.size <= 1) return false
        popping = true
        stack.removeAt(stack.lastIndex)
        return true
    }
    fun replaceAll(route: Route) { popping = false; stack.clear(); stack += route }
}

val LocalNavigator = staticCompositionLocalOf<Navigator> { error("no navigator") }
val LocalApp = staticCompositionLocalOf<App> { error("no app") }

@Composable
fun Root(app: App) {
    val dark = isSystemInDarkTheme()
    val nav = remember { Navigator() }
    val saveable = androidx.compose.runtime.saveable.rememberSaveableStateHolder()
    val model = app.model
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    val reduceMotion = remember(configuration) { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }

    LaunchedEffect(configuration.locales[0]) { app.bridge.setLocale(configuration.locales[0].toLanguageTag()) }
    // A pairing link (aa-pair://…) that launched the app.
    LaunchedEffect(Unit) {
        (context as? android.app.Activity)?.intent?.data?.toString()?.takeIf { it.startsWith("aa-pair://") }?.let { nav.push(Route.Pair(it)) }
    }

    AATheme(dark) {
        val mode = app.glass.mode
        val overlays = remember { OverlayCount() }
        CompositionLocalProvider(
            LocalNavigator provides nav,
            LocalApp provides app,
            LocalGlassMode provides mode,
            LocalGlassFrost provides app.glass.frost,
            // Only a screen that records what is under its glass (the conversation's WebView) provides a backdrop;
            // everywhere else glass draws opaque (never a see-through tint without blur).
            LocalWebBackdrop provides null,
            LocalOverlayCount provides overlays,
        ) {
            Box(Modifier.fillMaxSize().background(Ios.colors.groupedBackground)) {
                if (!model.signedIn) {
                    SignInScreen()
                } else {
                    BackHandler(enabled = nav.stack.size > 1) { nav.pop() }
                    AnimatedContent(
                        targetState = nav.top,
                        transitionSpec = { pushTransition(nav.popping, reduceMotion) },
                        label = "nav",
                    ) { route ->
                        saveable.SaveableStateProvider(route.toString()) { when (route) {
                            Route.Home -> HomeScreen()
                            is Route.Device -> DeviceScreen(route.deviceId)
                            is Route.Conversation -> ConversationScreen(route.deviceId, route.sessionId)
                            is Route.Terminal -> TerminalScreen(route.deviceId, route.terminalId, route.created)
                            Route.Settings -> SettingsScreen()
                            is Route.Pair -> PairScreen(route.uri)
                        } }
                    }
                }
                AAMenuHost(nav.menu) { nav.menu = null }
            }
        }
    }
}

/** UINavigationController: the new screen slides in from the right over the old one, which moves a third left. */
private fun pushTransition(popping: Boolean, reduceMotion: Boolean): ContentTransform {
    if (reduceMotion) return fadeIn(tween(150)) togetherWith fadeOut(tween(150))
    val spec = tween<androidx.compose.ui.unit.IntOffset>(350, easing = androidx.compose.animation.core.CubicBezierEasing(0.2f, 0.9f, 0.3f, 1f))
    return if (!popping) {
        (slideInHorizontally(spec) { it }) togetherWith (slideOutHorizontally(spec) { -it / 3 } + fadeOut(tween(350), 0.6f))
    } else {
        (slideInHorizontally(spec) { -it / 3 } + fadeIn(tween(350), 0.6f)) togetherWith (slideOutHorizontally(spec) { it })
    }.apply { targetContentZIndex = if (popping) 0f else 1f }
}

/** The WebView host recording for glass (used by screens that show the render bundle). */
fun Modifier.recordedFor(backdrop: com.kyant.backdrop.backdrops.LayerBackdrop?): Modifier =
    if (backdrop != null) this.layerBackdrop(backdrop) else this
