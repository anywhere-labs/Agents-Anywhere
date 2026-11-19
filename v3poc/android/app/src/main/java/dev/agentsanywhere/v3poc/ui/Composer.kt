package dev.agentsanywhere.v3poc.ui

import dev.agentsanywhere.v3poc.design.continuousRect
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.util.lerp
import dev.agentsanywhere.v3poc.design.AA
import dev.agentsanywhere.v3poc.design.claimTouches
import dev.agentsanywhere.v3poc.design.textScrim
import dev.agentsanywhere.v3poc.design.AAFonts
import dev.agentsanywhere.v3poc.design.AAMetrics
import dev.agentsanywhere.v3poc.design.AAMotion
import dev.agentsanywhere.v3poc.design.AASymbol
import dev.agentsanywhere.v3poc.design.AAText
import dev.agentsanywhere.v3poc.design.Press
import dev.agentsanywhere.v3poc.design.glass
import dev.agentsanywhere.v3poc.design.iosSpring
import dev.agentsanywhere.v3poc.design.liquidPress
import dev.agentsanywhere.v3poc.design.pressable
import dev.agentsanywhere.v3poc.design.style
import kotlin.math.roundToInt

/**
 * The iOS `ChatComposer`: a 48 dp glass pill (plus · text · send) that expands into a card while focused or
 * non-empty, keeping the same three children (and the IME state) and moving them, as `ComposerLayout` does.
 * The send button turns into stop while the agent runs. Return inserts a newline; only the button sends.
 */
@Composable
fun Composer(
    ui: UiState,
    running: Boolean,
    canSend: Boolean,
    placeholder: String,
    maximumEditorHeight: Dp,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onOptions: () -> Unit,
) {
    val expanded = ui.composerFocused || ui.draft.text.isNotEmpty()
    val t by animateFloatAsState(if (expanded) 1f else 0f, iosSpring(AAMotion.composerExpand.smooth), label = "composer")
    val focus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(ui.focusRequest) {
        when (ui.focusRequest) {
            true -> { focus.requestFocus(); keyboard?.show() }
            false -> focusManager.clearFocus()
            null -> {}
        }
        ui.focusRequest = null
    }
    val c = AA.colors
    val horizontal = lerp(AAMetrics.composerCollapsedHorizontalInset.value, AAMetrics.composerExpandedHorizontalInset.value, t).dp
    val corner = lerp(AAMetrics.composerCollapsedCornerRadius.value, AAMetrics.composerExpandedCornerRadius.value, t).dp
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val enabled = running || (canSend && ui.draft.text.isNotBlank())

    Box(Modifier.fillMaxWidth().padding(start = horizontal, end = horizontal, top = AAMetrics.composerTopPadding, bottom = AAMetrics.composerBottomPadding)) {
        Layout(
            modifier = Modifier.fillMaxWidth().liquidPress().glass(continuousRect(corner), pressed = if (pressed) 0.6f else 0f).claimTouches(),
            content = {
                Box(Modifier.size(AAMetrics.touchTarget).pressable(Press.Dim, label = "附件与对话选项", onClick = onOptions), contentAlignment = Alignment.Center) {
                    AASymbol("plus", size = 24.dp)
                }
                BasicTextField(
                    value = ui.draft,
                    onValueChange = { ui.draft = it },
                    modifier = Modifier.focusRequester(focus).onFocusChanged { ui.composerFocused = it.isFocused }.semantics { contentDescription = "消息" },
                    textStyle = AAFonts.body.style(color = c.label),
                    cursorBrush = SolidColor(c.label),
                    interactionSource = interaction,
                    decorationBox = { inner ->
                        Box {
                            if (ui.draft.text.isEmpty()) AAText(placeholder, Modifier.textScrim(), color = c.controlSecondaryLabel, maxLines = 1)
                            inner()
                        }
                    },
                )
                Box(
                    Modifier.size(AAMetrics.touchTarget).pressable(Press.Scale, enabled, label = if (running) "停止生成" else "发送消息") { if (running) onStop() else onSend() },
                    contentAlignment = Alignment.Center,
                ) {
                    // SwiftUI dims a disabled plain button to half opacity on top of the 0.42 background alpha.
                    Box(Modifier.size(AAMetrics.sendDiameter).graphicsLayer { alpha = if (enabled) 1f else 0.5f }.background(c.primaryControlBackground.copy(alpha = if (enabled) 1f else 0.42f), CircleShape),
                        contentAlignment = Alignment.Center) {
                        AASymbol(if (running) "stop.fill" else "arrow.up", size = if (running) 13.dp else 18.dp, tint = c.primaryControlForeground)
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
            val collapsedEditorWidth = width - (button + collapsedInset + gap) * 2
            val expandedEditorWidth = width - textInset * 2
            val editorWidth = lerp(collapsedEditorWidth.toFloat(), expandedEditorWidth.toFloat(), t).roundToInt().coerceAtLeast(1)
            val maxEditor = maximumEditorHeight.roundToPx()
            val plus = measurables[0].measure(Constraints.fixed(button, button))
            val editor = measurables[1].measure(Constraints(minWidth = editorWidth, maxWidth = editorWidth, minHeight = 0, maxHeight = maxEditor))
            val send = measurables[2].measure(Constraints.fixed(button, button))
            val textH = editor.height
            val expandedH = textInset + textH + AAMetrics.composerTextToActions.roundToPx() + button + AAMetrics.composerExpandedBottomInset.roundToPx()
            val h = lerp(diameter.toFloat(), expandedH.toFloat(), t).roundToInt()
            val inset = lerp(collapsedInset.toFloat(), AAMetrics.composerExpandedBottomInset.toPx(), t).roundToInt()
            val buttonY = lerp(h / 2f - button / 2f, (h - AAMetrics.composerExpandedBottomInset.toPx() - button), t).roundToInt()
            val editorX = lerp((collapsedInset + button + gap).toFloat(), textInset.toFloat(), t).roundToInt()
            val editorY = lerp((h - textH) / 2f, textInset.toFloat(), t).roundToInt()
            layout(width, h) {
                plus.place(inset, buttonY)
                send.place(width - inset - button, buttonY)
                editor.place(editorX, editorY)
            }
        }
    }
}
