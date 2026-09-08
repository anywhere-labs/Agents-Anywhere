package com.agentsanywhere.app.ui.screens.common

import androidx.compose.runtime.Composable
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.ui.designsystem.AADropdownMenu
import com.agentsanywhere.app.ui.designsystem.AADropdownMenuItem

@Composable
internal fun DevicePickerMenu(
    expanded: Boolean,
    devices: List<AgentDevice>,
    selectedDevice: AgentDevice?,
    onDismiss: () -> Unit,
    onSelectDevice: (AgentDevice) -> Unit,
) {
    val pickerDevices = devices.filter { it.online }
    if (pickerDevices.isEmpty()) return

    AADropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismiss,
    ) {
        pickerDevices.forEach { device ->
            AADropdownMenuItem(
                text = device.name,
                selected = device.id == selectedDevice?.id,
                onClick = { onSelectDevice(device); onDismiss() },
            )
        }
    }
}
