package com.agentsanywhere.app.ui.screens.devices

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.Image
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
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.HeaderPlusButton
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.PlaceholderScreen
import com.agentsanywhere.app.ui.designsystem.SectionLabel
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.Folder
import com.composables.icons.lucide.Lucide
import com.valentinilk.shimmer.shimmer
import java.time.Duration
import java.time.Instant
import java.time.format.DateTimeParseException

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DevicesScreen(
    navigate: (AppDestination) -> Unit,
    state: SessionsState,
    isRefreshing: Boolean,
    onRefresh: () -> Unit,
) {
    val colors = LocalAAColors.current
    val darkMode = colors.canvas == Color(0xFF09090B)
    val devices = remember(state.devices) { state.devices.sortedForDevicesPage() }
    val workspaces = remember(state.sessions) { workspaceRows(state.sessions) }
    var connectorsExpanded by remember { mutableStateOf(true) }
    var workspacesExpanded by remember { mutableStateOf(true) }
    val refreshState = rememberPullToRefreshState()
    val refreshIndicatorContainer = if (darkMode) Color(0xFF27272A) else Color(0xFFF2F2F2)
    val refreshIndicatorColor = if (darkMode) Color(0xFFE4E4E7) else Color(0xFF8E8E93)

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.canvas),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(start = 24.dp, top = 20.dp, end = 24.dp),
        ) {
            DevicesHeader(
                darkMode = darkMode,
                onAdd = {},
            )
            Spacer(Modifier.height(12.dp))

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
                    state.isLoading && !state.hasLoaded -> DevicesLoadingList(darkMode = darkMode)
                    state.devices.isEmpty() -> Box(
                        modifier = Modifier.fillMaxSize(),
                        contentAlignment = Alignment.Center,
                    ) {
                        DevicesEmptyState(message = state.errorMessage)
                    }
                    else -> LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        item("connectors-label") {
                            SectionLabel(
                                label = "CONNECTORS",
                                expanded = connectorsExpanded,
                                onClick = { connectorsExpanded = !connectorsExpanded },
                            )
                        }
                        if (connectorsExpanded) {
                            items(devices, key = { it.id }) { device ->
                                DeviceRow(
                                    device = device,
                                    darkMode = darkMode,
                                    onClick = { navigate(AppDestination.DeviceDetail) },
                                )
                            }
                        }
                        if (workspaces.isNotEmpty()) {
                            item("workspace-gap") {
                                Spacer(Modifier.height(4.dp))
                            }
                            item("workspaces-label") {
                                SectionLabel(
                                    label = "WORKSPACES",
                                    expanded = workspacesExpanded,
                                    onClick = { workspacesExpanded = !workspacesExpanded },
                                )
                            }
                            if (workspacesExpanded) {
                                items(workspaces, key = { it.path }) { workspace ->
                                    WorkspaceRow(
                                        workspace = workspace,
                                        darkMode = darkMode,
                                        onClick = { navigate(AppDestination.DeviceDetail) },
                                    )
                                }
                            }
                        }
                        item("bottom-space") {
                            Spacer(Modifier.height(18.dp))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DevicesEmptyState(message: String?) {
    val colors = LocalAAColors.current

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = "No Devices",
            color = colors.ink,
            fontSize = 28.sp,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = message ?: "Pair a device first, so sessions have somewhere to land.",
            color = colors.muted,
            fontSize = 15.sp,
            lineHeight = 21.sp,
        )
    }
}

@Composable
private fun DevicesHeader(
    darkMode: Boolean,
    onAdd: () -> Unit,
) {
    val titleColor = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF0A0A0B)

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(58.dp),
    ) {
        Text(
            text = "Devices",
            modifier = Modifier.align(Alignment.CenterStart),
            color = titleColor,
            fontSize = 30.sp,
            fontWeight = FontWeight.ExtraBold,
            lineHeight = 36.sp,
        )
        HeaderPlusButton(
            onClick = onAdd,
            contentDescription = "Add device",
            modifier = Modifier.align(Alignment.CenterEnd),
        )
    }
}

@Composable
fun DeviceDetailPlaceholderScreen(navigate: (AppDestination) -> Unit) {
    ScreenScaffold {
        Box(
            modifier = Modifier.fillMaxSize(),
            contentAlignment = Alignment.Center,
        ) {
            PlaceholderScreen(
                title = "Device Detail",
                subtitle = "Device details will appear here.",
                primaryActionLabel = "Back to Devices",
                onPrimaryAction = { navigate(AppDestination.Devices) },
            )
        }
    }
}

@Composable
private fun DeviceRow(
    device: AgentDevice,
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
                StatusPill(online = device.online, darkMode = darkMode)
            }
            Text(
                text = deviceMeta(device),
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
private fun StatusPill(online: Boolean, darkMode: Boolean) {
    val textColor = when {
        online && darkMode -> Color(0xFF74F2B2)
        online -> Color(0xFF159A61)
        darkMode -> Color(0xFFA1A1AA)
        else -> Color(0xFF999999)
    }
    val surface = when {
        online && darkMode -> Color(0xFF0E2A1F)
        online -> Color(0xFFEAF7EF)
        darkMode -> Color(0xFF27272A)
        else -> Color(0xFFF0F0F0)
    }
    val border = when {
        online && darkMode -> Color(0xFF164A35)
        online -> Color.Transparent
        darkMode -> Color(0xFF3F3F46)
        else -> Color.Transparent
    }

    Box(
        modifier = Modifier
            .height(23.dp)
            .width(62.dp)
            .clip(CircleShape)
            .background(surface)
            .border(1.dp, border, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = if (online) "Online" else "Offline",
            color = textColor,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            lineHeight = 14.sp,
            maxLines = 1,
        )
    }
}

@Composable
private fun WorkspaceRow(
    workspace: WorkspaceRowModel,
    darkMode: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val surface = colors.raisedSurface
    val border = if (darkMode) colors.border else Color(0xFFECECEC)
    val title = if (darkMode) Color(0xFFDADADF) else Color(0xFF343436)
    val meta = if (darkMode) colors.muted else colors.faint
    val icon = colors.faint
    val shape = RoundedCornerShape(15.dp)
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    val haptic = LocalHapticFeedback.current

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .shadow(
                if (pressed) 9.dp else if (darkMode) 2.dp else 0.dp,
                shape,
                ambientColor = Color.Black.copy(alpha = if (pressed) 0.16f else 0.20f),
                spotColor = Color.Black.copy(alpha = if (pressed) 0.16f else 0.20f),
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
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Lucide.Folder,
            contentDescription = null,
            tint = icon,
            modifier = Modifier.size(28.dp),
        )
        Spacer(Modifier.width(11.dp))
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterVertically),
        ) {
            Text(
                text = workspace.title,
                color = title,
                fontSize = 15.5.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 18.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = workspace.path,
                color = meta,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                lineHeight = 14.sp,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
            )
        }
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
        SectionLabel(
            label = "CONNECTORS",
            expanded = true,
            onClick = {},
        )
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

private fun deviceMeta(device: AgentDevice): String {
    val count = device.attachedRuntimes.size
    val agents = "$count ${if (count == 1) "agent" else "agents"}"
    val seen = if (device.online) "now" else device.lastSeenAt.relativeTimeLabel()
    return "$agents · $seen"
}

private fun List<AgentDevice>.sortedForDevicesPage(): List<AgentDevice> {
    return sortedWith(
        compareBy<AgentDevice> { it.createdAt.orEmpty() }
            .thenBy { it.name.lowercase() },
    )
}

private fun workspaceRows(sessions: List<AgentSession>): List<WorkspaceRowModel> {
    return sessions
        .asSequence()
        .mapNotNull { session ->
            val path = session.cwd?.trim()?.trimEnd('/', '\\')?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            path to session
        }
        .groupBy({ it.first }, { it.second })
        .map { (path, grouped) ->
            WorkspaceRowModel(
                path = path,
                title = workspaceTitle(path),
                sortKey = grouped.maxOfOrNull { it.sortKey } ?: "",
            )
        }
        .sortedWith(compareByDescending<WorkspaceRowModel> { it.sortKey }.thenBy { it.title.lowercase() })
        .toList()
}

private fun workspaceTitle(path: String): String {
    val clean = path.trimEnd('/', '\\')
    if (clean == "/") return "/"
    return clean.replace('\\', '/').substringAfterLast('/').ifBlank { clean }
}

private fun String?.relativeTimeLabel(): String {
    if (isNullOrBlank()) return "offline"
    val instant = try {
        Instant.parse(this)
    } catch (_: DateTimeParseException) {
        return "offline"
    }
    val elapsed = Duration.between(instant, Instant.now()).coerceAtLeast(Duration.ZERO)
    val minutes = elapsed.toMinutes()
    val hours = elapsed.toHours()
    val days = elapsed.toDays()
    return when {
        minutes < 1 -> "now"
        minutes < 60 -> "${minutes}m ago"
        hours < 24 -> "${hours}h ago"
        days == 1L -> "yesterday"
        days < 30 -> "${days}d ago"
        days < 365 -> "${days / 30}mo ago"
        else -> "${days / 365}y ago"
    }
}

private fun deviceKind(device: AgentDevice): DeviceKind {
    when (device.deviceOs?.lowercase()) {
        "macos" -> return DeviceKind.Mac
        "windows" -> return DeviceKind.Windows
        "linux" -> return DeviceKind.Linux
    }
    val lower = device.name.lowercase()
    return when {
        "mac" in lower || "mbp" in lower || "book" in lower -> DeviceKind.Mac
        "win" in lower || "pc" in lower -> DeviceKind.Windows
        "linux" in lower || "ubuntu" in lower || "staging" in lower -> DeviceKind.Linux
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

private data class WorkspaceRowModel(
    val path: String,
    val title: String,
    val sortKey: String,
)

private enum class DeviceKind {
    Mac,
    Windows,
    Linux,
    Generic,
}
