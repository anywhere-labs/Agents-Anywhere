package dev.agentsanywhere.v3poc.ui

import dev.agentsanywhere.v3poc.design.continuousRect
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.animation.core.FastOutLinearInEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import dev.agentsanywhere.v3poc.App
import dev.agentsanywhere.v3poc.design.AA
import dev.agentsanywhere.v3poc.design.AAFonts
import dev.agentsanywhere.v3poc.design.AAMetrics
import dev.agentsanywhere.v3poc.design.AASheet
import dev.agentsanywhere.v3poc.design.AASwitch
import dev.agentsanywhere.v3poc.design.AASymbol
import dev.agentsanywhere.v3poc.design.AAText
import dev.agentsanywhere.v3poc.design.AccountAvatar
import dev.agentsanywhere.v3poc.design.GlassButton
import dev.agentsanywhere.v3poc.design.GlassMode
import dev.agentsanywhere.v3poc.design.LocalGlassMode
import dev.agentsanywhere.v3poc.design.Press
import dev.agentsanywhere.v3poc.design.SheetHeader
import dev.agentsanywhere.v3poc.design.iosSpring
import dev.agentsanywhere.v3poc.design.pressable
import dev.agentsanywhere.v3poc.model.ConfigOption
import dev.agentsanywhere.v3poc.model.SessionController

/** The cards inside a glass sheet (iOS `ComposerOptionSurface`). */
@Composable
private fun Modifier.sheetCard() = this.background(AA.colors.sheetCard, continuousRect(AAMetrics.sheetCardCornerRadius))

@Composable
private fun sheetBottom() = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()

/**
 * iOS `ComposerOptionsSheet`: photo / file tiles, one row per `session.config` option (generic over `ConfigOption`,
 * nothing keyed on the agent) pushing a value list, and context usage from `control.usage`.
 */
@Composable
fun OptionsSheet(controller: SessionController, ui: UiState) {
    var page by remember { mutableStateOf<String?>(null) }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(5)) { if (it.isNotEmpty()) controller.showToast("演示：附件不会上传") }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { if (it.isNotEmpty()) controller.showToast("演示：附件不会上传") }
    val density = LocalDensity.current
    AASheet(ui.optionsSheet, onDismiss = { ui.optionsSheet = false; page = null }) {
        // Material's shared axis X transition between the levels of a long list: the outgoing page fades out over
        // the first 90 ms while moving 30 dp, the incoming one fades in after it, both moving the same way. The sheet
        // follows the new page's height (SizeTransform, clipped to the sheet).
        AnimatedContent(page, Modifier.fillMaxWidth(), label = "options", transitionSpec = {
            val forward = targetState != null
            val distance = with(density) { 30.dp.roundToPx() }
            val move = tween<IntOffset>(300, easing = FastOutSlowInEasing)
            (slideInHorizontally(move) { if (forward) distance else -distance } + fadeIn(tween(210, delayMillis = 90, easing = LinearOutSlowInEasing))) togetherWith
                (slideOutHorizontally(move) { if (forward) -distance else distance } + fadeOut(tween(90, easing = FastOutLinearInEasing))) using
                SizeTransform(clip = true)
        }) { current ->
            val option = current?.let { id -> controller.config.firstOrNull { it.id == id } }
            if (option == null) {
                Column(Modifier.fillMaxWidth()) {
                    SheetHeader("对话选项") { ui.optionsSheet = false }
                    Column(
                        Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
                            .padding(start = AAMetrics.sheetContentPadding, end = AAMetrics.sheetContentPadding, top = AAMetrics.sheetContentPadding, bottom = AAMetrics.sheetContentPadding + sheetBottom()),
                        verticalArrangement = Arrangement.spacedBy(AAMetrics.sheetSectionSpacing),
                    ) {
                        Row(horizontalArrangement = Arrangement.spacedBy(AAMetrics.sheetTileSpacing)) {
                            Tile("照片", "photo.on.rectangle", Modifier.weight(1f)) {
                                ui.optionsSheet = false
                                photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                            }
                            Tile("文件", "doc", Modifier.weight(1f)) { ui.optionsSheet = false; files.launch(arrayOf("*/*")) }
                        }
                        val config = controller.config
                        if (config.isNotEmpty()) {
                            Column(Modifier.fillMaxWidth().sheetCard()) {
                                config.forEachIndexed { index, o ->
                                    if (index > 0) Box(Modifier.padding(start = AAMetrics.sheetRowDividerLeading).fillMaxWidth().height(0.5.dp).background(AA.colors.separator))
                                    // Short value lists open a dropdown on the row (Material's exposed menu); long ones
                                    // move to their own page.
                                    if (o.options.size <= SHORT_LIST) OptionDropdownRow(o) { controller.setConfig(o.id, it) }
                                    else OptionRow(o) { page = o.id }
                                }
                            }
                        } else {
                            AAText("Agent 还没有报告可调整的设置", font = AAFonts.footnote, color = AA.colors.secondaryLabel)
                        }
                        controller.usage?.let { (used, size) ->
                            Row(Modifier.fillMaxWidth().sheetCard().padding(AAMetrics.sheetRowPadding), verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(AAMetrics.sheetRowIconGap)) {
                                ContextRing((used / size).toFloat())
                                Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                                    AAText("上下文")
                                    AAText("${Math.round(used / size * 100)}% · ${(used / 1000).toInt()}k / ${(size / 1000).toInt()}k tokens",
                                        font = AAFonts.subheadline, color = AA.colors.secondaryLabel)
                                }
                            }
                        }
                    }
                }
            } else {
                Column(Modifier.fillMaxWidth()) {
                    SheetHeader(option.name, back = true) { page = null }
                    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
                        .padding(start = AAMetrics.sheetContentPadding, end = AAMetrics.sheetContentPadding, top = AAMetrics.sheetContentPadding, bottom = AAMetrics.sheetContentPadding + sheetBottom())) {
                        Column(Modifier.fillMaxWidth().sheetCard()) {
                            option.options.forEachIndexed { index, value ->
                                if (index > 0) Box(Modifier.padding(start = 48.dp).fillMaxWidth().height(0.5.dp).background(AA.colors.separator))
                                SelectionRow(value.name, value.description, value.value == option.current) {
                                    controller.setConfig(option.id, value.value)
                                    page = null
                                }
                            }
                        }
                        option.options.firstOrNull { it.value == option.current }?.description?.let {
                            AAText(it, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), font = AAFonts.footnote, color = AA.colors.secondaryLabel)
                        }
                    }
                }
            }
        }
    }
}

private fun icon(category: String?) = when (category) {
    "model" -> "sparkles"
    "mode" -> "checkmark.shield"
    "thought_level" -> "bolt"
    else -> "slider.horizontal.3"
}

@Composable
private fun Tile(title: String, symbol: String, modifier: Modifier, onClick: () -> Unit) {
    Column(
        modifier.height(AAMetrics.sheetTileHeight).sheetCard().pressable(Press.Dim, onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
    ) {
        AASymbol(symbol, size = AAMetrics.sheetTileIcon)
        AAText(title, font = AAFonts.subheadline, weight = 500)
    }
}

@Composable
private fun OptionRow(option: ConfigOption, chevron: String = "chevron.right", onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().pressable(Press.Dim, onClick = onClick).padding(AAMetrics.sheetRowPadding),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(AAMetrics.sheetRowIconGap)) {
        Box(Modifier.width(AAMetrics.sheetRowIconColumn), contentAlignment = Alignment.Center) { AASymbol(icon(option.category), size = AAMetrics.sheetRowIcon) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            AAText(option.name)
            AAText(option.currentName, font = AAFonts.subheadline, color = AA.colors.secondaryLabel, maxLines = 2)
        }
        AASymbol(chevron, size = AAMetrics.sheetChevron, tint = AA.colors.secondaryLabel)
    }
}

/** Value lists up to this long open as a dropdown on their row; longer ones get their own page. */
private const val SHORT_LIST = 5

/** An option row whose values open in a Material dropdown menu anchored to the row (end-aligned), current one checked. */
@Composable
private fun OptionDropdownRow(option: ConfigOption, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val c = AA.colors
    Box(Modifier.fillMaxWidth()) {
        OptionRow(option, chevron = "chevron.down") { open = true }
        Box(Modifier.align(Alignment.BottomEnd)) {
            androidx.compose.material3.DropdownMenu(
                expanded = open,
                onDismissRequest = { open = false },
                containerColor = c.menuBackground.copy(alpha = 1f),
                shape = continuousRect(16.dp),
            ) {
                option.options.forEach { value ->
                    androidx.compose.material3.DropdownMenuItem(
                        text = {
                            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                AAText(value.name, weight = if (value.value == option.current) 600 else 400)
                                if (!value.description.isNullOrEmpty()) AAText(value.description, font = AAFonts.footnote, color = c.secondaryLabel, maxLines = 2)
                            }
                        },
                        leadingIcon = { Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) { if (value.value == option.current) AASymbol("checkmark", size = 18.dp) } },
                        onClick = { open = false; onPick(value.value) },
                    )
                }
            }
        }
    }
}

/** iOS `InlineSelectionButton`: checkmark column, title, optional detail. */
@Composable
private fun SelectionRow(title: String, detail: String?, selected: Boolean, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().pressable(Press.Dim, onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) { if (selected) AASymbol("checkmark", size = 18.dp) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            AAText(title, weight = 500)
            if (!detail.isNullOrEmpty()) AAText(detail, font = AAFonts.footnote, color = AA.colors.secondaryLabel)
        }
    }
}

/** Context window usage (`control.usage.used / size`). */
@Composable
private fun ContextRing(fraction: Float) {
    val c = AA.colors
    Canvas(Modifier.size(23.dp)) {
        val stroke = 3.dp.toPx()
        val inset = stroke / 2
        drawArc(c.secondaryLabel.copy(alpha = 0.25f), 0f, 360f, false, Offset(inset, inset), Size(size.width - stroke, size.height - stroke), style = Stroke(stroke))
        drawArc(if (fraction > 0.8f) c.orange else c.label, -90f, 360f * fraction.coerceIn(0f, 1f), false, Offset(inset, inset),
            Size(size.width - stroke, size.height - stroke), style = Stroke(stroke, cap = StrokeCap.Round))
    }
}

/** `open` from the renderer: the page never navigates; native shows the target. */
@Composable
fun OpenSheet(controller: SessionController) {
    var last by remember { mutableStateOf<SessionController.OpenRequest?>(null) }
    controller.openRequest?.let { last = it }
    val request = last ?: return
    AASheet(controller.openRequest != null, onDismiss = { controller.openRequest = null }, allowsLarge = false) {
        SheetHeader(request.title) { controller.openRequest = null }
        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            AAText(request.detail, Modifier.fillMaxWidth().background(AA.colors.fillTertiary, continuousRect(16.dp)).padding(16.dp), mono = true)
            AAText("演示：真实 App 会在这里通过设备预览文件，或交给系统打开链接。", font = AAFonts.footnote, color = AA.colors.secondaryLabel)
            GlassButton("复制", symbol = "doc.on.doc") {
                controller.copy(request.detail)
                controller.openRequest = null
            }
        }
    }
}

/** Placeholder for flows the PoC does not implement (pairing). */
@Composable
fun DemoSheet(ui: UiState) {
    var last by remember { mutableStateOf<Pair<String, String>?>(null) }
    ui.demoSheet?.let { last = it }
    val (title, message) = last ?: return
    AASheet(ui.demoSheet != null, onDismiss = { ui.demoSheet = null }, allowsLarge = false) {
        SheetHeader(title) { ui.demoSheet = null }
        Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
            AAText(message, color = AA.colors.secondaryLabel, align = TextAlign.Center)
        }
    }
}

/** The account sheet: who is signed in, and the 「毛玻璃效果」 setting (Android only; iOS has no such switch). */
@Composable
fun AccountSheet(controller: SessionController, ui: UiState, app: App) {
    val glass = app.glass
    AASheet(ui.accountSheet, onDismiss = { ui.accountSheet = false }) {
        SheetHeader("账号") { ui.accountSheet = false }
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(AAMetrics.sheetSectionSpacing)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                AccountAvatar(controller.account.name, 52.dp)
                Column {
                    AAText(controller.account.name, font = AAFonts.headline)
                    AAText(controller.account.email, font = AAFonts.subheadline, color = AA.colors.secondaryLabel)
                }
            }
            Column(Modifier.fillMaxWidth().sheetCard()) {
                SwitchRow("毛玻璃效果", glass.enabled && glass.supported, enabled = glass.supported) { glass.updateEnabled(it) }
                Box(Modifier.padding(start = 16.dp).fillMaxWidth().height(0.5.dp).background(AA.colors.separator))
                SwitchRow("省电模式下也开启", glass.ignorePowerSaver, enabled = glass.supported && glass.enabled) { glass.updateIgnorePowerSaver(it) }
                Box(Modifier.padding(start = 16.dp).fillMaxWidth().height(0.5.dp).background(AA.colors.separator))
                Box(Modifier.padding(start = 16.dp).fillMaxWidth().height(0.5.dp).background(AA.colors.separator))
                SwitchRow("面板和菜单的玻璃", glass.sheetGlass, enabled = glass.supported && glass.enabled) { glass.updateSheetGlass(it) }
                Box(Modifier.padding(start = 16.dp).fillMaxWidth().height(0.5.dp).background(AA.colors.separator))
                FrostRow(glass.frost, enabled = glass.mode == GlassMode.Blur) { glass.updateFrost(it) }
            }
            val note = when {
                !glass.supported -> "Android 12 以下没有实时模糊（RenderEffect），玻璃控件固定为不透明实色。"
                glass.accessibilitySolid -> "系统开启了提高对比度或关闭了动画：玻璃控件改用不透明实色。"
                glass.pausedForPowerSaver -> "省电模式下已暂停：玻璃控件改用不透明实色，不再录制背景。"
                glass.mode == GlassMode.Blur && !glass.sheetGlass -> "已开启：顶栏、输入框、审批区会模糊并折射背后的对话内容。面板和菜单的玻璃已关闭：它们改用不透明背景，不再录制整个屏幕，可以省电。"
                glass.mode == GlassMode.Blur -> "已开启：顶栏、输入框、审批区会模糊并折射背后的对话内容；面板和菜单会模糊背后的整个屏幕（包括侧栏），这部分最耗电，可以单独关闭。关闭总开关后控件外形不变，改用不透明实色，不再录制和模糊背景。"
                else -> "已关闭：玻璃控件使用不透明实色、高光边框和阴影，不录制背景。"
            }
            AAText(note, Modifier.padding(horizontal = 16.dp), font = AAFonts.footnote, color = AA.colors.secondaryLabel)
            Spacer(Modifier.height(sheetBottom()))
        }
    }
}

/** 「模糊程度」: a Material slider from clear (refraction only) to frosted; changes the glass live. */
@Composable
private fun FrostRow(value: Float, enabled: Boolean, onChange: (Float) -> Unit) {
    val c = AA.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)) {
        AAText("模糊程度", color = if (enabled) c.label else c.secondaryLabel)
        androidx.compose.material3.Slider(
            value = value, onValueChange = onChange, enabled = enabled,
            colors = androidx.compose.material3.SliderDefaults.colors(
                thumbColor = c.label, activeTrackColor = c.label, inactiveTrackColor = c.fillTertiary,
                disabledThumbColor = c.tertiaryLabel, disabledActiveTrackColor = c.tertiaryLabel, disabledInactiveTrackColor = c.fillTertiary,
            ),
        )
        Row(Modifier.fillMaxWidth()) {
            AAText("清透", Modifier.weight(1f), font = AAFonts.footnote, color = c.secondaryLabel)
            AAText("磨砂", font = AAFonts.footnote, color = c.secondaryLabel)
        }
    }
}

@Composable
private fun SwitchRow(title: String, checked: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        AAText(title, Modifier.weight(1f), color = if (enabled) AA.colors.label else AA.colors.secondaryLabel)
        AASwitch(checked, enabled, onChange)
    }
}
