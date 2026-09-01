package com.agentsanywhere.app.ui.screens.devices

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceAgentPreviews
import com.agentsanywhere.app.feature.devices.DeviceAgentPreviewState
import com.agentsanywhere.app.feature.devices.DeviceRuntimeList
import com.agentsanywhere.app.feature.devices.onlineAgentCount
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.common.AppEmptyState
import com.composables.icons.lucide.ChevronLeft
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.Circle
import com.composables.icons.lucide.CircleCheck
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Plus
import com.valentinilk.shimmer.shimmer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DevicesScreen(
    state: SessionsState,
    isRefreshing: Boolean,
    onRefresh: () -> Unit,
    onOpenDevice: (AgentDevice) -> Unit,
    onBack: (() -> Unit)? = null,
    agentPreviews: DeviceAgentPreviews,
    onAddDevice: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val devices = remember(state.devices) { state.devices.sortedForDevicesPage() }
    val refreshState = rememberPullToRefreshState()
    val refreshIndicatorContainer = if (darkMode) Color(0xFF27272A) else Color(0xFFF2F2F2)
    val refreshIndicatorColor = if (darkMode) Color(0xFFE4E4E7) else Color(0xFF8E8E93)
    if (onBack != null) {
        BackHandler(onBack = onBack)
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.canvas),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.statusBars)
        ) {
            DevicesHeader(
                darkMode = darkMode,
                onBack = onBack,
            )

            PullToRefreshBox(
                isRefreshing = isRefreshing,
                state = refreshState,
                onRefresh = onRefresh,
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                indicator = {
                    PullToRefreshDefaults.Indicator(
                        modifier = Modifier.align(Alignment.TopCenter),
                        isRefreshing = isRefreshing,
                        state = refreshState,
                        containerColor = refreshIndicatorContainer,
                        color = refreshIndicatorColor,
                    )
                },
            ) {
                when {
                    state.isLoading && !state.hasLoaded && state.devices.isEmpty() -> DevicesLoadingList(darkMode = darkMode)
                    else -> LazyColumn(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(horizontal = 24.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                        contentPadding = PaddingValues(top = 8.dp, bottom = 28.dp),
                    ) {
                        item("add-device") {
                            AddDeviceRow(
                                darkMode = darkMode,
                                onClick = onAddDevice,
                            )
                        }
                        if (devices.isEmpty()) {
                            item("empty") {
                                DevicesEmptyState(message = state.errorMessage)
                            }
                        } else {
                            items(devices, key = { it.id }) { device ->
                                DeviceRow(
                                    device = device,
                                    agentPreview = agentPreviews.byDeviceId[device.id],
                                    darkMode = darkMode,
                                    onClick = { onOpenDevice(device) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }

}

@Composable
internal fun rememberDeviceAgentPreviews(
    devices: List<AgentDevice>,
    isRefreshing: Boolean,
    refreshKey: Long,
    onListDeviceRuntimes: suspend (String) -> Result<DeviceRuntimeList>,
): DeviceAgentPreviews {
    val onlineDeviceIds = remember(devices) {
        devices.filter(AgentDevice::online).map(AgentDevice::id).toSet()
    }
    val onlineDeviceKey = remember(onlineDeviceIds) {
        onlineDeviceIds.sorted().joinToString("|")
    }
    var previews by remember { mutableStateOf(DeviceAgentPreviews()) }

    LaunchedEffect(onlineDeviceKey, isRefreshing, refreshKey) {
        val refresh = previews.beginRefresh(onlineDeviceIds)
        previews = refresh
        val generation = refresh.generation
        if (isRefreshing || onlineDeviceIds.isEmpty()) return@LaunchedEffect

        coroutineScope {
            onlineDeviceIds.forEach { deviceId ->
                launch {
                    val result = try {
                        onListDeviceRuntimes(deviceId)
                    } catch (error: CancellationException) {
                        throw error
                    } catch (error: Exception) {
                        Result.failure(error)
                    }
                    previews = result.fold(
                        onSuccess = { inventory ->
                            previews.loaded(
                                requestGeneration = generation,
                                deviceId = deviceId,
                                onlineAgentCount = inventory.onlineAgentCount(),
                            )
                        },
                        onFailure = {
                            previews.failed(generation, deviceId)
                        },
                    )
                }
            }
        }
    }

    return previews
}

@Composable
private fun DevicesEmptyState(message: String?) {
    AppEmptyState(
        message = message ?: stringResource(R.string.devices_empty),
        modifier = Modifier
            .fillMaxWidth()
            .height(360.dp),
    )
}

@Composable
private fun DevicesHeader(
    darkMode: Boolean,
    onBack: (() -> Unit)?,
) {
    val colors = LocalAAColors.current
    val iconColor = if (darkMode) Color(0xFFE4E4E7) else Color(0xFF1C1C1E)
    val iconSurface = if (darkMode) Color(0xFF18181B) else Color.White
    val iconBorder = if (darkMode) Color(0xFF27272A) else Color(0xFFE7E6E2)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(64.dp)
            .padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .clip(CircleShape)
                    .background(iconSurface)
                    .border(1.dp, iconBorder, CircleShape)
                    .clickable(onClick = onBack),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Lucide.ChevronLeft,
                    contentDescription = stringResource(R.string.common_back),
                    tint = iconColor,
                    modifier = Modifier.size(22.dp),
                )
            }
            Spacer(Modifier.width(12.dp))
        }
        Text(
            text = stringResource(R.string.devices_title),
            color = colors.ink,
            fontSize = 17.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 22.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun AddDeviceRow(
    darkMode: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val surface = colors.raisedSurface
    val border = if (darkMode) colors.border else Color(0xFFECECEC)
    val title = if (darkMode) Color(0xFFDADADF) else Color(0xFF343436)
    val meta = colors.faint
    val shape = RoundedCornerShape(15.dp)
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    val haptic = LocalHapticFeedback.current

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(60.dp)
            .shadow(
                if (pressed) 9.dp else 2.dp,
                shape,
                ambientColor = Color.Black.copy(alpha = if (pressed) 0.16f else if (darkMode) 0.20f else 0.03f),
                spotColor = Color.Black.copy(alpha = if (pressed) 0.16f else if (darkMode) 0.20f else 0.03f),
            )
            .clip(shape)
            .background(surface)
            .border(1.dp, border, shape)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
            ) {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onClick()
            }
            .padding(start = 12.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(42.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(if (darkMode) Color(0xFF27272A) else Color(0xFFF3F2EF)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Lucide.Plus,
                contentDescription = null,
                tint = title,
                modifier = Modifier.size(22.dp),
            )
        }
        Spacer(Modifier.width(11.dp))
        Text(
            text = stringResource(R.string.devices_add_new),
            modifier = Modifier.weight(1f),
            color = title,
            fontSize = 17.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 21.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Icon(
            imageVector = Lucide.ChevronRight,
            contentDescription = null,
            tint = meta,
            modifier = Modifier.size(20.dp),
        )
    }
}

@Composable
internal fun DeviceRow(
    device: AgentDevice,
    agentPreview: DeviceAgentPreviewState?,
    darkMode: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val surface = colors.raisedSurface
    val border = if (darkMode) colors.border else Color(0xFFECECEC)
    val title = if (darkMode) Color(0xFFDADADF) else Color(0xFF343436)
    val offlineTitle = colors.muted
    val meta = if (darkMode) colors.muted else colors.faint
    val chevron = colors.faint
    val shape = RoundedCornerShape(15.dp)
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    val haptic = LocalHapticFeedback.current

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(60.dp)
            .shadow(
                if (pressed) 9.dp else 2.dp,
                shape,
                ambientColor = Color.Black.copy(alpha = if (pressed) 0.16f else if (darkMode) 0.20f else 0.03f),
                spotColor = Color.Black.copy(alpha = if (pressed) 0.16f else if (darkMode) 0.20f else 0.03f),
            )
            .clip(shape)
            .background(surface)
            .border(1.dp, border, shape)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
            ) {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onClick()
            }
            .padding(start = 12.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        DeviceIcon(device = device, darkMode = darkMode)
        Spacer(Modifier.width(11.dp))
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.Center,
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = device.name,
                    modifier = Modifier.weight(1f, fill = false),
                    color = if (device.online) title else offlineTitle,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                    lineHeight = 21.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                DeviceStatusLabel(online = device.online)
            }
            Text(
                text = deviceAgentPreviewLabel(device, agentPreview),
                modifier = Modifier.fillMaxWidth(0.84f),
                color = meta,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                lineHeight = 16.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Icon(
            imageVector = Lucide.ChevronRight,
            contentDescription = null,
            tint = chevron,
            modifier = Modifier.size(20.dp),
        )
    }
}

@Composable
private fun DeviceStatusLabel(online: Boolean) {
    val colors = LocalAAColors.current
    val statusColor = if (online) Color(0xFF10B981) else colors.muted

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            imageVector = if (online) Lucide.CircleCheck else Lucide.Circle,
            contentDescription = null,
            tint = if (online) statusColor else statusColor.copy(alpha = 0.4f),
            modifier = Modifier.size(16.dp),
        )
        Text(
            text = stringResource(if (online) R.string.devices_online else R.string.devices_offline),
            color = statusColor,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            lineHeight = 16.sp,
            maxLines = 1,
        )
    }
}

@Composable
private fun DeviceIcon(device: AgentDevice, darkMode: Boolean) {
    Image(
        painter = painterResource(deviceIconRes(device = device, darkMode = darkMode)),
        contentDescription = null,
        modifier = Modifier.size(42.dp),
    )
}

@Composable
private fun DevicesLoadingList(darkMode: Boolean) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        repeat(4) {
            LoadingRow(darkMode)
        }
    }
}

@Composable
private fun LoadingRow(darkMode: Boolean) {
    val surface = if (darkMode) Color(0xFF18181B) else Color.White
    val border = if (darkMode) Color(0xFF27272A) else Color(0xFFECECEC)
    val line = if (darkMode) Color(0xFF27272A) else Color(0xFFF0F0F0)
    val shape = RoundedCornerShape(15.dp)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(60.dp)
            .shimmer()
            .clip(shape)
            .background(surface)
            .border(1.dp, border, shape)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(42.dp).clip(RoundedCornerShape(10.dp)).background(line))
        Spacer(Modifier.width(11.dp))
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(width = 116.dp, height = 15.dp).clip(CircleShape).background(line))
            Box(Modifier.size(width = 82.dp, height = 11.dp).clip(CircleShape).background(line))
        }
    }
}

@Composable
private fun deviceAgentPreviewLabel(
    device: AgentDevice,
    preview: DeviceAgentPreviewState?,
): String {
    if (!device.online) return stringResource(R.string.devices_offline)
    return when (preview) {
        is DeviceAgentPreviewState.Loaded -> pluralStringResource(
            R.plurals.devices_agents_online,
            preview.onlineAgentCount,
            preview.onlineAgentCount,
        )
        DeviceAgentPreviewState.Unavailable -> stringResource(R.string.devices_agent_status_unavailable)
        DeviceAgentPreviewState.Loading,
        null,
        -> stringResource(R.string.devices_agent_status_loading)
    }
}

internal fun List<AgentDevice>.sortedForDevicesPage(): List<AgentDevice> {
    return sortedWith(
        compareByDescending<AgentDevice> { it.online }
            .thenBy { it.createdAt.orEmpty() }
            .thenBy { it.name.lowercase() },
    )
}

private fun deviceKind(device: AgentDevice): DeviceKind {
    return when (device.deviceOs?.lowercase()) {
        "macos" -> DeviceKind.Mac
        "windows" -> DeviceKind.Windows
        "linux" -> DeviceKind.Linux
        else -> DeviceKind.Generic
    }
}

private fun deviceIconRes(device: AgentDevice, darkMode: Boolean): Int {
    return when (deviceKind(device)) {
        DeviceKind.Mac -> when {
            darkMode && device.online -> R.drawable.device_icon_dark_macos_online_3x
            darkMode -> R.drawable.device_icon_dark_macos_offline_3x
            device.online -> R.drawable.device_icon_light_macos_online_3x
            else -> R.drawable.device_icon_light_macos_offline_3x
        }
        DeviceKind.Windows -> when {
            darkMode && device.online -> R.drawable.device_icon_dark_windows_online_3x
            darkMode -> R.drawable.device_icon_dark_windows_offline_3x
            device.online -> R.drawable.device_icon_light_windows_online_3x
            else -> R.drawable.device_icon_light_windows_offline_3x
        }
        DeviceKind.Linux,
        DeviceKind.Generic,
        -> when {
            darkMode && device.online -> R.drawable.device_icon_dark_linux_online_3x
            darkMode -> R.drawable.device_icon_dark_linux_offline_3x
            device.online -> R.drawable.device_icon_light_linux_online_3x
            else -> R.drawable.device_icon_light_linux_offline_3x
        }
    }
}

private enum class DeviceKind {
    Mac,
    Windows,
    Linux,
    Generic,
}
