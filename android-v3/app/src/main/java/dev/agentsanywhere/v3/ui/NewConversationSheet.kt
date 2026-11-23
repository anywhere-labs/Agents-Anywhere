package dev.agentsanywhere.v3.ui

import android.content.Context
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import dev.agentsanywhere.v3.core.model.projectName
import dev.agentsanywhere.v3.design.AASheet
import dev.agentsanywhere.v3.design.AASpinner
import dev.agentsanywhere.v3.design.AASymbol
import dev.agentsanywhere.v3.design.AgentIcon
import dev.agentsanywhere.v3.design.SheetHeader
import dev.agentsanywhere.v3.model.userMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * New conversation (§2.6): device → Agent → directory, remembering the last choice, then straight into the
 * conversation (`aa.v3.Sessions/create`).
 */
@Composable
fun NewConversationSheet(
    visible: Boolean,
    initialDeviceId: String?,
    initialAgent: String? = null,
    onDismiss: () -> Unit,
    onCreated: (deviceId: String, sessionId: String) -> Unit,
) {
    val app = LocalApp.current
    val model = app.model
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("aa.newConversation", Context.MODE_PRIVATE) }
    val scope = rememberCoroutineScope()
    var deviceId by remember(visible) { mutableStateOf(initialDeviceId ?: prefs.getString("device", null)?.takeIf { id -> model.device(id)?.online == true }) }
    var agent by remember(visible, deviceId) { mutableStateOf(initialAgent ?: prefs.getString("agent.$deviceId", null)) }
    var cwd by remember(visible, deviceId) { mutableStateOf(prefs.getString("cwd.$deviceId", null) ?: "") }
    var busy by remember { mutableStateOf(false) }
    var error by remember(visible) { mutableStateOf<String?>(null) }
    val status = deviceId?.let { model.statuses[it] }

    LaunchedEffect(visible, deviceId) {
        val id = deviceId ?: return@LaunchedEffect
        if (visible && model.statuses[id] == null) runCatching { model.loadStatus(id) }.onFailure { if (it !is CancellationException) error = it.userMessage() }
    }

    AASheet(visible = visible, onDismiss = onDismiss) {
        SheetHeader("新对话", back = deviceId != null && initialDeviceId == null) {
            if (deviceId != null && initialDeviceId == null) deviceId = null else onDismiss()
        }
        Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()).windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))) {
            val id = deviceId
            if (id == null) {
                val online = model.devices.filter { it.online }
                GroupedSection(header = "设备") {
                    if (online.isEmpty()) ListRow("没有在线设备", separator = false)
                    online.forEachIndexed { i, d ->
                        DeviceRow(d, model.deviceStates[d.id], model.sessionsOf(d.id).size, model.isPaired(d.id), separator = i < online.lastIndex) { deviceId = d.id }
                    }
                }
            } else {
                val runtimes = status?.runtimes.orEmpty()
                GroupedSection(header = "Agent · ${model.device(id)?.name ?: ""}") {
                    when {
                        status == null && error == null -> ListRow("正在读取 Agent…", trailing = { AASpinner() }, separator = false)
                        runtimes.isEmpty() -> ListRow("这台设备没有可用的 Agent", separator = false)
                        else -> runtimes.forEachIndexed { i, r ->
                            ListRow(r.name.ifBlank { r.id }, leading = { AgentIcon(r.id, size = 22.dp, tint = Ios.colors.secondaryText) },
                                trailing = if (agent == r.id) ({ AASymbol("Check", size = 18.dp, tint = Ios.colors.tint) }) else null,
                                separator = i < runtimes.lastIndex) { agent = r.id }
                        }
                    }
                }
                val recentDirs = (model.projects(id) + model.sessionsOf(id).map { it.cwd }).filter { it.isNotBlank() }.distinct().take(8)
                GroupedSection(header = "目录", footer = "留空则使用设备上的主目录。") {
                    TextFieldRow(cwd, { cwd = it }, "~/projects/my-app", mono = true, imeAction = ImeAction.Done, separator = recentDirs.isNotEmpty())
                    recentDirs.forEachIndexed { i, dir ->
                        ListRow(projectName(dir), subtitle = dir, symbol = "Folder",
                            trailing = if (cwd == dir) ({ AASymbol("Check", size = 18.dp, tint = Ios.colors.tint) }) else null,
                            separator = i < recentDirs.lastIndex) { cwd = dir }
                    }
                }
                error?.let { GroupedSection { ListRow("无法创建", subtitle = it, symbol = "CircleAlert", symbolTint = Ios.colors.red, separator = false) } }
                Box(Modifier.padding(horizontal = 20.dp, vertical = 20.dp)) {
                    ProminentButton("开始对话", enabled = agent != null && runtimes.any { it.id == agent }, loading = busy) {
                        val a = agent ?: return@ProminentButton
                        busy = true
                        error = null
                        scope.launch {
                            try {
                                val dir = cwd.trim().ifEmpty { null }
                                val session = withContext(Dispatchers.IO) { app.graph.device(id).create(a, dir) }
                                prefs.edit().putString("device", id).putString("agent.$id", a).putString("cwd.$id", dir ?: "").apply()
                                onCreated(id, session.id)
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Throwable) {
                                error = e.userMessage()
                            } finally {
                                busy = false
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}
