package com.agentsanywhere.app.ui.screens.devices

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceRuntimeList
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.X
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AddAgentSheet(
    device: AgentDevice,
    onDismiss: () -> Unit,
    onDiscoverDeviceRuntimes: suspend (String) -> Result<DeviceRuntimeList>,
) {
    val colors = LocalAAColors.current
    val context = LocalContext.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val sheet = if (darkMode) Color(0xFF18181B) else Color(0xFFFDFCFB)
    val handle = if (darkMode) Color(0xFF3F3F46) else Color(0xFFD8D5CF)
    val scope = rememberCoroutineScope()
    var busy by remember(device.id) { mutableStateOf(false) }
    var error by remember(device.id) { mutableStateOf<String?>(null) }
    var result by remember(device.id) { mutableStateOf<DeviceRuntimeList?>(null) }

    fun discover() {
        if (busy) return
        busy = true
        error = null
        result = null
        scope.launch {
            onDiscoverDeviceRuntimes(device.id)
                .onSuccess { result = it }
                .onFailure { failure ->
                    error = failure.message ?: context.getString(R.string.add_agent_scan_failed)
                }
            busy = false
        }
    }

    ModalBottomSheet(
        onDismissRequest = { if (!busy) onDismiss() },
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
            verticalArrangement = Arrangement.spacedBy(14.dp),
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
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    text = stringResource(R.string.add_agent_title),
                    modifier = Modifier.weight(1f),
                    color = colors.ink,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.ExtraBold,
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
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                lineHeight = 18.sp,
            )
            result?.let { discovered ->
                val message = if (discovered.runtimes.isEmpty()) {
                    stringResource(R.string.add_agent_none_found)
                } else {
                    stringResource(
                        R.string.add_agent_discovered,
                        discovered.runtimes.joinToString(", ") { it.displayName },
                    )
                }
                AddAgentMessage(message = message, error = false)
            }
            error?.let { AddAgentMessage(message = it, error = true) }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(9.dp),
            ) {
                SheetTextButton(
                    label = stringResource(R.string.common_cancel),
                    enabled = !busy,
                    primary = false,
                    modifier = Modifier.weight(1f),
                    onClick = onDismiss,
                )
                SheetTextButton(
                    label = when {
                        busy -> stringResource(R.string.add_agent_scanning)
                        result != null -> stringResource(R.string.common_done)
                        else -> stringResource(R.string.add_agent_scan)
                    },
                    enabled = !busy,
                    primary = true,
                    modifier = Modifier.weight(1f),
                    onClick = { if (result != null) onDismiss() else discover() },
                )
            }
        }
    }
}

@Composable
private fun AddAgentMessage(message: String, error: Boolean) {
    val colors = LocalAAColors.current
    Text(
        text = message,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(if (error) colors.errorText.copy(alpha = 0.1f) else colors.primaryAction.copy(alpha = 0.1f))
            .padding(12.dp),
        color = if (error) colors.errorText else colors.ink,
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
        lineHeight = 18.sp,
    )
}
