package com.agentsanywhere.app.ui.screens.devices

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.agentsanywhere.app.feature.devices.DeviceDetailAgent
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable

internal sealed interface DeviceConfirmAction {
    data object DeleteDevice : DeviceConfirmAction
    data class RevokeDevice(val deviceName: String) : DeviceConfirmAction
    data class DeleteAgent(val agent: DeviceDetailAgent) : DeviceConfirmAction
}

@Composable
internal fun DeviceConfirmDialog(
    action: DeviceConfirmAction,
    busy: Boolean,
    errorMessage: String?,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val shape = RoundedCornerShape(26.dp)
    val surface = if (darkMode) Color(0xFF18181B) else Color.White
    val secondaryButton = if (darkMode) Color(0xFF27272A) else Color(0xFFF3F3F3)
    val title: String
    val body: String
    val confirmLabel: String

    when (action) {
        DeviceConfirmAction.DeleteDevice -> {
            title = "Delete this device?"
            body = "This removes the device and deletes all server records tied to it, including its sessions, workspaces, attached agents, runtime settings, and connector token. To bring it back you'll need to pair it again."
            confirmLabel = when {
                busy -> "Deleting..."
                errorMessage != null -> "Retry delete"
                else -> "Delete"
            }
        }
        is DeviceConfirmAction.RevokeDevice -> {
            title = "Revoke this device token?"
            body = "The current connector token for ${action.deviceName} will stop working and the device will be disconnected until you run the new setup command."
            confirmLabel = if (busy) "Revoking..." else "Revoke"
        }
        is DeviceConfirmAction.DeleteAgent -> {
            val label = action.agent.label
            title = "Remove $label from this device?"
            body = "Removing $label only forgets it on the server - your local install on this machine is untouched. All chat sessions for $label on this device will be permanently removed. To bring $label back later, click + Add above."
            confirmLabel = when {
                busy -> "Removing..."
                errorMessage != null -> "Retry remove"
                else -> "Remove agent"
            }
        }
    }

    Dialog(
        onDismissRequest = { if (!busy) onDismiss() },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Column(
            modifier = Modifier
                .padding(horizontal = 22.dp)
                .widthIn(max = 380.dp)
                .shadow(34.dp, shape, ambientColor = Color(0x33000000), spotColor = Color(0x33000000))
                .clip(shape)
                .background(surface)
                .border(1.dp, colors.border, shape)
                .padding(22.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Text(
                text = title,
                color = colors.ink,
                fontSize = 24.sp,
                fontWeight = FontWeight.ExtraBold,
                lineHeight = 29.sp,
            )
            Text(
                text = body,
                color = colors.muted,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                lineHeight = 21.sp,
            )
            errorMessage?.let { message ->
                Text(
                    text = message,
                    color = colors.errorText,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    lineHeight = 17.sp,
                )
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                DeviceDialogButton(
                    label = "Cancel",
                    background = secondaryButton,
                    content = colors.ink,
                    enabled = !busy,
                    modifier = Modifier.weight(1f),
                    onClick = onDismiss,
                )
                DeviceDialogButton(
                    label = confirmLabel,
                    background = colors.errorText.copy(alpha = if (busy) 0.38f else 1f),
                    content = Color.White,
                    enabled = !busy,
                    modifier = Modifier.weight(1f),
                    onClick = onConfirm,
                )
            }
        }
    }
}

@Composable
private fun DeviceDialogButton(
    label: String,
    background: Color,
    content: Color,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Box(
        modifier = modifier
            .height(50.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(background)
            .noRippleClickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = content.copy(alpha = if (enabled) 1f else 0.55f),
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold,
            lineHeight = 19.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
