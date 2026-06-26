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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceDetailAgent
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable

internal sealed interface DeviceConfirmAction {
    data object DeleteDevice : DeviceConfirmAction
    data class RevokeDevice(val deviceName: String) : DeviceConfirmAction
    data class DeleteAgent(val agent: DeviceDetailAgent) : DeviceConfirmAction
    data class ArchiveAllSessions(
        val deviceName: String,
        val archived: Boolean,
        val scopeLabel: String,
    ) : DeviceConfirmAction
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
    val danger: Boolean

    when (action) {
        DeviceConfirmAction.DeleteDevice -> {
            danger = true
            title = stringResource(R.string.device_confirm_delete_device_title)
            body = stringResource(R.string.device_confirm_delete_device_body)
            confirmLabel = when {
                busy -> stringResource(R.string.device_confirm_deleting)
                errorMessage != null -> stringResource(R.string.device_confirm_retry_delete)
                else -> stringResource(R.string.common_delete)
            }
        }
        is DeviceConfirmAction.RevokeDevice -> {
            danger = true
            title = stringResource(R.string.device_confirm_revoke_title)
            body = stringResource(R.string.device_confirm_revoke_body, action.deviceName)
            confirmLabel = if (busy) stringResource(R.string.device_confirm_revoking) else stringResource(R.string.common_revoke)
        }
        is DeviceConfirmAction.DeleteAgent -> {
            danger = true
            val label = action.agent.label
            title = stringResource(R.string.device_confirm_remove_agent_title, label)
            body = stringResource(R.string.device_confirm_remove_agent_body, label)
            confirmLabel = when {
                busy -> stringResource(R.string.device_confirm_removing)
                errorMessage != null -> stringResource(R.string.device_confirm_retry_remove)
                else -> stringResource(R.string.device_confirm_remove_agent)
            }
        }
        is DeviceConfirmAction.ArchiveAllSessions -> {
            danger = false
            title = stringResource(
                if (action.archived) R.string.device_confirm_archive_all_title else R.string.device_confirm_unarchive_all_title,
                action.scopeLabel,
            )
            body = if (action.archived) {
                stringResource(R.string.device_confirm_archive_all_body, action.deviceName)
            } else {
                stringResource(R.string.device_confirm_unarchive_all_body, action.deviceName)
            }
            confirmLabel = if (busy) {
                stringResource(R.string.common_working)
            } else {
                stringResource(if (action.archived) R.string.device_confirm_archive_all_confirm else R.string.device_confirm_unarchive_all_confirm)
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
                    label = stringResource(R.string.common_cancel),
                    background = secondaryButton,
                    content = colors.ink,
                    enabled = !busy,
                    modifier = Modifier.weight(1f),
                    onClick = onDismiss,
                )
                DeviceDialogButton(
                    label = confirmLabel,
                    background = if (danger) {
                        colors.errorText.copy(alpha = if (busy) 0.38f else 1f)
                    } else if (darkMode) {
                        Color(0xFFE4E4E7)
                    } else {
                        Color(0xFF181816)
                    },
                    content = if (!danger && darkMode) Color(0xFF181816) else Color.White,
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
