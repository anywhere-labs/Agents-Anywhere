package dev.agentsanywhere.v3poc.ui

import com.kyant.backdrop.effects.blur
import com.kyant.backdrop.effects.runtimeShaderEffect
import com.kyant.backdrop.drawBackdrop
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.drawWithContent
import dev.agentsanywhere.v3poc.design.continuousRect
import dev.agentsanywhere.v3poc.design.LocalWebBackdrop
import com.kyant.backdrop.backdrops.rememberLayerBackdrop
import com.kyant.backdrop.backdrops.layerBackdrop
import androidx.compose.runtime.CompositionLocalProvider
import android.os.Build
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.agentsanywhere.v3poc.DebugLaunch
import dev.agentsanywhere.v3poc.bridge.RendererBridge
import dev.agentsanywhere.v3poc.bridge.StressMetrics
import dev.agentsanywhere.v3poc.design.AA
import dev.agentsanywhere.v3poc.design.claimTouches
import dev.agentsanywhere.v3poc.design.AAFonts
import dev.agentsanywhere.v3poc.design.AAMetrics
import dev.agentsanywhere.v3poc.design.AAMotion
import dev.agentsanywhere.v3poc.design.AASpinner
import dev.agentsanywhere.v3poc.design.AASymbol
import dev.agentsanywhere.v3poc.design.AAText
import dev.agentsanywhere.v3poc.design.GlassButton
import dev.agentsanywhere.v3poc.design.GlassCapsule
import dev.agentsanywhere.v3poc.design.GlassCircleButton
import dev.agentsanywhere.v3poc.design.GlassMode
import dev.agentsanywhere.v3poc.design.LocalGlassMode
import dev.agentsanywhere.v3poc.design.MenuItem
import dev.agentsanywhere.v3poc.design.MenuRequest
import dev.agentsanywhere.v3poc.design.Press
import dev.agentsanywhere.v3poc.design.glass
import dev.agentsanywhere.v3poc.design.iosSpring
import dev.agentsanywhere.v3poc.design.pressable
import dev.agentsanywhere.v3poc.model.SessionActivity
import dev.agentsanywhere.v3poc.model.SessionController
import dev.agentsanywhere.v3poc.model.str
import dev.agentsanywhere.v3poc.model.get
import kotlinx.coroutines.delay

/**
 * The conversation page: the app's single WebView edge to edge, with native chrome over it (toolbar, approval dock,
 * composer, 到底部 pill, toasts). What the chrome covers goes to the renderer as `viewport`, so the document scrolls
 * under it. Only the controls themselves are glass: nothing blurs or fades behind the composer and dock.
 */
@Composable
fun ConversationPage(controller: SessionController, ui: UiState, onMenu: () -> Unit) {
    val bridge = controller.bridge
    val c = AA.colors
    val density = LocalDensity.current
    val statusTop = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val summary = controller.selectedSummary
    val device = summary?.let { s -> controller.devices.firstOrNull { it.id == s.device_id } }
    val deviceOnline = device?.isOnline ?: true
    val title = controller.session["title"].str ?: summary?.title ?: "会话"
    val subtitle = listOfNotNull(summary?.agentLabel, controller.session["device"]["name"].str ?: device?.name).joinToString(" · ")
    var bottomBarTop by remember { mutableFloatStateOf(0f) }
    var rootHeight by remember { mutableFloatStateOf(0f) }

    // The thread's recording is created at the root (Root.kt), so sheets drawn there can be glass over it too.
    val webBackdrop = LocalWebBackdrop.current
    CompositionLocalProvider(LocalWebBackdrop provides webBackdrop) {
    BoxWithConstraints(Modifier.fillMaxSize().background(c.background).onGloballyPositioned { rootHeight = it.size.height.toFloat() }) {
        val maxEditor = minOf(AAMetrics.composerEditorMaxHeight.value, maxOf(AAMetrics.composerEditorMinHeight.value, maxHeight.value * AAMetrics.composerEditorMaxScreenFraction)).dp

        // Thread. With glass on it is recorded (Kyant layerBackdrop, a draw modifier: no touch handling) so the glass
        // controls over it blur and refract it; with glass off nothing is recorded.
        WebViewHost(bridge, if (webBackdrop != null) Modifier.fillMaxSize().layerBackdrop(webBackdrop) else Modifier.fillMaxSize())
        DisposableEffect(bridge) {
            bridge.onUserDrag = { if (ui.composerFocused) ui.focusRequest = false }
            onDispose { bridge.onUserDrag = {} }
        }
        RendererState(bridge)

        // Viewport: status bar + toolbar on top; composer / dock + navigation bar or keyboard at the bottom.
        LaunchedEffect(statusTop, bottomBarTop, rootHeight) {
            if (rootHeight > 0 && bottomBarTop > 0) {
                bridge.setViewport(statusTop.value + AAMetrics.toolbarHeight.value, with(density) { (rootHeight - bottomBarTop).toDp().value })
            }
        }

        // The toolbar's glass buttons stand on the top edge's blur: on Android 13+ the edge exports what it draws
        // (blur + veil) and the buttons sample that, not the bare thread (Android 12's layered edge does not export).
        val topBackdrop = com.kyant.backdrop.backdrops.rememberLayerBackdrop()
        val topExports = LocalWebBackdrop.current != null && android.os.Build.VERSION.SDK_INT >= 33
        TopEdge(statusTop + AAMetrics.toolbarHeight + AAMetrics.topEdgeBelowHeader, if (topExports) topBackdrop else null)
        if (topExports) dev.agentsanywhere.v3poc.design.OnGlass(topBackdrop) { Toolbar(title, subtitle, controller, deviceOnline, ui, statusTop, onMenu) }
        else Toolbar(title, subtitle, controller, deviceOnline, ui, statusTop, onMenu)

        // Toast: a glass capsule under the toolbar.
        AnimatedVisibility(
            visible = controller.toast != null,
            modifier = Modifier.align(Alignment.TopCenter).padding(top = statusTop + AAMetrics.toolbarHeight + AAMetrics.toastTop),
            enter = slideInVertically(iosSpring(AAMotion.toast.smooth)) { -it } + fadeIn(),
            exit = slideOutVertically(iosSpring(AAMotion.toast.smooth)) { -it } + fadeOut(),
        ) {
            var last by remember { mutableStateOf("") }
            controller.toast?.let { last = it }
            GlassCapsule(Modifier.pressable(Press.None) { controller.dismissToast() }, minHeight = 0.dp, horizontal = AAMetrics.toastPaddingHorizontal, vertical = AAMetrics.toastPaddingVertical) {
                AAText(last, font = AAFonts.subheadline, weight = 500)
            }
        }

        // Bottom chrome: approval dock + composer, riding the keyboard.
        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))
                .widthIn(max = AAMetrics.maximumContentWidth)
                .onGloballyPositioned { bottomBarTop = it.positionInRoot().y },
        ) {
            val request = controller.pending
            AnimatedVisibility(request != null,
                enter = slideInVertically(iosSpring(AAMotion.dockAppear.smooth)) { it / 2 } + fadeIn(),
                exit = slideOutVertically(iosSpring(AAMotion.dockAppear.smooth)) { it / 2 } + fadeOut()) {
                var shown by remember { mutableStateOf(request) }
                if (request != null) shown = request
                shown?.let { r ->
                    Column(Modifier.padding(top = AAMetrics.dockTopGap, bottom = AAMetrics.dockToComposerGap - AAMetrics.composerTopPadding)) {
                        ApprovalDock(r, summary?.agentLabel ?: "Agent", controller.pendingCount, deviceOnline, ui) { controller.answer(r.requestId, it) }
                    }
                }
            }
            Composer(
                ui = ui, running = controller.isRunning, canSend = deviceOnline,
                placeholder = if (deviceOnline) "询问 Agents" else "设备离线，暂时不能发送",
                maximumEditorHeight = maxEditor,
                onSend = { val text = ui.draft.text; ui.draft = androidx.compose.ui.text.input.TextFieldValue(""); controller.send(text) },
                onStop = controller::stop,
                onOptions = { ui.focusRequest = false; ui.optionsSheet = true },
            )
        }

        // 到底部: a glass capsule 50 dp above the bottom chrome.
        val pillVisible = bridge.isReady && !bridge.atEnd
        val pillY = with(density) { (bottomBarTop - AAMetrics.pillOffsetAboveBottomBar.toPx()).toDp() }
        AnimatedVisibility(pillVisible, Modifier.align(Alignment.TopCenter).offset(y = pillY),
            enter = scaleIn(iosSpring(AAMotion.pillAppear.smooth), initialScale = AAMotion.pillAppear.scaleFrom) + fadeIn(iosSpring(AAMotion.pillAppear.smooth)),
            exit = scaleOut(iosSpring(AAMotion.pillAppear.smooth), targetScale = AAMotion.pillAppear.scaleFrom) + fadeOut(iosSpring(AAMotion.pillAppear.smooth))) {
            Box(Modifier.height(44.dp).onGloballyPositioned {
                val b = it.boundsInRoot()
                StressMetrics.ui("pill", b.center.x, b.center.y)
            }, contentAlignment = Alignment.Center) {
                GlassCapsule(Modifier.pressable(Press.Scale, label = "滚动到底部") { bridge.scrollToEnd() }, minHeight = AAMetrics.pillMinHeight, horizontal = AAMetrics.pillHorizontalPadding) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        AASymbol("arrow.down", size = AAMetrics.pillIcon)
                        AAText("到底部", font = AAFonts.footnote, weight = 500)
                    }
                }
            }
        }
    }
    }

    val context = androidx.compose.ui.platform.LocalContext.current
    val dark = dev.agentsanywhere.v3poc.design.LocalDark.current
    // Debug launch actions, once the renderer is ready.
    var applied by remember { mutableStateOf(false) }
    LaunchedEffect(bridge.isReady) {
        if (!bridge.isReady || applied) return@LaunchedEffect
        applied = true
        delay(900)
        if (DebugLaunch.sheet == "options") ui.optionsSheet = true
        if (DebugLaunch.sheet == "account") ui.accountSheet = true
        if (DebugLaunch.focus) ui.focusRequest = true
        if (DebugLaunch.openSheet) controller.openRequest = SessionController.OpenRequest("打开文件", "server/agent_server/services/session_read_state.py:12")
        if (DebugLaunch.webGlass == "window" || DebugLaunch.webGlass == "window-untheme") (context as? android.app.Activity)?.let { WindowGlassSpike.show(it, dark, themed = DebugLaunch.webGlass == "window") }
        if (DebugLaunch.webGlass in setOf("behind", "bgafter", "bgaftert")) (context as? android.app.Activity)?.let { WindowGlassSpike.control(it, DebugLaunch.webGlass) }
        DebugLaunch.scrollUp?.let { delay(2000); bridge.scrollUp(it) }
    }
    LaunchedEffect(Unit) {
        val at = DebugLaunch.crashRendererAt ?: return@LaunchedEffect
        while (!bridge.isReady) delay(200)
        delay(at * 1000L)
        bridge.crashRenderer()
    }
}

/**
 * Hosts the bridge's WebView (re-parented when it is recreated). Never recorded into a GraphicsLayer: that made
 * Chromium exceed its tile memory and drop tiles (blank / flickering thread), see v3poc/design/README.md.
 */
@Composable
private fun WebViewHost(bridge: RendererBridge, modifier: Modifier) {
    // No pointer modifiers here or on any ancestor: touches on the thread go to the WebView alone (native controls
    // are siblings on top and get only the touches that hit them).
    Box(modifier) {
        AndroidView(
            factory = { context -> FrameLayout(context).apply { clipChildren = true } },
            modifier = Modifier.fillMaxSize().graphicsLayer { alpha = if (bridge.isReady) 1f else 0f },
            update = { frame ->
                val view = bridge.webView
                @Suppress("UNUSED_VARIABLE") val generation = bridge.generation
                if (view != null && view.parent !== frame) {
                    (view.parent as? ViewGroup)?.removeView(view)
                    frame.removeAllViews()
                    frame.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                }
            },
        )
    }
}

@Composable
private fun RendererState(bridge: RendererBridge) {
    when (val phase = bridge.phase) {
        is RendererBridge.Phase.Ready -> {}
        RendererBridge.Phase.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { AASpinner(20.dp) }
        RendererBridge.Phase.Missing -> RendererProblem("缺少渲染器",
            "APK 里没有 renderer.html。先在 v3poc/web 运行 npm run build:renderer（会生成 v3poc/ios/AAv3PoC/Renderer/renderer.html），再重新构建。", null)
        is RendererBridge.Phase.Failed -> RendererProblem("渲染器出错", phase.message) { bridge.load() }
    }
}

@Composable
private fun RendererProblem(title: String, message: String, onRetry: (() -> Unit)?) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = 340.dp).glass(continuousRect(28.dp)).padding(28.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            AASymbol("exclamationmark.triangle", size = 28.dp, tint = AA.colors.orange)
            AAText(title, font = AAFonts.headline)
            AAText(message, font = AAFonts.subheadline, color = AA.colors.secondaryLabel, align = TextAlign.Center)
            onRetry?.let { GlassButton("重试", onClick = it) }
        }
    }
}

/**
 * iOS's soft scroll edge under the status bar and toolbar, as a fade of the page colour (blurring it would mean
 * recording the WebView). Top only; the bottom has none.
 */
@Composable
private fun TopEdge(start: androidx.compose.ui.unit.Dp, exportTo: com.kyant.backdrop.backdrops.LayerBackdrop? = null) {
    val c = AA.colors
    val web = LocalWebBackdrop.current
    // iOS 26's scroll edge effect, from just below the header up to the screen top: two independent eased ramps that
    // both start at 0 at the band's bottom and grow to the top: the veil's opacity, and the blur radius.
    if (web == null) {
        // No blur (glass off, power saver, Android < 12): the page colour along the same range and curve.
        Box(Modifier.fillMaxWidth().height(start).background(easedRamp(c.toolbarEdgeTint, 1f, easeOut = true)))
        return
    }
    val maxRadius = AAMetrics.topEdgeMaxBlur
    Box(Modifier.fillMaxWidth().height(start)) {
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            // A truly variable blur: radius r(y) = maxRadius × ease(1 − y / h), separable (a horizontal pass, exact
            // because r is constant along a row, then a vertical pass with r(y)). r = 0 at the band's bottom, so the
            // blurred thread meets the sharp one without an edge.
            Box(Modifier.fillMaxSize().drawBackdrop(web, shape = { androidx.compose.ui.graphics.RectangleShape }, effects = {
                val w = size.width; val h = size.height; val r = maxRadius.toPx()
                runtimeShaderEffect("aa-vblur-h", VARIABLE_BLUR, "content") { setFloatUniform("size", w, h); setFloatUniform("maxRadius", r); setFloatUniform("dir", 1f, 0f) }
                runtimeShaderEffect("aa-vblur-v", VARIABLE_BLUR, "content") { setFloatUniform("size", w, h); setFloatUniform("maxRadius", r); setFloatUniform("dir", 0f, 1f) }
            }, highlight = null, shadow = null, exportedBackdrop = exportTo,
                // The veil is drawn as this backdrop's surface, so the exported result (what the toolbar buttons
                // sample) already has it.
                onDrawSurface = { drawRect(easedRamp(c.toolbarEdgeTint, AAMetrics.topEdgeVeil, easeOut = true)) }))
        } else {
            // Android 12: no runtime shaders. Fixed-radius layers, each faded in by an eased ramp over the whole band
            // (bigger radius ramps in later), so the strength still rises smoothly towards the top.
            listOf(maxRadius * 0.25f to 1f, maxRadius * 0.5f to 0.66f, maxRadius to 0.33f).forEach { (radius, reach) ->
                Box(
                    Modifier.fillMaxSize()
                        .graphicsLayer { compositingStrategy = androidx.compose.ui.graphics.CompositingStrategy.Offscreen }
                        .drawWithContent {
                            drawContent()
                            drawRect(easedRamp(Color.Black, 1f, reach), blendMode = androidx.compose.ui.graphics.BlendMode.DstIn)
                        }
                        .drawBackdrop(web, shape = { androidx.compose.ui.graphics.RectangleShape }, effects = { blur(radius.toPx()) },
                            highlight = null, shadow = null),
                )
            }
            Box(Modifier.fillMaxSize().background(easedRamp(c.toolbarEdgeTint, AAMetrics.topEdgeVeil, easeOut = true)))
        }
    }
}

/**
 * [color] transparent at the bottom, rising along smoothstep to [alpha] at the top; with [reach] < 1 it is only
 * non-zero in the top [reach] of the height. Enough stops that the curve shows no bands.
 */
private fun easedRamp(color: Color, alpha: Float, reach: Float = 1f, easeOut: Boolean = false): Brush {
    val steps = 24
    val stops = (0..steps).map { i ->
        val t = i / steps.toFloat()                       // 0 = top, 1 = bottom
        val x = ((1f - t) / reach).coerceIn(0f, 1f)        // 1 at the top, 0 at reach and below
        // smoothstep stays near 0 over the bottom third; the veil uses ease-out instead, so its opacity already
        // changes visibly right from where the band starts and levels off towards the top.
        val e = if (easeOut) 1f - (1f - x) * (1f - x) else x * x * (3f - 2f * x)
        t to color.copy(alpha = color.alpha * alpha * e)
    }
    return Brush.verticalGradient(*stops.toTypedArray())
}

/** Separable variable-radius Gaussian along `dir`; radius eased from 0 at the bottom to `maxRadius` at the top. */
private const val VARIABLE_BLUR = """
uniform shader content;
uniform float2 size;
uniform float maxRadius;
uniform float2 dir;
half4 main(float2 p) {
    float x = clamp(1.0 - p.y / size.y, 0.0, 1.0);
    float r = maxRadius * x * x * (3.0 - 2.0 * x);
    if (r < 0.5) return content.eval(p);
    half4 acc = half4(0.0);
    float total = 0.0;
    for (int i = 0; i < 25; i++) {
        float k = float(i) / 12.0 - 1.0;
        float w = exp(-k * k * 4.5);
        float2 q = clamp(p + dir * (k * r), float2(0.5), size - float2(0.5));
        acc += content.eval(q) * w;
        total += w;
    }
    return acc / total;
}
"""

/** iOS `ChatPageToolbar`: glass sidebar button, leading title + agent · device · status, glass menu button. */
@Composable
private fun Toolbar(title: String, subtitle: String, controller: SessionController, deviceOnline: Boolean, ui: UiState,
                    statusTop: androidx.compose.ui.unit.Dp, onMenu: () -> Unit) {
    val status = headerStatus(controller.activity, controller.errorMessage, deviceOnline)
    var menuBounds by remember { mutableStateOf(Rect.Zero) }
    Row(
        Modifier.padding(top = statusTop).fillMaxWidth().height(AAMetrics.toolbarHeight).padding(horizontal = AAMetrics.toolbarHorizontalInset),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        GlassCircleButton("sidebar.left", "打开侧栏", onClick = onMenu)
        Spacer(Modifier.size(AAMetrics.toolbarTitleGap))
        Column(Modifier.weight(1f).claimTouches(), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            AAText(title, Modifier.semantics { heading() }, font = AAFonts.headline, maxLines = 1)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.height(16.dp)) {
                when {
                    status == null -> {}
                    status.progress -> AASpinner(12.dp)
                    else -> AASymbol(status.symbol, size = 12.dp, tint = AA.colors.controlSecondaryLabel)
                }
                AAText(listOfNotNull(subtitle.takeIf { it.isNotEmpty() }, status?.title).joinToString(" · "), font = AAFonts.caption, color = AA.colors.controlSecondaryLabel, maxLines = 1)
            }
        }
        Spacer(Modifier.size(AAMetrics.toolbarTitleGap))
        GlassCircleButton("ellipsis", "会话菜单", modifier = Modifier.onGloballyPositioned { menuBounds = it.boundsInRoot() }) {
            ui.menu = MenuRequest(buildList {
                add(MenuItem("会话详情", "info.circle") { controller.showToast("演示：会话详情") })
                add(MenuItem("复制会话 ID", "number") { controller.copy(controller.selectedId ?: ""); controller.showToast("已复制") })
                if (controller.isRunning) add(MenuItem("停止", "CircleStop", destructive = true, divider = true) { controller.stop() })
            }, menuBounds, alignEnd = true)
        }
    }
}

private data class HeaderStatus(val title: String, val symbol: String, val progress: Boolean)

private fun headerStatus(activity: SessionActivity, error: String?, deviceOnline: Boolean): HeaderStatus? = when {
    !deviceOnline -> HeaderStatus("设备离线", "desktopcomputer", false)
    activity == SessionActivity.Running -> HeaderStatus("正在处理任务", "info.circle", true)
    activity == SessionActivity.Waiting -> HeaderStatus("等待回应", "hand.raised", false)
    activity == SessionActivity.Error || activity == SessionActivity.Disconnected -> HeaderStatus(error ?: "连接已断开", "exclamationmark.circle", false)
    else -> null
}
