package com.agentsanywhere.app.ui.designsystem

import androidx.compose.foundation.interaction.FocusInteraction
import androidx.compose.foundation.interaction.HoverInteraction
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.KeyRound
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Pencil
import com.composables.icons.lucide.Trash2

@Preview(name = "Model choices · dark", widthDp = 375, heightDp = 700)
@Composable
private fun ModelChoicesPreview() {
    AgentsAnywhereTheme(AAAppearanceMode.Dark) {
        AABottomSheetContent(title = "选择模型", onDismissRequest = {}) {
            listOf("GPT-6-Astra", "GPT-5.6-Sol", "GPT-5.6-Terra", "GPT-5.6-Luna", "GPT-5.5", "GPT-5.2").forEachIndexed { index, model ->
                AABottomSheetItem(text = model, selected = index == 0, onClick = {})
            }
            AABottomSheetItem(text = "模式与推理强度", supportingText = "请求批准 · Low", showChevron = true, onClick = {})
        }
    }
}

@Preview(name = "Device actions · dark", widthDp = 375, heightDp = 400)
@Composable
private fun DeviceActionsPreview() {
    AgentsAnywhereTheme(AAAppearanceMode.Dark) {
        AABottomSheetContent(title = "HUAWEI MateStation S", onDismissRequest = {}) {
            AABottomSheetItem(text = "重命名", icon = Lucide.Pencil, onClick = {})
            AABottomSheetItem(text = "撤销", icon = Lucide.KeyRound, onClick = {})
            AABottomSheetItem(text = "删除", icon = Lucide.Trash2, danger = true, onClick = {})
        }
    }
}

@Preview(name = "States · dark · 320", widthDp = 320, heightDp = 900)
@Preview(name = "States · dark · 375", widthDp = 375, heightDp = 900)
@Preview(name = "States · dark · 414", widthDp = 414, heightDp = 900)
@Preview(name = "States · dark · 768", widthDp = 768, heightDp = 900)
@Composable
private fun DarkStatesPreview() = SheetStates(AAAppearanceMode.Dark)

@Preview(name = "States · light · 320", widthDp = 320, heightDp = 900)
@Preview(name = "States · light · 375", widthDp = 375, heightDp = 900)
@Preview(name = "States · light · 414", widthDp = 414, heightDp = 900)
@Preview(name = "States · light · 768", widthDp = 768, heightDp = 900)
@Preview(name = "States · large text", widthDp = 320, heightDp = 1000, fontScale = 1.5f)
@Composable
private fun LightStatesPreview() = SheetStates(AAAppearanceMode.Light)

@Composable
private fun SheetStates(appearanceMode: String) {
    val hover = remember { MutableInteractionSource() }
    val focus = remember { MutableInteractionSource() }
    val press = remember { MutableInteractionSource() }
    LaunchedEffect(Unit) {
        hover.emit(HoverInteraction.Enter())
        focus.emit(FocusInteraction.Focus())
        press.emit(PressInteraction.Press(Offset.Zero))
    }
    AgentsAnywhereTheme(appearanceMode) {
        Box(Modifier.widthIn(max = 560.dp)) {
            AABottomSheetContent(title = "底部弹窗 · 状态预览", onDismissRequest = {}) {
                AABottomSheetItem(text = "默认", onClick = {})
                AABottomSheetItem(text = "悬停", interactionSource = hover, onClick = {})
                AABottomSheetItem(text = "键盘聚焦", interactionSource = focus, onClick = {})
                AABottomSheetItem(text = "按下", interactionSource = press, onClick = {})
                AABottomSheetItem(text = "暂不可用", supportingText = "等待设备上线后可选择", enabled = false, onClick = {})
                AABottomSheetItem(text = "正在保存", loading = true, onClick = {})
                AABottomSheetItem(text = "重试", errorMessage = "加载失败，请重试", onClick = {})
                AABottomSheetItem(text = "已选择", selected = true, onClick = {})
            }
        }
    }
}
