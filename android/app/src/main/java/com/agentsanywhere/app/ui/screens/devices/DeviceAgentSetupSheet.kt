package com.agentsanywhere.app.ui.screens.devices

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceAgentOperations
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.ui.designsystem.AABottomSheet
import com.agentsanywhere.app.ui.designsystem.AAToastHost
import com.agentsanywhere.app.ui.designsystem.AAToastVisuals
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import kotlinx.coroutines.launch

/**
 * Adds Agents to a newly connected device, or to one of [devices] from the empty-Agent
 * reminder. Leaving without any configured Agent asks once more before [onFinish].
 * [onCheckAgents] looks at every device; a failed check never keeps the user here.
 */
@Composable
internal fun DeviceAgentSetupSheet(
    devices: List<AgentDevice>,
    operations: DeviceAgentOperations,
    onCheckAgents: suspend () -> Result<Boolean>,
    onFinish: () -> Unit,
) {
    val first = devices.firstOrNull() ?: return
    val colors = LocalAAColors.current
    val scope = rememberCoroutineScope()
    val toastState = remember { SnackbarHostState() }
    var selectedId by remember { mutableStateOf(first.id) }
    val device = devices.firstOrNull { it.id == selectedId } ?: first
    val controller = rememberDeviceAgentsController(device.id, device.online, operations, discoverOnOpen = true)
    val state by controller.state.collectAsState()
    var checking by remember { mutableStateOf(false) }
    var showReminder by remember { mutableStateOf(false) }
    val idle = !checking && !state.busy

    fun finish() {
        if (!idle) return
        if (state.inventory.hasConfiguredRuntime) {
            onFinish()
            return
        }
        checking = true
        scope.launch {
            val configured = onCheckAgents().getOrDefault(true)
            checking = false
            if (configured) onFinish() else showReminder = true
        }
    }

    // Every exit goes through the Agent check, so the sheet never hides behind the reminder.
    AABottomSheet(
        title = stringResource(R.string.agent_setup_title),
        onDismissRequest = ::finish,
        dismissEnabled = idle,
        dismissOnGesture = false,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            AAToastHost(toastState)
            Text(
                text = stringResource(
                    if (device.online) R.string.agent_setup_online else R.string.agent_setup_waiting,
                    device.name,
                ),
                color = colors.inkSoft,
                fontSize = 14.sp,
                lineHeight = 20.sp,
            )
            Text(
                text = stringResource(R.string.agent_setup_hint),
                color = colors.muted,
                fontSize = 12.5.sp,
                lineHeight = 17.sp,
            )
            if (devices.size > 1) {
                DeviceChooser(
                    devices = devices,
                    selectedId = device.id,
                    enabled = idle,
                    onSelect = { selectedId = it },
                )
            }
            if (!device.online) {
                Row(
                    modifier = Modifier.fillMaxWidth().height(40.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    Text(
                        text = stringResource(R.string.device_pairing_waiting_online),
                        color = colors.muted,
                        fontSize = 13.sp,
                    )
                }
            }
            // Stays composed while the device reconnects, so open forms and running adds survive.
            DeviceAgentsPanel(
                controller = controller,
                online = device.online,
                onMessage = { message, isError ->
                    scope.launch {
                        toastState.currentSnackbarData?.dismiss()
                        toastState.showSnackbar(AAToastVisuals(message = message, isError = isError))
                    }
                },
                scope = scope,
            )
            SheetTextButton(
                label = if (checking) stringResource(R.string.common_checking) else stringResource(R.string.common_done),
                enabled = idle,
                primary = true,
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                onClick = ::finish,
            )
        }
    }

    if (showReminder) {
        DeviceConfirmDialog(
            title = stringResource(R.string.agent_reminder_title),
            body = stringResource(R.string.agent_reminder_description),
            confirmLabel = stringResource(R.string.agent_reminder_add),
            dismissLabel = stringResource(R.string.agent_reminder_skip),
            onDismiss = {
                showReminder = false
                onFinish()
            },
            onConfirm = { showReminder = false },
            onDismissRequest = { showReminder = false },
        )
    }
}

@Composable
private fun DeviceChooser(
    devices: List<AgentDevice>,
    selectedId: String,
    enabled: Boolean,
    onSelect: (String) -> Unit,
) {
    val colors = LocalAAColors.current
    val description = stringResource(R.string.agent_setup_choose_device)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .semantics { contentDescription = description },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        devices.forEach { device ->
            val selected = device.id == selectedId
            Box(
                modifier = Modifier
                    .height(34.dp)
                    .clip(CircleShape)
                    .background(
                        when {
                            selected && colors.isDark -> Color(0xFFE4E4E7)
                            selected -> Color(0xFF181816)
                            else -> Color.Transparent
                        },
                    )
                    .border(1.dp, if (selected) Color.Transparent else colors.border, CircleShape)
                    .semantics {
                        role = Role.RadioButton
                        this.selected = selected
                    }
                    .noRippleClickable(enabled = enabled && !selected) { onSelect(device.id) }
                    .padding(horizontal = 14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = device.name,
                    color = when {
                        selected && colors.isDark -> Color(0xFF181816)
                        selected -> Color.White
                        else -> colors.ink
                    },
                    fontSize = 13.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
