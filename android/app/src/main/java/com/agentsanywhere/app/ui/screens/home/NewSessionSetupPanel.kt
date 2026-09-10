package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.LocalAAColors

@Composable
internal fun NewSessionSetupPanel(
    state: NewSessionSetupState,
    refreshing: Boolean,
    onOpenDevices: () -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current
    val reason = state.reason
    val retry = reason == NewSessionSetupReason.AgentLoadFailed || reason == NewSessionSetupReason.DeviceLoadFailed
    val message = when (reason) {
        NewSessionSetupReason.CheckingDevices, NewSessionSetupReason.CheckingAgents -> return
        NewSessionSetupReason.AgentLoadFailed ->
            R.string.new_session_agents_unavailable_description
        NewSessionSetupReason.DeviceLoadFailed ->
            R.string.new_session_devices_unavailable_description
        else -> R.string.new_session_no_available_agents
    }
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            modifier = Modifier.widthIn(max = 360.dp).fillMaxWidth()
                .verticalScroll(rememberScrollState()).padding(horizontal = 28.dp, vertical = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Image(
                painter = painterResource(R.drawable.ic_agent_unavailable),
                contentDescription = null,
                modifier = Modifier.size(168.dp),
            )
            Spacer(Modifier.height(24.dp))
            Text(
                text = stringResource(message),
                color = colors.inkSoft,
                fontSize = 16.sp,
                lineHeight = 25.sp,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(28.dp))
            Box(Modifier.widthIn(max = 224.dp).fillMaxWidth()) {
                StartChatButton(
                    label = stringResource(if (retry) R.string.common_retry else R.string.new_session_configure_agent_action),
                    enabled = !retry || !refreshing,
                    onClick = if (retry) onRetry else onOpenDevices,
                )
            }
        }
    }
}
