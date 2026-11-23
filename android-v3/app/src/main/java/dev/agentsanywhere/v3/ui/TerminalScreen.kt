package dev.agentsanywhere.v3.ui

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import dev.agentsanywhere.v3.design.AA
import dev.agentsanywhere.v3.design.AAFonts
import dev.agentsanywhere.v3.design.AAText
import dev.agentsanywhere.v3.design.LocalDark
import dev.agentsanywhere.v3.design.Press
import dev.agentsanywhere.v3.design.claimTouches
import dev.agentsanywhere.v3.design.pressable
import dev.agentsanywhere.v3.model.TerminalController

/**
 * A device terminal drawn by the render bundle, with a native extra-keys bar (Esc, Ctrl, Tab, arrows, PgUp/PgDn,
 * Home/End, ^C) that sends `term.key`; the page maps keys to bytes like the Web row and latches Ctrl itself.
 */
@Composable
fun TerminalScreen(deviceId: String, terminalId: String, created: Boolean = false) {
    val app = LocalApp.current
    val nav = LocalNavigator.current
    val bridge = app.bridge
    val controller = remember(deviceId, terminalId) { TerminalController(app.model, bridge, deviceId, terminalId, created) }
    DisposableEffect(controller) {
        controller.start()
        controller.loadInfo()
        onDispose { controller.stop() }
    }
    val dark = LocalDark.current
    val density = LocalDensity.current
    val configuration = LocalConfiguration.current
    val statusTop = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    var barTop by remember { mutableFloatStateOf(0f) }
    var rootHeight by remember { mutableFloatStateOf(0f) }
    var navHeight by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(dark, barTop, rootHeight, navHeight) {
        if (rootHeight > 0 && barTop > 0) {
            // The terminal sits between the opaque navigation bar and the keys bar.
            bridge.setTheme(dark, with(density) { navHeight.toDp().value }, with(density) { (rootHeight - barTop).toDp().value },
                configuration.fontScale, false, (configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == 0 && false)
        }
    }
    val device = app.model.device(deviceId)

    Box(Modifier.fillMaxSize().background(AA.colors.background).onGloballyPositioned { rootHeight = it.size.height.toFloat() }) {
        WebViewHost(bridge, controller, Modifier.fillMaxSize())
        Box(Modifier.onGloballyPositioned { navHeight = it.size.height.toFloat() }) {
            NavBar(title = "终端", subtitle = listOfNotNull(device?.name, phaseText(controller.phase, controller.error)).joinToString(" · "),
                onBack = { nav.pop() }, backLabel = device?.name ?: "设备", background = AA.colors.background)
        }
        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))
                .onGloballyPositioned { barTop = it.positionInRoot().y },
        ) {
            Row(
                Modifier.fillMaxWidth().background(Ios.colors.groupedBackground).claimTouches().horizontalScroll(rememberScrollState())
                    .padding(horizontal = 6.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                // Key names of aa.render/2 `term.key` (web-v3/embed/src/protocol.ts); `ctrl` alone latches Ctrl in the page
                // for the next character typed on the keyboard.
                KeyCap("Esc", "Escape") { controller.key("escape") }
                KeyCap("Ctrl", "Control（作用于下一个输入的字符）") { controller.key("ctrl") }
                KeyCap("Tab") { controller.key("tab") }
                KeyCap("^C", "Control-C") { controller.key("c", ctrl = true) }
                KeyCap("↑", "上") { controller.key("up") }
                KeyCap("↓", "下") { controller.key("down") }
                KeyCap("←", "左") { controller.key("left") }
                KeyCap("→", "右") { controller.key("right") }
                KeyCap("Home") { controller.key("home") }
                KeyCap("End") { controller.key("end") }
                KeyCap("PgUp", "Page Up") { controller.key("page_up") }
                KeyCap("PgDn", "Page Down") { controller.key("page_down") }
            }
        }
    }
}

private fun phaseText(phase: String, error: String?): String? = when (phase) {
    "attaching" -> "正在连接"
    "exited" -> "已退出"
    "error" -> error ?: "连接失败"
    else -> null
}

@Composable
private fun KeyCap(label: String, description: String? = null, latched: Boolean = false, onClick: () -> Unit) {
    val c = Ios.colors
    Box(
        Modifier.defaultMinSize(minWidth = 44.dp).height(36.dp)
            .background(if (latched) AA.colors.primaryControlBackground else c.cell, RoundedCornerShape(8.dp))
            .pressable(Press.Dim, label = description ?: label, onClick = onClick)
            .padding(horizontal = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        AAText(label, font = AAFonts.subheadline, weight = 600, mono = true,
            color = if (latched) AA.colors.primaryControlForeground else AA.colors.label, maxLines = 1)
    }
}
