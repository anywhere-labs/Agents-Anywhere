package com.agentsanywhere.app.ui.screens.devices

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceAgentScanResult
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Terminal
import com.composables.icons.lucide.X
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AddAgentSheet(
    device: AgentDevice,
    onDismiss: () -> Unit,
    onScanDeviceAgent: suspend (String, String, String) -> Result<DeviceAgentScanResult>,
) {
    val colors = LocalAAColors.current
    val context = LocalContext.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val sheet = if (darkMode) Color(0xFF18181B) else Color(0xFFFDFCFB)
    val handle = if (darkMode) Color(0xFF3F3F46) else Color(0xFFD8D5CF)
    val scope = rememberCoroutineScope()
    val available = remember(device.id) {
        AddableAgentRuntime.entries.filterNot { it.id in device.attachedRuntimes }
    }
    var runtime by remember(device.id) { mutableStateOf(available.firstOrNull() ?: AddableAgentRuntime.Codex) }
    var customPath by remember(device.id) { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var scanResult by remember { mutableStateOf<AddAgentScanUiResult?>(null) }

    fun scan() {
        if (busy || available.isEmpty()) return
        busy = true
        error = null
        scanResult = null
        scope.launch {
            onScanDeviceAgent(device.id, runtime.id, customPath)
                .onSuccess { result ->
                    scanResult = AddAgentScanUiResult(
                        runtime = result.runtime,
                        outcome = deriveAddAgentOutcome(result.runtime, result.report),
                        report = result.report,
                        attached = result.runtime in result.attachedRuntimes,
                    )
                }
                .onFailure { scanError ->
                    error = scanError.message ?: context.getString(R.string.add_agent_scan_failed)
                }
            busy = false
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        containerColor = sheet,
        contentColor = colors.ink,
        dragHandle = null,
        scrimColor = if (darkMode) Color(0x99000000) else Color(0x66000000),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(start = 22.dp, end = 22.dp, top = 10.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    modifier = Modifier
                        .width(40.dp)
                        .height(4.dp)
                        .clip(CircleShape)
                        .background(handle),
                )
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(34.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    text = stringResource(R.string.add_agent_title),
                    modifier = Modifier.weight(1f),
                    color = colors.ink,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.ExtraBold,
                    lineHeight = 24.sp,
                    maxLines = 1,
                )
                RoundIconAction(
                    icon = Lucide.X,
                    contentDescription = stringResource(R.string.common_close),
                    danger = false,
                    onClick = onDismiss,
                )
            }
            Text(
                text = stringResource(R.string.add_agent_intro),
                color = colors.muted,
                fontSize = 12.8.sp,
                fontWeight = FontWeight.Medium,
                lineHeight = 17.sp,
            )
            if (available.isEmpty()) {
                AddAgentResultChip(
                    outcome = AddAgentOutcome.Ok,
                    message = stringResource(R.string.add_agent_all_attached),
                )
            } else {
                AddAgentLabel(stringResource(R.string.add_agent_type))
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(50.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    available.forEach { option ->
                        AddAgentRuntimeOption(
                            option = option,
                            selected = runtime == option,
                            enabled = !busy,
                            modifier = Modifier.weight(1f),
                            onClick = {
                                runtime = option
                                scanResult = null
                                error = null
                            },
                        )
                    }
                }
                AddAgentLabel(stringResource(R.string.add_agent_custom_path))
                AddAgentPathInput(
                    value = customPath,
                    placeholder = runtime.placeholder,
                    enabled = !busy,
                    onValueChange = {
                        customPath = it
                        scanResult = null
                        error = null
                    },
                )
                scanResult?.let { result ->
                    AddAgentResultChip(
                        outcome = result.outcome,
                        message = addAgentResultMessage(result),
                    )
                }
                error?.let { message ->
                    AddAgentResultChip(outcome = AddAgentOutcome.Failed, message = message)
                }
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(9.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.weight(1f)) {
                    SheetTextButton(
                        label = stringResource(R.string.common_cancel),
                        enabled = !busy,
                        primary = false,
                        modifier = Modifier.fillMaxWidth(),
                        onClick = onDismiss,
                    )
                }
                Box(Modifier.weight(1f)) {
                    SheetTextButton(
                        label = when {
                            busy -> stringResource(R.string.add_agent_scanning)
                            scanResult?.attached == true -> stringResource(R.string.common_done)
                            else -> stringResource(R.string.add_agent_scan)
                        },
                        enabled = !busy && available.isNotEmpty(),
                        primary = true,
                        modifier = Modifier.fillMaxWidth(),
                        onClick = {
                            if (scanResult?.attached == true) onDismiss() else scan()
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun AddAgentLabel(text: String) {
    Text(
        text = text,
        color = LocalAAColors.current.faint,
        fontSize = 11.2.sp,
        fontWeight = FontWeight.ExtraBold,
        maxLines = 1,
    )
}

@Composable
private fun AddAgentRuntimeOption(
    option: AddableAgentRuntime,
    selected: Boolean,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val border = when {
        selected && darkMode -> Color(0xFF57534E)
        selected -> Color(0xFFD8D1C8)
        darkMode -> Color(0xFF27272A)
        else -> Color(0xFFE8E5DF)
    }
    val surface = if (darkMode) Color(0xFF111113) else Color.White

    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(50.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(surface)
            .border(1.dp, border, RoundedCornerShape(8.dp))
            .noRippleClickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(option.accent),
        )
        Text(
            text = option.label,
            modifier = Modifier.weight(1f),
            color = colors.ink,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (selected) {
            Icon(
                imageVector = Lucide.Check,
                contentDescription = null,
                tint = option.accent,
                modifier = Modifier.size(13.dp),
            )
        }
    }
}

@Composable
private fun AddAgentPathInput(
    value: String,
    placeholder: String,
    enabled: Boolean,
    onValueChange: (String) -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)

    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        singleLine = true,
        modifier = Modifier
            .fillMaxWidth()
            .height(42.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (darkMode) Color(0xFF111113) else Color.White)
            .border(1.dp, colors.border, RoundedCornerShape(8.dp))
            .padding(horizontal = 11.dp),
        textStyle = TextStyle(
            color = colors.ink,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            fontFamily = FontFamily.Monospace,
        ),
        cursorBrush = SolidColor(colors.ink),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        decorationBox = { innerTextField ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(
                    imageVector = Lucide.Terminal,
                    contentDescription = null,
                    tint = colors.faint,
                    modifier = Modifier.size(13.dp),
                )
                Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                    if (value.isBlank()) {
                        Text(
                            text = placeholder,
                            color = colors.faint,
                            fontSize = 10.8.sp,
                            fontWeight = FontWeight.SemiBold,
                            fontFamily = FontFamily.Monospace,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    innerTextField()
                }
            }
        },
    )
}

@Composable
private fun AddAgentResultChip(
    outcome: AddAgentOutcome,
    message: String,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val dot = when (outcome) {
        AddAgentOutcome.Ok -> Color(0xFF34C759)
        AddAgentOutcome.Missing -> Color(0xFFB77742)
        AddAgentOutcome.Failed -> colors.errorText
    }
    val surface = when {
        outcome == AddAgentOutcome.Ok && darkMode -> Color(0xFF102419)
        outcome == AddAgentOutcome.Ok -> Color(0xFFF4FAF5)
        darkMode -> Color(0xFF211A12)
        else -> Color(0xFFFFFAF2)
    }
    val border = when {
        outcome == AddAgentOutcome.Ok && darkMode -> Color(0xFF1F5134)
        outcome == AddAgentOutcome.Ok -> Color(0xFFDDEBDF)
        darkMode -> Color(0xFF4A3217)
        else -> Color(0xFFEEDFC9)
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(60.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(surface)
            .border(1.dp, border, RoundedCornerShape(8.dp))
            .padding(horizontal = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(dot),
        )
        Text(
            text = message,
            modifier = Modifier.weight(1f),
            color = if (outcome == AddAgentOutcome.Ok) colors.ink else colors.muted,
            fontSize = 12.5.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 16.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

private enum class AddableAgentRuntime(
    val id: String,
    val label: String,
    val placeholder: String,
    val accent: Color,
) {
    Codex("codex", "Codex", "/usr/local/bin/codex", Color(0xFF4DBA72)),
    Claude("claude", "Claude Code", "/usr/local/bin/claude", Color(0xFFB77742)),
    Gemini("gemini", "Gemini CLI", "/usr/local/bin/gemini", Color(0xFF4285F4)),
    GrokBuild("grok_build", "Grok Build", "/usr/local/bin/grok", Color(0xFF111111)),
    Cursor("cursor", "Cursor", "/usr/local/bin/agent", Color(0xFF7C3AED)),
    CodeBuddy("codebuddy", "CodeBuddy", "/usr/local/bin/codebuddy", Color(0xFF0052D9)),
}

private enum class AddAgentOutcome {
    Ok,
    Missing,
    Failed,
}

private data class AddAgentScanUiResult(
    val runtime: String,
    val outcome: AddAgentOutcome,
    val report: Map<String, Any?>,
    val attached: Boolean,
)

private fun deriveAddAgentOutcome(runtime: String, report: Map<String, Any?>): AddAgentOutcome {
    if (report["execution"] == "ok") return AddAgentOutcome.Ok
    if (
        runtime == "claude" &&
        report["error"] == null &&
        (report["history"] == "ok" || report["history"] == "ok_empty")
    ) {
        return AddAgentOutcome.Ok
    }
    val checked = report["checked"] as? List<*> ?: emptyList<Any>()
    if (checked.isNotEmpty() && checked.all { (it as? Map<*, *>)?.get("status") == "missing" }) {
        return AddAgentOutcome.Missing
    }
    return AddAgentOutcome.Failed
}

@Composable
private fun addAgentResultMessage(result: AddAgentScanUiResult): String {
    val label = addAgentRuntimeLabel(result.runtime)
    return when (result.outcome) {
        AddAgentOutcome.Ok -> {
            val selected = result.report["selected"] as? Map<*, *>
            val path = selected?.get("path") as? String ?: "(unknown path)"
            stringResource(R.string.add_agent_found, label, path)
        }
        AddAgentOutcome.Missing -> when (result.runtime) {
            "codex" -> stringResource(R.string.add_agent_codex_not_found)
            "claude" -> stringResource(R.string.add_agent_claude_not_found)
            else -> stringResource(R.string.add_agent_not_found, label)
        }
        AddAgentOutcome.Failed -> {
            val error = result.report["error"] as? Map<*, *>
            val checked = result.report["checked"] as? List<*>
            val reason = error?.get("message") as? String
                ?: checked
                    ?.asReversed()
                    ?.mapNotNull { entry -> (entry as? Map<*, *>)?.takeIf { it["status"] == "failed" }?.get("reason") as? String }
                    ?.firstOrNull()
                ?: stringResource(R.string.add_agent_check_failed)
            stringResource(R.string.add_agent_found_check_failed, reason)
        }
    }
}

private fun addAgentRuntimeLabel(runtime: String): String {
    return AddableAgentRuntime.entries.firstOrNull { it.id == runtime }?.label ?: runtime
}
