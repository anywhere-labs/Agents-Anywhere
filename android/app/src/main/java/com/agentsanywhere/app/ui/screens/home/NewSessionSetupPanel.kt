package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.Bot
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Monitor
import com.composables.icons.lucide.RefreshCw

@Composable
internal fun NewSessionSetupPanel(
    state: NewSessionSetupState,
    refreshing: Boolean,
    onConnectDevice: () -> Unit,
    onOpenDevices: (AgentDevice?) -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current
    val reason = state.reason
    val checking = reason == NewSessionSetupReason.CheckingDevices || reason == NewSessionSetupReason.CheckingAgents
    val deviceStep = reason in setOf(
        NewSessionSetupReason.CheckingDevices, NewSessionSetupReason.DeviceLoadFailed,
        NewSessionSetupReason.NoDevices, NewSessionSetupReason.DevicesOffline,
    )
    val retryFirst = reason == NewSessionSetupReason.DeviceLoadFailed || reason == NewSessionSetupReason.AgentLoadFailed
    val (title, description) = when (reason) {
        NewSessionSetupReason.CheckingDevices -> R.string.new_session_checking_devices to R.string.new_session_checking_devices_description
        NewSessionSetupReason.DeviceLoadFailed -> R.string.new_session_devices_unavailable to R.string.new_session_devices_unavailable_description
        NewSessionSetupReason.NoDevices -> R.string.new_session_connect_device_title to R.string.new_session_connect_device_description
        NewSessionSetupReason.DevicesOffline -> R.string.new_session_devices_offline_title to R.string.new_session_devices_offline_description
        NewSessionSetupReason.CheckingAgents -> R.string.new_session_checking_agents to R.string.new_session_checking_agents_description
        NewSessionSetupReason.AgentLoadFailed -> R.string.new_session_agents_unavailable to R.string.new_session_agents_unavailable_description
        NewSessionSetupReason.NeedsAgentSetup -> R.string.new_session_setup_agent_title to R.string.new_session_setup_agent_description
        NewSessionSetupReason.NeedsAgentStart -> R.string.new_session_start_agent_title to R.string.new_session_start_agent_description
        NewSessionSetupReason.AgentStarting -> R.string.new_session_agent_starting_title to R.string.new_session_agent_starting_description
    }
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            modifier = Modifier.widthIn(max = 360.dp).fillMaxWidth()
                .verticalScroll(rememberScrollState()).padding(horizontal = 28.dp, vertical = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(
                modifier = Modifier.size(72.dp).clip(RoundedCornerShape(24.dp)).background(colors.raisedSurface),
                contentAlignment = Alignment.Center,
            ) {
                if (checking || reason == NewSessionSetupReason.AgentStarting) {
                    CircularProgressIndicator(Modifier.size(30.dp), color = colors.inkSoft, strokeWidth = 2.dp)
                } else {
                    Icon(if (deviceStep) Lucide.Monitor else Lucide.Bot, null, tint = colors.inkSoft, modifier = Modifier.size(32.dp))
                }
            }
            Spacer(Modifier.height(24.dp))
            Text(stringResource(title), color = colors.ink, fontSize = 21.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
            state.device?.let {
                Spacer(Modifier.height(8.dp))
                Text(it.name, color = colors.muted, fontSize = 13.sp, textAlign = TextAlign.Center)
            }
            Spacer(Modifier.height(12.dp))
            Text(stringResource(description), color = colors.inkSoft, fontSize = 14.sp, lineHeight = 22.sp, textAlign = TextAlign.Center)
            if (!checking) {
                Spacer(Modifier.height(28.dp))
                StartChatButton(
                    label = stringResource(when {
                        retryFirst && refreshing -> R.string.new_session_checking_again
                        retryFirst -> R.string.new_session_check_again
                        reason == NewSessionSetupReason.NoDevices -> R.string.new_session_connect_device_action
                        reason == NewSessionSetupReason.NeedsAgentStart -> R.string.new_session_manage_agents
                        else -> R.string.new_session_view_devices
                    }),
                    enabled = !retryFirst || !refreshing,
                    onClick = {
                        when {
                            retryFirst -> onRetry()
                            reason == NewSessionSetupReason.NoDevices -> onConnectDevice()
                            else -> onOpenDevices(state.device)
                        }
                    },
                )
                Spacer(Modifier.height(12.dp))
                Row(
                    modifier = Modifier.height(44.dp).clip(RoundedCornerShape(12.dp))
                        .noRippleClickable(enabled = retryFirst || !refreshing) {
                            if (retryFirst) onOpenDevices(state.device) else onRetry()
                        }.padding(horizontal = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (!retryFirst) {
                        if (refreshing) CircularProgressIndicator(Modifier.size(15.dp), color = colors.muted, strokeWidth = 1.5.dp)
                        else Icon(Lucide.RefreshCw, null, tint = colors.muted, modifier = Modifier.size(16.dp))
                    }
                    Text(
                        stringResource(if (retryFirst) R.string.new_session_view_devices else if (refreshing) R.string.new_session_checking_again else R.string.new_session_check_again),
                        color = colors.muted, fontSize = 14.sp,
                    )
                }
            }
        }
    }
}
