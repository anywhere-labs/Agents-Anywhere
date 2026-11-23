package dev.agentsanywhere.v3.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.util.lerp
import dev.agentsanywhere.v3.core.model.PendingRequest
import dev.agentsanywhere.v3.core.model.QueuedMessage
import dev.agentsanywhere.v3.design.AA
import dev.agentsanywhere.v3.design.AAFonts
import dev.agentsanywhere.v3.design.AAMetrics
import dev.agentsanywhere.v3.design.AAMotion
import dev.agentsanywhere.v3.design.AASpinner
import dev.agentsanywhere.v3.design.AASymbol
import dev.agentsanywhere.v3.design.AAText
import dev.agentsanywhere.v3.design.GlassButton
import dev.agentsanywhere.v3.design.GlassCircleButton
import dev.agentsanywhere.v3.design.MenuItem
import dev.agentsanywhere.v3.design.MenuRequest
import dev.agentsanywhere.v3.design.OnGlass
import dev.agentsanywhere.v3.design.Press
import dev.agentsanywhere.v3.design.claimTouches
import dev.agentsanywhere.v3.design.continuousRect
import dev.agentsanywhere.v3.design.glass
import dev.agentsanywhere.v3.design.iosSpring
import dev.agentsanywhere.v3.design.liquidPress
import dev.agentsanywhere.v3.design.pressable
import dev.agentsanywhere.v3.design.style
import dev.agentsanywhere.v3.model.PendingAttachment
import kotlin.math.roundToInt

/** Composer text, focus and requests, kept by the conversation screen. */
class ComposerState {
    var draft by mutableStateOf(TextFieldValue(""))
    var focused by mutableStateOf(false)
    /** true: focus and show the keyboard; false: clear focus; consumed by the composer. */
    var focusRequest by mutableStateOf<Boolean?>(null)
}

/**
 * The iOS `ChatComposer`: a 48 dp glass pill (+ · text · send) that grows into a card while focused or non-empty.
 * While the agent runs: with no text the button stops the turn; with text it sends (queued until the turn ends), and a
 * second button steers (interrupts and runs this next). Return inserts a newline; only the button sends.
 */
@Composable
fun Composer(
    state: ComposerState,
    running: Boolean,
    canSend: Boolean,
    canSteer: Boolean,
    placeholder: String,
    attachmentsReady: Boolean,
    maximumEditorHeight: Dp,
    onSend: () -> Unit,
    onSteer: () -> Unit,
    onStop: () -> Unit,
    onPlus: () -> Unit,
) {
    val hasText = state.draft.text.isNotBlank() || attachmentsReady
    val expanded = state.focused || state.draft.text.isNotEmpty()
    val t by animateFloatAsState(if (expanded) 1f else 0f, iosSpring(AAMotion.composerExpand.smooth), label = "composer")
    val focus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(state.focusRequest) {
        when (state.focusRequest) {
            true -> { focus.requestFocus(); keyboard?.show() }
            false -> focusManager.clearFocus()
            null -> {}
        }
        state.focusRequest = null
    }
    val c = AA.colors
    val horizontal = lerp(AAMetrics.composerCollapsedHorizontalInset.value, AAMetrics.composerExpandedHorizontalInset.value, t).dp
    val corner = lerp(AAMetrics.composerCollapsedCornerRadius.value, AAMetrics.composerExpandedCornerRadius.value, t).dp
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val stopMode = running && !hasText
    val enabled = stopMode || (canSend && hasText)
    val showSteer = running && hasText && canSteer && canSend

    Box(Modifier.fillMaxWidth().padding(start = horizontal, end = horizontal, top = AAMetrics.composerTopPadding, bottom = AAMetrics.composerBottomPadding)) {
        Layout(
            modifier = Modifier.fillMaxWidth().liquidPress().glass(continuousRect(corner), pressed = if (pressed) 0.6f else 0f).claimTouches(),
            content = {
                Box(Modifier.size(AAMetrics.touchTarget).pressable(Press.Dim, label = "附件与对话选项", onClick = onPlus), contentAlignment = Alignment.Center) {
                    AASymbol("plus", size = 24.dp)
                }
                BasicTextField(
                    value = state.draft,
                    onValueChange = { state.draft = it },
                    modifier = Modifier.focusRequester(focus).onFocusChanged { state.focused = it.isFocused }.semantics { contentDescription = "消息" },
                    textStyle = AAFonts.body.style(color = c.label),
                    cursorBrush = SolidColor(c.label),
                    interactionSource = interaction,
                    decorationBox = { inner ->
                        Box {
                            if (state.draft.text.isEmpty()) AAText(placeholder, color = c.controlSecondaryLabel, maxLines = 1)
                            inner()
                        }
                    },
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (showSteer) {
                        Box(Modifier.size(AAMetrics.touchTarget).pressable(Press.Scale, label = "插话（打断当前回合）", onClick = onSteer), contentAlignment = Alignment.Center) {
                            Box(Modifier.size(AAMetrics.sendDiameter).background(c.fillTertiary, CircleShape), contentAlignment = Alignment.Center) {
                                AASymbol("Zap", size = 17.dp)
                            }
                        }
                    }
                    Box(
                        Modifier.size(AAMetrics.touchTarget).pressable(Press.Scale, enabled, label = if (stopMode) "停止" else if (running) "排队发送" else "发送") { if (stopMode) onStop() else onSend() },
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(Modifier.size(AAMetrics.sendDiameter).graphicsLayer { alpha = if (enabled) 1f else 0.5f }.background(c.primaryControlBackground.copy(alpha = if (enabled) 1f else 0.42f), CircleShape),
                            contentAlignment = Alignment.Center) {
                            AASymbol(if (stopMode) "stop.fill" else "arrow.up", size = if (stopMode) 13.dp else 18.dp, tint = c.primaryControlForeground)
                        }
                    }
                }
            },
        ) { measurables, constraints ->
            val width = constraints.maxWidth
            val button = AAMetrics.touchTarget.roundToPx()
            val diameter = AAMetrics.controlDiameter.roundToPx()
            val collapsedInset = (diameter - button) / 2
            val textInset = AAMetrics.composerTextInset.roundToPx()
            val gap = AAMetrics.composerCollapsedTextGap.roundToPx()
            val plus = measurables[0].measure(Constraints.fixed(button, button))
            val send = measurables[2].measure(Constraints(maxWidth = button * 2, minHeight = button, maxHeight = button))
            val collapsedEditorWidth = width - (button + collapsedInset + gap) - (send.width + collapsedInset + gap)
            val expandedEditorWidth = width - textInset * 2
            val editorWidth = lerp(collapsedEditorWidth.toFloat(), expandedEditorWidth.toFloat(), t).roundToInt().coerceAtLeast(1)
            val editor = measurables[1].measure(Constraints(minWidth = editorWidth, maxWidth = editorWidth, minHeight = 0, maxHeight = maximumEditorHeight.roundToPx()))
            val textH = editor.height
            val expandedH = textInset + textH + AAMetrics.composerTextToActions.roundToPx() + button + AAMetrics.composerExpandedBottomInset.roundToPx()
            val h = lerp(diameter.toFloat(), expandedH.toFloat(), t).roundToInt()
            val inset = lerp(collapsedInset.toFloat(), AAMetrics.composerExpandedBottomInset.toPx(), t).roundToInt()
            val buttonY = lerp(h / 2f - button / 2f, (h - AAMetrics.composerExpandedBottomInset.toPx() - button), t).roundToInt()
            val editorX = lerp((collapsedInset + button + gap).toFloat(), textInset.toFloat(), t).roundToInt()
            val editorY = lerp((h - textH) / 2f, textInset.toFloat(), t).roundToInt()
            layout(width, h) {
                plus.place(inset, buttonY)
                send.place(width - inset - send.width, buttonY)
                editor.place(editorX, editorY)
            }
        }
    }
}

/** Picked attachments above the composer: name, size, upload state; tap × to remove. */
@Composable
fun AttachmentStrip(items: List<PendingAttachment>, onRemove: (String) -> Unit) {
    if (items.isEmpty()) return
    LazyRow(Modifier.fillMaxWidth().padding(horizontal = AAMetrics.composerExpandedHorizontalInset), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(items, key = { it.key }) { a ->
            Row(
                Modifier.height(36.dp).widthIn(max = 240.dp).glass(RoundedCornerShape(50)).claimTouches().padding(start = 12.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                when {
                    a.error != null -> AASymbol("CircleAlert", size = 16.dp, tint = Ios.colors.red)
                    !a.ready -> AASpinner(14.dp)
                    a.mime.startsWith("image/") -> AASymbol("Image", size = 16.dp)
                    else -> AASymbol("File", size = 16.dp)
                }
                AAText(a.error ?: a.name, Modifier.weight(1f, fill = false), font = AAFonts.footnote, maxLines = 1,
                    color = if (a.error != null) Ios.colors.red else AA.colors.label)
                Box(Modifier.size(32.dp).pressable(Press.Dim, label = "移除附件") { onRemove(a.key) }, contentAlignment = Alignment.Center) {
                    AASymbol("X", size = 14.dp, tint = AA.colors.controlSecondaryLabel)
                }
            }
        }
    }
}

/** Messages waiting for the running turn to end (`control.queued`): steer one now, or take it back. */
@Composable
fun QueuedStrip(items: List<QueuedMessage>, canSteer: Boolean, onSteer: (String) -> Unit, onUnqueue: (String) -> Unit) {
    if (items.isEmpty()) return
    Column(Modifier.fillMaxWidth().padding(horizontal = AAMetrics.dockOuterHorizontalInset, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        items.take(3).forEach { q ->
            Row(
                Modifier.fillMaxWidth().defaultMinSize(minHeight = 40.dp).glass(RoundedCornerShape(20.dp)).claimTouches().padding(start = 14.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AASymbol("Clock", size = 15.dp, tint = AA.colors.controlSecondaryLabel)
                AAText(q.content.ifBlank { "附件" }, Modifier.weight(1f).padding(horizontal = 8.dp), font = AAFonts.footnote, maxLines = 1)
                if (canSteer) Box(Modifier.size(36.dp).pressable(Press.Dim, label = "立即插话") { onSteer(q.client_msg_id) }, contentAlignment = Alignment.Center) {
                    AASymbol("Zap", size = 16.dp)
                }
                Box(Modifier.size(36.dp).pressable(Press.Dim, label = "撤回") { onUnqueue(q.client_msg_id) }, contentAlignment = Alignment.Center) {
                    AASymbol("Undo2", size = 16.dp)
                }
            }
        }
    }
}

/**
 * The iOS `ApprovalDock` for `control.pending[0]`, pinned above the composer: title in monospace, one glass button per
 * option, `allow_once` prominent; when they do not fit, `allow_always` moves into a 更多 menu.
 */
@Composable
fun ApprovalDock(request: PendingRequest, agentLabel: String, count: Int, enabled: Boolean, onMenu: (MenuRequest) -> Unit, onAnswer: (String) -> Unit) {
    val dockBackdrop = com.kyant.backdrop.backdrops.rememberLayerBackdrop()
    Column(
        Modifier.padding(horizontal = AAMetrics.dockOuterHorizontalInset).fillMaxWidth()
            .glass(continuousRect(AAMetrics.dockCornerRadius), exportTo = dockBackdrop)
            .claimTouches()
            .padding(horizontal = AAMetrics.dockPaddingHorizontal, vertical = AAMetrics.dockPaddingVertical),
        verticalArrangement = Arrangement.spacedBy(AAMetrics.dockSpacing),
    ) {
        Row(Modifier.fillMaxWidth().defaultMinSize(minHeight = AAMetrics.dockHeaderMinHeight), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AASymbol("checkmark.shield", size = AAMetrics.dockIcon)
            Box(Modifier.weight(1f)) { AAText("$agentLabel 请求权限", font = AAFonts.subheadline, weight = 600, maxLines = 1) }
            if (count > 1) AAText("1/$count", font = AAFonts.caption, color = AA.colors.controlSecondaryLabel)
        }
        AAText(request.title, Modifier.fillMaxWidth().defaultMinSize(minHeight = (AAFonts.subheadline.lineHeight * 2).dp),
            font = AAFonts.subheadline, mono = true, color = AA.colors.controlSecondaryLabel, maxLines = 3, top = true)
        OnGlass(dockBackdrop) {
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                val all = request.options
                val fits = all.size <= 2 || maxWidth > 360.dp
                val shown = if (fits) all else all.filter { it.kind != "allow_always" }
                val more = if (fits) emptyList() else all.filter { it.kind == "allow_always" }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (option in shown) {
                        GlassButton(option.name.ifBlank { option.kind }, Modifier.weight(1f), prominent = option.kind == "allow_once",
                            enabled = enabled, font = AAFonts.subheadline) { onAnswer(option.id) }
                    }
                    if (more.isNotEmpty()) {
                        var bounds by remember { mutableStateOf(Rect.Zero) }
                        GlassCircleButton("ellipsis", "更多", size = AAMetrics.glassButtonHeight, iconSize = 20.dp,
                            modifier = Modifier.onGloballyPositioned { bounds = it.boundsInRoot() }) {
                            onMenu(MenuRequest(more.map { o -> MenuItem(o.name) { onAnswer(o.id) } }, bounds, alignEnd = true))
                        }
                    }
                }
            }
        }
    }
}
