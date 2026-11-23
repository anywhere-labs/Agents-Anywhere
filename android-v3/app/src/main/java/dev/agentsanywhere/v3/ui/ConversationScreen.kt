package dev.agentsanywhere.v3.ui

import android.content.res.Configuration
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
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
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import dev.agentsanywhere.v3.core.model.ConfigOption
import dev.agentsanywhere.v3.core.model.agentDisplayName
import dev.agentsanywhere.v3.core.model.projectName
import dev.agentsanywhere.v3.design.AA
import dev.agentsanywhere.v3.design.AAFonts
import dev.agentsanywhere.v3.design.AAMetrics
import dev.agentsanywhere.v3.design.AAMotion
import dev.agentsanywhere.v3.design.AASheet
import dev.agentsanywhere.v3.design.AASpinner
import dev.agentsanywhere.v3.design.AASymbol
import dev.agentsanywhere.v3.design.AAText
import dev.agentsanywhere.v3.design.GlassCapsule
import dev.agentsanywhere.v3.design.GlassCircleButton
import dev.agentsanywhere.v3.design.GlassToolbarAction
import dev.agentsanywhere.v3.design.GlassToolbarGroup
import dev.agentsanywhere.v3.design.LocalDark
import dev.agentsanywhere.v3.design.LocalWebBackdrop
import dev.agentsanywhere.v3.design.MenuItem
import dev.agentsanywhere.v3.design.MenuRequest
import dev.agentsanywhere.v3.design.OnGlass
import dev.agentsanywhere.v3.design.Press
import dev.agentsanywhere.v3.design.SheetHeader
import dev.agentsanywhere.v3.design.claimTouches
import dev.agentsanywhere.v3.design.iosSpring
import dev.agentsanywhere.v3.design.pressable
import dev.agentsanywhere.v3.model.ConversationController
import kotlinx.coroutines.delay

/**
 * The conversation page (§2.4): the render bundle's WebView edge to edge, native chrome over it (toolbar, queued
 * messages, approval dock, attachments, composer, 回到底部, toasts). What the chrome covers goes to the page as
 * `theme.insets`, so the thread scrolls under the glass.
 */
@Composable
fun ConversationScreen(deviceId: String, sessionId: String) {
    val app = LocalApp.current
    val nav = LocalNavigator.current
    val model = app.model
    val bridge = app.bridge
    val context = LocalContext.current
    val controller = remember(deviceId, sessionId) { ConversationController(context.applicationContext, model, bridge, deviceId, sessionId) }
    val haptics = LocalHapticFeedback.current
    DisposableEffect(controller) {
        controller.haptic = { kind -> haptics.performHapticFeedback(if (kind == "light") HapticFeedbackType.TextHandleMove else HapticFeedbackType.LongPress) }
        controller.start()
        onDispose { controller.stop() }
    }
    val composer = remember { ComposerState() }
    var optionsSheet by remember { mutableStateOf(false) }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris -> uris.forEach(controller::attach) }

    val c = AA.colors
    val dark = LocalDark.current
    val density = LocalDensity.current
    val configuration = LocalConfiguration.current
    val statusTop = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val device = model.device(deviceId)
    val online = device?.online == true
    val session = controller.session
    val summary = model.sessions.firstOrNull { it.id == sessionId }
    val agent = session?.agent ?: summary?.agent ?: ""
    val agentLabel = agentDisplayName(agent, model.statuses[deviceId]?.runtimes.orEmpty())
    val title = session?.title?.ifBlank { null } ?: summary?.title?.ifBlank { null } ?: "新对话"
    val subtitle = listOfNotNull(device?.name, agentLabel.ifBlank { null }, (session?.cwd ?: summary?.cwd)?.let(::projectName)).joinToString(" · ")
    val control = controller.control
    val running = control.running
    var bottomBarTop by remember { mutableFloatStateOf(0f) }
    var rootHeight by remember { mutableFloatStateOf(0f) }
    val reduceMotion = remember(configuration) { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }
    val highContrast = (configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == 0 && android.os.Build.VERSION.SDK_INT >= 34 &&
        context.getSystemService(android.app.UiModeManager::class.java).contrast > 0f

    LaunchedEffect(dark, statusTop, bottomBarTop, rootHeight, configuration.fontScale) {
        if (rootHeight > 0 && bottomBarTop > 0) {
            bridge.setTheme(dark, statusTop.value + AAMetrics.toolbarHeight.value, with(density) { (rootHeight - bottomBarTop).toDp().value },
                configuration.fontScale, reduceMotion, highContrast)
        }
    }
    LaunchedEffect(controller.toast) {
        if (controller.toast != null) { delay((AAMotion.toast.visibleSeconds * 1000).toLong()); controller.toast = null }
    }

    val recorded = com.kyant.backdrop.backdrops.rememberLayerBackdrop()
    val webBackdrop = if (dev.agentsanywhere.v3.design.LocalGlassMode.current == dev.agentsanywhere.v3.design.GlassMode.Blur && android.os.Build.VERSION.SDK_INT >= 31) recorded else null
    Box(Modifier.fillMaxSize()) {
      CompositionLocalProvider(LocalWebBackdrop provides webBackdrop) {
        BoxWithConstraints(Modifier.fillMaxSize().background(c.background).onGloballyPositioned { rootHeight = it.size.height.toFloat() }) {
            val maxEditor = minOf(AAMetrics.composerEditorMaxHeight.value, maxOf(AAMetrics.composerEditorMinHeight.value, maxHeight.value * AAMetrics.composerEditorMaxScreenFraction)).dp

            WebViewHost(bridge, controller, Modifier.fillMaxSize().recordedFor(webBackdrop))

            val topBackdrop = com.kyant.backdrop.backdrops.rememberLayerBackdrop()
            val topExports = webBackdrop != null && android.os.Build.VERSION.SDK_INT >= 33
            TopEdge(statusTop + AAMetrics.toolbarHeight + AAMetrics.topEdgeBelowHeader, if (topExports) topBackdrop else null)
            val toolbar: @Composable () -> Unit = {
                ConversationToolbar(title, subtitle, statusText(controller.phase, running, control.pending.isNotEmpty(), online, controller.error), running,
                    statusTop, onBack = { nav.pop() }, onOptions = { composer.focusRequest = false; optionsSheet = true }, onMenu = { bounds ->
                        nav.menu = MenuRequest(buildList {
                            add(MenuItem("对话选项", "slider.horizontal.3") { optionsSheet = true })
                            add(MenuItem("复制对话 ID", "number") { controller.toast = "已复制"; copy(context, sessionId) })
                            add(MenuItem("回到底部", "arrow.down") { bridge.scroll("bottom") })
                            if (running) add(MenuItem("停止", "CircleStop", destructive = true, divider = true) { controller.stopTurn() })
                        }, bounds, alignEnd = true)
                    })
            }
            if (topExports) OnGlass(topBackdrop) { toolbar() } else toolbar()

            // Toast under the toolbar.
            AnimatedVisibility(
                visible = controller.toast != null,
                modifier = Modifier.align(Alignment.TopCenter).padding(top = statusTop + AAMetrics.toolbarHeight + AAMetrics.toastTop),
                enter = slideInVertically(iosSpring(AAMotion.toast.smooth)) { -it } + fadeIn(),
                exit = slideOutVertically(iosSpring(AAMotion.toast.smooth)) { -it } + fadeOut(),
            ) {
                var last by remember { mutableStateOf("") }
                controller.toast?.let { last = it }
                GlassCapsule(Modifier.pressable(Press.None) { controller.toast = null }, minHeight = 0.dp, horizontal = AAMetrics.toastPaddingHorizontal, vertical = AAMetrics.toastPaddingVertical) {
                    AAText(last, font = AAFonts.subheadline, weight = 500)
                }
            }

            // Bottom chrome: queued messages, approval dock, attachments, composer; rides the keyboard.
            Column(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                    .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))
                    .widthIn(max = AAMetrics.maximumContentWidth)
                    .onGloballyPositioned { bottomBarTop = it.positionInRoot().y },
            ) {
                QueuedStrip(control.queued, canSteer = online, onSteer = controller::steerQueued, onUnqueue = controller::unqueue)
                val request = control.pending.firstOrNull()
                AnimatedVisibility(request != null,
                    enter = slideInVertically(iosSpring(AAMotion.dockAppear.smooth)) { it / 2 } + fadeIn(),
                    exit = slideOutVertically(iosSpring(AAMotion.dockAppear.smooth)) { it / 2 } + fadeOut()) {
                    var shown by remember { mutableStateOf(request) }
                    if (request != null) shown = request
                    shown?.let { r ->
                        Column(Modifier.padding(top = AAMetrics.dockTopGap, bottom = AAMetrics.dockToComposerGap - AAMetrics.composerTopPadding)) {
                            ApprovalDock(r, agentLabel.ifBlank { "Agent" }, control.pending.size, online, onMenu = { nav.menu = it }) { controller.answer(r.request_id, it) }
                        }
                    }
                }
                AttachmentStrip(controller.attachments, controller::removeAttachment)
                Composer(
                    state = composer,
                    running = running,
                    canSend = online && !controller.busy && controller.attachments.none { !it.ready && it.error == null },
                    canSteer = control.steer != "none",
                    placeholder = when {
                        !online -> "设备离线，暂时不能发送"
                        running -> "补充说明，回合结束后发送"
                        else -> "给 $agentLabel 发消息"
                    },
                    attachmentsReady = controller.attachments.any { it.ready },
                    maximumEditorHeight = maxEditor,
                    onSend = { val text = composer.draft.text; composer.draft = TextFieldValue(""); controller.send(text, if (running) "queue" else null) },
                    onSteer = { val text = composer.draft.text; composer.draft = TextFieldValue(""); controller.send(text, "steer") },
                    onStop = controller::stopTurn,
                    onPlus = { composer.focusRequest = false; optionsSheet = true },
                )
            }

            // 回到底部: a glass capsule above the bottom chrome.
            val pillVisible = bridge.isReady && !bridge.atBottom
            val pillY = with(density) { (bottomBarTop - AAMetrics.pillOffsetAboveBottomBar.toPx()).toDp() }
            AnimatedVisibility(pillVisible, Modifier.align(Alignment.TopCenter).offset(y = pillY),
                enter = scaleIn(iosSpring(AAMotion.pillAppear.smooth), initialScale = AAMotion.pillAppear.scaleFrom) + fadeIn(),
                exit = scaleOut(iosSpring(AAMotion.pillAppear.smooth), targetScale = AAMotion.pillAppear.scaleFrom) + fadeOut()) {
                Box(Modifier.height(44.dp), contentAlignment = Alignment.Center) {
                    GlassCapsule(Modifier.pressable(Press.Scale, label = "回到底部") { bridge.scroll("bottom") }, minHeight = AAMetrics.pillMinHeight, horizontal = AAMetrics.pillHorizontalPadding) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            AASymbol("arrow.down", size = AAMetrics.pillIcon)
                            AAText("回到底部", font = AAFonts.footnote, weight = 500)
                        }
                    }
                }
            }
        }
      }
        CompositionLocalProvider(LocalWebBackdrop provides null) {
            ConversationOptionsSheet(optionsSheet, controller, online, onDismiss = { optionsSheet = false }, onAttach = { optionsSheet = false; pick.launch("*/*") })
        }
    }
}

private fun copy(context: android.content.Context, text: String) {
    context.getSystemService(android.content.ClipboardManager::class.java).setPrimaryClip(android.content.ClipData.newPlainText("AA", text))
}

private data class HeaderStatus(val text: String, val symbol: String?, val progress: Boolean)

private fun statusText(phase: String, running: Boolean, waiting: Boolean, online: Boolean, error: String?): HeaderStatus? = when {
    !online -> HeaderStatus("设备离线 · 只读", "WifiOff", false)
    phase == "connecting" -> HeaderStatus("正在连接", null, true)
    phase == "error" || (phase == "cached" && error != null) -> HeaderStatus(error ?: "连接已断开", "CircleAlert", false)
    waiting -> HeaderStatus("等待回应", "Hand", false)
    running -> HeaderStatus("正在处理", null, true)
    else -> null
}

/** iOS toolbar: ‹ back, title / status, options + menu in one glass group. */
@Composable
private fun ConversationToolbar(
    title: String, subtitle: String, status: HeaderStatus?, running: Boolean, statusTop: androidx.compose.ui.unit.Dp,
    onBack: () -> Unit, onOptions: () -> Unit, onMenu: (Rect) -> Unit,
) {
    var menuBounds by remember { mutableStateOf(Rect.Zero) }
    Row(
        Modifier.padding(top = statusTop).fillMaxWidth().height(AAMetrics.toolbarHeight).padding(horizontal = AAMetrics.toolbarHorizontalInset),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        GlassCircleButton("ChevronLeft", "返回", onClick = onBack)
        Spacer(Modifier.size(AAMetrics.toolbarTitleGap))
        Column(Modifier.weight(1f).claimTouches(), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            AAText(title, Modifier.semantics { heading() }, font = AAFonts.headline, maxLines = 1)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.height(16.dp)) {
                when {
                    status == null -> {}
                    status.progress -> AASpinner(12.dp, AA.colors.controlSecondaryLabel)
                    status.symbol != null -> AASymbol(status.symbol, size = 12.dp, tint = AA.colors.controlSecondaryLabel)
                }
                AAText(listOfNotNull(status?.text, subtitle.takeIf { it.isNotEmpty() }).joinToString(" · "), font = AAFonts.caption,
                    color = AA.colors.controlSecondaryLabel, maxLines = 1)
            }
        }
        Spacer(Modifier.size(AAMetrics.toolbarTitleGap))
        GlassToolbarGroup { interaction ->
            GlassToolbarAction("slider.horizontal.3", "对话选项", interaction, onClick = onOptions)
            GlassToolbarAction("ellipsis", "更多", interaction, modifier = Modifier.onGloballyPositioned { menuBounds = it.boundsInRoot() }) { onMenu(menuBounds) }
        }
    }
    @Suppress("UNUSED_EXPRESSION") running
}

/** Attachments and the agent's options (model, reasoning effort, permission mode …: `session.config` → `set_config`). */
@Composable
private fun ConversationOptionsSheet(visible: Boolean, controller: ConversationController, online: Boolean, onDismiss: () -> Unit, onAttach: () -> Unit) {
    var editing by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(visible) { if (!visible) editing = null }
    val config = controller.session?.config.orEmpty()
    AASheet(visible = visible, onDismiss = onDismiss) {
        val option: ConfigOption? = editing?.let { id -> config.firstOrNull { it.id == id } }
        SheetHeader(option?.name ?: "对话选项", back = option != null) { if (option != null) editing = null else onDismiss() }
        Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState())) {
            if (option == null) {
                GroupedSection {
                    ListRow("添加附件", subtitle = "图片或文件，保存到设备上的对话目录（≤ 8 MB）", symbol = "Plus", enabled = online, separator = false, onClick = onAttach)
                }
                if (config.isNotEmpty()) GroupedSection(header = "Agent 设置") {
                    config.forEachIndexed { i, o ->
                        ListRow(o.name.ifBlank { o.id }, value = o.currentName, chevron = true, enabled = online, separator = i < config.lastIndex) { editing = o.id }
                    }
                } else GroupedSection(footer = "这个 Agent 没有可调整的设置。") {}
            } else {
                GroupedSection(footer = option.description) {
                    option.options.forEachIndexed { i, choice ->
                        ListRow(choice.name.ifBlank { choice.value }, subtitle = choice.description,
                            trailing = if (choice.value == option.current) ({ AASymbol("Check", size = 18.dp, tint = Ios.colors.tint) }) else null,
                            separator = i < option.options.lastIndex, enabled = online) {
                            controller.setConfig(option.id, choice.value)
                            editing = null
                        }
                    }
                }
            }
            Spacer(Modifier.height(32.dp))
        }
    }
}
