package dev.agentsanywhere.v3.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.agentsanywhere.v3.core.merge.DeviceListState
import dev.agentsanywhere.v3.core.model.DeviceRecord
import dev.agentsanywhere.v3.core.model.SessionSummary
import dev.agentsanywhere.v3.core.model.agentDisplayName
import dev.agentsanywhere.v3.core.model.projectName
import dev.agentsanywhere.v3.design.AAFonts
import dev.agentsanywhere.v3.design.AASpinner
import dev.agentsanywhere.v3.design.AASymbol
import dev.agentsanywhere.v3.design.AAText
import dev.agentsanywhere.v3.design.AgentIcon
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Home (device first): devices, then recent conversations across devices. */
@Composable
fun HomeScreen() {
    val app = LocalApp.current
    val nav = LocalNavigator.current
    val model = app.model
    var newConversation by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            NavBar(title = "", trailing = {
                BarButton("ScanQrCode", "扫码配对加密设备") { nav.push(Route.Pair()) }
                BarButton("SquarePen", "新对话", enabled = model.devices.any { it.online }) { newConversation = true }
                BarButton("Settings", "设置") { nav.push(Route.Settings) }
            })
            LazyColumn(Modifier.fillMaxSize(), contentPadding = WindowInsets.navigationBars.asPaddingValues()) {
                item { LargeTitle("Agents Anywhere") }
                if (model.connection == "offline") item {
                    GroupedSection {
                        ListRow("无法连接控制面", subtitle = model.lastError ?: "正在重试…", symbol = "WifiOff", symbolTint = Ios.colors.orange, separator = false)
                    }
                }
                devicesSection(model.devices, model.deviceStates, model.sessions, { model.isPaired(it) }) { nav.push(Route.Device(it.id)) }
                val recent = model.sessions.take(20)
                if (recent.isNotEmpty()) item {
                    GroupedSection(header = "最近对话") {
                        recent.forEachIndexed { i, s ->
                            SessionRow(s, deviceName = model.device(s.device_id)?.name, separator = i < recent.lastIndex) {
                                nav.push(Route.Conversation(s.device_id, s.id))
                            }
                        }
                    }
                }
                item { Spacer(Modifier.height(32.dp)) }
            }
        }
        NewConversationSheet(visible = newConversation, initialDeviceId = null, onDismiss = { newConversation = false }) { deviceId, sessionId ->
            newConversation = false
            nav.push(Route.Conversation(deviceId, sessionId))
        }
    }
}

private fun LazyListScope.devicesSection(
    devices: List<DeviceRecord>,
    states: Map<String, DeviceListState>,
    sessions: List<SessionSummary>,
    paired: (String) -> Boolean,
    onOpen: (DeviceRecord) -> Unit,
) {
    item {
        if (devices.isEmpty()) {
            GroupedSection(header = "设备") {
                EmptyState("Monitor", "还没有设备", "在工作电脑上安装 Agents Anywhere Desktop 或 Connector 并登录同一个账号，设备会出现在这里。")
            }
        } else {
            GroupedSection(header = "设备") {
                devices.forEachIndexed { i, d ->
                    DeviceRow(d, states[d.id], sessions.count { it.device_id == d.id }, paired(d.id), separator = i < devices.lastIndex) { onOpen(d) }
                }
            }
        }
    }
}

@Composable
fun DeviceRow(device: DeviceRecord, state: DeviceListState?, count: Int, paired: Boolean, separator: Boolean, onClick: () -> Unit) {
    val c = Ios.colors
    val encrypted = device.encrypted || paired
    val status = buildList {
        add(if (device.online) "在线" else "离线")
        add(platformName(device.platform))
        if (count > 0) add("$count 个对话")
        if (state?.errorCode == "e2e_required_locally") add("拒绝明文结果")
        else if (encrypted && !paired) add("未配对")
    }.joinToString(" · ")
    ListRow(
        title = device.name,
        subtitle = status,
        leading = {
            Box {
                AASymbol("Monitor", size = 24.dp, tint = if (device.online) c.tint else c.secondaryText)
                Box(Modifier.align(Alignment.BottomEnd)) { StatusDot(if (device.online) c.green else c.tertiaryText, 9.dp) }
            }
        },
        trailing = if (encrypted) ({ AASymbol(if (paired) "ShieldCheck" else "ShieldAlert", size = 18.dp, tint = if (paired) c.green else c.secondaryText) }) else null,
        chevron = true,
        separator = separator,
        onClick = onClick,
    )
}

@Composable
fun SessionRow(s: SessionSummary, deviceName: String?, showAgent: Boolean = true, separator: Boolean, onClick: () -> Unit) {
    val c = Ios.colors
    val meta = listOfNotNull(deviceName, agentDisplayName(s.agent).takeIf { showAgent }, projectName(s.cwd), relativeTime(s.updated_at)).joinToString(" · ")
    ListRow(
        title = s.title.ifBlank { "新对话" },
        subtitle = meta,
        leading = { AgentIcon(s.agent, size = 22.dp, tint = c.secondaryText) },
        trailing = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                when (s.state) {
                    "running" -> AASpinner(14.dp, c.secondaryText)
                    "waiting" -> AASymbol("Hand", size = 16.dp, tint = c.orange)
                    "error" -> AASymbol("CircleAlert", size = 16.dp, tint = c.red)
                }
                if (s.unread) StatusDot(c.tint, 9.dp)
                if (s.pinned) AASymbol("Pin", size = 14.dp, tint = c.secondaryText)
            }
        },
        chevron = true,
        separator = separator,
        onClick = onClick,
    )
}

fun platformName(platform: String): String = when (platform) {
    "macos" -> "macOS"
    "windows" -> "Windows"
    "linux" -> "Linux"
    else -> platform
}

/** "刚刚", "5 分钟前", "3 小时前", "昨天", then a date. */
fun relativeTime(iso: String): String? {
    val t = runCatching { Instant.parse(iso) }.getOrNull() ?: return null
    val d = Duration.between(t, Instant.now())
    return when {
        d.toMinutes() < 1 -> "刚刚"
        d.toHours() < 1 -> "${d.toMinutes()} 分钟前"
        d.toDays() < 1 -> "${d.toHours()} 小时前"
        d.toDays() < 2 -> "昨天"
        else -> DateTimeFormatter.ofPattern("M月d日").withZone(ZoneId.systemDefault()).format(t)
    }
}

@Suppress("unused")
@Composable
private fun SectionTitle(text: String) = AAText(text, Modifier.fillMaxWidth().padding(16.dp), font = AAFonts.headline)
