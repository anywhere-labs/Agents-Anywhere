package dev.agentsanywhere.v3.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.agentsanywhere.v3.BuildConfig
import dev.agentsanywhere.v3.core.pairing.keyFingerprint
import dev.agentsanywhere.v3.design.AASwitch
import dev.agentsanywhere.v3.design.AccountAvatar

/** Settings (console shell on the phone): account, this client's key, paired devices, appearance, about. */
@Composable
fun SettingsScreen() {
    val app = LocalApp.current
    val nav = LocalNavigator.current
    val model = app.model
    val user = model.user
    var trustVersion by remember { mutableIntStateOf(0) }
    val trusted = remember(trustVersion) { app.graph.trust.all().values.sortedBy { it.paired_at } }
    Column(Modifier.fillMaxSize()) {
        NavBar(title = "设置", onBack = { nav.pop() }, backLabel = "返回")
        LazyColumn(Modifier.fillMaxSize(), contentPadding = WindowInsets.navigationBars.asPaddingValues()) {
            item {
                GroupedSection(header = "账号") {
                    ListRow(user?.display_name?.ifBlank { null } ?: user?.email ?: "账号", subtitle = user?.email,
                        leading = { AccountAvatar(user?.display_name?.ifBlank { null } ?: user?.email ?: "?", 30.dp) })
                    ListRow("控制面", subtitle = model.controlUrl, symbol = "Server", separator = false)
                }
                GroupedSection(header = "本机", footer = "加密设备用这把密钥识别这台手机。重新安装 App 会生成新密钥，需要重新配对。") {
                    ListRow("客户端 ID", subtitle = app.graph.identity.client_id, symbol = "Hash")
                    ListRow("密钥指纹", subtitle = keyFingerprint(app.graph.identity.public_key), symbol = "KeyRound", separator = false)
                }
                GroupedSection(header = "已配对的加密设备") {
                    if (trusted.isEmpty()) ListRow("没有已配对的设备", separator = false)
                    trusted.forEachIndexed { i, t ->
                        ListRow(model.device(t.device_id)?.name ?: t.device_name_hint ?: t.device_id, subtitle = keyFingerprint(t.device_pub),
                            symbol = "ShieldCheck", symbolTint = Ios.colors.green,
                            trailing = { BarTextButton("取消配对") { model.unpair(t.device_id); trustVersion++ } },
                            separator = i < trusted.lastIndex)
                    }
                }
                GroupedSection(header = "外观", footer = if (!app.glass.supported) "Android 12 以下没有实时模糊，控件使用不透明背景。"
                    else if (app.glass.pausedForPowerSaver) "省电模式下暂停毛玻璃。" else "关闭后控件使用不透明背景。") {
                    ListRow("毛玻璃效果", symbol = "Sparkles", trailing = {
                        AASwitch(app.glass.enabled && app.glass.supported, enabled = app.glass.supported) { app.glass.updateEnabled(it) }
                    }, separator = false)
                }
                GroupedSection(header = "关于") {
                    ListRow("版本", value = BuildConfig.VERSION_NAME, symbol = "Info")
                    ListRow("渲染包", value = if (app.bridge.usesPlaceholder) "占位页面" else "web-v3", symbol = "Braces", separator = false)
                }
                GroupedSection {
                    ListRow("退出登录", destructive = true, separator = false) { model.signOut(); nav.replaceAll(Route.Home) }
                }
                Spacer(Modifier.height(32.dp))
            }
        }
    }
}
