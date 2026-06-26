package com.agentsanywhere.app.ui.screens.common

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Lucide

@Composable
internal fun DevicePickerMenu(
    expanded: Boolean,
    devices: List<AgentDevice>,
    selectedDevice: AgentDevice?,
    onDismiss: () -> Unit,
    onSelectDevice: (AgentDevice) -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val surface = if (darkMode) Color(0xFF181818) else Color.White
    val border = if (darkMode) Color(0xFF2D2D2F) else Color(0xFFEFEDE9)
    val shadow = if (darkMode) Color(0x80000000) else Color(0x1A000000)
    val text = if (darkMode) Color(0xFFF4F4F5) else Color(0xFF2F302D)
    val pickerDevices = devices.filter { it.online }
    if (pickerDevices.isEmpty()) return

    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismiss,
        offset = DpOffset(x = 0.dp, y = 6.dp),
        shape = RoundedCornerShape(22.dp),
        containerColor = surface,
        tonalElevation = 0.dp,
        shadowElevation = 0.dp,
        modifier = Modifier
            .width(252.dp)
            .heightIn(max = 318.dp)
            .shadow(34.dp, RoundedCornerShape(22.dp), ambientColor = shadow, spotColor = shadow)
            .clip(RoundedCornerShape(22.dp))
            .background(surface)
            .border(1.dp, border, RoundedCornerShape(22.dp)),
    ) {
        Column(
            modifier = Modifier
                .padding(vertical = 7.dp),
        ) {
            pickerDevices.forEach { device ->
                val selected = device.id == selectedDevice?.id
                DevicePickerRow(
                    device = device,
                    selected = selected,
                    textColor = text,
                    onClick = {
                        onSelectDevice(device)
                        onDismiss()
                    },
                )
            }
        }
    }
}

@Composable
private fun DevicePickerRow(
    device: AgentDevice,
    selected: Boolean,
    textColor: Color,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(50.dp)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = device.name,
            modifier = Modifier.weight(1f),
            color = textColor,
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
            lineHeight = 20.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (selected) {
            Icon(
                imageVector = Lucide.Check,
                contentDescription = null,
                tint = textColor,
                modifier = Modifier.size(22.dp),
            )
        }
    }
}
