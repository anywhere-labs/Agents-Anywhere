package com.agentsanywhere.app.ui.screens.terminal

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.feature.terminal.RemoteTerminalController
import com.agentsanywhere.app.feature.terminal.TerminalController
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.common.AppEmptyState
import com.agentsanywhere.app.ui.screens.common.DevicePickerMenu
import com.agentsanywhere.app.ui.screens.devices.sortedForDevicesPage
import com.agentsanywhere.app.ui.screens.sessiondetail.TerminalContent
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.ChevronLeft
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Monitor
import kotlinx.coroutines.launch

@Composable
fun TerminalScreen(
    navigate: (AppDestination) -> Unit,
    state: SessionsState,
    terminalController: TerminalController,
    onPairDevice: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val devices = remember(state.devices) { state.devices.sortedForDevicesPage() }
    var selectedDeviceId by remember { mutableStateOf(devices.firstOrNull { it.online }?.id) }
    val selectedDevice = devices.firstOrNull { it.id == selectedDeviceId && it.online }
    val scope = rememberCoroutineScope()
    val remoteTerminalController = remember(selectedDevice?.id, terminalController) {
        selectedDevice?.let { RemoteTerminalController(terminalController) }
    }

    BackHandler { navigate(AppDestination.Sessions) }

    LaunchedEffect(devices) {
        if (devices.none { it.id == selectedDeviceId && it.online }) {
            selectedDeviceId = devices.firstOrNull { it.online }?.id
        }
    }

    DisposableEffect(remoteTerminalController) {
        onDispose {
            val controller = remoteTerminalController ?: return@onDispose
            scope.launch {
                controller.close()
                controller.dispose()
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.canvas)
            .windowInsetsPadding(WindowInsets.statusBars),
    ) {
        TerminalHeader(
            devices = devices,
            selectedDevice = selectedDevice,
            darkMode = darkMode,
            onBack = { navigate(AppDestination.Sessions) },
            onSelectDevice = { selectedDeviceId = it.id },
        )
        if (devices.isEmpty()) {
            AppEmptyState(
                message = stringResource(R.string.terminal_pair_first),
                buttonLabel = stringResource(R.string.home_pair_new_device),
                buttonIcon = Lucide.Monitor,
                onButtonClick = onPairDevice,
                modifier = Modifier.weight(1f),
            )
        } else if (selectedDevice == null || remoteTerminalController == null) {
            EmptyTerminalMessage(stringResource(R.string.terminal_all_devices_offline), darkMode, Modifier.weight(1f))
        } else {
            TerminalContent(
                terminalController = remoteTerminalController,
                darkMode = darkMode,
                terminalKey = selectedDevice.id,
                canReconnect = selectedDevice.online,
                onStart = { remoteTerminalController.ensureStarted(selectedDevice) },
                onRestart = { remoteTerminalController.restart(selectedDevice) },
                onVerticalDragChange = {},
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun TerminalHeader(
    devices: List<AgentDevice>,
    selectedDevice: AgentDevice?,
    darkMode: Boolean,
    onBack: () -> Unit,
    onSelectDevice: (AgentDevice) -> Unit,
) {
    val colors = LocalAAColors.current
    val iconColor = if (darkMode) Color(0xFFE4E4E7) else Color(0xFF1C1C1E)
    val surface = if (darkMode) Color(0xFF18181B) else Color.White
    val border = if (darkMode) Color(0xFF27272A) else Color(0xFFE7E6E2)
    val hasOnlineDevice = devices.any { it.online }
    var expanded by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(64.dp)
            .padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(CircleShape)
                .background(surface)
                .border(1.dp, border, CircleShape)
                .clickable(onClick = onBack),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Lucide.ChevronLeft, contentDescription = stringResource(R.string.common_back), tint = iconColor, modifier = Modifier.size(22.dp))
        }
        Spacer(Modifier.width(12.dp))
        Box(modifier = Modifier.weight(1f)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(44.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(surface)
                    .border(1.dp, border, RoundedCornerShape(14.dp))
                    .clickable(enabled = hasOnlineDevice) { expanded = true }
                    .padding(horizontal = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = selectedDevice?.name ?: stringResource(R.string.devices_no_online),
                    modifier = Modifier.weight(1f),
                    color = colors.ink,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Icon(Lucide.ChevronDown, contentDescription = null, tint = colors.faint, modifier = Modifier.size(19.dp))
            }
            DevicePickerMenu(
                expanded = expanded,
                devices = devices,
                selectedDevice = selectedDevice,
                onDismiss = { expanded = false },
                onSelectDevice = onSelectDevice,
            )
        }
    }
}

@Composable
private fun EmptyTerminalMessage(
    text: String,
    darkMode: Boolean,
    modifier: Modifier = Modifier,
) {
    Box(modifier = modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Text(
            text = text,
            modifier = Modifier.padding(horizontal = 34.dp),
            color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF6F706A),
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 19.sp,
            textAlign = TextAlign.Center,
        )
    }
}
