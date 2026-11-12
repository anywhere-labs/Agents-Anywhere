package com.agentsanywhere.app.ui.screens.devices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceSettingsState
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.RefreshCw

/** Switches the user chose for this device, saved on the Server and sent to the device. */
@Composable
internal fun DeviceSettingsSection(
    state: DeviceSettingsState,
    onConfirmQuitOnShutdownChange: (Boolean) -> Unit,
    onRetry: () -> Unit,
) {
    val colors = LocalAAColors.current
    SectionBlock(title = stringResource(R.string.device_detail_settings_section)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 64.dp)
                .padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    text = stringResource(R.string.device_settings_confirm_quit_title),
                    color = colors.ink,
                    fontSize = 16.5.sp,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    text = stringResource(R.string.device_settings_confirm_quit_description),
                    color = colors.muted,
                    fontSize = 11.5.sp,
                    fontWeight = FontWeight.Medium,
                    lineHeight = 15.sp,
                )
            }
            AgentSwitch(
                checked = state.settings?.confirmQuitOnShutdown ?: false,
                enabled = state.canEdit,
                onCheckedChange = onConfirmQuitOnShutdownChange,
            )
        }
        if (state.loadFailed) {
            Text(
                text = stringResource(R.string.device_settings_load_failed),
                color = colors.errorText,
                fontSize = 12.5.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 17.sp,
                modifier = Modifier.padding(vertical = 8.dp),
            )
            SmallActionButton(
                icon = Lucide.RefreshCw,
                label = stringResource(R.string.common_retry),
                danger = false,
                enabled = !state.loading,
                onClick = onRetry,
            )
        }
    }
}
