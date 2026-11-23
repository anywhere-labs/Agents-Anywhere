package dev.agentsanywhere.v3.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.agentsanywhere.v3.core.model.TerminalInfo
import dev.agentsanywhere.v3.core.model.agentDisplayName
import dev.agentsanywhere.v3.core.model.groupByAgentAndProject
import dev.agentsanywhere.v3.core.pairing.keyFingerprint
import dev.agentsanywhere.v3.design.AASpinner
import dev.agentsanywhere.v3.design.AASymbol
import dev.agentsanywhere.v3.design.AgentIcon
import dev.agentsanywhere.v3.model.userMessage
import io.github.t4wefan.meshcall.MeshCallException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Device page (§2.3): overview, conversations by Agent → project, terminals. */
@Composable
fun DeviceScreen(deviceId: String) {
    val app = LocalApp.current
    val nav = LocalNavigator.current
    val model = app.model
    val device = model.device(deviceId)
    val scope = rememberCoroutineScope()
    var tab by rememberSaveable { mutableStateOf(1) }
    var error by remember { mutableStateOf<String?>(null) }
    var needsPairing by remember { mutableStateOf(false) }
    var terminals by remember { mutableStateOf<List<TerminalInfo>?>(null) }
    var newConversation by remember { mutableStateOf<String?>(null) }
    val status = model.statuses[deviceId]
    val online = device?.online == true
    val paired = model.isPaired(deviceId)
    val encrypted = device?.encrypted == true || paired

    // Live conversation list over this device's tunnel, plus its status (agents).
    LaunchedEffect(deviceId, online) {
        if (!online) return@LaunchedEffect
        if (device?.encrypted == true && !paired) { needsPairing = true; return@LaunchedEffect }
        launch {
            try { model.loadStatus(deviceId) } catch (e: CancellationException) { throw e } catch (e: Throwable) { error = e.userMessage() }
        }
        var attempt = 0
        while (true) {
            try {
                app.graph.device(deviceId).watchList().collect { ev ->
                    attempt = 0
                    error = null
                    model.applyLocalList(deviceId, dev.agentsanywhere.v3.core.model.SessionList(ev.sessions, ev.projects))
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (e is MeshCallException && (e.reason == "e2e_peer_required" || e.reason == "e2e_not_paired")) { needsPairing = true; return@LaunchedEffect }
                if (e is dev.agentsanywhere.v3.core.mesh.AAException && e.code == "e2e_not_paired") { needsPairing = true; return@LaunchedEffect }
                error = e.userMessage()
            }
            delay((1_000L shl attempt.coerceAtMost(4)).coerceAtMost(15_000)); attempt++
        }
    }
    suspend fun loadTerminals() {
        terminals = try { withContext(Dispatchers.IO) { app.graph.device(deviceId).listTerminals() } } catch (e: CancellationException) { throw e } catch (e: Throwable) { error = e.userMessage(); emptyList() }
    }
    LaunchedEffect(tab, online) { if (tab == 2 && online && !needsPairing) loadTerminals() }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            NavBar(title = device?.name ?: "设备", subtitle = if (online) "在线" else "离线", onBack = { nav.pop() }, backLabel = "设备", trailing = {
                BarButton("SquarePen", "新对话", enabled = online && !needsPairing) { newConversation = "" }
            })
            SegmentedControl(listOf("概览", "对话", "终端"), tab, Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) { tab = it }
            LazyColumn(Modifier.fillMaxSize(), contentPadding = WindowInsets.navigationBars.asPaddingValues()) {
                if (needsPairing && !paired) item {
                    GroupedSection(footer = "加密设备只接受经过二维码配对的客户端；控制面看不到对话内容。在设备上打开 Desktop 的「安全」页显示配对二维码。") {
                        ListRow("这台设备已加密，需要先配对", symbol = "ShieldAlert", symbolTint = Ios.colors.orange, separator = true)
                        ListRow("扫描配对二维码", symbol = "ScanQrCode", chevron = true, separator = false) { nav.push(Route.Pair()) }
                    }
                }
                error?.let { e -> item { GroupedSection { ListRow("连接问题", subtitle = e, symbol = "CircleAlert", symbolTint = Ios.colors.red, separator = false) } } }
                when (tab) {
                    0 -> item {
                        GroupedSection(header = "状态") {
                            ListRow("状态", value = if (online) "在线" else "离线（只读缓存）", symbol = if (online) "Wifi" else "WifiOff", symbolTint = if (online) Ios.colors.green else Ios.colors.secondaryText)
                            ListRow("平台", value = listOfNotNull(platformName(device?.platform ?: ""), status?.arch?.ifBlank { null }).joinToString(" "), symbol = "Monitor")
                            ListRow("Connector", value = status?.connector_version ?: device?.connector_version, symbol = "Server")
                            ListRow("模式", value = if (encrypted) "加密" else "普通", symbol = if (encrypted) "ShieldCheck" else "Unplug",
                                symbolTint = if (encrypted && paired) Ios.colors.green else null, separator = paired)
                            if (paired) app.graph.trust.get(deviceId)?.let { t ->
                                ListRow("设备密钥指纹", subtitle = keyFingerprint(t.device_pub), symbol = "KeyRound", separator = false)
                            }
                        }
                        GroupedSection(header = "Agent", footer = if (status == null && online) null else if (!online) "设备离线时无法读取 Agent 列表。" else null) {
                            val runtimes = status?.runtimes.orEmpty()
                            when {
                                status == null && online && !needsPairing -> ListRow("正在读取…", trailing = { AASpinner() }, separator = false)
                                runtimes.isEmpty() -> ListRow("没有可用的 Agent", subtitle = "在设备上安装并登录 Claude Code、Codex、Pi 等 Agent 后再试。", separator = false)
                                else -> runtimes.forEachIndexed { i, r ->
                                    ListRow(r.name.ifBlank { r.id }, subtitle = r.id, leading = { AgentIcon(r.id, size = 22.dp, tint = Ios.colors.secondaryText) },
                                        trailing = { AASymbol("Plus", size = 18.dp, tint = Ios.colors.tint) }, separator = i < runtimes.lastIndex, enabled = online) {
                                        newConversation = r.id
                                    }
                                }
                            }
                        }
                        if (paired) GroupedSection(header = "安全") {
                            ListRow("取消配对", destructive = true, separator = false) { model.unpair(deviceId); nav.pop() }
                        }
                    }
                    1 -> {
                        val sessions = model.sessionsOf(deviceId)
                        if (sessions.isEmpty()) item {
                            GroupedSection {
                                EmptyState("MessagesSquare", "还没有对话", if (online) "点右上角开始一个新对话。" else "设备离线。")
                            }
                        }
                        groupByAgentAndProject(sessions).forEach { group ->
                            group.projects.forEach { project ->
                                item(key = group.agent + "|" + project.cwd) {
                                    GroupedSection(header = "${agentDisplayName(group.agent, status?.runtimes.orEmpty())} · ${project.name}") {
                                        project.sessions.forEachIndexed { i, s ->
                                            SessionRow(s, deviceName = null, showAgent = false, separator = i < project.sessions.lastIndex) {
                                                nav.push(Route.Conversation(deviceId, s.id))
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    else -> item {
                        GroupedSection(header = "终端") {
                            val list = terminals
                            when {
                                !online -> ListRow("设备离线", separator = false)
                                list == null -> ListRow("正在读取…", trailing = { AASpinner() }, separator = false)
                                else -> {
                                    list.forEach { t ->
                                        ListRow(t.shell.substringAfterLast('/').ifBlank { "shell" }, subtitle = listOfNotNull(t.cwd, if (t.running) "运行中" else "已退出").joinToString(" · "),
                                            symbol = "SquareTerminal", chevron = true) { nav.push(Route.Terminal(deviceId, t.id)) }
                                    }
                                    ListRow("新建终端", symbol = "Plus", separator = false) {
                                        scope.launch {
                                            try {
                                                val t = withContext(Dispatchers.IO) { app.graph.device(deviceId).createTerminal(cols = 80, rows = 24) }
                                                nav.push(Route.Terminal(deviceId, t.id, created = true))
                                            } catch (e: CancellationException) { throw e } catch (e: Throwable) { error = e.userMessage() }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                item { Spacer(Modifier.height(32.dp)) }
            }
        }
        NewConversationSheet(visible = newConversation != null, initialDeviceId = deviceId, initialAgent = newConversation?.ifEmpty { null },
            onDismiss = { newConversation = null }) { d, s ->
            newConversation = null
            nav.push(Route.Conversation(d, s))
        }
    }
}
